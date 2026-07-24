// Express web server: invite links -> Microsoft login -> callback that
// whitelists the player's real Mojang profile.
//
// Callback authorization is "consume-then-act": the invite token carried in the
// OAuth `state` is atomically validated + marked consumed BEFORE any code
// exchange or whitelist side effect (see inviteStore.ts).

import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { Config } from './config.js';
import type { InviteStatus, InviteStore } from './inviteStore.js';
import type { Whitelister } from './whitelist.js';
import type { AdminAuth } from './adminAuth.js';
import { mintAdminInvite } from './adminInvites.js';
import { escapeHtml, renderPage } from './html.js';
import { formatUuid, MinecraftAuthError, type MinecraftProfile } from './minecraftAuth.js';

const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers';
const MS_SCOPES = ['XboxLive.signin', 'offline_access'];

/** Microsoft OAuth (auth-code flow) abstraction so the server is testable. */
export interface MicrosoftAuth {
  authorizeUrl(state: string): Promise<string>;
  /** Exchanges an authorization code for a Microsoft access token. */
  exchangeCode(code: string): Promise<string>;
}

export class MsalMicrosoftAuth implements MicrosoftAuth {
  private readonly app: ConfidentialClientApplication;

  constructor(private readonly config: Pick<Config, 'azureClientId' | 'azureClientSecret' | 'oauthRedirectUri'>) {
    this.app = new ConfidentialClientApplication({
      auth: {
        clientId: config.azureClientId,
        clientSecret: config.azureClientSecret,
        authority: MS_AUTHORITY,
      },
    });
  }

  authorizeUrl(state: string): Promise<string> {
    return this.app.getAuthCodeUrl({
      scopes: MS_SCOPES,
      redirectUri: this.config.oauthRedirectUri,
      state,
      prompt: 'select_account',
    });
  }

  async exchangeCode(code: string): Promise<string> {
    const result = await this.app.acquireTokenByCode({
      code,
      scopes: MS_SCOPES,
      redirectUri: this.config.oauthRedirectUri,
    });
    if (!result?.accessToken) throw new Error('Microsoft token response contained no access token');
    return result.accessToken;
  }
}

export interface WebServerDeps {
  config: Config;
  store: InviteStore;
  msAuth: MicrosoftAuth;
  whitelist: Whitelister;
  fetchProfile: (msAccessToken: string) => Promise<MinecraftProfile>;
  adminAuth: AdminAuth;
}

// POST /admin/invite limits (the Discord /invite command has its own).
export const WEB_INVITE_LIMITS = {
  uses: { min: 1, max: 50, default: 1 },
  ttlMinutes: { min: 1, max: 7 * 24 * 60, default: 24 * 60 },
} as const;

