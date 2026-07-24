// Whitelisting orchestration: durable persistence (S3 profile.env, optional)
// + live application over RCON. See profileStore.ts for why persistence
// matters with this repo's itzg SYNCHRONIZE setup.

import type { ProfileStore } from './profileStore.js';
import type { RconCommandRunner } from './rcon.js';

/** Minecraft usernames: [A-Za-z0-9_], up to 16 chars (same rule as control-api). */
export function isValidPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name);
}

export interface WhitelistOutcome {
  /** Saved to the durable whitelist (survives restarts). undefined = no store configured. */
  persisted: 'saved' | 'already-listed' | undefined;
  /** Applied to the running server over RCON right now? */
  live: 'applied' | 'unreachable';
  liveReply?: string;
}

export interface Whitelister {
  add(playerName: string): Promise<WhitelistOutcome>;
}

export class HamaroWhitelister implements Whitelister {
  constructor(
    private readonly rcon: RconCommandRunner,
    private readonly profileStore: ProfileStore | undefined,
  ) {}

  async add(playerName: string): Promise<WhitelistOutcome> {
    if (!isValidPlayerName(playerName)) {
      throw new Error(`Refusing to whitelist an invalid player name: ${JSON.stringify(playerName)}`);
    }

    // 1) Durable write first. If a profile store is configured this MUST
    //    succeed — it's the copy that survives a server restart.
    let persisted: WhitelistOutcome['persisted'];
    if (this.profileStore) {
      persisted = (await this.profileStore.addWhitelistEntry(playerName)) ? 'saved' : 'already-listed';
    }

    // 2) Live apply. With a durable copy saved, an unreachable server (e.g.
    //    the game host is asleep) is not fatal — it applies on next boot.
    try {
      const reply = await this.rcon.run(`whitelist add ${playerName}`);
      return { persisted, live: 'applied', liveReply: reply };
    } catch (err) {
      if (persisted === undefined) throw err; // RCON was our only mechanism
      const message = err instanceof Error ? err.message : String(err);
      return { persisted, live: 'unreachable', liveReply: message };
    }
  }
}

/** Dry-run: never touches RCON or S3. */
export class DryRunWhitelister implements Whitelister {
  async add(playerName: string): Promise<WhitelistOutcome> {
    return { persisted: undefined, live: 'applied', liveReply: `[dry-run] would run: whitelist add ${playerName}` };
  }
}
