/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Discord invite link; when set, the landing page shows a "Join our Discord" button. */
  readonly VITE_DISCORD_INVITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
