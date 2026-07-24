// Admin-minted whitelist invite links: shared by the Discord /invite command
// and the web dashboard's POST /admin/invite so both mint from the one store.

import type { InviteStore } from './inviteStore.js';

export interface MintAdminInviteOptions {
  uses: number;
  ttlMinutes: number;
  /** Who minted it — Discord tag or "web:<admin>" — for logs only. */
  issuedByTag: string;
}

export interface MintedInvite {
  url: string;
  /** ISO 8601 expiry. */
  expiresAt: string;
  uses: number;
}

export function inviteUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/invite/${token}`;
}

export function mintAdminInvite(
  store: InviteStore,
  publicBaseUrl: string,
  options: MintAdminInviteOptions,
): MintedInvite {
  const invite = store.createAdminInvite({
    uses: options.uses,
    ttlMs: options.ttlMinutes * 60 * 1000,
    issuedByTag: options.issuedByTag,
  });
  console.log(
    `[invite] ${options.issuedByTag} minted a ${options.uses}-use, ${options.ttlMinutes}m invite (${invite.token.slice(0, 6)}…)`,
  );
  return {
    url: inviteUrl(publicBaseUrl, invite.token),
    expiresAt: new Date(invite.expiresAt).toISOString(),
    uses: invite.totalUses,
  };
}
