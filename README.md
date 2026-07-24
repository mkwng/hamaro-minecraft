# Hamaro Minecraft

A family Minecraft (Java) server on AWS for Hazel, Marlowe, and Rowan — built to last
from age 6 through college, at ~$5/month.

- **Play at:** `mc.rowan.wang` (Minecraft Java Edition, port 25565)
- **Control panel:** https://hamaro.rowan.wang — anyone can press Start; admin stuff needs the password
- **How it saves money:** the server machine turns itself off after 15 minutes with no players.
  Pressing Start on the website wakes it up in ~1–2 minutes. While it's off, we pay only for
  storage (a few dollars a month).

## How it works (one paragraph)

An EC2 instance (`t4g.large`, us-west-2) runs the Minecraft server in Docker
([itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server), pinned tag mirrored to
our private ECR). World data lives on a separate EBS volume under `/srv/minecraft/profiles/<name>/`
— each "profile" is a self-contained world with its own pinned Minecraft version, settings, and
mods, so switching worlds is safe and instant. A systemd watchdog on the instance stops everything
gracefully (with a backup to S3) after 15 idle minutes; an independent "reaper" Lambda force-stops
a wedged instance. A tiny zero-dependency Lambda API (behind `api.mc.rowan.wang`) powers the static
control website. Everything is defined in AWS CDK under `infra/`.

## Repo map

| Dir | What |
|---|---|
| `infra/` | AWS CDK (TypeScript). `GameStack` (us-west-2): EC2, EBS, Route 53, API, SES, reaper, budgets. `WebStack` (us-east-1): website hosting. |
| `control-api/` | Lambda handlers. Plain JavaScript, **zero npm dependencies** (survives Node runtime bumps with a one-line change). |
| `web/` | The control website: Vite + React + TS. **`dist/` is committed** so the site stays deployable even if the toolchain rots. |
| `server/` | Everything that runs ON the instance: boot, watchdog (idle-sleep + live map markers), backup, restore, map render. Synced from S3 on every boot — edit here, `cdk deploy`, reboot. |
| `whitelist-bot/` | Discord `/whitelist` + `/invite` bot: players self-whitelist via Microsoft login (real Mojang profile → RCON). Own README with the Discord/Azure setup. |
| `scripts/` | One-time/maintenance helpers: admin password, Gandi DNS delegation, item-icon mirror, seeding. |
| `docs/` | **Start with `docs/RUNBOOK.md`.** Restore drills, DNS setup, yearly maintenance. |

## The three rules of not losing everything (read `docs/RUNBOOK.md`)

1. Keep the `rowan.wang` domain renewed (auto-renew + working card at Gandi).
2. Keep the AWS account healthy (root MFA, working payment method, billing alerts go to a read email).
3. Do the yearly maintenance day (calendar reminder — checklist in the runbook).