function clampInt(value: unknown, limits: { min: number; max: number; default: number }): number | undefined {
  if (value === undefined || value === null) return limits.default;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** OAuth `state` = "<inviteToken>.<nonce>". */
function packState(token: string, nonce: string): string {
  return `${token}.${nonce}`;
}

function unpackState(state: unknown): { token: string; nonce: string } | undefined {
  if (typeof state !== 'string') return undefined;
  const idx = state.lastIndexOf('.');
  if (idx <= 0 || idx === state.length - 1) return undefined;
  return { token: state.slice(0, idx), nonce: state.slice(idx + 1) };
}

const DEAD_LINK_MESSAGES: Record<InviteStatus, string> = {
  used: 'This invite link has already been used.',
  expired: 'This invite link has expired.',
  unknown: "This invite link isn't valid.",
  live: "This invite link isn't valid.",
};

function sendPage(res: Response, status: number, title: string, bodyHtml: string): void {
  res.status(status).type('html').send(renderPage(title, bodyHtml));
}

function sendDeadLinkPage(res: Response, httpStatus: number, tokenStatus: InviteStatus): void {
  sendPage(
    res,
    httpStatus,
    'This link no longer works',
    `<p>${DEAD_LINK_MESSAGES[tokenStatus]}</p>
     <p>Ask whoever gave you this link for a new one (server members can run
     <code>/whitelist</code> in Discord).</p>`,
  );
}

export function createApp(deps: WebServerDeps): express.Express {
  const { config, store, msAuth, whitelist, fetchProfile, adminAuth } = deps;
  const app = express();
  app.disable('x-powered-by');
  // No CORS headers on any route: the dashboard calls /admin/* same-origin
  // (both live behind hamaro.rowan.wang), so nothing cross-origin is allowed.

  app.get('/healthz', (_req: Request, res: Response) => {
    res.type('text/plain').send('ok');
  });

  // Defense in depth: when ORIGIN_VERIFY_SECRET is set, the player-facing
  // routes only answer requests carrying CloudFront's shared-secret custom
  // origin header (X-Origin-Verify), so the origin can't be used to bypass
  // the CDN. /healthz stays open for the local Docker healthcheck.
  if (config.originVerifySecret) {
    const expected = Buffer.from(config.originVerifySecret);
    app.use((req: Request, res: Response, next) => {
      const got = Buffer.from(req.get('x-origin-verify') ?? '');
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        next();
        return;
      }
      res.status(403).type('text/plain').send('forbidden');
    });
  }

  // Dashboard: mint a whitelist invite link. Auth = the control panel's own
  // session token (verified exactly like control-api does). 401 = missing /
  // invalid / expired token; body limits are clamped, not rejected.
  app.post(
    '/admin/invite',
    express.json({ limit: '1kb' }),
    async (req: Request, res: Response, next) => {
      try {
        let who: string | null;
        try {
          who = await adminAuth.verifyAuthorizationHeader(req.get('authorization'));
        } catch (err) {
          console.error('[admin] cannot verify session (signing key unavailable):', err instanceof Error ? err.message : err);
          res.status(503).json({ error: 'admin auth unavailable' });
          return;
        }
        if (!who) {
          res.status(401).json({ error: 'admin login required' });
          return;
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const uses = clampInt(body.uses, WEB_INVITE_LIMITS.uses);
        const ttlMinutes = clampInt(body.ttlMinutes, WEB_INVITE_LIMITS.ttlMinutes);
        if (uses === undefined || ttlMinutes === undefined) {
          res.status(400).json({ error: 'uses and ttlMinutes must be integers' });
          return;
        }

        const minted = mintAdminInvite(store, config.publicBaseUrl, {
          uses,
          ttlMinutes,
          issuedByTag: `web:${who}`,
        });
        res.status(200).json(minted);
      } catch (err) {
        next(err);
      }
    },
  );

  // Step 1: user clicks an invite link (from /whitelist or an admin's /invite).
  app.get('/invite/:token', async (req: Request, res: Response, next) => {
    try {
      const token = String(req.params.token);
      const started = store.beginAuth(token);
      if (!started) {
        sendDeadLinkPage(res, 410, store.status(token));
        return;
      }
      const url = await msAuth.authorizeUrl(packState(started.invite.token, started.nonce));
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  });

  // Step 2: Microsoft redirects back here with ?code=&state=.
  app.get('/auth/callback', async (req: Request, res: Response, next) => {
    try {
      const msError = typeof req.query.error === 'string' ? req.query.error : undefined;
      if (msError) {
        const description =
          typeof req.query.error_description === 'string' ? req.query.error_description : msError;
        sendPage(
          res,
          400,
          'Microsoft sign-in was cancelled or failed',
          `<p>Microsoft said: <code>${escapeHtml(description)}</code></p>
           <p>Click your invite link again to retry (server members can also run
           <code>/whitelist</code> in Discord for a fresh one).</p>`,
        );
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = unpackState(req.query.state);
      if (!code || !state) {
        sendPage(res, 400, 'Invalid callback', '<p>Missing OAuth code or state.</p>');
        return;
      }

      // AUTHORIZATION GATE: atomically validate + consume the invite bound to
      // this state before doing anything privileged. A forged/replayed state or
      // a concurrent second callback fails here.
      const invite = store.consume(state.token, state.nonce);
      if (!invite) {
        sendDeadLinkPage(res, 403, store.status(state.token));
        return;
      }

      // Microsoft code -> access token -> Xbox/XSTS -> Minecraft profile.
      // Nothing privileged has happened yet, so any failure here refunds the
      // use and the same link can be retried.
      let profile: MinecraftProfile;
      try {
        const msAccessToken = await msAuth.exchangeCode(code);
        profile = await fetchProfile(msAccessToken);
      } catch (err) {
        store.reopen(invite.token);
        if (err instanceof MinecraftAuthError) {
          console.warn(`[auth] ${err.code}: ${err.message}`);
          sendPage(
            res,
            err.httpStatus,
            err.title,
            `<p>${escapeHtml(err.message)}</p>
             <p class="muted">You can click your invite link again to retry while it's still valid.</p>`,
          );
          return;
        }
        throw err;
      }

      const issuedFor = invite.discordUserId
        ? `Discord user ${invite.issuedByTag} (${invite.discordUserId})`
        : `admin invite from ${invite.issuedByTag}`;
      console.log(`[auth] ${issuedFor} verified as Minecraft "${profile.name}" (${formatUuid(profile.id)})`);

      // The privileged side effect. `whitelist.add` only throws when nothing
      // was written anywhere (S3 failed, or RCON failed in RCON-only mode),
      // so refunding the use on a throw is safe and lets the link be retried.
      const name = escapeHtml(profile.name);
      try {
        const outcome = await whitelist.add(profile.name);
        console.log(
          `[whitelist] ${profile.name}: durable=${outcome.persisted ?? 'not-configured'} ` +
            `live=${outcome.live} ${outcome.liveReply ? `(${outcome.liveReply.trim()})` : ''}`,
        );
        const applyNote =
          outcome.live === 'applied'
            ? "It's applied right now."
            : `The game server was unreachable (${escapeHtml(
                outcome.liveReply ?? 'no reply',
              )}), so it takes effect when the server next starts.`;
        const discordLink = config.discordInviteUrl
          ? `<p class="muted"><a href="${escapeHtml(config.discordInviteUrl)}">Join our Discord</a> to chat with the other players.</p>`
          : '';
        sendPage(
          res,
          200,
          "You're on the whitelist!",
          `<p>You're whitelisted as <code>${name}</code>. ${applyNote}</p>
           <p>Connect to <code>${escapeHtml(config.mcServerAddress)}</code> in Minecraft: Java Edition.</p>
           ${discordLink}
           <p class="muted">You can close this tab.</p>`,
        );
      } catch (err) {
        console.error('[whitelist] add failed:', err instanceof Error ? err.message : err);
        store.reopen(invite.token);
        sendPage(
          res,
          502,
          "Couldn't reach the game server",
          `<p>You're verified as <code>${name}</code>, but the whitelist couldn't be saved,
           so you're not whitelisted yet.</p>
           <p>Click your invite link again in a minute to retry, or ask a server admin to add you.</p>`,
        );
      }
    } catch (err) {
      next(err);
    }
  });

  app.use((_req: Request, res: Response) => {
    sendPage(res, 404, 'Not found', '<p>Nothing here. This service only handles whitelist invite links.</p>');
  });

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'malformed JSON body' });
      return;
    }
    console.error('[web] unhandled error:', err);
    sendPage(res, 500, 'Something went wrong', '<p>Please try again in a moment.</p>');
  });

  return app;
}
