# RUNBOOK — read me when something breaks (or once a year)

Written for future-Michael with zero context. The kids were 6 when this was built (July 2026).

## The mental model

- One EC2 instance (`hamaro-minecraft`, us-west-2) runs Minecraft in Docker. **Stopped = free** (only storage bills).
- The **website Start button** starts the instance. On boot it points `mc.rowan.wang` at itself, syncs its scripts from S3 (`s3://hamaro-minecraft-<acct>/server/`), and starts the pinned server image from our private ECR.
- The **watchdog** (on the instance, every minute) shuts it down after 15 empty minutes — backing up the world to S3 first.
- The **reaper** (Lambda, every 15 min) force-stops a wedged instance (stale heartbeat or >12 h uptime) and emails you.
- **Worlds are profiles**: `/srv/minecraft/profiles/<name>/` on the EBS data volume, each with its own `profile.env` (mastered in S3) and `data/` dir. The active one is named in SSM param `/hamaro/active-profile`.
- **Nothing is hand-configured.** The instance can be destroyed and recreated by CDK at any time; only the EBS data volume and the S3 bucket matter.

## Common operations

| Task | How |
|---|---|
| Start/stop, switch world, settings, whitelist, backups, console, map | https://hamaro.rowan.wang → grown-ups (email magic link) |
| Add/remove an admin (the other dads) | Admin → Admins tab (allowlist lives at s3://…/config/admins.json) |
| Admin email link not arriving | Check spam; SES sender is server@mc.rowan.wang. Break-glass: password login still works (hash in SSM /hamaro/admin-password-hash) |
| Approve a kid's friend | Admin → Requests (they applied via "Ask to join"); approval whitelists + emails them |
| Update the public world map | happens automatically at every auto-sleep; or Admin → Console → "Update world map now" |
| Shell on the instance (no SSH keys exist) | `aws ssm start-session --target <instance-id> --region us-west-2` |
| Watch server logs | shell in, then `docker logs -f hamaro-mc` |
| Deploy infra/script/website changes | `cd infra && npx cdk deploy HamaroGame HamaroWeb` (script changes take effect on next instance boot) |
| Rotate admin password | `node scripts/set-admin-password.mjs` (prints the new one once) |
| Forgot admin password | same command — it overwrites the hash in SSM; nothing else to update |

## Emergency: "the server won't start"

**First look at the website itself** — since July 2026 the watchdog detects a crash-looping
container (docker restarting the same failure repeatedly) within ~1-2 minutes and shows
"⚠️ The server hit a startup problem" with the actual error line, instead of spinning on
"waking up" forever. The 🔔 notification bell surfaces the same thing. This already covers the
most common cause: a whitelist/ops name that doesn't resolve to a real Mojang account (added via
raw Settings edit, bypassing the validation the structured Players-tab add path runs). Fix it in
World → Settings, Save + apply.

If there's no on-screen error, or you need to go deeper:
1. `aws ec2 describe-instances --region us-west-2` — is the instance actually running?
2. Shell in via SSM. `systemctl status hamaro-boot` and `journalctl -u hamaro-boot -e` show why boot failed.
3. `docker logs hamaro-mc` for Minecraft-level failures (bad plugin, corrupt world, wrong Java).
4. Nuclear option that always works: the world is in S3 backups. Recreate everything:
   `cdk deploy` (rebuild instance) → restore latest backup via website → play.

### Why the whitelist bug happened, and how it's now prevented

A username with a typo or that no longer resolves on Mojang's servers can make the itzg
container's whitelist-sync step fail on every boot, forever — the container restarts and fails
the same way each time. Two independent things now stop this:
- **Adding a name (Players tab, or "Ask to join" approval) checks Mojang before saving.** A name
  that doesn't resolve is rejected outright, with a clear error.
- **Editing the raw `WHITELIST=`/`OPS=` lines in World → Settings** runs the same check as a
  non-blocking warning before saving (`POST /validate-players`) — you can still proceed (e.g. if
  Mojang is temporarily unreachable), but you're told which names look wrong first.

If a bad name somehow gets in anyway, the watchdog's crash-loop detection (RestartCount ≥ 2)
catches it within a minute or two and surfaces the actual log line, rather than leaving `/status`
reading "starting" indefinitely.

## Emergency: "AWS bill is weird"

Budget emails fire at $20 and $35/mo. The reaper caps runaway instances at 12 h.
Check: instance stuck running? (`stop` it), NAT gateway accidentally created? (there should be NONE),
S3 bucket growing unexpectedly? (`aws s3 ls s3://hamaro-minecraft-<acct>/backups/ --recursive --summarize`).

## Deploying safely (won't interrupt active players)

**The vast majority of changes are zero-risk to a live game**, because they never touch the
EC2 instance itself:
- Website (`web/`) and control API (`control-api/*.mjs`) — Lambda/S3 redeploys, live in seconds,
  no effect on the running Minecraft process at all.
- Server scripts (`server/*.sh`) — synced from S3, picked up on the instance's *next* boot or
  stop, never mid-session.
- World/mod/settings changes — applied via the admin panel, which already only restarts the
  Minecraft *container* (a normal, expected, brief interruption players understand), never the
  EC2 host underneath it.

