import { setCachedBotOwnerId } from '../agent/tools.js';
import { ActivityType, Client, GatewayIntentBits, ChannelType, Events, Partials, Options, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setupModeratorAndChat } from './moderator.js';
import {
  getGuildConfig,
  getAllPendingReminders,
  removeGuildReminder,
  getStarboardEntry,
  setStarboardEntry,
  getAllPendingGiveaways,
  endGuildGiveaway,
  getGuildChatter,
  setGuildChatter,
  removeGuildChatterTrigger,
  getAllActiveChatters
} from '../util/storage.js';
import { generateChatterMessage } from '../agent/aiServices.js';

export const guildScope = new AsyncLocalStorage();

let clientInstance = null;
let clientReadyPromise = null;

const PRIVILEGED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers
];

const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildEmojisAndStickers,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildScheduledEvents,
  GatewayIntentBits.AutoModerationConfiguration
];

const CLIENT_PARTIALS = [
  Partials.Channel,
  Partials.Message,
  Partials.User,
  Partials.GuildMember,
  Partials.Reaction
];

export function isDiscordConfigured() {
  const token = process.env.DISCORD_BOT_TOKEN;
  return Boolean(token && token.trim());
}

export function isDiscordReady() {
  return Boolean(clientInstance && clientInstance.isReady());
}

