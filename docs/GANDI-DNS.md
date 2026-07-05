# Gandi DNS delegation (one-time, and how to redo it)

`rowan.wang` is registered at Gandi and its DNS stays there. Only two subdomains are
delegated to AWS Route 53:

| Subdomain | Zone lives in | Why |
|---|---|---|
| `mc.rowan.wang` | Route 53 (HamaroGame stack, us-west-2) | instance updates its A record on every boot |
| `hamaro.rowan.wang` | Route 53 (HamaroWeb stack, us-east-1) | website alias + automated cert validation |

Everything else on rowan.wang is untouched.

## Automated way

`scripts/delegate-gandi.sh` — reads the Gandi PAT from `~/.config/gandi/config.yaml`,
fetches the NS names from the CloudFormation outputs, and PUTs two NS record sets
via Gandi's LiveDNS API. Idempotent.

## Manual way (PAT expired / script rot)

1. Get the four NS hostnames for each zone:
   `aws cloudformation describe-stacks --stack-name HamaroGame --region us-west-2 --query "Stacks[0].Outputs"`
   (and `HamaroWeb` in us-east-1), or Route 53 console → hosted zone → NS record.
2. Gandi admin → rowan.wang → DNS Records → add records:
   - name `mc`, type `NS`, TTL 3600, one entry per Route 53 nameserver (4 of them, keep trailing dots)
   - name `hamaro`, type `NS`, TTL 3600, same idea with the web zone's nameservers
3. Verify: `dig +short NS mc.rowan.wang` returns the AWS nameservers.

## If the Route 53 zones are ever recreated

Recreated zones get NEW nameservers — redo the delegation (either way above).
Symptoms: `mc.rowan.wang` stops resolving even though the instance is up.