**The one category that's genuinely dangerous:** anything that changes the EC2 **instance**
resource itself (AMI, instance type, subnet/VPC, etc.) forces CloudFormation to *replace* the
whole host — destroy the running one, boot a new one. For a stateful single-instance game server
mid-session, that's catastrophic if it happens by surprise. This actually happened on 2026-07-08:
CDK's "latest Amazon Linux" AMI lookup silently drifted to a newer image between deploys, and a
routine CI run tried to replace the live instance while 2 players were connected. Two things now
prevent a repeat:
1. **`gameAmiId` in `infra/lib/config.ts` is a pinned, explicit AMI ID** — never re-resolved
   "latest" — so ordinary deploys can never drift into a surprise replacement.
2. **CI runs `cdk diff HamaroGame` before every deploy and hard-fails if McInstance would be
   replaced** (`.github/workflows/deploy.yml`, "Guard against accidental game-instance
   replacement"). No routine push can silently take down the game host — the pipeline stops
   and tells you exactly why.

**If you ever deliberately need to replace the instance** (new instance type, a real AMI bump
on maintenance day): do it manually, not through the CI gate.
1. Check nobody's playing: `curl -s https://api.mc.rowan.wang/status` — `players` should be 0,
   or just ask the family first.
2. Trigger a fresh backup (admin panel → World → Backups → "Back up now").
3. Make the change, run `cdk diff HamaroGame` yourself and actually read it — confirm you
   *intend* the replacement it's showing.
4. `cdk deploy HamaroGame` locally (`aws login` first), watch it complete, then verify
   `curl .../status` shows the server healthy again before considering it done.

## If CDK itself won't build (it's 2033 and node/CDK moved on)

The synthesized CloudFormation templates are **committed** in `infra/cdk.out/`. Deploy them raw:
AWS Console → CloudFormation → update stack `HamaroGame` (or `HamaroWeb`) → upload template.
The Lambda code is plain `.mjs` in `control-api/` — paste it into the Lambda console editor if needed.
The website is plain files in `web/` — `aws s3 sync web/ s3://<site-bucket>/` still works.

## Version upgrades (Minecraft or the container image)

1. **Back up first** (website → Backups → Back up now). World upgrades are ONE-WAY.
2. Minecraft version: website → Settings → change `VERSION=` → Save + apply. (Or edit the S3 profile.env.)
3. Container image: bump `mcImageTag` in `infra/lib/config.ts`, `cdk deploy HamaroGame`, restart the
   server. The instance auto-mirrors the new tag from Docker Hub into ECR on next boot (`ensure-image.sh`).
4. Node Lambda runtime deprecated (AWS emails you): bump `NODEJS_22_X` in `infra/lib/game-stack.ts`
   to the current runtime and `cdk deploy`. The handlers use zero npm dependencies precisely so this
   is always a one-line change.

## Yearly maintenance day (~1 hour — put it on the calendar)

- [ ] Restore drill: pick a recent backup, restore into a throwaway profile (`test-restore`), switch to it, see the world load. Delete the profile dir after.
- [ ] Bump `mcImageTag` to the latest itzg release; upgrade `VERSION` if the kids want the new Minecraft.
- [ ] Check for a Lambda runtime deprecation notice; bump if needed.
- [ ] `dnf update -y` via SSM shell, or just terminate the instance and `cdk deploy` a fresh one (worlds are on the separate volume; nothing is lost).
- [ ] Confirm budget alert emails still reach a mailbox you read.
- [ ] Gandi: domain auto-renew ON, payment card valid. **Domain expiry is the #1 way this all dies.**
- [ ] AWS root account: MFA works, recovery codes still printed/findable, payment card valid.

## Account hygiene (do once, matters forever)

- Root account: enable MFA, print recovery codes, store physically.
- Create an IAM admin user for day-to-day work; stop using root credentials.
- Billing alerts → an email you actually read (currently hello@mkwng.com).
- Gandi: auto-renew ON for rowan.wang; PAT tokens expire — the manual delegation steps are in GANDI-DNS.md.

## Email (SES) notes

- Sender identity: the mc.rowan.wang domain (DKIM records auto-managed in Route 53). Production
  access granted July 2026, so magic links and approval emails deliver to anyone.
- If SES sending ever breaks: password login is the break-glass (`node scripts/set-admin-password.mjs`
  to rotate), and whitelisting still works from the Requests/Players tabs — only notifications stop.

## Website build (the one deliberate toolchain dependency)

The site is Vite + React + TypeScript in `web/`. **`web/dist/` is committed on every deploy** —
if the toolchain won't build years from now, deploy the committed dist as-is
(`cd infra && npx cdk deploy HamaroWeb`, or `aws s3 sync web/dist s3://<site-bucket>/`).
The control API stays zero-dependency regardless. Rebuild: `cd web && npm install && npm run build`.
Social images: `node assets/make-social.mjs` regenerates `public/og.png` from `assets/og.svg`.

## Why it's built this way (so you don't "modernize" it into fragility)

- **Zero npm deps in Lambdas**: toolchains rot; plain files don't. (The website traded this
  guarantee for interactivity in v3 — its escape hatch is the committed dist/.)
- **Pinned image tag mirrored to private ECR**: Docker Hub rate limits/outages can't break boot.
- **`VERSION` always explicit**: an unattended reboot must never silently one-way-upgrade a world.
- **No Cognito**: a password hash in SSM has no pricing tiers, no forced UI migrations.
- **No Elastic IP**: boot-time Route 53 update avoids the idle IPv4 charge.
- **EC2 over Fargate/EFS**: cheaper while running, sub-ms disk for world saves, real machine to SSM into.
