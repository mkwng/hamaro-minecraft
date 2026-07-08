#!/usr/bin/env bash
# Restore a backup into a profile: restore.sh <s3-key> <target-profile>
# The target's current data is kept aside as data.pre-restore (one level of undo).
# If the target is the active running profile, the server is restarted onto the
# restored world.
set -euo pipefail
source /etc/hamaro/env
KEY="${1:?usage: restore.sh <s3-key> <target-profile>}"
TARGET="${2:?usage: restore.sh <s3-key> <target-profile>}"

TARGET_DIR="/srv/minecraft/profiles/${TARGET}"
STAGE=/srv/minecraft/backups
mkdir -p "$STAGE" "$TARGET_DIR"
TMP="${STAGE}/restore.tar.gz"

aws s3 cp "s3://${HAMARO_BUCKET}/${KEY}" "$TMP" --no-progress

ACTIVE=""
[ -f /srv/minecraft/runtime.env ] && ACTIVE=$(grep '^PROFILE=' /srv/minecraft/runtime.env | cut -d= -f2)
WAS_RUNNING=false
if [ "$TARGET" = "$ACTIVE" ] && docker ps --format '{{.Names}}' | grep -q '^hamaro-mc$'; then
  WAS_RUNNING=true
  docker stop -t 120 hamaro-mc
  docker rm hamaro-mc
fi

rm -rf "${TARGET_DIR}/data.pre-restore"
[ -d "${TARGET_DIR}/data" ] && mv "${TARGET_DIR}/data" "${TARGET_DIR}/data.pre-restore"
tar -xzf "$TMP" -C "$TARGET_DIR"    # extracts data/ and profile.env
rm -f "$TMP"

# The backup's profile.env belongs to the backed-up profile; only keep it if
# restoring in place. For a copy into a NEW profile, S3 remains the config master.
if aws s3 ls "s3://${HAMARO_BUCKET}/profiles/${TARGET}/profile.env" >/dev/null 2>&1; then
  aws s3 cp "s3://${HAMARO_BUCKET}/profiles/${TARGET}/profile.env" "${TARGET_DIR}/profile.env" --no-progress
else
  aws s3 cp "${TARGET_DIR}/profile.env" "s3://${HAMARO_BUCKET}/profiles/${TARGET}/profile.env" --no-progress
fi

if $WAS_RUNNING; then /opt/hamaro/boot.sh; fi
echo "[restore] restored ${KEY} -> ${TARGET}"
