---
name: verify
description: How to build and drive this repo's runnable pieces (whitelist-bot service, web landing page, infra) to observe a change working.
---

# Verify recipes for hamaro-minecraft

## whitelist-bot/ (Node service — the drivable surface)

```bash
cd whitelist-bot && npm ci && npm run build
# Dry-run needs no real creds/network: starts the HTTP server only.
env -i PATH="$PATH" HOME="$HOME" DISCORD_TOKEN=x DISCORD_CLIENT_ID=1 AZURE_CLIENT_ID=x \
  AZURE_CLIENT_SECRET=x OAUTH_REDIRECT_URI=https://hamaro.rowan.wang/auth/callback \
  RCON_HOST=127.0.0.1 RCON_PASSWORD=x MC_SERVER_ADDRESS=mc.rowan.wang PORT=3950 DRY_RUN=true \
  node dist/index.js &
curl -si http://127.0.0.1:3950/healthz            # 200 ok
curl -s  http://127.0.0.1:3950/invite/bad          # 410 friendly page
curl -s "http://127.0.0.1:3950/auth/callback?code=a&state=t.n"   # 403 (forged state)
curl -s "http://127.0.0.1:3950/auth/callback?error=access_denied&error_description=<b>x</b>"  # escaped
```

Gotchas:
- Run from a directory WITHOUT `whitelist-bot/.env` (or unset vars) when
  testing missing-env errors — `dotenv` loads `./.env` from the cwd.
- Missing required env → one-line `Configuration error: ...`, exit 1.
- Non-dry-run needs `discord.com` (blocked in the CCR sandbox: proxy CONNECT
  403). The Microsoft/Xbox/Minecraft chain and RCON can't be exercised without
  real creds + Mojang AppID approval; a valid invite token can only be minted
  via the Discord `/whitelist` command.
- `pkill -f "node dist/index.js"` also kills your own bash if it's in the
  command string — kill by PID instead.

## web/ (Vite landing page)

```bash
cd web && npm ci && npm run build     # dist/ IS committed — commit the rebuild
VITE_DISCORD_INVITE_URL=https://discord.gg/73K2NaWXmT npm run build \
  && grep -o "Join our Discord" dist/assets/*.js   # button baked in only when var set
```

## infra/ (CDK) — no runtime surface here
`cd infra && npm ci && npx tsc --noEmit && npx cdk synth --quiet`. Don't commit
a locally regenerated `cdk.out/` (asset-hash churn) unless intentionally
refreshing the committed fallback templates.
