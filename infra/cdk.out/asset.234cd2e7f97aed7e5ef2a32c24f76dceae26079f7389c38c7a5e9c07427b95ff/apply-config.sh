#!/usr/bin/env bash
# Apply the declared state (active profile pointer in SSM + profile.env in S3)
# to the running instance. Used after settings edits and world switches.
# Safe: backs up the currently-running world before touching anything.
set -euo pipefail
source /etc/hamaro/env

if docker ps --format '{{.Names}}' | grep -q '^hamaro-mc$'; then
  /opt/hamaro/backup.sh
  docker stop -t 120 hamaro-mc
  docker rm hamaro-mc
fi
exec /opt/hamaro/boot.sh
