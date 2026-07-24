# whitelist-bot

Self-service whitelisting for the Paper server. A Discord bot plus a tiny web
service (one Node.js process): players prove which Minecraft account is theirs
by signing in with Microsoft, and the bot whitelists that real Mojang profile
— no admin needed, and rename-proof because it whitelists the account that
actually owns the game, not whatever name someone typed.

```
 Discord                          whitelist-bot                       External
 -------                          -------------                       --------
 /whitelist ─────────────────────► issue 1-use token (15 min)
                (ephemeral reply:  https://hamaro.rowan.wang/invite/<token>)
 /invite (admins) ───────────────► issue N-use token (default 24 h)
                                        │
 player clicks link ──────────────► GET /invite/:token
                                    validate token, mint nonce
                                    302 ──────────────────────────► login.microsoftonline.com
                                                                     (XboxLive.signin consent)
 Microsoft ────────────────────────► GET /auth/callback?code=&state=
                                    consume token (single-use gate)
                                    code -> MS access token
                                    MS -> XBL -> XSTS -> Minecraft ───► api.minecraftservices.com
                                    profile {id, name}
                                    S3: append to profile.env WHITELIST=   (durable)
                                    RCON: whitelist add <name>            (live)
                                    success page: name + server address
```

## Contents

- [Operator setup](#operator-setup) — Discord app, Azure app (**+ Mojang review**), Paper config
- [How the whitelist is persisted](#how-the-whitelist-is-persisted)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally) · [Deploying](#deploying)
- [Commands](#commands) · [Testing status](#testing-status) · [Security notes](#security-notes)

## Operator setup

### 1. Discord application + bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**.
2. **Bot** tab → **Reset Token** → copy it → `DISCORD_TOKEN`. No privileged
   gateway intents are needed (the bot only handles slash commands).
3. **General Information** → copy **Application ID** → `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator**: tick scopes `bot` and `applications.commands`
   (no bot permissions are required — replies are ephemeral). Open the
   generated URL and add the bot to your server.
5. Optional: copy your server's ID (Developer Mode → right-click the server →
   **Copy Server ID**) into `DISCORD_GUILD_ID`. With it set, the slash commands
   are registered as *guild* commands and appear instantly; without it they are
   registered globally, which can take up to an hour to propagate. Guild
   registration only works once the bot has been added to that server.
6. Optional: `ADMIN_ROLE_ID` — a role whose members may run `/invite` in
   addition to anyone with the **Manage Server** permission.
7. Optional: `DISCORD_INVITE_URL=https://discord.gg/73K2NaWXmT` — shown as a
   "Join our Discord" link on the success page for people who were invited
   via `/invite` and aren't in the server yet. (The landing page in `web/` has
   a build-time equivalent, `VITE_DISCORD_INVITE_URL` — see `web/.env.example`.)

### 2. Microsoft / Azure app registration

1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. **Supported account types**: **Personal Microsoft accounts only**
   (`consumers`). Minecraft accounts are personal MSAs, not work/school ones.
   (This is why the bot's authority is `login.microsoftonline.com/consumers`.)
3. **Redirect URI** → platform **Web** →
   `https://hamaro.rowan.wang/auth/callback` (add
   `http://localhost:3000/auth/callback` as a second one if you want dev runs).
   It must match `OAUTH_REDIRECT_URI` exactly (scheme, host, path). Microsoft
   requires `https://` for everything except `http://localhost`.
4. **Application (client) ID** → `AZURE_CLIENT_ID`. Ours is
   `d364007e-61ae-4a85-a09a-56f83b4691bd` (client IDs aren't secret — they show
   up in every login URL).
5. **Certificates & secrets** → **New client secret** → the *value* is
   `AZURE_CLIENT_SECRET`. Set it on the host at deploy time only; never commit
   it. Note the expiry date — rotate before then.
6. No API permissions need to be pre-configured: `XboxLive.signin` (plus
   `offline_access`) is requested at runtime as a delegated scope and each user
   sees a normal consent prompt the first time. No admin consent flow.

> **⚠️ Mojang AppID review — the whitelist flow does not work until this is
> approved.**
> New third-party Azure applications are **not** allowed to call
> `api.minecraftservices.com` — `/authentication/login_with_xbox` (and
> therefore the `/minecraft/profile` lookup) returns **HTTP 403** until Mojang
> approves the app. Submit the Application (client) ID via the AppID review
> form: <https://aka.ms/mce-reviewappid>
> (direct: <https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=v4j5cvGGr0GRqy180BHbR-ajEQ1td1ROpz00KtS8Gd5UNVpPTkVLNFVROVQxNkdRMEtXVjNQQjdXVC4u>;
> docs: <https://help.minecraft.net/hc/en-us/articles/16254801392141>).
>
> **Status:** submitted for `d364007e-…`; the profile lookup 403s until
> Mojang approves it, and approval can take a while. Everything up to and
> including the Microsoft/Xbox login works before approval — only the last
> hop to the Minecraft profile is blocked. Until then, players who try it see a
> "this bot isn't fully set up yet — tell an admin" page (a server-side setup
> issue, not something they did wrong).

### 3. Paper server RCON (as this repo actually runs it)

`server/boot.sh` starts the game as the `hamaro-mc` container from the itzg
image with `ENABLE_RCON=true`, the profile's `WHITELIST=` / `ENABLE_WHITELIST`
settings, and (as of this PR) `-p 127.0.0.1:25575:25575` — RCON is published
on the host's **loopback only**. So the bot, run with host networking on the
same box, uses `RCON_HOST=127.0.0.1`, `RCON_PORT=25575`.

The password: itzg needs a fixed `RCON_PASSWORD` in the container env or it
picks a random one per start (which is why `control-api` uses
`docker exec hamaro-mc rcon-cli` instead of the network). Add
`RCON_PASSWORD=<long random>` to the active profile's env via the control
panel (Settings → raw editor), and put the same value in the bot's
`RCON_PASSWORD`. `enforce-secure-profile` is irrelevant here.

**RCON is never exposed publicly** — no `0.0.0.0` publish and no security-group
rule for 25575; the loopback publish above is the only listener.

## How the whitelist is persisted

This repo runs the server with `EXISTING_WHITELIST_FILE=SYNCHRONIZE`
(`server/profiles/*.env`): on every container start `whitelist.json` is
**regenerated** from the profile's `WHITELIST=` line in
`s3://<data-bucket>/profiles/<active>/profile.env` — the same file the control
panel's Players tab edits. An RCON-only `whitelist add` would silently vanish
on the next server start.

So with `HAMARO_BUCKET` set, the bot mirrors what `control-api` does: it first
appends the verified name to that `WHITELIST=` line (durable), then applies
`whitelist add <name>` live over RCON. If the game server is asleep/unreachable
the durable write still succeeds and the entry applies on the next boot; the
success page tells the player which case happened. Without `HAMARO_BUCKET` the
bot logs a startup warning and is RCON-only (live, but lost on restart under
SYNCHRONIZE).

The bot needs AWS credentials with `s3:GetObject`/`s3:PutObject` on
`<data-bucket>/profiles/*` and `ssm:GetParameter` on `/hamaro/active-profile`.
On the game host the instance role already has both, and the AWS SDK picks it
up automatically (no keys to configure).

## Environment variables

Copy `.env.example` to `.env` for local runs (loaded via `dotenv`); in Docker
pass real env vars. Secrets are set on the host, never committed.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Bot token (Developer Portal → Bot). |
| `DISCORD_CLIENT_ID` | yes | — | Application ID. |
| `DISCORD_GUILD_ID` | no | *(unset → global)* | Register commands to this guild for instant availability. |
| `ADMIN_ROLE_ID` | no | *(unset)* | Extra role allowed to run `/invite` (besides Manage Server). |
| `DISCORD_INVITE_URL` | no | *(unset)* | "Join our Discord" link on the success page. |
| `AZURE_CLIENT_ID` | yes | — | Azure app (client) ID, personal-accounts app. |
| `AZURE_CLIENT_SECRET` | yes | — | Azure client secret value (host-only). |
| `OAUTH_REDIRECT_URI` | yes | — | Must exactly match the Azure Web redirect URI (`…/auth/callback`). |
| `PUBLIC_BASE_URL` | no | origin of `OAUTH_REDIRECT_URI` | Base for invite links (`https://hamaro.rowan.wang`). |
| `ORIGIN_VERIFY_SECRET` | no | *(unset → no check)* | Shared secret CloudFront sends as `X-Origin-Verify`; when set, `/invite` and `/auth/*` require it. |
| `RCON_HOST` | yes | — | Paper RCON host (`127.0.0.1` with host networking on the game box). |
| `RCON_PORT` | no | `25575` | RCON port. |
| `RCON_PASSWORD` | yes | — | RCON password — must match `RCON_PASSWORD` in the active profile.env (never logged). |
| `HAMARO_BUCKET` | no *(recommended)* | *(unset → RCON-only)* | Data bucket for durable whitelist writes to the active profile.env. |
| `AWS_REGION` | no | `us-west-2` | Region for S3/SSM. |
| `HAMARO_ACTIVE_PROFILE` | no | *(from SSM)* | Pin the profile name instead of reading the parameter. |
| `HAMARO_ACTIVE_PROFILE_PARAM` | no | `/hamaro/active-profile` | SSM parameter naming the active profile. |
| `MC_SERVER_ADDRESS` | yes | — | Address shown to players on the success page. |
| `PORT` | no | `3000` | HTTP listen port. |
| `INVITE_TTL_MINUTES` | no | `15` | Lifetime of `/whitelist` self-serve links. |
| `DRY_RUN` | no | `false` | `true` = validate config + serve HTTP, but skip Discord login, RCON and S3. |

## Running locally

```bash
cd whitelist-bot
cp .env.example .env        # fill it in
npm ci
npm run build
npm start                   # node dist/index.js
```

- `npm run dev` — run from source with reload (`tsx watch`).
- `npm run typecheck` / `npm run lint`.
- `npm run register-commands` — (re)register the slash commands without
  starting the bot (the bot also registers them on every startup).
- **Dry run:** `DRY_RUN=true npm start` (or `--dry-run`) validates the config,
  serves `/healthz` and the invite pages, but never logs into Discord, opens an
  RCON connection or touches S3. Missing/invalid env vars fail fast at startup
  with a one-line message naming the variable.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/whitelist` | anyone in the server | Ephemeral reply with a personal link: **1 use**, expires after `INVITE_TTL_MINUTES` (15). One live link per Discord user — asking again replaces the old one. |
| `/invite [count] [expires-in]` | Manage Server permission **or** `ADMIN_ROLE_ID` role | Ephemeral reply with a link to give to someone who isn't in Discord. `count` = uses (default 1, max 100), `expires-in` = hours (default 24, max 720). These links aren't tied to a Discord user and don't invalidate each other. |

`/invite` is registered with `default_member_permissions = Manage Server` (so
Discord hides it from regular members) and the permission/role is checked
again at runtime.

The web flow works for people who never touch Discord: the success page just
says "You're whitelisted as `<name>`. Connect to `mc.rowan.wang`." (plus the
optional Discord link).

## Deploying

Target: the bot runs on the **game host** next to the MC container, and its
routes are served on the main site domain — invite links look like
`https://hamaro.rowan.wang/invite/<token>`, the OAuth callback is
`https://hamaro.rowan.wang/auth/callback`. Players never see another hostname.

**How the routing works (all in the CDK, `infra/`):** `hamaro.rowan.wang` is
S3 + CloudFront (`WebStack`, `infra/lib/web-stack.ts`, us-east-1). This PR
adds three CloudFront behaviors — `/invite/*`, `/auth/*`, `/healthz` — with
caching disabled and query strings forwarded, that proxy **over HTTPS**
(`https-only`, TLS ≥ 1.2) to the game host, addressed by its existing A record
`mc.rowan.wang` (`server/boot.sh` re-points it at the box's current IP on
every boot). On the box, **Caddy** holds an ACME cert for that name and
reverse-proxies to the bot on `127.0.0.1:3000` (`deploy/Caddyfile`), so the
OAuth callback (which carries MS auth codes and invite tokens) is never sent in
plaintext. CloudFront also adds a shared-secret custom origin header
(`X-Origin-Verify`, from the `botOriginVerifySecret` CDK context value) that the
bot verifies via `ORIGIN_VERIFY_SECRET`, so the origin can't be used to bypass
the CDN. `GameStack` (`infra/lib/game-stack.ts`, us-west-2) opens **443** to
CloudFront's origin-facing prefix list only and **80** to the world (ACME
HTTP-01 cert issuance/renewal); 3000 and 25575 are never opened. None of the
proxied paths exist in the Vite app (hash routes), so nothing collides.

Steps:

1. **Deploy the infra change** (CI does `HamaroGame` + `HamaroWeb` on merge to
   `main`, but pass the secret yourself since it's not committed):
   ```bash
   cd infra
   npx cdk deploy HamaroGame HamaroWeb -c botOriginVerifySecret="<32-byte hex>"
   ```
   Verify the CloudFront origin-facing prefix-list ID first (command in the
   comment above `cloudfrontOriginPrefixListId` in `infra/lib/config.ts`). If
   you deploy without `-c botOriginVerifySecret=…` the header is simply not
   sent — then leave `ORIGIN_VERIFY_SECRET` unset on the bot too (it relies on
   the SG restriction alone).
2. **Set a fixed RCON password**: add `RCON_PASSWORD=<long random>` to the
   active profile's env (control panel → Settings raw editor) so it survives
   restarts, and use the same value in the bot's env. `server/boot.sh` now
   publishes RCON on `127.0.0.1:25575` (reboot the game host once so the
   updated script — synced from S3 by CI/deploy — takes effect).
3. **Run the bot + Caddy on the game host** with host networking (see
   `docker-compose.example.yml`, which pairs the bot with `caddy:2` using
   `deploy/Caddyfile`):
   ```bash
   docker compose -f docker-compose.example.yml up -d --build
   ```
   Env: `OAUTH_REDIRECT_URI=https://hamaro.rowan.wang/auth/callback` (also the
   Azure Web redirect URI), `MC_SERVER_ADDRESS=mc.rowan.wang`,
   `RCON_HOST=127.0.0.1`, `HAMARO_BUCKET=<data bucket>` (durable whitelist),
   `ORIGIN_VERIFY_SECRET=<same value as the CDK context>`, plus the Discord /
   Azure secrets — all on the host, never committed.
4. Sanity check: `curl https://hamaro.rowan.wang/healthz` → `ok` (and directly on
   the box: `curl -H "X-Origin-Verify: <secret>" http://127.0.0.1:3000/healthz`).

Implemented in this PR: the CDK behaviors/origin/SG rules, the `boot.sh` RCON
loopback publish, the bot's `ORIGIN_VERIFY_SECRET` check, and the
Caddy/compose examples. **Manual, one-time**: choosing the secret and passing
it to `cdk deploy`, the fixed `RCON_PASSWORD` in profile.env, and starting the
containers on the box.

> ⚠️ **Heads-up: the game host auto-sleeps.** It's stopped by the watchdog after
> 15 idle minutes (`docs/RUNBOOK.md`), and everything co-hosted there sleeps
> with it: `/whitelist` links only work while the host is awake (players will
> have pressed Start on the site anyway), Discord shows the bot offline while
> it's asleep, and the CloudFront-proxied paths return a 502 during that time.
> Outstanding invite tokens live in memory, so a sleep/wake cycle invalidates
> them — long-lived admin `/invite` links won't survive a nap. If you want it
> always-on, run bot + Caddy on a separate tiny host, point `botOriginDomain` at
> a name for that host, and reach RCON over the VPC (allowing 25575 only from
> that host's security group).

## Testing status

- `npm run typecheck`, `npm run lint` and `npm run build` are clean.
- Startup was verified in dry-run mode (`/healthz` → `ok`, `/invite/<bad>` →
  friendly 410 page, forged `/auth/callback` state → 403), and missing/invalid
  env vars produce a clear one-line error and exit 1.
- **Not exercised:** the live Discord gateway, the Microsoft → Xbox Live → XSTS
  → Minecraft-profile chain, S3 persistence, RCON, and the CloudFront proxying.
  Those need real credentials, the Mojang AppID approval and a deploy; the
  sandbox this was written in had no network path to Discord or the Minecraft
  services. Expect to do the first real login end-to-end yourself.

## Security notes

- Invite tokens are 24 random bytes, have a TTL and a use budget; `/whitelist`
  tokens are single-use and only one is live per Discord user.
- The OAuth `state` carries `<token>.<nonce>`; the nonce is minted server-side
  when the login starts and must come back. The callback **atomically
  validates + consumes** the token *before* any code exchange or whitelist
  side effect ("consume-then-act"), so a forged/replayed state or a duplicate
  callback cannot whitelist anyone. If the login fails before the whitelist
  step the use is given back so the link can be retried.
- Secrets only ever come from env vars; the RCON password and OAuth secrets are
  never logged. Player names are validated (`^[A-Za-z0-9_]{1,16}$`) before
  being interpolated into the RCON command; all user-provided values are
  HTML-escaped in rendered pages.
- The token store is in-memory (fine for one process; a restart invalidates
  outstanding links). It sits behind a small interface, so a persistent
  implementation could be swapped in.
