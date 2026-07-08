#!/usr/bin/env bash
# Graceful stop: save + stop the container, back up the world to S3, then
# (optionally) power off. Instance-initiated shutdown STOPS the instance
# (set in CDK), so a stopped server bills only EBS storage.
set -uo pipefail
# Pick up any script updates shipped since boot — the goodnight backup and map
# render must run the latest versions, not the ones from hours ago.
/usr/local/bin/hamaro-sync >/dev/null 2>&1 || true
source /etc/hamaro/env

# itzg traps the stop signal and saves the world cleanly (120 s grace).
docker stop -t 120 hamaro-mc >/dev/null 2>&1 || true
docker rm hamaro-mc >/dev/null 2>&1 || true

# Backup after the container is down: world files are fully quiesced.
/opt/hamaro/backup.sh || echo "[stop-server] WARN: backup failed (EBS + weekly snapshots still protect the world)"

# Refresh the public terrain map while the world is quiesced (best effort —
# never let a map render block bedtime).
timeout 300 /opt/hamaro/render-map.sh || echo "[stop-server] WARN: map render skipped/failed"

if [ "${1:-}" = "poweroff" ]; then
  # Final heartbeat so the website shows "asleep" promptly.
  aws ssm put-parameter --name /hamaro/heartbeat --type String --overwrite \
    --value "{\"ts\": $(date +%s), \"state\": \"stopped\", \"players\": null, \"idleMinutes\": 0, \"profile\": \"\", \"uptimeMinutes\": 0}" >/dev/null || true
  shutdown -h now
fi
