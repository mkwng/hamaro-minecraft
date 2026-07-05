#!/usr/bin/env bash
# Delegates mc.rowan.wang and hamaro.rowan.wang to Route 53 by creating NS
# records at Gandi (LiveDNS API, PAT from ~/.config/gandi/config.yaml).
# Idempotent: PUT replaces the record set each run. Manual fallback: docs/GANDI-DNS.md
set -euo pipefail
KEY=$(awk '/apirest/{f=1} f&&/key:/{print $2; exit}' ~/.config/gandi/config.yaml)
[ -n "$KEY" ] || { echo "No Gandi PAT found in ~/.config/gandi/config.yaml"; exit 1; }

ns_for() { # stack-name, region, output-key -> space-separated NS hosts
  aws --region "$2" cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text
}

delegate() { # subdomain-label, ns-list
  local label=$1; shift
  local values=""
  for ns in "$@"; do values+="\"${ns}.\","; done
  values=${values%,}
  echo "Delegating ${label}.rowan.wang -> $*"
  curl -sf -X PUT "https://api.gandi.net/v5/livedns/domains/rowan.wang/records/${label}/NS" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"rrset_ttl\": 3600, \"rrset_values\": [${values}]}"
  echo
}

delegate mc     $(ns_for HamaroGame us-west-2 GameZoneNameServers)
delegate hamaro $(ns_for HamaroWeb  us-east-1 WebZoneNameServers)
echo "Done. Delegation may take a few minutes to propagate."
