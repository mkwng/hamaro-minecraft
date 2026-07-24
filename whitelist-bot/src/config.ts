// Reads and validates configuration from environment variables at startup.
// Fails fast with a clear message naming the missing/invalid variable.

export interface Config {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | undefined;
  /** Optional role that may run /invite in addition to Manage Server members. */
  adminRoleId: string | undefined;
  /** Optional Discord invite link shown on the success page. */
  discordInviteUrl: string | undefined;
  /**
   * Optional shared secret CloudFront sends as the X-Origin-Verify header.
   * When set, /invite and /auth/* refuse requests that lack it, so the origin
   * can't be reached around the CDN.
   */
  originVerifySecret: string | undefined;
  azureClientId: string;
  azureClientSecret: string;
  oauthRedirectUri: string;
  publicBaseUrl: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  /**
   * Optional durable whitelist persistence (mirrors control-api): the data
   * bucket holding profiles/<active>/profile.env. When set, whitelist adds are
   * saved to the profile's WHITELIST line so they survive server restarts.
   */
  hamaroBucket: string | undefined;
  /** AWS region for S3/SSM (default us-west-2). */
  awsRegion: string;
  /** Fixed profile name; if unset, read from the SSM parameter below. */
  hamaroActiveProfile: string | undefined;
  /** SSM parameter naming the active profile. */
  hamaroActiveProfileParam: string;
  /**
   * Admin session-token signing key (same as control-api's /hamaro/session-key).
   * Set only for dev/dry-run; in prod it is read from the SSM parameter below.
   */
  sessionKey: string | undefined;
  /** SSM SecureString parameter holding the admin session signing key. */
  sessionKeyParam: string;
  mcServerAddress: string;
  port: number;
  inviteTtlMinutes: number;
  dryRun: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. See whitelist-bot/.env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function intWithDefault(name: string, defaultValue: number): number {
  const raw = optional(name);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer (got "${raw}").`);
  }
  return parsed;
}

function boolean(name: string): boolean {
  const raw = optional(name);
  return raw !== undefined && ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** loadConfig() for entrypoints: print a one-line message and exit 1 on bad config. */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export function loadConfig(): Config {
  const oauthRedirectUri = required('OAUTH_REDIRECT_URI');
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(oauthRedirectUri);
  } catch {
    throw new ConfigError(`OAUTH_REDIRECT_URI is not a valid URL: "${oauthRedirectUri}"`);
  }

  // PUBLIC_BASE_URL defaults to the origin of the OAuth redirect URI so the invite
  // links and the callback live on the same host.
  const publicBaseUrl = (optional('PUBLIC_BASE_URL') ?? redirectUrl.origin).replace(/\/+$/, '');

  return {
    discordToken: required('DISCORD_TOKEN'),
    discordClientId: required('DISCORD_CLIENT_ID'),
    discordGuildId: optional('DISCORD_GUILD_ID'),
    adminRoleId: optional('ADMIN_ROLE_ID'),
    discordInviteUrl: optional('DISCORD_INVITE_URL'),
    originVerifySecret: optional('ORIGIN_VERIFY_SECRET'),
    azureClientId: required('AZURE_CLIENT_ID'),
    azureClientSecret: required('AZURE_CLIENT_SECRET'),
    oauthRedirectUri,
    publicBaseUrl,
    rconHost: required('RCON_HOST'),
    rconPort: intWithDefault('RCON_PORT', 25575),
    rconPassword: required('RCON_PASSWORD'),
    hamaroBucket: optional('HAMARO_BUCKET'),
    awsRegion: optional('AWS_REGION') ?? 'us-west-2',
    hamaroActiveProfile: optional('HAMARO_ACTIVE_PROFILE'),
    hamaroActiveProfileParam: optional('HAMARO_ACTIVE_PROFILE_PARAM') ?? '/hamaro/active-profile',
    sessionKey: optional('HAMARO_SESSION_KEY'),
    sessionKeyParam: optional('HAMARO_SESSION_KEY_PARAM') ?? '/hamaro/session-key',
    mcServerAddress: required('MC_SERVER_ADDRESS'),
    port: intWithDefault('PORT', 3000),
    inviteTtlMinutes: intWithDefault('INVITE_TTL_MINUTES', 15),
    dryRun: boolean('DRY_RUN') || process.argv.includes('--dry-run'),
  };
}
