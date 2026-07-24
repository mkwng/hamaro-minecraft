// Invite tokens with per-token TTL + a use budget (`remainingUses`).
//
// Two flavours share one model:
//  - Self-serve (/whitelist): 1 use, short TTL, bound to a Discord user — at
//    most one live token per user (issuing a new one invalidates the old).
//  - Admin-minted (/invite): N uses, longer TTL, not bound to a Discord user,
//    and don't invalidate each other. Meant to be pasted to people who aren't
//    in the Discord server.
//
// The store is an in-memory Map behind a small interface. A persistent
// implementation (e.g. sqlite) could implement InviteStore and be dropped in
// without touching the rest of the app; in-memory is fine for a single-process
// bot where a restart simply invalidates outstanding links.
//
// Security model:
//  - `beginAuth` mints a fresh anti-CSRF nonce for a live token when the login
//    flow starts; the nonce travels in the OAuth `state` and must come back.
//    Nonces live in a per-token set so a shared multi-use link can have
//    several people mid-flow at once.
//  - `consume` is the authorization gate for the callback: it atomically checks
//    (token live, nonce known) and spends one use + the nonce in one
//    synchronous step (Node's single-threaded event loop makes the
//    check-and-set atomic — there is no await between them). Only after a
//    successful consume does the caller perform the privileged side effect
//    (RCON whitelist add). This is "consume-then-act": a replayed/forged state
//    or a second concurrent callback with the same nonce cannot trigger a
//    second whitelist add.
//  - `reopen` gives one use back if the flow failed before the side effect
//    happened, so the same link can be retried.

import { randomBytes } from 'node:crypto';

/** Cap on concurrent in-flight logins per token (bounds the nonce set). */
const MAX_PENDING_NONCES = 64;

export interface Invite {
  token: string;
  expiresAt: number;
  totalUses: number;
  remainingUses: number;
  /** Set for self-serve tokens; admin-minted tokens are not user-bound. */
  discordUserId: string | undefined;
  /** Discord tag of whoever issued it (self-serve user or the admin), for logs. */
  issuedByTag: string;
  /** Anti-CSRF nonces of in-flight logins started via this link. */
  pendingNonces: Set<string>;
}

export type InviteStatus = 'live' | 'used' | 'expired' | 'unknown';

export interface AdminInviteOptions {
  uses: number;
  ttlMs: number;
  issuedByTag: string;
}

export interface InviteStore {
  /** Self-serve invite: 1 use, store's default TTL, one live token per user. */
  createUserInvite(discordUserId: string, discordTag: string): Invite;
  /** Admin invite: N uses, custom TTL, not tied to (or limited by) a user. */
  createAdminInvite(options: AdminInviteOptions): Invite;
  /** Returns the invite if it is live (exists, unexpired, uses left). */
  get(token: string): Invite | undefined;
  /** Why a token is (not) usable — for friendly error pages. */
  status(token: string): InviteStatus;
  /** Validate a live token and mint a nonce for the OAuth state. */
  beginAuth(token: string): { invite: Invite; nonce: string } | undefined;
  /**
   * Atomically validate (live + nonce known) and spend one use.
   * Returns the invite on success, undefined otherwise. Compare-and-swap.
   */
  consume(token: string, nonce: string): Invite | undefined;
  /** Give back one use of a token whose action never happened. */
  reopen(token: string): void;
  close(): void;
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export class MemoryInviteStore implements InviteStore {
  private readonly invites = new Map<string, Invite>();
  private readonly byUser = new Map<string, string>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly userInviteTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // Periodic sweep of expired entries so the map doesn't grow unbounded.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  createUserInvite(discordUserId: string, discordTag: string): Invite {
    // Rate limit: one live self-serve token per Discord user — issuing a new
    // one kills the old.
    const previous = this.byUser.get(discordUserId);
    if (previous) this.invites.delete(previous);

    const invite = this.insert({
      uses: 1,
      ttlMs: this.userInviteTtlMs,
      issuedByTag: discordTag,
      discordUserId,
    });
    this.byUser.set(discordUserId, invite.token);
    return invite;
  }

  createAdminInvite(options: AdminInviteOptions): Invite {
    return this.insert({ ...options, discordUserId: undefined });
  }

  private insert(options: AdminInviteOptions & { discordUserId: string | undefined }): Invite {
    const invite: Invite = {
      token: newToken(),
      expiresAt: this.now() + options.ttlMs,
      totalUses: options.uses,
      remainingUses: options.uses,
      discordUserId: options.discordUserId,
      issuedByTag: options.issuedByTag,
      pendingNonces: new Set(),
    };
    this.invites.set(invite.token, invite);
    return invite;
  }

  get(token: string): Invite | undefined {
    const invite = this.invites.get(token);
    if (!invite || invite.remainingUses <= 0 || invite.expiresAt <= this.now()) return undefined;
    return invite;
  }

  status(token: string): InviteStatus {
    const invite = this.invites.get(token);
    if (!invite) return 'unknown';
    if (invite.remainingUses <= 0) return 'used';
    if (invite.expiresAt <= this.now()) return 'expired';
    return 'live';
  }

  beginAuth(token: string): { invite: Invite; nonce: string } | undefined {
    const invite = this.get(token);
    if (!invite) return undefined;
    if (invite.pendingNonces.size >= MAX_PENDING_NONCES) {
      // Someone is spamming the link; drop the oldest in-flight login.
      const oldest = invite.pendingNonces.values().next().value;
      if (oldest !== undefined) invite.pendingNonces.delete(oldest);
    }
    const nonce = randomBytes(16).toString('base64url');
    invite.pendingNonces.add(nonce);
    return { invite, nonce };
  }

  consume(token: string, nonce: string): Invite | undefined {
    // No `await` between the checks and the mutations below: this is atomic
    // with respect to other requests on the single-threaded event loop.
    const invite = this.get(token);
    if (!invite || !invite.pendingNonces.delete(nonce)) return undefined;
    invite.remainingUses -= 1;
    return invite;
  }

  reopen(token: string): void {
    const invite = this.invites.get(token);
    if (invite && invite.expiresAt > this.now() && invite.remainingUses < invite.totalUses) {
      invite.remainingUses += 1;
    }
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, invite] of this.invites) {
      // Spent tokens are kept until expiry so a re-clicked link says
      // "already used" rather than "unknown"; drop everything at expiry.
      if (invite.expiresAt <= now) {
        this.invites.delete(token);
        if (invite.discordUserId && this.byUser.get(invite.discordUserId) === token) {
          this.byUser.delete(invite.discordUserId);
        }
      }
    }
  }
}
