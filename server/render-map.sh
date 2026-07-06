#!/usr/bin/env bash
# Renders a top-down terrain web map of the active world with uNmINeD and
# publishes it to the website at https://<web-domain>/map/ (public, static).
# Runs after every goodnight backup and on demand from the admin panel.
#
# Mirror-once pattern (like the ECR image): the unmined-cli binary is fetched
# from unmined.net a single time, then stashed in our S3 bucket so future
# instance rebuilds never depend on a third-party site being up.
set -euo pipefail
source /etc/hamaro/env
source /srv/minecraft/runtime.env
log() { echo "[render-map] $*"; }

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

WORLD="${PROFILE_DIR}/data/world"
[ -d "$WORLD" ] || { log "no world directory at $WORLD"; exit 1; }

OUT=/srv/minecraft/map
rm -rf "$OUT"
# AL2023 ships no ICU libs; .NET needs invariant globalization mode to run.
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
"$BIN" web render --world="$WORLD" --output="$OUT" --zoomin=2 --zoomout=4
mv "$OUT"/unmined.index.html "$OUT"/index.html 2>/dev/null || true

# Wire in live player markers: custom.markers.js is refreshed every minute by
# the watchdog (no-cache), and loading it after the baked markers file lets it
# override UnminedCustomMarkers before the viewer initializes.
# Also: "fog of war" — unexplored world shows the page background, so paint it
# dark with a faint pixel-dither fog instead of default white.
FOG='<style>html,body{background:#0c0e0b!important}body{background-image:repeating-linear-gradient(0deg,rgba(72,213,151,.022) 0 2px,transparent 2px 8px),repeating-linear-gradient(90deg,rgba(125,138,114,.03) 0 2px,transparent 2px 10px)!important}canvas,img{image-rendering:pixelated}</style>'
sed -i "s#</head>#${FOG}<script src=\"custom.markers.js\"></script></head>#" "$OUT/index.html" || true

aws s3 sync "$OUT" "s3://${SITE_BUCKET}/map/" --delete --no-progress
if [ -n "${SITE_DISTRIBUTION_ID:-}" ]; then
  aws cloudfront create-invalidation --distribution-id "$SITE_DISTRIBUTION_ID" --paths "/map/*" >/dev/null || true
fi
log "map published for profile=${PROFILE}"
