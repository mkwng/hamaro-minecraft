#!/usr/bin/env bash
# Mirror Minecraft item icons (PrismarineJS/minecraft-assets) into the website
# bucket at /items/<id>.png so the admin inventory view can show pictures.
# Mirror-once philosophy: after this, the site depends only on our S3.
# Re-run on a maintenance day to pick up icons for newly added items.
set -euo pipefail
VERSION="${1:-1.21.9}"
SITE_BUCKET="${SITE_BUCKET:-hamaroweb-sitebucket397a1860-vvfauro7hkzh}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "sparse-cloning minecraft-assets (items for ${VERSION})..."
git clone --quiet --depth 1 --filter=blob:none --sparse \
  https://github.com/PrismarineJS/minecraft-assets "$WORK/assets"
git -C "$WORK/assets" sparse-checkout set "data/${VERSION}/items" --skip-checks
COUNT=$(ls "$WORK/assets/data/${VERSION}/items" | wc -l | xargs)
echo "syncing ${COUNT} icons to s3://${SITE_BUCKET}/items/ ..."
aws s3 sync "$WORK/assets/data/${VERSION}/items/" "s3://${SITE_BUCKET}/items/" \
  --cache-control "public, max-age=2592000" --size-only --no-progress | tail -1

# Manifest of item ids for the console autocomplete.
ls "$WORK/assets/data/${VERSION}/items" | sed 's/\.png$//' | \
  python3 -c "import json,sys; print(json.dumps(sys.stdin.read().split()))" | \
  aws s3 cp - "s3://${SITE_BUCKET}/items/index.json" \
  --cache-control "public, max-age=86400" --content-type application/json
echo "done (icons + index.json)"