function attachEventHandlers(client) {
  client.on(Events.Error, (err) => {
    console.error('⚠️ [Discord Gateway] Client error:', err.message || err);
  });
  client.on(Events.ShardError, (err, shardId) => {
    console.error(`⚠️ [Discord Gateway] Shard ${shardId} error:`, err.message || err);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`⚠️ [Discord Gateway] Shard ${shardId} disconnected:`, event?.reason || event);
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`🔄 [Discord Gateway] Shard ${shardId} reconnecting...`);
  });

  // Handle new member join: Auto-role & Welcome messages
  client.on(Events.GuildMemberAdd, async (member) => {
    if (!member || member.user?.bot || !member.guild) return;
    const cfg = getGuildConfig(member.guild.id);

    // 1. Auto-Role
    if (cfg?.autorole?.enabled && cfg?.autorole?.roleId) {
      try {
        const role = await member.guild.roles.fetch(cfg.autorole.roleId).catch(() => null);
        if (role && member.guild.members.me?.roles.highest.position > role.position) {
          await member.roles.add(role, 'Bobby Auto-Role on join');
        }
      } catch (err) {
        console.error(`[AutoRole] Failed:`, err.message);
      }
    }

    // 2. Welcome Message
    if (cfg?.welcome?.enabled && cfg?.welcome?.channelId) {
      try {
        const channel = await member.guild.channels.fetch(cfg.welcome.channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const template = cfg.welcome.message || 'Welcome {user} to {server}! 🎉 You are member #{count}.';
          const rendered = template
            .replace(/{user}/g, `<@${member.id}>`)
            .replace(/{username}/g, member.user.username)
            .replace(/{server}/g, member.guild.name)
            .replace(/{count}/g, String(member.guild.memberCount));

          await channel.send({
            content: rendered,
            allowedMentions: { users: [member.id] }
          });
        }
      } catch (err) {
        console.error(`[Welcome] Failed:`, err.message);
      }
    }
  });

  // Handle reaction role add
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!reaction || user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
      const guild = reaction.message.guild;
      if (!guild) return;

      const cfg = getGuildConfig(guild.id);
      const msgEntry = cfg?.reaction_roles?.[reaction.message.id];
      if (!msgEntry || !msgEntry.mappings) return;

      const emojiKey = reaction.emoji.id || reaction.emoji.name;
      const roleId = msgEntry.mappings[emojiKey] || msgEntry.mappings[reaction.emoji.name] || msgEntry.mappings[`<:${reaction.emoji.name}:${reaction.emoji.id}>`];
      if (!roleId) return;

      const member = await guild.members.fetch(user.id).catch(() => null);
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!member || !role) return;

      const botMe = guild.members.me || (await guild.members.fetch(client.user.id).catch(() => null));
      if (botMe && botMe.roles.highest.position > role.position && !role.permissions.has(PermissionFlagsBits.Administrator)) {
        await member.roles.add(role, 'Bobby Reaction Role self-assign');
      }
    } catch (err) {
      console.error('[ReactionRole Add Error]', err.message);
    }

    await handleStarboardReaction(reaction, user, false).catch(() => null);
  });

  // Handle reaction role remove
  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    if (!reaction || user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch().catch(() => null);
      if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
      const guild = reaction.message.guild;
      if (!guild) return;

      const cfg = getGuildConfig(guild.id);
      const msgEntry = cfg?.reaction_roles?.[reaction.message.id];
      if (!msgEntry || !msgEntry.mappings) {
        await handleStarboardReaction(reaction, user, true).catch(() => null);
        return;
      }

      const emojiKey = reaction.emoji.id || reaction.emoji.name;
      const roleId = msgEntry.mappings[emojiKey] || msgEntry.mappings[reaction.emoji.name] || msgEntry.mappings[`<:${reaction.emoji.name}:${reaction.emoji.id}>`];
      if (!roleId) {
        await handleStarboardReaction(reaction, user, true).catch(() => null);
        return;
      }

      const member = await guild.members.fetch(user.id).catch(() => null);
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!member || !role) {
        await handleStarboardReaction(reaction, user, true).catch(() => null);
        return;
      }

      const botMe = guild.members.me || (await guild.members.fetch(client.user.id).catch(() => null));
      if (botMe && botMe.roles.highest.position > role.position && !role.permissions.has(PermissionFlagsBits.Administrator)) {
        await member.roles.remove(role, 'Bobby Reaction Role remove');
      }
    } catch (err) {
      console.error('[ReactionRole Remove Error]', err.message);
    }

    await handleStarboardReaction(reaction, user, true).catch(() => null);
  });

  // Handle modern select menu & button roles
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.guild) return;
    try {
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bobby_role_select_')) {
        const selectedRoleIds = interaction.values;
        const member = interaction.member;
        if (!member) return;

        const allOptionRoleIds = interaction.component.options.map((opt) => opt.value);
        const botMe = interaction.guild.members.me || (await interaction.guild.members.fetch(client.user.id).catch(() => null));

        for (const rid of allOptionRoleIds) {
          const role = await interaction.guild.roles.fetch(rid).catch(() => null);
          if (!role || role.permissions.has(PermissionFlagsBits.Administrator)) continue;
          if (botMe && botMe.roles.highest.position <= role.position) continue;

          if (selectedRoleIds.includes(rid)) {
            if (!member.roles.cache.has(rid)) {
              await member.roles.add(role, 'Bobby Select Menu Role');
            }
          } else {
            if (member.roles.cache.has(rid)) {
              await member.roles.remove(role, 'Bobby Select Menu Role');
            }
          }
        }

        await interaction.reply({
          content: 'Your roles have been updated.',
          ephemeral: true
        });
      }
    } catch (err) {
      console.error('[Role Interaction Error]', err.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Failed to update roles: ' + err.message, ephemeral: true }).catch(() => null);
      }
    }
  });

  setupModeratorAndChat(client);
}

