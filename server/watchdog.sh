#!/usr/bin/env bash
# Runs every minute (hamaro-watchdog.timer).
# Counts idle minutes (0 players — or server unreachable, so a crash-loop can't
# idle forever), publishes a heartbeat to SSM for the website + reaper Lambda,
# and gracefully shuts the instance down after IDLE_MINUTES.
set -uo pipefail
source /etc/hamaro/env

UPTIME_MIN=$(awk '{print int($1/60)}' /proc/uptime)
IDLE_FILE=/run/hamaro-idle
IDLE=$(cat "$IDLE_FILE" 2>/dev/null || echo 0)

PLAYERS=""
STATE="running"
if OUT=$(docker exec hamaro-mc mc-monitor status --host 127.0.0.1 --port 25565 2>/dev/null); then
  PLAYERS=$(echo "$OUT" | grep -oE 'online=[0-9]+' | head -1 | cut -d= -f2)
fi

if [ -z "$PLAYERS" ]; then
  if [ "$UPTIME_MIN" -lt "$BOOT_GRACE_MINUTES" ]; then
    STATE="starting"            # server still booting — don't count against it yet
  else
    STATE="unreachable"         # crashed/OOM/won't start — counts as idle
    IDLE=$((IDLE + 1))
  fi
elif [ "$PLAYERS" -eq 0 ]; then
  IDLE=$((IDLE + 1))
else
  IDLE=0
  touch /srv/minecraft/dirty   # someone is playing — world worth backing up
fi
echo "$IDLE" > "$IDLE_FILE"

PROFILE=$(grep '^PROFILE=' /srv/minecraft/runtime.env 2>/dev/null | cut -d= -f2 || echo "")

# Publish live player positions + warp landmarks for the public map (best effort).
: > /tmp/hamaro-players.txt
if [ -n "$PLAYERS" ] && [ "$PLAYERS" -gt 0 ] 2>/dev/null; then
  NAMES=$(docker exec hamaro-mc rcon-cli list 2>/dev/null | sed 's/.*online://' | tr ',' '\n' | tr -cd 'A-Za-z0-9_\n')
  # One rcon session for all position queries (a connection per player spams the
  # server console with "Thread RCON Client" start/stop pairs). Responses carry
  # the player's name ("Steve has the following entity data: ..."), so each line
  # can be matched back regardless of order; per-player fallback if one is missing.
  POSDATA=$(printf 'data get entity %s Pos\n' $NAMES | docker exec -i hamaro-mc rcon-cli 2>/dev/null | sed 's/^> //')
  for P in $NAMES; do
    [ -z "$P" ] && continue
    LINE=$(echo "$POSDATA" | grep -m1 "^$P has" || docker exec hamaro-mc rcon-cli data get entity $P Pos 2>/dev/null)
    POS=$(echo "$LINE" | grep -oE '\-?[0-9]+\.?[0-9]*d' | tr -d 'd' | head -3 | xargs)
    X=$(echo $POS | cut -d' ' -f1); Z=$(echo $POS | cut -d' ' -f3)
    [ -n "$X" ] && echo "$P|$X|$Z" >> /tmp/hamaro-players.txt
    # Mirror the player's head avatar once into our own bucket (mc-heads.net is
    # only contacted the first time we ever see this player).
    if ! aws s3 ls "s3://${SITE_BUCKET}/avatars/${P}.png" >/dev/null 2>&1; then
      if curl -fsSL --max-time 6 "https://mc-heads.net/avatar/${P}/16" -o /tmp/avatar.png 2>/dev/null; then
        aws s3 cp /tmp/avatar.png "s3://${SITE_BUCKET}/avatars/${P}.png" \
          --cache-control "public, max-age=604800" --content-type image/png >/dev/null 2>&1 || true
      fi
    fi
  done
fi
# Death pins: scan the last log window for death messages, resolve each
# player's LastDeathLocation, keep pins for an hour (rendered by gen-markers).
if [ "$STATE" = "running" ]; then
  DEAD=$(docker logs hamaro-mc --since 75s 2>&1 \
    | grep -oE 'INFO\]: [A-Za-z0-9_]{1,16} (was |died|drowned|blew up|fell |burned|went up in flames|hit the ground|suffocated|starved|withered|walked into|tried to swim in lava|experienced|froze|left the game and)' \
    | sed 's/INFO\]: //; s/ .*//' | sort -u | grep -vE 'left$' || true)
  for P in $DEAD; do
    LOC=$(docker exec hamaro-mc rcon-cli data get entity $P LastDeathLocation 2>/dev/null || true)
    XYZ=$(echo "$LOC" | grep -oE '\[I; *-?[0-9]+, *-?[0-9]+, *-?[0-9]+\]' | tr -cd '0-9,-' )
    [ -n "$XYZ" ] && P="$P" XYZ="$XYZ" python3 - <<'DEATHS'
