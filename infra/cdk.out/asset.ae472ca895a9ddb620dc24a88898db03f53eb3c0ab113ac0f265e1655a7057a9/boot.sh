#!/usr/bin/env bash
# Runs on every instance boot (hamaro-boot.service).
# 1. Points mc.rowan.wang at our current public IP
# 2. Ensures the pinned server image exists in our private ECR (mirrors from Docker Hub if not)
# 3. Syncs the active profile's config from S3 and starts the server
set -euo pipefail
source /etc/hamaro/env
log() { echo "[hamaro-boot] $*"; }

TOK=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
md() { curl -s -H "X-aws-ec2-metadata-token: $TOK" "http://169.254.169.254/latest/meta-data/$1"; }
PUBLIC_IP=$(md public-ipv4)

log "updating DNS: ${HAMARO_DOMAIN} -> ${PUBLIC_IP}"
aws route53 change-resource-record-sets --hosted-zone-id "$HAMARO_ZONE_ID" --change-batch "{
  \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {
    \"Name\": \"${HAMARO_DOMAIN}.\", \"Type\": \"A\", \"TTL\": 60,
    \"ResourceRecords\": [{\"Value\": \"${PUBLIC_IP}\"}]}}]}"

/opt/hamaro/ensure-image.sh

PROFILE=$(aws ssm get-parameter --name /hamaro/active-profile --query 'Parameter.Value' --output text)
PROFILE_DIR="/srv/minecraft/profiles/${PROFILE}"
mkdir -p "${PROFILE_DIR}/data"
aws s3 cp "s3://${HAMARO_BUCKET}/profiles/${PROFILE}/profile.env" "${PROFILE_DIR}/profile.env"

# Never run an un-pinned version: an unattended boot must not silently upgrade a world.
if ! grep -q '^VERSION=' "${PROFILE_DIR}/profile.env" || grep -qiE '^VERSION=(LATEST|SNAPSHOT)\s*$' "${PROFILE_DIR}/profile.env"; then
  log "FATAL: profile '${PROFILE}' has no pinned VERSION in profile.env — refusing to start"
  exit 1
fi

aws ecr get-login-password | docker login --username AWS --password-stdin "$HAMARO_ECR" >/dev/null

cat > /srv/minecraft/runtime.env <<EOF
PROFILE=${PROFILE}
PROFILE_DIR=${PROFILE_DIR}
EOF

docker rm -f hamaro-mc >/dev/null 2>&1 || true
docker run -d --name hamaro-mc \
  --restart unless-stopped \
  --stop-timeout 120 \
  -p 25565:25565 \
  --env-file "${PROFILE_DIR}/profile.env" \
  -e EULA=TRUE -e ENABLE_RCON=true \
  -v "${PROFILE_DIR}/data:/data" \
  "${HAMARO_ECR}/${MC_IMAGE_REPO}:${MC_IMAGE_TAG}"
echo 0 > /run/hamaro-idle
log "started profile=${PROFILE} version=$(grep '^VERSION=' "${PROFILE_DIR}/profile.env" | cut -d= -f2)"

# Publish a fresh heartbeat right away (backgrounded — boot.sh shouldn't block
# on it). Without this, the website reads whatever heartbeat was last published
# BEFORE this boot (e.g. "stopped") until the watchdog timer's own first tick,
# which can leave a real, ready-to-play server showing as stuck "waking up" for
# no reason. The timer's OnBootSec is a shortened fallback net, not the primary path.
/opt/hamaro/watchdog.sh >/dev/null 2>&1 &
