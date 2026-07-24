// Durable whitelist persistence, mirroring control-api/api.mjs.
//
// Why: this repo runs the server via itzg/minecraft-server with
// EXISTING_WHITELIST_FILE=SYNCHRONIZE — on every container start the
// whitelist.json is regenerated from the profile's WHITELIST= line in
// s3://<bucket>/profiles/<active>/profile.env. That file is the source of
// truth (it's what the control panel's Players tab edits). An RCON-only
// `whitelist add` would silently vanish on the next server start, so when
// HAMARO_BUCKET is configured we append the name to that line first, exactly
// the way control-api's postPlayerRole does, then apply live over RCON.
//
// Credentials come from the default AWS chain (on the game host: the instance
// role, which already has read/write on the data bucket and ssm:GetParameter
// on /hamaro/*).

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Persistence side of whitelisting: make the entry survive server restarts. */
export interface ProfileStore {
  /** Adds the name to the durable whitelist; true if newly added, false if already there. */
  addWhitelistEntry(playerName: string): Promise<boolean>;
}

export interface S3ProfileStoreOptions {
  bucket: string;
  region: string;
  /** Fixed profile name; if unset, resolved from the SSM parameter each time. */
  activeProfile: string | undefined;
  /** SSM parameter naming the active profile (default /hamaro/active-profile). */
  activeProfileParam: string;
}

// Same on-disk format helpers as control-api/api.mjs (comma-separated list line).
function envGetList(env: string, key: string): string[] {
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m?.[1] ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function envSetList(env: string, key: string, list: string[]): string {
  const line = `${key}=${list.join(',')}`;
  return new RegExp(`^${key}=`, 'm').test(env)
    ? // replacer function (not a string) so `$` in names is never a replacement pattern
      env.replace(new RegExp(`^${key}=.*$`, 'm'), () => line)
    : `${env.trimEnd()}\n${line}\n`;
}

export class S3ProfileStore implements ProfileStore {
  private readonly s3: S3Client;
  private readonly ssm: SSMClient;
  /** Serializes read-modify-write cycles within this process (no S3 CAS available). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: S3ProfileStoreOptions) {
    this.s3 = new S3Client({ region: options.region });
    this.ssm = new SSMClient({ region: options.region });
  }

  private async activeProfile(): Promise<string> {
    if (this.options.activeProfile) return this.options.activeProfile;
    const out = await this.ssm.send(new GetParameterCommand({ Name: this.options.activeProfileParam }));
    const name = out.Parameter?.Value;
    if (!name) throw new Error(`SSM parameter ${this.options.activeProfileParam} is empty`);
    return name;
  }

  addWhitelistEntry(playerName: string): Promise<boolean> {
    // Two callbacks completing at once (e.g. a shared multi-use link) would
    // otherwise both read the same env and last-write-wins one name away.
    // (Concurrent edits from the control panel are a separate, rarer race.)
    const task = this.queue.then(() => this.doAdd(playerName));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async doAdd(playerName: string): Promise<boolean> {
    const profile = await this.activeProfile();
    const key = `profiles/${profile}/profile.env`;
    const current = await this.s3.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    const env = (await current.Body?.transformToString()) ?? '';

    const list = envGetList(env, 'WHITELIST');
    if (list.some((n) => n.toLowerCase() === playerName.toLowerCase())) return false;
    list.push(playerName);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: envSetList(env, 'WHITELIST', list),
        ContentType: 'text/plain',
      }),
    );
    return true;
  }
}