import json, os, time
f = "/srv/minecraft/deaths.json"
try: deaths = json.load(open(f))
except Exception: deaths = []
x, y, z = [int(v) for v in os.environ["XYZ"].split(",")[:3]]
p = os.environ["P"]
deaths = [d for d in deaths if time.time() - d.get("ts", 0) < 3600
          and not (d["player"] == p and d["x"] == x and d["z"] == z)]
deaths.append({"player": p, "x": x, "z": z, "ts": int(time.time())})
json.dump(deaths[-30:], open(f, "w"))
DEATHS
  done
fi

# Whitelist knocks: someone tried to join but isn't whitelisted. File it as a
# join request (config/join-requests.json — same list the "ask to join" form
# feeds) so the admin bell can approve straight from the notification. Handles
# both log shapes (modern "Disconnecting Name (/ip)" and old GameProfile[name=…])
# and both spellings ("whitelisted" / "white-listed"). A /run seen-file dedups
# across the 15s overlap between the 75s log window and the 60s timer.
if [ "$STATE" = "running" ]; then
  SEEN=/run/hamaro-knocks-seen
  touch "$SEEN"
  REJECTS=$(docker logs hamaro-mc --since 75s 2>&1 | grep -E 'Disconnecting .*You are not white-?listed' || true)
  KNOCKS=$({ echo "$REJECTS" | grep -oE 'name=[A-Za-z0-9_]{1,16}' | cut -d= -f2;
             echo "$REJECTS" | grep -oE 'Disconnecting [A-Za-z0-9_]{1,16} ' | awk '{print $2}'; } \
           | sort -u | grep -vxFf "$SEEN" || true)
  if [ -n "$KNOCKS" ]; then
    echo "$KNOCKS" >> "$SEEN" && tail -100 "$SEEN" > "$SEEN.t" && mv "$SEEN.t" "$SEEN"
    REQS=$(aws s3 cp "s3://${HAMARO_BUCKET}/config/join-requests.json" - 2>/dev/null || echo '[]')
    NEW=$(KNOCKS="$KNOCKS" REQS="$REQS" python3 - <<'KNOCKS_PY'
import json, os, time
try: reqs = json.loads(os.environ.get("REQS") or "[]")
except Exception: reqs = []
have = {r.get("username", "").lower() for r in reqs}
added = False
for p in os.environ["KNOCKS"].split():
    if p.lower() in have or len(reqs) >= 50: continue
    reqs.append({"username": p, "email": "", "knock": True,
                 "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    added = True
print(json.dumps(reqs, indent=2) if added else "")
KNOCKS_PY
)
    if [ -n "$NEW" ]; then
      echo "$NEW" | aws s3 cp - "s3://${HAMARO_BUCKET}/config/join-requests.json" \
        --content-type application/json >/dev/null 2>&1 \
        && echo "[watchdog] whitelist knock: $(echo $KNOCKS | xargs)"
    fi
  fi
fi

if /opt/hamaro/gen-markers.sh /tmp/hamaro-players.txt > /tmp/custom.markers.js 2>/dev/null; then
  aws s3 cp /tmp/custom.markers.js "s3://${SITE_BUCKET}/map/custom.markers.js" \
    --cache-control "no-cache, no-store" --content-type "application/javascript" >/dev/null 2>&1 || true
fi
aws ssm put-parameter --name /hamaro/heartbeat --type String --overwrite --value "{
  \"ts\": $(date +%s), \"state\": \"${STATE}\", \"players\": ${PLAYERS:-null},
  \"idleMinutes\": ${IDLE}, \"profile\": \"${PROFILE}\", \"uptimeMinutes\": ${UPTIME_MIN}
}" >/dev/null || echo "[watchdog] WARN: heartbeat publish failed"

if [ "$IDLE" -ge "$IDLE_MINUTES" ]; then
  echo "[watchdog] ${IDLE} idle minutes — backing up and shutting down"
  /opt/hamaro/stop-server.sh poweroff
fi
