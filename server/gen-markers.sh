#!/usr/bin/env bash
# Emit custom.markers.js to stdout: warp landmarks (always) + live players
# (optional file of "Name|X|Z" lines). Also sets the viewer's dark background —
# this file is the single injection point into the uNmINeD viewer.
set -euo pipefail
source /etc/hamaro/env
PROFILE=$(grep '^PROFILE=' /srv/minecraft/runtime.env 2>/dev/null | cut -d= -f2 \
  || aws ssm get-parameter --name /hamaro/active-profile --query 'Parameter.Value' --output text)

export WARPS_JSON=$(aws s3 cp "s3://${HAMARO_BUCKET}/profiles/${PROFILE}/warps.json" - 2>/dev/null || echo '{}')
python3 - "${1:-}" <<'PY'
import json, os, sys

markers = []
try: warps = json.loads(os.environ.get("WARPS_JSON") or "{}")
except Exception: warps = {}
for name, w in sorted(warps.items()):
    if "overworld" not in w.get("dimension", "minecraft:overworld"):
        continue  # the rendered map is the overworld
    markers.append({
        "x": w["x"], "z": w["z"],
        "image": "custom.pin.png", "imageAnchor": [0.5, 1], "imageScale": 0.5,
        "text": name, "textColor": "#5ac2c9", "offsetY": 14,
        "font": "bold 14px ui-monospace, monospace",
    })

pf = sys.argv[1]
if pf and os.path.exists(pf):
    for line in open(pf):
        parts = line.strip().split("|")
        if len(parts) == 3:
            try:
                markers.append({
                    "x": int(float(parts[1])), "z": int(float(parts[2])),
                    "text": "▶ " + parts[0], "textColor": "#f5cf65",
                    "font": "bold 16px ui-monospace, monospace",
                })
            except ValueError:
                pass

print("UnminedCustomMarkers = { isEnabled: true, markers: %s };" % json.dumps(markers))
print('if (typeof UnminedMapProperties !== "undefined") UnminedMapProperties.background = "#0c0e0b";')
PY
