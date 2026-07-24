// Entrypoint: load config, wire the invite store, Discord bot, web server and
// the whitelist backend together. Set DRY_RUN=true (or --dry-run) to validate
// config and start the HTTP server without logging into Discord, connecting to
// RCON or touching S3.

import 'dotenv/config';
import { loadConfigOrExit } from './config.js';
import { MemoryInviteStore } from './inviteStore.js';
import { createDiscordClient, registerCommands } from './discordBot.js';
import { createApp, MsalMicrosoftAuth } from './webServer.js';
import { RconClient } from './rcon.js';
import { S3ProfileStore } from './profileStore.js';
import { DryRunWhitelister, HamaroWhitelister, type Whitelister } from './whitelist.js';
import { fetchMinecraftProfile } from './minecraftAuth.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();

  if (config.dryRun) console.log('[boot] DRY_RUN enabled: Discord login, RCON and S3 are disabled.');

  const store = new MemoryInviteStore(config.inviteTtlMinutes * 60_000);

  let whitelist: Whitelister;
  if (config.dryRun) {
    whitelist = new DryRunWhitelister();
  } else {
    const profileStore = config.hamaroBucket
      ? new S3ProfileStore({
          bucket: config.hamaroBucket,
          region: config.awsRegion,
          activeProfile: config.hamaroActiveProfile,
          activeProfileParam: config.hamaroActiveProfileParam,
        })
      : undefined;
    if (profileStore) {
      console.log(`[boot] durable whitelist: s3://${config.hamaroBucket}/profiles/<active>/profile.env`);
    } else {
      console.warn(
        '[boot] HAMARO_BUCKET not set: whitelist adds are RCON-only. If the server uses ' +
          'EXISTING_WHITELIST_FILE=SYNCHRONIZE they will be lost on the next server start.',
      );
    }
    whitelist = new HamaroWhitelister(
      new RconClient({ host: config.rconHost, port: config.rconPort, password: config.rconPassword }),
      profileStore,
    );
  }

  const app = createApp({
    config,
    store,
    msAuth: new MsalMicrosoftAuth(config),
    whitelist,
    fetchProfile: fetchMinecraftProfile,
  });

  const server = app.listen(config.port, () => {
    console.log(`[web] listening on :${config.port} (public base ${config.publicBaseUrl})`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[web] cannot listen on :${config.port}: ${err.code ?? err.message}`);
    process.exit(1);
  });

  const discord = createDiscordClient({ config, store });

  if (!config.dryRun) {
    const scope = await registerCommands({
      token: config.discordToken,
      clientId: config.discordClientId,
      guildId: config.discordGuildId,
    });
    console.log(`[discord] registered slash commands (${scope})`);
    await discord.login(config.discordToken);
  }

  const shutdown = (signal: string): void => {
    console.log(`[boot] ${signal} received, shutting down`);
    store.close();
    server.close();
    void discord.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    const extra = 'status' in err ? ` (HTTP ${String((err as { status: unknown }).status)})` : '';
    console.error(`[boot] fatal: ${err.name}: ${err.message}${extra}`);
  } else {
    console.error('[boot] fatal:', err);
  }
  process.exit(1);
});
