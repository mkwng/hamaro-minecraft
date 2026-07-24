// Admin authentication for the web dashboard's calls to this bot.
//
// The control panel (web/) authenticates to control-api with a bearer session
// token issued by control-api/api.mjs: `<exp>.<who-b64url>.<hmac>`, where
// hmac = HMAC-SHA256(key, "hamaro:<exp>:<who-b64url>") and the key is the SSM
// SecureString /hamaro/session-key (created by scripts/set-admin-password.mjs).
// We verify the exact same token with the exact same key, so "signed in to the
// panel" is one credential everywhere and control-api's login flow stays the
// single source of truth (this file mirrors api.mjs verifySigned/checkToken).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const KEY_CACHE_MS = 5 * 60 * 1000;

export interface AdminAuthOptions {
  /** Explicit signing key (dev/dry-run); when set, SSM is not consulted. */
  sessionKey: string | undefined;
  /** SSM SecureString parameter holding the signing key (control-api's). */
  sessionKeyParam: string;
  region: string;
}

/** Verifies control-panel bearer tokens. Returns `who` (admin email or "password") or null. */
export class AdminAuth {
  private readonly ssm: SSMClient;
  private cached: { key: string; at: number } | undefined;

  constructor(private readonly options: AdminAuthOptions) {
    this.ssm = new SSMClient({ region: options.region });
  }

  private async signingKey(): Promise<string> {
    if (this.options.sessionKey) return this.options.sessionKey;
    if (this.cached && Date.now() - this.cached.at < KEY_CACHE_MS) return this.cached.key;
    const out = await this.ssm.send(
      new GetParameterCommand({ Name: this.options.sessionKeyParam, WithDecryption: true }),
    );
    const key = out.Parameter?.Value;
    if (!key) throw new Error(`SSM parameter ${this.options.sessionKeyParam} is empty`);
    this.cached = { key, at: Date.now() };
    return key;
  }

  /** Mirrors control-api verifySigned + checkToken. */
  async verifyAuthorizationHeader(header: string | undefined): Promise<string | null> {
    const token = (header ?? '').replace(/^Bearer\s+/i, '');
    const [exp, w, mac] = token.split('.');
    if (!exp || !w || !mac || Number(exp) < Date.now() / 1000) return null;
    const key = await this.signingKey();
    const want = createHmac('sha256', key).update(`hamaro:${exp}:${w}`).digest().toString('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const who = Buffer.from(w, 'base64url').toString();
    // "magic:<email>" tokens are one-time email login links, not sessions.
    return who && !who.startsWith('magic:') ? who : null;
  }
}
