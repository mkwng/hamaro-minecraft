/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Discord invite link; when set, the landing page shows a "Join our Discord" button. */
  readonly VITE_DISCORD_INVITE_URL?: string;
  /** Whitelist-bot origin for /admin/* calls; unset = same origin (production). */
  readonly VITE_WHITELIST_BOT_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
