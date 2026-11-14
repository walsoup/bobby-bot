import { Events, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { runDiscordAgent } from '../agent/loop.js';
import { isStaffMember } from '../agent/tools.js';
import { handlePrefixCommand } from './commands.js';
import { log } from '../util/log.js';
import { getGuildConfig, getGuildAutoChatChannel } from '../util/storage.js';
import { triageModmail } from '../agent/aiServices.js';

// Anti-spam in-memory tracker: userId -> [timestamp1, ...]
const userMessageMap = new Map();
const SPAM_WINDOW_MS = 3000;
const SPAM_MAX_MESSAGES = 10;

// Per-channel execution lock so concurrent triggers serialize cleanly
const channelLocks = new Map();

function pruneInMemoryMaps() {
  const now = Date.now();
  if (userMessageMap.size > 200) {
    for (const [uid, timestamps] of userMessageMap.entries()) {
      const recent = timestamps.filter((t) => now - t < SPAM_WINDOW_MS);
      if (recent.length === 0) userMessageMap.delete(uid);
      else userMessageMap.set(uid, recent);
    }
  }
}

/**
 * Checks if a member is immune to heuristic auto-moderation.
 */
export function isImmune(member, guild) {
  if (!member) return false;
  if (process.env.OWNER_DISCORD_ID && member.id === process.env.OWNER_DISCORD_ID.trim()) {
    return true;
  }
  if (guild && guild.ownerId === member.id) {
    return true;
  }
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    return true;
  }
  return false;
}

/**
 * Fast Heuristic Auto-Moderator: runs in 0ms without LLM.
 * Returns true if the message was handled/deleted.
 */
async function handleAutoModeration(message) {
  const { member, guild, author } = message;
  if (!guild || !member || author.bot) return false;
  if (isImmune(member, guild)) return false;

  pruneInMemoryMaps();

  const botMember = guild.members.me;
  const canDelete = botMember?.permissions.has(PermissionFlagsBits.ManageMessages);
  const canTimeout = botMember?.permissions.has(PermissionFlagsBits.ModerateMembers);

  // 1. Anti-Mass-Mentions (>= 5 users/roles or @everyone/@here)
  const totalMentions = message.mentions.users.size + message.mentions.roles.size;
  if (totalMentions >= 5 || message.mentions.everyone) {
    try {
      if (canDelete) await message.delete().catch(() => null);
      if (canTimeout && member.moderatable) {
        await member.timeout(5 * 60 * 1000, 'Auto-Mod: Mass mentions detected').catch(() => null);
      }
      await message.channel.send({
        content: `🛡️ ${author}, mass mentions are not allowed. (Timed out for 5 minutes)`,
        allowedMentions: { parse: [], users: [author.id] }
      }).catch(() => null);
      log.warn('automod', `mass-mentions ${author.username} (${author.id}) in #${message.channel.name}`);
      return true;
    } catch (_) {}
  }

  // 2. Anti-Spam Flood (10 messages in 3 seconds)
  const now = Date.now();
  const timestamps = userMessageMap.get(author.id) || [];
  const recent = timestamps.filter((t) => now - t < SPAM_WINDOW_MS);
  recent.push(now);
  userMessageMap.set(author.id, recent);

  if (recent.length >= SPAM_MAX_MESSAGES) {
    userMessageMap.delete(author.id);
    try {
      if (canDelete) await message.delete().catch(() => null);
      if (canTimeout && member.moderatable) {
        await member.timeout(60 * 1000, 'Auto-Mod: Rapid message spam').catch(() => null);
      }
      await message.channel.send({
        content: `⚠️ ${author}, slow down vro! Timed out for 1 minute for spamming.`,
        allowedMentions: { parse: [], users: [author.id] }
      }).catch(() => null);
      log.warn('automod', `spam-flood ${author.username} (${author.id}) in #${message.channel.name}`);
      return true;
    } catch (_) {}
  }

  return false;
}

/**
 * Fetch 25 recent messages before the trigger message for default conversational context.
 */
const DEFAULT_RECENT_MESSAGES = 25;

async function fetchDefaultRecentContext(message, includeIds) {
  const lines = [];
  try {
    const fetched = await message.channel.messages.fetch({ limit: DEFAULT_RECENT_MESSAGES, before: message.id });
    const ordered = Array.from(fetched.values()).reverse();

    // If user replied to a specific message not in the last 25, include it at top
    if (message.reference?.messageId && !fetched.has(message.reference.messageId)) {
      const refMsg = await message.fetchReference().catch(() => null);
      if (refMsg) ordered.unshift(refMsg);
    }

    for (const m of ordered) {
      let text = (m.content || '').trim();
      if (!text) {
        if (m.attachments.size > 0) text = `[Attachment: ${m.attachments.map((a) => a.name || 'file').join(', ')}]`;
        else if (m.embeds.length > 0) text = `[Embed: ${m.embeds[0].title || 'embed'}]`;
        else if (m.stickers?.size > 0) text = `[Sticker: ${m.stickers.map((s) => s.name).join(', ')}]`;
        else continue;
      }
      const authorLabel = includeIds
        ? `[msg:${m.id}] ${m.member?.displayName || m.author.username} (${m.author.username}, id:${m.author.id})`
        : `[msg:${m.id}] ${m.member?.displayName || m.author.username}`;
      lines.push(`${authorLabel}: ${text.slice(0, 350)}`);
    }
  } catch (_) {}
  return lines;
}

