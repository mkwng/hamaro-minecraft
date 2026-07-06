#!/usr/bin/env bash
# Renders the public terrain maps (overworld + nether/end when visited) with
# uNmINeD and publishes them to the website: /map/, /map/nether/, /map/end/.
# Also: exploration stats (/map/stats.json), a monthly time-lapse snapshot
# (/map-archive/YYYY-MM.png + index.json), fog-of-war styling, live-marker
# refresh, and shift+click pinning (hamaro.map.js).
# Runs after every goodnight backup and on demand from the admin panel.
set -euo pipefail
source /etc/hamaro/env
source /srv/minecraft/runtime.env
log() { echo "[render-map] $*"; }

# ---- unmined-cli: mirror-once install (see tools/ in the data bucket) ----
UNMINED_DIR=/opt/unmined
BIN="${UNMINED_DIR}/unmined-cli"
if [ ! -x "$BIN" ]; then
  mkdir -p "$UNMINED_DIR"
  if aws s3 ls "s3://${HAMARO_BUCKET}/tools/unmined-cli.tar.gz" >/dev/null 2>&1; then
    log "installing unmined-cli from S3 mirror"
    aws s3 cp "s3://${HAMARO_BUCKET}/tools/unmined-cli.tar.gz" /tmp/unmined.tar.gz --no-progress
  else
    log "first run: downloading unmined-cli from unmined.net (${UNMINED_URL})"
    curl -fsSL "$UNMINED_URL" -o /tmp/unmined.tar.gz
    aws s3 cp /tmp/unmined.tar.gz "s3://${HAMARO_BUCKET}/tools/unmined-cli.tar.gz" --no-progress
  fi
  tar -xzf /tmp/unmined.tar.gz -C "$UNMINED_DIR" --strip-components=1
  rm -f /tmp/unmined.tar.gz
  chmod +x "$BIN"
fi
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1  # AL2023 has no ICU libs

FOG='<style>html,body{background:#0c0e0b!important}body{background-image:repeating-linear-gradient(0deg,rgba(72,213,151,.022) 0 2px,transparent 2px 8px),repeating-linear-gradient(90deg,rgba(125,138,114,.03) 0 2px,transparent 2px 10px)!important}canvas,img{image-rendering:pixelated}</style>'

render_dim() { # world-dir dimension out-subpath (empty for overworld)
  local WDIR=$1 DIM=$2 SUB=$3
  [ -d "$WDIR" ] || { log "no ${DIM} world yet — skipping"; return 0; }
  local OUT="/srv/minecraft/map${SUB:+/$SUB}"
  rm -rf "$OUT"
  "$BIN" web render --world="$WDIR" --dimension="$DIM" --output="$OUT" --zoomin=2 --zoomout=4 \
    > /tmp/unmined-render.log 2>&1 \
    || { log "render failed for ${DIM}: $(tail -3 /tmp/unmined-render.log | tr '\n' ' ')"; return 0; }
  log "rendered ${DIM}"
  mv "$OUT"/unmined.index.html "$OUT"/index.html 2>/dev/null || true
  # NB: '|' delimiter — the fog CSS contains '#' (hex colors), which as a sed
  # delimiter silently breaks the substitution.
  sed -i "s|</head>|${FOG}</head>|" "$OUT/index.html" || echo "[render-map] WARN fog inject failed"
  if [ -z "$SUB" ]; then # overworld gets markers + pinning
    /opt/hamaro/gen-markers.sh > "$OUT/custom.markers.js" || echo "[render-map] WARN gen-markers failed"
    cp /opt/hamaro/hamaro.map.js "$OUT/hamaro.map.js"
    sed -i 's|</body>|<script src="hamaro.map.js"></script></body>|' "$OUT/index.html" || true
  fi
  aws s3 sync "$OUT" "s3://${SITE_BUCKET}/map${SUB:+/$SUB}/" --delete --only-show-errors \
    --exclude "nether/*" --exclude "end/*"
}

DATA="${PROFILE_DIR}/data"
rm -rf /srv/minecraft/map
render_dim "$DATA/world" overworld ""
render_dim "$DATA/world_nether" nether nether
render_dim "$DATA/world_the_end" end end

# custom.markers.js must never be CDN-cached (it goes stale within a minute).
if [ -f /srv/minecraft/map/custom.markers.js ]; then
  aws s3 cp /srv/minecraft/map/custom.markers.js "s3://${SITE_BUCKET}/map/custom.markers.js" \
    --cache-control "no-cache, no-store" --content-type "application/javascript" --only-show-errors || true
fi

# ---- exploration stats: find the overworld region dir wherever this MC
# version keeps it (26.x moved it under dimensions/) ----
REGION_DIR=$(find "$DATA/world" -type d -name region 2>/dev/null | grep -v -E "nether|end" | head -1)
if [ -n "$REGION_DIR" ]; then
  REGIONS=$(ls "$REGION_DIR"/*.mca 2>/dev/null | wc -l | xargs)
  KM2=$(python3 -c "print(round($REGIONS * 512 * 512 / 1e6, 2))")
  printf '{"regions": %s, "km2": %s, "updated": "%s"}\n' "$REGIONS" "$KM2" "$(date -u +%FT%TZ)" \
    | aws s3 cp - "s3://${SITE_BUCKET}/map/stats.json" \
      --cache-control "no-cache" --content-type application/json \
    && log "explored: ${REGIONS} regions (~${KM2} km2)" || log "WARN stats upload failed"
fi

# ---- monthly time-lapse snapshot (one per month, first render wins) ----
MONTH=$(date -u +%Y-%m)
if ! aws s3 ls "s3://${SITE_BUCKET}/map-archive/${PROFILE}-${MONTH}.png" >/dev/null 2>&1; then
  if "$BIN" image render --world="$DATA/world" --dimension=overworld \
      --output=/tmp/archive.png --zoom=-2 > /tmp/unmined-image.log 2>&1 \
     || "$BIN" image render --world="$DATA/world" --dimension=overworld \
      --output=/tmp/archive.png > /tmp/unmined-image.log 2>&1; then
    { aws s3 cp /tmp/archive.png "s3://${SITE_BUCKET}/map-archive/${PROFILE}-${MONTH}.png" --only-show-errors \
      && aws s3 ls "s3://${SITE_BUCKET}/map-archive/" | awk '{print $NF}' | grep '\.png$' \
        | python3 -c "import json,sys; print(json.dumps(sorted(l.strip() for l in sys.stdin if l.strip())))" \
        | aws s3 cp - "s3://${SITE_BUCKET}/map-archive/index.json" \
          --cache-control "no-cache" --content-type application/json \
      && log "archived time-lapse snapshot ${PROFILE}-${MONTH}"; } \
      || log "WARN archive upload failed"
    rm -f /tmp/archive.png
  else
    log "WARN archive image render failed: $(tail -3 /tmp/unmined-image.log | tr '\n' ' ')"
  fi
fi

if [ -n "${SITE_DISTRIBUTION_ID:-}" ]; then
  aws cloudfront create-invalidation --distribution-id "$SITE_DISTRIBUTION_ID" --paths "/map/*" >/dev/null || true
fi
log "maps published for profile=${PROFILE}"
