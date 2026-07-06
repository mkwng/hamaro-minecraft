#!/usr/bin/env bash
# Emit custom.markers.js to stdout: warp landmarks (always) + live players
# (optional file of "Name|X|Z" lines). Also sets the viewer's dark background —
# this file is the single injection point into the uNmINeD viewer.
set -euo pipefail
source /etc/hamaro/env
PROFILE=$(grep '^PROFILE=' /srv/minecraft/runtime.env 2>/dev/null | cut -d= -f2 \
  || aws ssm get-parameter --name /hamaro/active-profile --query 'Parameter.Value' --output text)

export WARPS_JSON=$(aws s3 cp "s3://${HAMARO_BUCKET}/profiles/${PROFILE}/warps.json" - 2>/dev/null || echo '{}')
# Names with a mirrored avatar in the site bucket (only those get image markers,
# so a not-yet-mirrored head can never break a marker).
export AVATARS=$(aws s3 ls "s3://${SITE_BUCKET}/avatars/" 2>/dev/null | awk '{print $NF}' | sed 's/\.png$//' | tr '\n' ' ')
python3 - "${1:-}" <<'PY'
import json, os, sys

GLYPHS = {"pin": "📍", "home": "🏠", "farm": "🌾", "portal": "🌀", "danger": "☠️", "star": "⭐"}
COLORS = {"danger": "#ef6f6c", "star": "#f5cf65"}

markers = []
try: warps = json.loads(os.environ.get("WARPS_JSON") or "{}")
except Exception: warps = {}
for name, w in sorted(warps.items()):
    if "overworld" not in w.get("dimension", "minecraft:overworld"):
        continue  # the rendered map is the overworld
    t = w.get("type", "pin")
    markers.append({
        "x": w["x"], "z": w["z"],
        "text": f"{GLYPHS.get(t, GLYPHS['pin'])} {name}",
        "textColor": COLORS.get(t, "#5ac2c9"),
        "font": "bold 14px ui-monospace, monospace",
    })

# Recent deaths (written by the watchdog; pins fade out after an hour).
import time
try:
    deaths = json.load(open("/srv/minecraft/deaths.json"))
except Exception:
    deaths = []
for d in deaths:
    if time.time() - d.get("ts", 0) < 3600:
        markers.append({
            "x": d["x"], "z": d["z"], "text": "☠ " + d["player"],
            "textColor": "#ef6f6c", "font": "bold 13px ui-monospace, monospace",
        })

avatars = set((os.environ.get("AVATARS") or "").split())
pf = sys.argv[1]
if pf and os.path.exists(pf):
    for line in open(pf):
        parts = line.strip().split("|")
        if len(parts) == 3:
            try:
                m = {
                    "x": int(float(parts[1])), "z": int(float(parts[2])),
                    "text": parts[0], "textColor": "#f5cf65", "offsetY": 16,
                    "font": "bold 14px ui-monospace, monospace",
                }
                if parts[0] in avatars:  # mirrored head icon (pixel avatar)
                    m.update({"image": f"/avatars/{parts[0]}.png",
                              "imageAnchor": [0.5, 0.5], "imageScale": 1})
                markers.append(m)
            except ValueError:
                pass

print("UnminedCustomMarkers = { isEnabled: true, markers: %s };" % json.dumps(markers))
print('if (typeof UnminedMapProperties !== "undefined") UnminedMapProperties.background = "#0c0e0b";')
PY
