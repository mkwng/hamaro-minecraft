#!/usr/bin/env bash
# Backs up the active profile (world + config) to S3 as a plain .tar.gz.
# Works live (pauses world saves around the tar) or cold (container stopped).
# Restores are just: download, untar. See restore.sh and docs/RESTORE.md.
set -euo pipefail
source /etc/hamaro/env
source /srv/minecraft/runtime.env

TS=$(date -u +%Y%m%dT%H%M%SZ)
KEY="backups/${PROFILE}/${PROFILE}-${TS}.tar.gz"
STAGE=/srv/minecraft/backups
mkdir -p "$STAGE"
TMP="${STAGE}/inflight.tar.gz"

# Live mode only if the container is up AND rcon answers (a server mid-boot has
# no RCON yet — tar cold in that case rather than failing the whole backup).
LIVE=false
if docker ps --format '{{.Names}}' | grep -q '^hamaro-mc$' \
   && docker exec hamaro-mc rcon-cli save-all flush >/dev/null 2>&1; then
  LIVE=true
  docker exec hamaro-mc rcon-cli save-off >/dev/null 2>&1 || true
  sleep 3
fi
tar -czf "$TMP" -C "$PROFILE_DIR" data profile.env
if $LIVE; then
  docker exec hamaro-mc rcon-cli save-on >/dev/null 2>&1 || true
fi

aws s3 cp "$TMP" "s3://${HAMARO_BUCKET}/${KEY}" --no-progress
rm -f "$TMP"
echo "[backup] s3://${HAMARO_BUCKET}/${KEY}"