async function loginClientWithFallback(token) {
  const baseClientOptions = {
    partials: CLIENT_PARTIALS,
    makeCache: Options.cacheWithLimits({
      MessageManager: 35,
      ThreadManager: 10,
      StageInstanceManager: 0
    }),
    sweepers: {
      messages: {
        interval: 300,
        lifetime: 900
      }
    }
  };

  const client = new Client({ ...baseClientOptions, intents: PRIVILEGED_INTENTS });
  attachEventHandlers(client);

  try {
    await new Promise((resolve, reject) => {
      client.once(Events.ClientReady, async (readyClient) => {
        try {
          await readyClient.application?.fetch?.();
          if (readyClient.application?.owner?.id) {
            setCachedBotOwnerId(readyClient.application.owner.id);
          } else if (readyClient.application?.owner?.members) {
            for (const [memberId] of readyClient.application.owner.members) {
              setCachedBotOwnerId(memberId);
            }
          }
        } catch (_) {}
        readyClient.user?.setPresence({
          activities: [{ name: 'the server | @Bobby', type: ActivityType.Watching }],
          status: 'online'
        });
        await performSelfCheck(readyClient, true).catch(() => null);
        startPersistentReminders(readyClient);
        startPersistentGiveaways(readyClient);
        startPersistentChatter(readyClient);
        resolve(readyClient);
      });

      client.login(token.trim()).catch(reject);
    });

    return { client, hasPrivileged: true };
  } catch (err) {
    if (err.code === 'DisallowedIntents' || err.message?.includes('disallowed') || err.message?.includes('intent')) {
      console.warn('\n⚠️ [Discord Gateway] Message Content or Server Members intent is not enabled in Discord Developer Portal.');
      console.warn('⚠️ Falling back to base intents. Enable "Message Content Intent" and "Server Members Intent" in Discord Developer Portal > Bot.\n');

      try {
        client.destroy();
      } catch (_) {}

      const fallbackClient = new Client({ ...baseClientOptions, intents: BASE_INTENTS });
      attachEventHandlers(fallbackClient);

      await new Promise((resolve, reject) => {
        fallbackClient.once(Events.ClientReady, async (readyClient) => {
          readyClient.user?.setPresence({
            activities: [{ name: 'the server | @Bobby', type: ActivityType.Watching }],
            status: 'online'
          });
          await performSelfCheck(readyClient, false).catch(() => null);
          startPersistentReminders(readyClient);
          startPersistentGiveaways(readyClient);
          startPersistentChatter(readyClient);
          resolve(readyClient);
        });

        fallbackClient.login(token.trim()).catch(reject);
      });

      return { client: fallbackClient, hasPrivileged: false };
    }

    try {
      client.destroy();
    } catch (_) {}
    throw err;
  }
}

/**
 * Initialize and return the Discord client promise/instance.
 */
export function startDiscordClient() {
  if (clientReadyPromise) return clientReadyPromise;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !token.trim()) {
    throw new Error('DISCORD_BOT_TOKEN is missing in environment variables.');
  }

  clientReadyPromise = loginClientWithFallback(token)
    .then(({ client }) => {
      clientInstance = client;
      return client;
    })
    .catch((err) => {
      clientReadyPromise = null;
      throw err;
    });

  return clientReadyPromise;
}

export function getDiscordClient() {
  return clientInstance;
}

/**
 * Resume active timers on boot so reminders survive bot restarts.
 */
export function startPersistentReminders(client) {
  try {
    const pending = getAllPendingReminders();
    if (pending.length === 0) return;
    const now = Date.now();
    for (const r of pending) {
      const remainingMs = Math.max(r.dueAt - now, 0);
      setTimeout(async () => {
        try {
          const ch = await client.channels.fetch(r.channelId).catch(() => null);
          if (ch && ch.isTextBased()) {
            await ch.send({
              content: `<@${r.userId}> **Reminder:** ${r.note}`,
              allowedMentions: { users: [r.userId] }
            });
          }
        } catch (err) {
          console.error('[Persistent Reminder Error]', err.message);
        } finally {
          removeGuildReminder(r.guildId, r.id);
        }
      }, remainingMs);
    }
  } catch (err) {
    console.error('[Reminders] Failed to initialize:', err.message);
  }
}

/**
 * Handle Starboard reactions (Carl-bot parity).
 */
