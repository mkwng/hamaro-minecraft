// Discord side: two slash commands.
//   /whitelist — anyone in the server: get a personal one-time link (ephemeral).
//   /invite    — admins: mint a multi-use link to hand to people who are not
//                in the Discord server. Gated by Manage Server or ADMIN_ROLE_ID.

import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMemberRoleManager,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { Config } from './config.js';
import type { InviteStore } from './inviteStore.js';

export const WHITELIST_COMMAND = 'whitelist';
export const INVITE_COMMAND = 'invite';

const INVITE_DEFAULT_USES = 1;
const INVITE_DEFAULT_HOURS = 24;
const INVITE_MAX_USES = 100;
const INVITE_MAX_HOURS = 24 * 30;

export function buildCommands(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName(WHITELIST_COMMAND)
      .setDescription('Get a personal one-time link to whitelist yourself on the Minecraft server')
      .toJSON(),
    new SlashCommandBuilder()
      .setName(INVITE_COMMAND)
      .setDescription('Admin: create a whitelist invite link to give to someone outside Discord')
      // Hidden from members without Manage Server; also re-checked at runtime.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addIntegerOption((option) =>
        option
          .setName('count')
          .setDescription(`How many players can use this link (default ${INVITE_DEFAULT_USES})`)
          .setMinValue(1)
          .setMaxValue(INVITE_MAX_USES),
      )
      .addIntegerOption((option) =>
        option
          .setName('expires-in')
          .setDescription(`Hours until the link stops working (default ${INVITE_DEFAULT_HOURS})`)
          .setMinValue(1)
          .setMaxValue(INVITE_MAX_HOURS),
      )
      .toJSON(),
  ];
}

export interface RegisterCommandsOptions {
  token: string;
  clientId: string;
  guildId?: string | undefined;
}

/**
 * Registers the slash commands. If guildId is set they are registered as guild
 * commands (available instantly); otherwise as global commands (can take up to
 * an hour to appear).
 */
export async function registerCommands(options: RegisterCommandsOptions): Promise<'guild' | 'global'> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  const body = buildCommands();
  if (options.guildId) {
    await rest.put(Routes.applicationGuildCommands(options.clientId, options.guildId), { body });
    return 'guild';
  }
  await rest.put(Routes.applicationCommands(options.clientId), { body });
  return 'global';
}

export interface DiscordBotOptions {
  config: Pick<Config, 'publicBaseUrl' | 'inviteTtlMinutes' | 'adminRoleId'>;
  store: InviteStore;
}

/** Builds the invite URL for a token. */
export function inviteUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/invite/${token}`;
}

export function createDiscordClient(options: DiscordBotOptions): Client {
  // Guilds is enough for slash commands; no privileged intents required.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (ready) => {
    console.log(`[discord] logged in as ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void handleInteraction(interaction, options).catch((err: unknown) => {
      console.error('[discord] interaction handler failed:', err);
    });
  });

  return client;
}

async function handleInteraction(interaction: Interaction, options: DiscordBotOptions): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === WHITELIST_COMMAND) await handleWhitelist(interaction, options);
  else if (interaction.commandName === INVITE_COMMAND) await handleInvite(interaction, options);
}

async function handleWhitelist(
  interaction: ChatInputCommandInteraction,
  options: DiscordBotOptions,
): Promise<void> {
  const invite = options.store.createUserInvite(interaction.user.id, interaction.user.tag);
  const url = inviteUrl(options.config.publicBaseUrl, invite.token);
  console.log(`[discord] /whitelist: issued invite for ${interaction.user.tag} (${interaction.user.id})`);

  await interaction.reply({
    content:
      `Here's your personal whitelist link (only you can see this):\n${url}\n\n` +
      `It expires in ${options.config.inviteTtlMinutes} minutes and works once. ` +
      `Sign in with the Microsoft account that owns Minecraft: Java Edition and ` +
      `your in-game name will be whitelisted automatically.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** Manage Server permission OR the configured ADMIN_ROLE_ID role. */
function isInviteAdmin(interaction: ChatInputCommandInteraction, adminRoleId: string | undefined): boolean {
  if (!interaction.inGuild()) return false; // roles/permissions are guild concepts
  if (interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (!adminRoleId) return false;
  const roles = interaction.member.roles;
  return roles instanceof GuildMemberRoleManager ? roles.cache.has(adminRoleId) : roles.includes(adminRoleId);
}

async function handleInvite(
  interaction: ChatInputCommandInteraction,
  options: DiscordBotOptions,
): Promise<void> {
  if (!isInviteAdmin(interaction, options.config.adminRoleId)) {
    await interaction.reply({
      content: 'You need the Manage Server permission (or the configured admin role) to use `/invite`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const uses = interaction.options.getInteger('count') ?? INVITE_DEFAULT_USES;
  const hours = interaction.options.getInteger('expires-in') ?? INVITE_DEFAULT_HOURS;
  const invite = options.store.createAdminInvite({
    uses,
    ttlMs: hours * 60 * 60 * 1000,
    issuedByTag: interaction.user.tag,
  });
  const url = inviteUrl(options.config.publicBaseUrl, invite.token);
  console.log(
    `[discord] /invite: ${interaction.user.tag} minted a ${uses}-use, ${hours}h invite (${invite.token.slice(0, 6)}…)`,
  );

  await interaction.reply({
    content:
      `Whitelist invite link (${uses === 1 ? '1 use' : `${uses} uses`}, expires in ${hours}h):\n${url}\n\n` +
      `Anyone with this link can whitelist their own Minecraft: Java account — ` +
      `share it privately with the person you're inviting.`,
    flags: MessageFlags.Ephemeral,
  });
}