function splitForDiscord(text, maxLen = 1950) {
  const clean = (text || '').trim();
  if (!clean) return ['...'];
  if (clean.length <= maxLen) return [clean];

  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = remaining.lastIndexOf(' ', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function withChannelLock(channelId, fn) {
  const prev = channelLocks.get(channelId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (channelLocks.get(channelId) === next) {
      channelLocks.delete(channelId);
    }
  });
  channelLocks.set(channelId, next);
  return next;
}

// Burst debounce tracker: `${channel.id}:${author.id}` -> { fragments: [], lastMessage, client, timer, startTime }
export const burstMap = new Map();
const BURST_DEBOUNCE_MS = 1800;
const BURST_MAX_WAIT_MS = 4500;

export function clearBurstQueue() {
  for (const item of burstMap.values()) {
    if (item.timer) clearTimeout(item.timer);
  }
  burstMap.clear();
}

/**
 * Buffer rapid burst messages from the same user in the same channel,
 * combining fragmented lines into a single coherent thought before sending to the agent.
 */
export function queueBotInteraction(message, client, overrideContent = null) {
  const { author, channel, member } = message;
  if (!member) return;

  const botIdRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
  const cleanContent = overrideContent !== null
    ? overrideContent.trim()
    : message.content.replace(botIdRegex, '').trim();

  // If empty tag, reply directly without debounce
  if (!cleanContent) {
    handleBotInteraction(message, client, '');
    return;
  }

  const key = `${channel.id}:${author.id}`;

  // Start typing right away so user sees Bobby is listening and actively waiting
  channel.sendTyping?.().catch(() => null);

  if (burstMap.has(key)) {
    const existing = burstMap.get(key);
    existing.fragments.push(cleanContent);
    existing.lastMessage = message;

    if (existing.timer) clearTimeout(existing.timer);

    const elapsed = Date.now() - existing.startTime;
    const remainingTime = Math.max(200, Math.min(BURST_DEBOUNCE_MS, BURST_MAX_WAIT_MS - elapsed));

    existing.timer = setTimeout(() => {
      burstMap.delete(key);
      const combined = existing.fragments.join('\n');
      handleBotInteraction(existing.lastMessage, client, combined);
    }, remainingTime);
    return;
  }

  const burstData = {
    fragments: [cleanContent],
    lastMessage: message,
    startTime: Date.now(),
    timer: null
  };

  burstData.timer = setTimeout(() => {
    burstMap.delete(key);
    const combined = burstData.fragments.join('\n');
    handleBotInteraction(burstData.lastMessage, client, combined);
  }, BURST_DEBOUNCE_MS);

  burstMap.set(key, burstData);
}

/**
 * Handle @Bobby mention or direct reply to Bobby.
 */
export async function handleBotInteraction(message, client, overrideContent = null) {
  const { author, channel, guild, member } = message;
  if (!member) return;

  const botIdRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
  const cleanContent = overrideContent !== null
    ? overrideContent.trim()
    : message.content.replace(botIdRegex, '').trim();

  if (!cleanContent) {
    await message.reply({
      content: `Yo ${author.username}, tag me with whatever you need (e.g. \`@Bobby what's up?\`).`,
      allowedMentions: { parse: [], repliedUser: true }
    }).catch(() => null);
    return;
  }

  await withChannelLock(channel.id, async () => {
    await channel.sendTyping().catch(() => null);
    const typingInterval = setInterval(() => {
      channel.sendTyping().catch(() => null);
    }, 7000);

    try {
      const isStaff = isStaffMember(member, guild);
      const startedAt = Date.now();
      log.info(
        'chat',
        `${isStaff ? 'staff' : 'member'} ${member.displayName} (${author.id}) in #${channel.name}: ${cleanContent.slice(0, 200)}`
      );

      const recentLines = await fetchDefaultRecentContext(message, isStaff);
      const callerTag = isStaff
        ? `${member.displayName} (${author.username}, id:${author.id})`
        : `${member.displayName} (${author.username})`;

      const userPrompt = recentLines.length > 0
        ? `Recent ${recentLines.length} messages in #${channel.name}:\n${recentLines.join('\n')}\n\n${callerTag}: ${cleanContent}`
        : `${callerTag}: ${cleanContent}`;

      const replyText = await runDiscordAgent({
        userMessage: userPrompt,
        sessionKey: `${guild.id}:${channel.id}:${isStaff ? `staff:${member.id}` : 'public'}`,
        member,
        guild,
        channel
      });

      const chunks = splitForDiscord(replyText);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply({
            content: chunks[i],
            allowedMentions: { parse: [], repliedUser: true }
          });
        } else {
          await channel.send({
            content: chunks[i],
            allowedMentions: { parse: [] }
          });
        }
      }
      log.info('chat', `replied to ${author.username} in #${channel.name} (${Date.now() - startedAt}ms, ${chunks.length} msg)`);
    } catch (err) {
      log.error('chat', `interaction failed for ${author.username} in #${channel.name}: ${err.message || err}`);
      await message.reply({
        content: `Hit a snag vro: ${err.message?.slice(0, 200) || 'unknown error'}`,
        allowedMentions: { parse: [], repliedUser: true }
      }).catch(() => null);
    } finally {
      clearInterval(typingInterval);
    }
  });
}

