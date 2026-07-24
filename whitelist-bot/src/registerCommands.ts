// Standalone script: `npm run register-commands` registers the /whitelist and
// /invite slash commands without starting the bot. (The bot also does this on
// startup.)

import 'dotenv/config';
import { loadConfigOrExit } from './config.js';
import { registerCommands } from './discordBot.js';

const config = loadConfigOrExit();
try {
  const scope = await registerCommands({
    token: config.discordToken,
    clientId: config.discordClientId,
    guildId: config.discordGuildId,
  });
  console.log(`Registered slash commands (${scope}).`);
} catch (err) {
  console.error('Failed to register commands:', err instanceof Error ? err.message : err);
  process.exit(1);
}