export async function handleStarboardReaction(reaction, user, isRemove = false) {
  if (!reaction || reaction.emoji?.name !== '⭐') return;
  const guild = reaction.message?.guild;
  if (!guild) return;

  const cfg = getGuildConfig(guild.id);
  const sb = cfg?.starboard;
  if (!sb?.channelId) return;

  const threshold = sb.threshold || 3;
  const count = reaction.count || 0;

  try {
    const sbChannel = await guild.channels.fetch(sb.channelId).catch(() => null);
    if (!sbChannel || !sbChannel.isTextBased()) return;

    const entry = getStarboardEntry(guild.id, reaction.message.id);

    if (count >= threshold) {
      const msg = reaction.message;
      const author = msg.author;
      const imageAttachment = msg.attachments?.find((a) => a.contentType?.startsWith('image/'))?.url;

      const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setAuthor({ name: author ? author.username : 'User', iconURL: author?.displayAvatarURL?.({ dynamic: true }) })
        .setDescription(msg.content || (imageAttachment ? '[Image Only]' : '...'))
        .addFields({ name: 'Original', value: `[Jump to message](${msg.url})`, inline: false })
        .setFooter({ text: `ID: ${msg.id}` })
        .setTimestamp(msg.createdTimestamp || Date.now());

      if (imageAttachment) {
        embed.setImage(imageAttachment);
      }

      const content = `⭐ **${count}** | <#${msg.channelId}>`;

      if (entry && entry.starboardMessageId) {
        const existingMsg = await sbChannel.messages.fetch(entry.starboardMessageId).catch(() => null);
        if (existingMsg) {
          await existingMsg.edit({ content, embeds: [embed] });
          setStarboardEntry(guild.id, msg.id, { starboardMessageId: existingMsg.id, count });
          return;
        }
      }

      const sent = await sbChannel.send({ content, embeds: [embed] });
      setStarboardEntry(guild.id, msg.id, { starboardMessageId: sent.id, count });
    } else if (isRemove && count < threshold && entry && entry.starboardMessageId) {
      const existingMsg = await sbChannel.messages.fetch(entry.starboardMessageId).catch(() => null);
      if (existingMsg) {
        if (count === 0) {
          await existingMsg.delete().catch(() => null);
          setStarboardEntry(guild.id, reaction.message.id, null);
        } else {
          await existingMsg.edit({ content: `⭐ **${count}** | <#${reaction.message.channelId}>` });
          setStarboardEntry(guild.id, reaction.message.id, { starboardMessageId: existingMsg.id, count });
        }
      }
    }
  } catch (err) {
    console.error('[Starboard Error]', err.message);
  }
}

/**
 * Resolve an active giveaway and announce winner(s).
 */
