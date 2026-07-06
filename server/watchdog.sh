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
  for P in $NAMES; do
    [ -z "$P" ] && continue
    POS=$(docker exec hamaro-mc rcon-cli data get entity $P Pos 2>/dev/null | grep -oE '\-?[0-9]+\.?[0-9]*d' | tr -d 'd' | head -3 | xargs)
    X=$(echo $POS | cut -d' ' -f1); Z=$(echo $POS | cut -d' ' -f3)
    [ -n "$X" ] && echo "$P|$X|$Z" >> /tmp/hamaro-players.txt
  done
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