async function isTriggeredByMessage(message, client) {
  if (!client.user || message.mentions.everyone) return false;
  if (message.mentions.has(client.user)) return true;

  if (message.reference?.messageId) {
    const refMsg = await message.fetchReference().catch(() => null);
    if (refMsg && refMsg.author?.id === client.user.id) {
      return true;
    }
  }
  return false;
}

/**
 * Handle incoming user Direct Messages (DMs) for Modmail.
 */
async function handleDirectMessageModmail(message, client) {
  const author = message.author;
  if (!author || author.bot) return;

  const mutualGuilds = [];
  for (const [, guild] of client.guilds.cache) {
    const cfg = getGuildConfig(guild.id);
    if (cfg?.modmail?.enabled && cfg?.modmail?.channelId) {
      const isMember = await guild.members.fetch(author.id).catch(() => null);
      if (isMember) {
        mutualGuilds.push({ guild, channelId: cfg.modmail.channelId });
      }
    }
  }

  if (mutualGuilds.length === 0) {
    await message.reply({
      content: 'I received your DM, but modmail is not enabled on any mutual server.'
    }).catch(() => null);
    return;
  }

  const text = message.content || (message.attachments.size > 0 ? `[Attachment: ${message.attachments.first()?.url}]` : '');
  if (!text) return;

  for (const { guild, channelId } of mutualGuilds) {
    try {
      const staffChannel = await guild.channels.fetch(channelId).catch(() => null);
      if (!staffChannel || !staffChannel.isTextBased()) continue;

      const triage = await triageModmail({
        userMessage: text,
        username: author.username,
        userId: author.id,
        guildName: guild.name,
        guildId: guild.id
      });

      const colorMap = {
        Low: '#57F287',
        Medium: '#FEE75C',
        High: '#ED4245',
        Urgent: '#EB459E'
      };

      const embed = new EmbedBuilder()
        .setColor(colorMap[triage.severity] || '#5865F2')
        .setTitle(`Modmail from @${author.username}`)
        .setThumbnail(author.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'User ID', value: author.id, inline: true },
          { name: 'Severity', value: triage.severity, inline: true },
          { name: 'Category', value: triage.category, inline: true },
          { name: 'AI Triage Summary', value: triage.summary, inline: false },
          { name: 'Recommended Action', value: triage.recommendedAction, inline: false },
          { name: 'Message Content', value: text.slice(0, 1024), inline: false }
        )
        .setFooter({ text: `Reply with: !reply ${author.id} <your message>` })
        .setTimestamp();

      await staffChannel.send({ embeds: [embed] });
      await message.reply({
        content: `Your message has been delivered to the **${guild.name}** team. Someone will review it shortly.`
      }).catch(() => null);
    } catch (err) {
      console.error('[Modmail Forwarding Error]', err.message);
    }
  }
}

/**
 * Attach auto-moderation and @Bobby listeners to the Discord client.
 */
export function setupModeratorAndChat(client) {
  if (!client) return;

  client.on(Events.MessageCreate, async (message) => {
    if (!message || message.author?.bot) return;

    // Handle Direct Messages for Modmail
    if (!message.guild) {
      await handleDirectMessageModmail(message, client);
      return;
    }

    const handled = await handleAutoModeration(message, client);
    if (handled) return;

    const cmdResult = await handlePrefixCommand(message, client).catch((err) => {
      console.error('[Command Error]', err.message);
      return false;
    });

    if (cmdResult === true) return;

    if (cmdResult === 'ROUTE_TO_AGENT') {
      const withoutCmd = message.content.replace(/^[!?](ask|bobby)\s*/i, '').trim();
      await handleBotInteraction(message, client, withoutCmd);
      return;
    }

    if (await isTriggeredByMessage(message, client)) {
      await handleBotInteraction(message, client);
      return;
    }

    // Auto-Response Channel (responds to every message in the dedicated AI chat channel)
    // Uses queueBotInteraction so rapid burst messages are cleanly debounced and synthesized
    const autoChatChannelId = getGuildAutoChatChannel(message.guild.id);
    if (autoChatChannelId && autoChatChannelId === message.channel.id) {
      queueBotInteraction(message, client);
    }
  });

  log.info('boot', 'Auto-moderation, commands, and @Bobby chat listeners attached.');
}