export async function resolveGiveaway(client, gway) {
  try {
    const guild = await client.guilds.fetch(gway.guildId).catch(() => null);
    if (!guild) return;
    const channel = await guild.channels.fetch(gway.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const msg = await channel.messages.fetch(gway.messageId).catch(() => null);
    if (!msg) return;

    const reaction = msg.reactions?.cache?.get('🎉');
    const users = reaction ? await reaction.users.fetch().catch(() => new Map()) : new Map();
    const eligible = Array.from(users.values()).filter((u) => !u.bot).map((u) => u.id);

    const winnerCount = Math.min(gway.winnersCount || 1, eligible.length);
    const shuffled = [...eligible].sort(() => 0.5 - Math.random());
    const winners = shuffled.slice(0, winnerCount);

    endGuildGiveaway(gway.guildId, gway.messageId, winners);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Giveaway Ended: ${gway.prize}`)
      .setDescription(
        winners.length > 0
          ? `**Winner(s):** ${winners.map((id) => `<@${id}>`).join(', ')}`
          : 'No valid participants reacted with 🎉.'
      )
      .setFooter({ text: 'Giveaway Ended' })
      .setTimestamp();

    await msg.edit({ embeds: [embed] }).catch(() => null);

    if (winners.length > 0) {
      await channel.send({
        content: `Congratulations ${winners.map((id) => `<@${id}>`).join(', ')}! You won the giveaway for **${gway.prize}**!`
      });
    } else {
      await channel.send({
        content: `The giveaway for **${gway.prize}** has ended with no entries.`
      });
    }
  } catch (err) {
    console.error('[Resolve Giveaway Error]', err.message);
  }
}

/**
 * Resume active giveaways on boot so giveaways survive restarts.
 */
export function startPersistentGiveaways(client) {
  try {
    const pending = getAllPendingGiveaways();
    if (pending.length === 0) return;
    const now = Date.now();
    for (const gway of pending) {
      const remainingMs = Math.max(gway.endsAt - now, 0);
      setTimeout(() => {
        resolveGiveaway(client, gway);
      }, remainingMs);
    }
  } catch (err) {
    console.error('[Giveaways] Failed to initialize:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Contextual Random Chatter / Yap Engine
// ---------------------------------------------------------------------------

const activeChatterTimers = new Map(); // guildId -> Timeout[]

/**
 * Parse human time string into { hours, minutes, totalMinutes }
 * Supports: '10am', '11pm', '10:30am', '14:00', '23:30', '9'
 */
export function parseTimeString(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const modifier = m[3]?.toLowerCase();

  if (minutes < 0 || minutes > 59) return null;

  if (modifier === 'pm' && hours < 12) hours += 12;
  if (modifier === 'am' && hours === 12) hours = 0;

  if (hours < 0 || hours > 23) return null;

  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

/**
 * Format total minutes from midnight into 12-hour string (e.g. 600 -> "10:00 AM")
 */
export function formatMinutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  const mStr = m < 10 ? `0${m}` : `${m}`;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${mStr} ${ampm}`;
}

/**
 * Calculate random trigger timestamps strictly within the start & end minutes window.
 */
export function calculateNextTriggers(startMinutes, endMinutes, count, fromDate = new Date()) {
  const triggers = [];
  const now = fromDate;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const canScheduleToday = nowMinutes < (endMinutes - 15);
  const targetDate = new Date(now);

  let windowStart = startMinutes;
  let windowEnd = endMinutes;

  if (canScheduleToday) {
    if (nowMinutes > startMinutes) {
      windowStart = nowMinutes + 5;
    }
  } else {
    targetDate.setDate(targetDate.getDate() + 1);
  }

  const span = windowEnd - windowStart;
  const numToSchedule = Math.max(1, count);
  const slotSize = Math.max(1, Math.floor(span / numToSchedule));

  for (let i = 0; i < numToSchedule; i++) {
    const sStart = windowStart + (i * slotSize);
    const sEnd = Math.min(windowEnd, sStart + slotSize);
    const randMin = Math.floor(sStart + Math.random() * Math.max(1, sEnd - sStart));

    const d = new Date(targetDate);
    d.setHours(Math.floor(randMin / 60), randMin % 60, Math.floor(Math.random() * 60), 0);
    if (d.getTime() > Date.now()) {
      triggers.push(d.getTime());
    }
  }

  if (triggers.length === 0) {
    const tmrw = new Date(now);
    tmrw.setDate(tmrw.getDate() + 1);
    const slot = Math.max(1, Math.floor((endMinutes - startMinutes) / numToSchedule));
    for (let i = 0; i < numToSchedule; i++) {
      const sStart = startMinutes + (i * slot);
      const sEnd = Math.min(endMinutes, sStart + slot);
      const randMin = Math.floor(sStart + Math.random() * Math.max(1, sEnd - sStart));
      const d = new Date(tmrw);
      d.setHours(Math.floor(randMin / 60), randMin % 60, Math.floor(Math.random() * 60), 0);
      triggers.push(d.getTime());
    }
  }

  triggers.sort((a, b) => a - b);
  return triggers;
}

/**
 * Clear any pending timeouts for a guild's chatter scheduler.
 */
export function clearGuildChatterTimers(guildId) {
  if (activeChatterTimers.has(guildId)) {
    for (const t of activeChatterTimers.get(guildId)) {
      clearTimeout(t);
    }
    activeChatterTimers.delete(guildId);
  }
}

/**
 * Execute a single chatter event: fetch recent messages and chime in casually.
 */
export async function executeChatterTrigger(client, guildId, channelId) {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return false;

    const messagesColl = await ch.messages.fetch({ limit: 15 }).catch(() => null);
    const messages = messagesColl ? Array.from(messagesColl.values()).reverse() : [];

    const customEmojis = ch.guild?.emojis?.cache
      ? Array.from(ch.guild.emojis.cache.values()).map((e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)
      : [];

    const text = await generateChatterMessage({
      messages,
      customEmojis,
      guildName: ch.guild?.name || 'chat',
      guildId
    });

    if (text && text.trim()) {
      await ch.send({
        content: text.trim(),
        allowedMentions: { parse: [] }
      });
      return true;
    }
  } catch (err) {
    console.error(`[Chatter] Error in guild ${guildId}:`, err.message);
  }
  return false;
}

/**
 * Schedule/arm live timers for a guild's chatter configuration.
 */
export function scheduleGuildChatter(client, guildId) {
  clearGuildChatterTimers(guildId);

  const chatter = getGuildChatter(guildId);
  if (!chatter || !chatter.enabled || !chatter.channelId) return;

  const now = Date.now();
  let triggers = (chatter.triggers || []).filter((t) => t > now);

  if (triggers.length === 0) {
    triggers = calculateNextTriggers(chatter.startMinutes, chatter.endMinutes, chatter.count || 2);
    setGuildChatter(guildId, { ...chatter, triggers });
  }

  const timers = [];
  for (const triggerTime of triggers) {
    const delay = Math.max(triggerTime - now, 1000);
    const timer = setTimeout(async () => {
      await executeChatterTrigger(client, guildId, chatter.channelId);
      removeGuildChatterTrigger(guildId, triggerTime);
      scheduleGuildChatter(client, guildId);
    }, delay);
    timers.push(timer);
  }

  activeChatterTimers.set(guildId, timers);
}

/**
 * Resume all active chatter configs across guilds on bot boot.
 */
export function startPersistentChatter(client) {
  try {
    const all = getAllActiveChatters();
    for (const item of all) {
      scheduleGuildChatter(client, item.guildId);
    }
  } catch (err) {
    console.error('[Chatter] Failed to initialize persistent chatter:', err.message);
  }
}

/**
 * Perform a self-check on boot and print diagnostic stats.
 */
async function performSelfCheck(readyClient, hasPrivileged = true) {
  console.log('\n================ B.O.B.B.Y. SELF-CHECK ================');
  console.log('🤖 Identity:         Bobby');
  console.log(`🤖 Bot User:         ${readyClient.user.tag} (${readyClient.user.id})`);
  console.log(`🏰 Connected Guilds (${readyClient.guilds.cache.size}):`);
  readyClient.guilds.cache.forEach((g) => {
    console.log(`   - "${g.name}" (${g.id}) | Members: ${g.memberCount} | Owner: ${g.ownerId}`);
  });
  console.log(`💬 Message Content:  ${hasPrivileged ? 'ENABLED' : 'DISABLED'}`);
  console.log('======================================================\n');
}

/**
 * Await client readiness and fetch the target guild.
 */
export async function getGuild(targetGuildId = null) {
  const scopeGuildId = guildScope.getStore();
  const guildId = (targetGuildId || scopeGuildId || process.env.DISCORD_GUILD_ID || '').trim();
  if (!guildId) {
    throw new Error('Target Guild ID is not provided in context.');
  }

  const client = await startDiscordClient();
  const guild = await client.guilds.fetch(guildId).catch((err) => {
    throw new Error(`Failed to fetch guild ID ${guildId}: ${err.message}`);
  });

  if (!guild) {
    throw new Error(`Guild with ID ${guildId} was not found.`);
  }

  return guild;
}
