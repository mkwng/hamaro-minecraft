#!/usr/bin/env bash
# Apply the declared state (active profile pointer in SSM + profile.env in S3)
# to the running instance. Used after settings edits and world switches.
# Safe: backs up the currently-running world before touching anything.
set -euo pipefail
source /etc/hamaro/env

if docker ps --format '{{.Names}}' | grep -q '^hamaro-mc$'; then
  # A failed backup must never strand a switch halfway (EBS + snapshots still
  # protect the world) — warn and carry on.
  /opt/hamaro/backup.sh || echo "[apply-config] WARN: pre-switch backup failed, continuing"
  docker stop -t 120 hamaro-mc || true
  docker rm hamaro-mc || true
fi
exec /opt/hamaro/boot.sh
