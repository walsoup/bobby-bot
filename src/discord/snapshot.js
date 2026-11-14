import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { getGuild, getDiscordClient } from './client.js';
import { bitfieldToNames, bitfieldToKeyNames } from './permissions.js';

/**
 * Maps Discord ChannelType enum values to human-readable short strings.
 */
export function channelTypeToString(type) {
  switch (type) {
    case ChannelType.GuildText:
      return 'text';
    case ChannelType.GuildVoice:
      return 'voice';
    case ChannelType.GuildAnnouncement:
      return 'announcement';
    case ChannelType.GuildForum:
      return 'forum';
    case ChannelType.GuildStageVoice:
      return 'stage';
    case ChannelType.GuildCategory:
      return 'category';
    default:
      return 'other';
  }
}

/**
 * Maps short string type to Discord ChannelType enum value.
 */
export function stringToChannelType(str) {
  switch (str) {
    case 'text':
      return ChannelType.GuildText;
    case 'voice':
      return ChannelType.GuildVoice;
    case 'announcement':
      return ChannelType.GuildAnnouncement;
    case 'forum':
      return ChannelType.GuildForum;
    case 'stage':
      return ChannelType.GuildStageVoice;
    case 'category':
      return ChannelType.GuildCategory;
    default:
      throw new Error(`Unsupported channel type "${str}". Allowed: text, voice, announcement, forum, stage, category`);
  }
}

/**
 * Serialize permission overwrites into a compact array of non-empty overwrites.
 */
function serializeOverwrites(permissionOverwrites) {
  const result = [];
  if (!permissionOverwrites || !permissionOverwrites.cache) return result;

  for (const overwrite of permissionOverwrites.cache.values()) {
    const allow = bitfieldToNames(overwrite.allow);
    const deny = bitfieldToNames(overwrite.deny);

    if (allow.length === 0 && deny.length === 0) continue;

    const targetType = overwrite.type === OverwriteType.Role || overwrite.type === 0 ? 'role' : 'member';
    result.push({
      targetId: String(overwrite.id),
      type: targetType,
      allow,
      deny
    });
  }

  return result;
}

/**
 * Check if a channel or category is private (ViewChannel denied for @everyone).
 */
function isPrivateChannel(channel, guildId) {
  if (!channel.permissionOverwrites || !channel.permissionOverwrites.cache) return false;
  const everyoneOverwrite = channel.permissionOverwrites.cache.get(guildId);
  if (!everyoneOverwrite) return false;
  const deniedNames = bitfieldToNames(everyoneOverwrite.deny);
  return deniedNames.includes('ViewChannel');
}

function canCallerViewChannel(channel, viewerMember, guild) {
  if (!viewerMember) return true;
  if (guild.ownerId === viewerMember.id) return true;
  if (viewerMember.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!channel?.permissionsFor) return true;
  const perms = channel.permissionsFor(viewerMember);
  return Boolean(perms && perms.has(PermissionFlagsBits.ViewChannel));
}

/**
 * Generate a token-efficient compact snapshot of the guild state.
 * Accepts optional targetGuildId and viewerMember (filters out private channels the caller cannot view).
 */
export async function getSnapshot(targetGuildId = null, viewerMember = null) {
  const guild = await getGuild(targetGuildId);
  const client = getDiscordClient();

  const [rolesCache, channelsCache, botMember, emojisCache, stickersCache, automodCache, soundCache] = await Promise.all([
    guild.roles.fetch().catch(() => null),
    guild.channels.fetch().catch(() => null),
    client?.user ? guild.members.fetch(client.user.id).catch(() => null) : null,
    guild.emojis.fetch().catch(() => null),
    guild.stickers.fetch().catch(() => null),
    guild.autoModerationRules?.fetch().catch(() => null),
    guild.soundboardSounds?.fetch().catch(() => null)
  ]);

  const botHighestRolePosition = botMember && botMember.roles.highest ? botMember.roles.highest.position : 0;

  const allRoles = rolesCache ? Array.from(rolesCache.values()) : [];
  const allChannels = channelsCache ? Array.from(channelsCache.values()) : [];

  const nonThreadChannels = allChannels.filter(
    (c) =>
      c &&
      c.type !== ChannelType.PublicThread &&
      c.type !== ChannelType.PrivateThread &&
      c.type !== ChannelType.AnnouncementThread &&
      canCallerViewChannel(c, viewerMember, guild)
  );

  const roles = allRoles
    .map((r) => ({
      id: String(r.id),
      name: r.name,
      position: r.position,
      color: r.hexColor,
      hoist: r.hoist,
      keyPerms: bitfieldToKeyNames(r.permissions)
    }))
    .sort((a, b) => b.position - a.position);

  const categoriesList = nonThreadChannels.filter((c) => c.type === ChannelType.GuildCategory);
  const regularChannels = nonThreadChannels.filter((c) => c.type !== ChannelType.GuildCategory);

  const categories = categoriesList
    .map((cat) => {
      const catChannels = regularChannels
        .filter((c) => c.parentId === cat.id)
        .map((c) => ({
          id: String(c.id),
          name: c.name,
          type: channelTypeToString(c.type),
          position: c.position,
          topic: c.topic || null,
          private: isPrivateChannel(c, guild.id),
          overwrites: serializeOverwrites(c.permissionOverwrites)
        }))
        .sort((a, b) => a.position - b.position);

      return {
        id: String(cat.id),
        name: cat.name,
        position: cat.position,
        private: isPrivateChannel(cat, guild.id),
        channels: catChannels
      };
    })
    .sort((a, b) => a.position - b.position);

  const uncategorized = regularChannels
    .filter((c) => !c.parentId)
    .map((c) => ({
      id: String(c.id),
      name: c.name,
      type: channelTypeToString(c.type),
      position: c.position,
      topic: c.topic || null,
      private: isPrivateChannel(c, guild.id),
      overwrites: serializeOverwrites(c.permissionOverwrites)
    }))
    .sort((a, b) => a.position - b.position);

  const customEmojis = emojisCache
    ? Array.from(emojisCache.values()).map((e) => ({
        id: String(e.id),
        name: e.name,
        tag: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`
      }))
    : [];

  return {
    guild: {
      id: String(guild.id),
      name: guild.name,
      description: guild.description || null,
      memberCount: guild.memberCount,
      community: guild.features.includes('COMMUNITY'),
      iconURL: guild.iconURL?.() || null,
      bannerURL: guild.bannerURL?.() || null,
      splashURL: guild.splashURL?.() || null,
      vanityURLCode: guild.vanityURLCode || null,
      afkChannelId: guild.afkChannelId ? String(guild.afkChannelId) : null,
      systemChannelId: guild.systemChannelId ? String(guild.systemChannelId) : null,
      rulesChannelId: guild.rulesChannelId ? String(guild.rulesChannelId) : null,
      verificationLevel: guild.verificationLevel,
      premiumTier: guild.premiumTier,
      emojisCount: emojisCache?.size ?? 0,
      stickersCount: stickersCache?.size ?? 0,
      soundboardCount: soundCache?.size ?? 0,
      automodRulesCount: automodCache?.size ?? 0
    },
    roles,
    customEmojis,
    botHighestRolePosition,
    categories,
    uncategorized
  };
}
