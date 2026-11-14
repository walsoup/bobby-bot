import { EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import {
  getGuildConfig,
  getGuildMemories,
  setGuildMemory,
  deleteGuildMemory,
  getGuildReactionRoles,
  exportGuildConfig,
  importGuildConfig,
  setGuildAIConfig,
  resetGuildAIConfig,
  setGuildPersona,
  getGuildWarnings,
  addGuildWarning,
  clearGuildWarnings,
  addGuildReminder,
  removeGuildReminder,
  setGuildLockdown,
  getGuildLockdown,
  getGuildModmail,
  setGuildModmail,
  getGuildTags,
  getGuildTag,
  setGuildTag,
  deleteGuildTag,
  incrementTagUses,
  getGuildSuggestions,
  setGuildSuggestionsChannel,
  addGuildSuggestion,
  updateGuildSuggestionStatus,
  getGuildGiveaways,
  addGuildGiveaway,
  endGuildGiveaway,
  getGuildStarboard,
  setGuildStarboard,
  getGuildTickets,
  createGuildTicket,
  closeGuildTicket,
  getGuildChatter,
  setGuildChatter,
  getGuildAutoChatChannel,
  setGuildAutoChatChannel
} from '../util/storage.js';
import { isStaffMember, isOwnerOrAdmin, safeEvaluateMath } from '../agent/tools.js';
import { getAIConfig } from '../agent/config.js';
import { summarizeMessages, translateText } from '../agent/aiServices.js';
import {
  resolveGiveaway,
  parseTimeString,
  formatMinutesToTime,
  calculateNextTriggers,
  scheduleGuildChatter,
  clearGuildChatterTimers,
  executeChatterTrigger
} from './client.js';

/**
 * Handle instant prefix commands (! or ?).
 * Returns:
 * - true: command handled instantly
 * - 'ROUTE_TO_AGENT': command was !ask or !bobby, route to agent loop
 * - false: not a recognized command
 */
export async function handlePrefixCommand(message, client) {
  const content = (message.content || '').trim();
  if (!content.startsWith('!') && !content.startsWith('?')) {
    return false;
  }

  const prefix = content[0];
  const withoutPrefix = content.slice(1).trim();
  if (!withoutPrefix) return false;

  const args = withoutPrefix.split(/\s+/);
  const cmd = args[0].toLowerCase();
  const rest = withoutPrefix.slice(cmd.length).trim();

  // 1. !ping / ?ping
  if (cmd === 'ping') {
    const wsPing = client.ws.ping;
    const restPing = Date.now() - message.createdTimestamp;
    const memUsageMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;

    await message.reply({
      content: `**Pong!**\n- Gateway: \`${wsPing >= 0 ? wsPing : 0}ms\`\n- REST: \`${restPing}ms\`\n- Uptime: \`${hours}h ${mins}m ${secs}s\`\n- RAM Usage: \`${memUsageMB} MB / 100 MB\``
    });
    return true;
  }

  // 2. !about / ?about
  if (cmd === 'about') {
    const ai = getAIConfig(message.guild.id);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Bobby')
      .setDescription('just bobby vro.')
      .addFields(
        { name: 'Model', value: `\`${ai.model}\``, inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 3. !help / ?help [category]
  if (cmd === 'help') {
    const sub = args[1]?.toLowerCase();

    if (sub === 'mod' || sub === 'moderation') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — Moderation Commands')
        .setDescription('Moderation commands require appropriate server permissions.')
        .addFields(
          { name: 'Infractions & History', value: '`!warn <@user> [reason]` — Issue formal warning.\n`!warnings <@user>` — View warning history.\n`!clearwarns <@user>` — Clear user warnings.\n`!history <@user>` — Full infraction & timeout history.' },
          { name: 'Member Discipline', value: '`!timeout <@user> <mins> [reason]` — Mute member.\n`!untimeout <@user>` — Remove timeout.\n`!kick <@user> [reason]` — Kick member.\n`!ban <@user> [reason]` — Ban member.\n`!unban <id> [reason]` — Unban user by ID.\n`!softban <@user>` — Kick + delete 7 days of messages.\n`!nick <@user> <newname|reset>` — Change nickname.' },
          { name: 'Channel Controls', value: '`!purge <1-100>` — Bulk delete messages.\n`!slowmode <secs|off>` — Set or disable slowmode.\n`!lock` / `!unlock` — Lockdown current channel.\n`!hide` / `!unhide` — Hide channel from @everyone.\n`!nuke` — Clone and clear entire channel.\n`!lockdown` / `!unlockall` — Emergency server-wide lockdown.' }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'server' || sub === 'roles') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — Server & Roles')
        .addFields(
          { name: 'Roles', value: '`!roles` — List roles in hierarchy order.\n`!roleinfo <role>` — Detailed role statistics.\n`!giverole <@user> <role>` — Assign role.\n`!takerole <@user> <role>` — Remove role.' },
          { name: 'Custom Emojis', value: '`!emojis` — List custom server emojis.\n`!enlarge <emoji>` — Full-res image link.\n`!addemoji <name> <url>` — Fast emoji upload.' },
          { name: 'Server & Channels', value: '`!serverinfo` — Server statistics.\n`!channelinfo [#ch]` — Channel information.\n`!members` — Total, humans, and bots counts.\n`!audit` — Audit admin permissions & bot hierarchy.' },
          { name: 'Config & Backup', value: '`!config` — Active welcome & reaction roles.\n`!backup` — Export complete JSON backup.\n`!restore` — Restore configuration from JSON.' }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'util' || sub === 'fun') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — Utility & Fun')
        .addFields(
          { name: 'Utilities', value: '`!remind <time> <note>` — Persistent reminder (e.g. `10m`, `2h`, `1d`).\n`!poll <question> [| opt1 | opt2]` — Reaction poll.\n`!choose <opt1> | <opt2>` — Random decision maker.\n`!userinfo [@user]` — Member card.\n`!avatar [@user]` — Avatar direct link.' },
          { name: 'Math & Fun', value: '`!math <expression>` — Safe math runner.\n`!roll [sides]` — Dice roll.\n`!flip` — Coin flip.\n`!8ball <question>` — Magic 8-ball.\n`!tole` — Mei Mei quotes.' }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'ai') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — AI Commands')
        .addFields(
          { name: 'AI Tools', value: '`!summarize [#ch] [count]` — Channel summary (also `!tldr`).\n`!translate <lang> <text|reply>` — Translation (also `!tr`).\n`!modmail setup #staff` / `!modmail off` — User DM triage forwarding.\n`!reply <user_id> <msg>` — Reply to user DM.\n`!aichannel [#ch|off]` — Dedicated channel where Bobby responds to every message.' },
          { name: 'Chat', value: '`@Bobby <message>` or `!ask <prompt>` — Natural chat and management.' },
          { name: 'Model & Provider', value: '`!model [model_name]` — Switch model.\n`!apiconfig` — Modify provider & key.\n`!mode <vro|serious|pirate>` — Persona switch.\n`!about` — Bot info.' }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (sub === 'community' || sub === 'carl') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — Community')
        .addFields(
          { name: 'Tags', value: '`!tag <name>` — View tag.\n`!tag add <name> <content>` — Create tag.\n`!tag edit <name> <content>` — Edit tag.\n`!tag delete <name>` — Delete tag.\n`!tags` — List all tags.' },
          { name: 'Suggestions', value: '`!suggest <idea>` — Submit suggestion with votes.\n`!suggest channel [#ch|off]` — Configure suggestion channel.\n`!approve <id> [reason]` — Approve suggestion.\n`!deny <id> [reason]` — Deny suggestion.' },
          { name: 'Support Tickets', value: '`!ticket [reason]` — Open private support channel.\n`!close [reason]` — Close ticket.\n`!transcript` — Save ticket history to txt file.' },
          { name: 'Giveaways & Starboard', value: '`!gway <time> <winners> <prize>` — Persistent giveaway.\n`!reroll <msgID>` — Pick new winner.\n`!starboard setup #ch [stars]` — Starboard configuration.\n`!starboard off` — Disable starboard.' },
          { name: 'Random Chatter', value: '`!chatter set [#ch] <count> <start> <end>` — Random contextual chatter.\n`!chatter status` — View upcoming chatter schedule.\n`!chatter off` — Disable chatter.\n`!chatter trigger [#ch]` — Instant chatter test.' }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    // Default overview
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Bobby')
      .setDescription('Prefixes: `!` or `?`\nType `!help <category>` (mod, community, server, util, ai)')
      .addFields(
        { name: 'Moderation (`!help mod`)', value: '`!warn`, `!history`, `!timeout`, `!untimeout`, `!kick`, `!ban`, `!unban`, `!softban`, `!nick`, `!purge`, `!slowmode`, `!lock`, `!unlock`, `!hide`, `!nuke`, `!lockdown`' },
        { name: 'Community (`!help community`)', value: '`!tag`, `!tags`, `!suggest`, `!approve`, `!deny`, `!ticket`, `!close`, `!transcript`, `!gway`, `!reroll`, `!starboard`, `!chatter`' },
        { name: 'Server & Roles (`!help server`)', value: '`!roles`, `!roleinfo`, `!giverole`, `!takerole`, `!emojis`, `!enlarge`, `!addemoji`, `!serverinfo`, `!channelinfo`, `!members`, `!audit`, `!config`, `!backup`, `!restore`' },
        { name: 'Utility & Fun (`!help util`)', value: '`!remind`, `!poll`, `!choose`, `!math`, `!userinfo`, `!avatar`, `!roll`, `!flip`, `!8ball`, `!tole`' },
        { name: 'AI & Chat (`!help ai`)', value: '`!summarize`, `!translate`, `!modmail`, `!reply`, `!aichannel`, `!ask`, `!model`, `!apiconfig`, `!mode`, `!remember`, `!recall`, `!memories`, `!forget`, `!about`' }
      );

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 4. !math / ?math <expression>
  if (cmd === 'math' || cmd === 'calc') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!math <expression>` (e.g. `!math (100 * 5) + Math.sqrt(144)`)' });
      return true;
    }
    const evalRes = safeEvaluateMath(rest);
    if (!evalRes.ok) {
      await message.reply({ content: `Error: ${evalRes.error}` });
    } else {
      await message.reply({ content: `**Result:** \`${evalRes.result}\`` });
    }
    return true;
  }

  // 5. !remember / ?remember / !save / ?save <key> <value>
  if (cmd === 'remember' || cmd === 'save') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You lack staff permissions to save server memories.' });
      return true;
    }
    const parts = rest.split(/\s+/);
    if (parts.length < 2) {
      await message.reply({ content: 'Usage: `!remember <key> <value>` (e.g. `!remember ip play.example.com`)' });
      return true;
    }
    const key = parts[0];
    const val = rest.slice(key.length).trim();
    setGuildMemory(message.guild.id, key, val);
    await message.reply({ content: `Remembered **${key.toLowerCase()}**: "${val}"` });
    return true;
  }

  // 6. !recall / ?recall / !memory / ?memory [key]
  if (cmd === 'recall' || cmd === 'memory') {
    const memories = getGuildMemories(message.guild.id);
    if (!rest) {
      const keys = Object.keys(memories);
      if (keys.length === 0) {
        await message.reply({ content: 'No memories saved yet. Staff can add some with `!remember <key> <value>`.' });
      } else {
        await message.reply({ content: `**Saved Memory Keys (${keys.length}):** \`${keys.join('`, `')}\`\nUse \`!recall <key>\` to view one.` });
      }
      return true;
    }
    const q = rest.trim().toLowerCase();
    if (memories[q]) {
      await message.reply({ content: `**${q}:** ${memories[q]}` });
    } else {
      const matched = Object.entries(memories).filter(([k, v]) => k.includes(q) || v.toLowerCase().includes(q));
      if (matched.length > 0) {
        const text = matched.map(([k, v]) => `• **${k}**: ${v}`).join('\n');
        await message.reply({ content: `**Matches for "${rest}":**\n${text}` });
      } else {
        await message.reply({ content: `No memory found matching "${rest}". Use \`!memories\` to see all keys.` });
      }
    }
    return true;
  }

  // 7. !memories / ?memories / !listmemories
  if (cmd === 'memories' || cmd === 'listmemories') {
    const memories = getGuildMemories(message.guild.id);
    const keys = Object.keys(memories);
    if (keys.length === 0) {
      await message.reply({ content: 'No memories saved yet. Staff can add some with `!remember <key> <value>`.' });
    } else {
      const list = keys.map((k) => `• **${k}**: ${memories[k].slice(0, 80)}`).join('\n');
      await message.reply({ content: `**Server Memories (${keys.length}):**\n${list}` });
    }
    return true;
  }

  // 8. !forget / ?forget <key>
  if (cmd === 'forget') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You lack staff permissions to delete server memories.' });
      return true;
    }
    if (!rest) {
      await message.reply({ content: 'Usage: `!forget <key>`' });
      return true;
    }
    const res = deleteGuildMemory(message.guild.id, rest);
    if (res.deleted) {
      await message.reply({ content: `Deleted memory for **${res.key}**.` });
    } else {
      await message.reply({ content: `Key "${rest}" was not found in memory.` });
    }
    return true;
  }

  // 9. !config / ?config
  if (cmd === 'config') {
    const cfg = getGuildConfig(message.guild.id);
    const rrs = getGuildReactionRoles(message.guild.id);

    const welcomeStr = cfg?.welcome?.enabled && cfg?.welcome?.channelId
      ? `Enabled in <#${cfg.welcome.channelId}>\nMessage: \`${cfg.welcome.message?.slice(0, 60)}...\``
      : 'Disabled';

    const autoroleStr = cfg?.autorole?.enabled && cfg?.autorole?.roleId
      ? `Enabled (<@&${cfg.autorole.roleId}>)`
      : 'Disabled';

    const rrCount = Object.keys(rrs).length;
    const memCount = Object.keys(cfg?.memories || {}).length;

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Server Config — ${message.guild.name}`)
      .addFields(
        { name: 'Welcome System', value: welcomeStr, inline: false },
        { name: 'Join Auto-Role', value: autoroleStr, inline: false },
        { name: 'Reaction Roles', value: `${rrCount} message(s) active`, inline: true },
        { name: 'Memories Saved', value: `${memCount} fact(s) stored`, inline: true }
      );

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 10. !backup / ?backup / !export
  if (cmd === 'backup' || cmd === 'export') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to back up server config.' });
      return true;
    }
    const config = exportGuildConfig(message.guild.id);
    const buffer = Buffer.from(JSON.stringify(config, null, 2), 'utf8');
    await message.reply({
      content: `**Server Backup Created for ${message.guild.name}**\nContains welcome settings, auto-roles, reaction role mappings, and memories.\nTo restore anytime, attach this file and run \`!restore\`.`,
      files: [{
        attachment: buffer,
        name: `bobby-backup-${message.guild.id}.json`
      }]
    });
    return true;
  }

  // 11. !restore / ?restore / !import
  if (cmd === 'restore' || cmd === 'import') {
    if (!isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only the Server Owner or an Administrator can restore configuration.' });
      return true;
    }

    let rawJson = null;
    const attachment = message.attachments?.first?.();
    if (attachment && (attachment.name?.endsWith('.json') || attachment.contentType?.includes('json'))) {
      try {
        const res = await fetch(attachment.url);
        rawJson = await res.text();
      } catch (err) {
        await message.reply({ content: `Failed to download attachment: ${err.message}` });
        return true;
      }
    } else if (rest) {
      rawJson = rest;
    }

    if (!rawJson) {
      await message.reply({ content: 'Usage: Attach your `bobby-backup.json` file and type `!restore`, or paste the JSON text after the command.' });
      return true;
    }

    try {
      const parsed = JSON.parse(rawJson);
      importGuildConfig(message.guild.id, parsed);
      const rrCount = Object.keys(parsed.reaction_roles || {}).length;
      const memCount = Object.keys(parsed.memories || {}).length;

      await message.reply({
        content: `**Configuration Restored Successfully**\n- Welcome System: ${parsed.welcome?.enabled ? 'Active' : 'Disabled'}\n- Auto-Role: ${parsed.autorole?.enabled ? 'Active' : 'Disabled'}\n- Reaction Roles: **${rrCount}** message(s)\n- Memories: **${memCount}** fact(s)`
      });
    } catch (err) {
      await message.reply({ content: `Invalid backup JSON: ${err.message}` });
    }
    return true;
  }

  // 12. !model / ?model [model_name]
  if (cmd === 'model') {
    const current = getAIConfig(message.guild.id);
    if (!rest) {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — AI Model Settings')
        .setDescription(`Current model: **\`${current.model}\`**\nStatus: ${current.isCustom ? 'Custom Guild Override' : 'Default (.env)'}`)
        .addFields(
          { name: 'Provider Endpoint', value: `\`${current.baseURL || 'https://api.openai.com/v1'}\``, inline: false },
          { name: 'To Change Model', value: '`!model <model_name>`\n*Examples:* `!model gpt-4o-mini`, `!model deepseek-v4.1-flash-1017`, `!model claude-3-5-haiku`, `!model llama-3.3-70b`', inline: false },
          { name: 'To Reset', value: '`!model reset` (reverts back to .env default)', inline: false }
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (!isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only the Server Owner or an Administrator can change the AI model.' });
      return true;
    }

    if (rest.toLowerCase() === 'reset') {
      resetGuildAIConfig(message.guild.id);
      const def = getAIConfig();
      await message.reply({ content: `Reset AI model to default: **\`${def.model}\`**` });
      return true;
    }

    const newModel = rest.split(/\s+/)[0];
    setGuildAIConfig(message.guild.id, { model: newModel });
    await message.reply({ content: `AI model switched to **\`${newModel}\`** for this server.` });
    return true;
  }

  // 13. !apiconfig / ?apiconfig
  if (cmd === 'apiconfig' || cmd === 'ai') {
    const current = getAIConfig(message.guild.id);
    if (!rest) {
      const maskedKey = current.apiKey
        ? `${current.apiKey.slice(0, 4)}...${current.apiKey.slice(-4)}`
        : 'None';
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Bobby — AI Provider Configuration')
        .addFields(
          { name: 'Model', value: `\`${current.model}\``, inline: true },
          { name: 'Base URL', value: `\`${current.baseURL || 'https://api.openai.com/v1'}\``, inline: true },
          { name: 'API Key', value: `\`${maskedKey}\``, inline: true },
          { name: 'Source', value: current.isCustom ? 'Custom Guild Override' : 'Default (.env)', inline: true },
          { name: 'Reasoning Effort', value: `\`${current.reasoningEffort || 'none'}\``, inline: true }
        )
        .setDescription(
          '**How to configure on the fly (Owner only):**\n' +
          '• Switch model: `!model <name>`\n' +
          '• Switch provider: `!apiconfig url <url> [key <key>] [model <model>]`\n' +
          '• Revert to default: `!apiconfig reset`'
        );
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (!isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only the Server Owner or an Administrator can modify the AI provider config.' });
      return true;
    }

    if (rest.toLowerCase() === 'reset') {
      resetGuildAIConfig(message.guild.id);
      await message.reply({ content: 'Reverted AI provider configuration to `.env` defaults.' });
      return true;
    }

    const update = {};
    const tokens = rest.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const k = tokens[i].toLowerCase();
      if (k === 'url' && tokens[i + 1]) {
        update.baseURL = tokens[++i];
      } else if (k === 'key' && tokens[i + 1]) {
        update.apiKey = tokens[++i];
      } else if (k === 'model' && tokens[i + 1]) {
        update.model = tokens[++i];
      } else if (k === 'reasoning' && tokens[i + 1]) {
        update.reasoningEffort = tokens[++i];
      }
    }

    if (Object.keys(update).length === 0) {
      await message.reply({ content: 'Usage: `!apiconfig url <baseURL> [key <apiKey>] [model <modelName>]` or `!apiconfig reset`' });
      return true;
    }

    setGuildAIConfig(message.guild.id, update);
    await message.reply({
      content: `**AI Provider Updated**\n${update.model ? `• Model: \`${update.model}\`\n` : ''}${update.baseURL ? `• Base URL: \`${update.baseURL}\`\n` : ''}${update.apiKey ? `• API Key: \`Updated\`\n` : ''}`
    });
    return true;
  }

  // 14. !mode / ?mode <vro|serious|pirate>
  if (cmd === 'mode' || cmd === 'persona') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: "You need staff permissions to change Bobby's persona." });
      return true;
    }
    const mode = rest.toLowerCase();
    if (!['vro', 'chill', 'serious', 'pro', 'pirate'].includes(mode)) {
      await message.reply({
        content: "Available modes:\n• `!mode vro` (Default casual Mei Mei vro vibe)\n• `!mode serious` (Professional, concise server executive)\n• `!mode pirate` (Salty witty pirate captain)"
      });
      return true;
    }
    const mapped = (mode === 'chill') ? 'vro' : (mode === 'pro') ? 'serious' : mode;
    setGuildPersona(message.guild.id, mapped);
    await message.reply({ content: `Bobby's persona set to **${mapped}** mode.` });
    return true;
  }

  // 14a. !summarize / !tldr [#channel] [count]
  if (cmd === 'summarize' || cmd === 'tldr') {
    let targetChannel = message.mentions.channels?.first() || message.channel;
    let count = 30;
    for (const a of args.slice(1)) {
      const num = parseInt(a, 10);
      if (!isNaN(num) && num >= 10 && num <= 100) {
        count = num;
      }
    }

    if (!targetChannel.isTextBased()) {
      await message.reply({ content: 'Channel must be a text channel.' });
      return true;
    }

    const waitMsg = await message.reply({ content: `Reading and summarizing last ${count} messages in #${targetChannel.name}...` });

    try {
      const fetched = await targetChannel.messages.fetch({ limit: count, before: message.id });
      const ordered = Array.from(fetched.values()).reverse().map((m) => ({
        author: m.author.username,
        content: m.content,
        timestamp: m.createdTimestamp
      })).filter((m) => m.content && m.content.trim());

      if (ordered.length === 0) {
        await waitMsg.edit({ content: `No text messages found in #${targetChannel.name} to summarize.` });
        return true;
      }

      const summary = await summarizeMessages({ messages: ordered, guildId: message.guild.id });

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Channel Summary — #${targetChannel.name}`)
        .setDescription(summary)
        .setFooter({ text: `Summarized ${ordered.length} messages` });

      await waitMsg.edit({ content: '', embeds: [embed] });
    } catch (err) {
      await waitMsg.edit({ content: `Failed to summarize: ${err.message}` });
    }
    return true;
  }

  // 14b. !translate / !tr <target_lang> [text]
  if (cmd === 'translate' || cmd === 'tr') {
    const targetLang = args[1];
    if (!targetLang) {
      await message.reply({ content: 'Usage: `!translate <language> <text>` or reply to a message with `!translate <language>`' });
      return true;
    }

    let textToTranslate = args.slice(2).join(' ').trim();
    if (!textToTranslate && message.reference?.messageId) {
      const refMsg = await message.fetchReference().catch(() => null);
      if (refMsg) textToTranslate = refMsg.content;
    }

    if (!textToTranslate) {
      await message.reply({ content: 'Please provide text to translate or reply to a message.' });
      return true;
    }

    const waitMsg = await message.reply({ content: `Translating to **${targetLang}**...` });
    try {
      const translated = await translateText({
        text: textToTranslate,
        targetLang,
        guildId: message.guild.id
      });

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Translation (${targetLang})`)
        .addFields(
          { name: 'Original', value: textToTranslate.slice(0, 1024), inline: false },
          { name: 'Translated', value: translated.slice(0, 1024), inline: false }
        );

      await waitMsg.edit({ content: '', embeds: [embed] });
    } catch (err) {
      await waitMsg.edit({ content: `Translation failed: ${err.message}` });
    }
    return true;
  }

  // 14c. !modmail <setup #channel | off>
  if (cmd === 'modmail') {
    if (!isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only the Server Owner or an Administrator can configure modmail.' });
      return true;
    }
    const sub = args[1]?.toLowerCase();
    if (sub === 'off' || sub === 'disable') {
      setGuildModmail(message.guild.id, { enabled: false, channelId: null });
      await message.reply({ content: 'Modmail disabled for this server.' });
      return true;
    }
    const targetChannel = message.mentions.channels?.first() || (args[2] ? await message.guild.channels.fetch(args[2]).catch(() => null) : null);
    if (!targetChannel) {
      const cfg = getGuildModmail(message.guild.id);
      await message.reply({
        content: `Modmail Status: ${cfg.enabled && cfg.channelId ? `Active in <#${cfg.channelId}>` : 'Disabled'}\nUsage: \`!modmail setup #staff-channel\` or \`!modmail off\``
      });
      return true;
    }
    setGuildModmail(message.guild.id, { enabled: true, channelId: targetChannel.id });
    await message.reply({ content: `Modmail enabled! Member DMs will be forwarded to <#${targetChannel.id}> with AI triage.` });
    return true;
  }

  // 14d. !reply <user_id> <message>
  if (cmd === 'reply' || cmd === 'dm') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to reply to modmail.' });
      return true;
    }
    const targetId = args[1]?.replace(/[<@!>]/g, '');
    const replyText = args.slice(2).join(' ').trim();
    if (!targetId || !replyText) {
      await message.reply({ content: 'Usage: `!reply <user_id> <message>`' });
      return true;
    }
    try {
      const targetUser = await client.users.fetch(targetId);
      const dmChannel = await targetUser.createDM();
      await dmChannel.send({
        content: `**Staff Response from ${message.guild.name}:**\n${replyText}`
      });
      await message.reply({ content: `Sent reply to <@${targetUser.id}> (${targetUser.username}).` });
    } catch (err) {
      await message.reply({ content: `Failed to deliver DM to user: ${err.message}` });
    }
    return true;
  }

  // 14e. !tags / !taglist
  if (cmd === 'tags' || cmd === 'taglist') {
    const tags = getGuildTags(message.guild.id);
    const keys = Object.keys(tags);
    if (keys.length === 0) {
      await message.reply({ content: 'No custom tags found. Staff can create some with `!tag add <name> <content>`.' });
      return true;
    }
    const list = keys.slice(0, 40).map((k) => `\`${k}\` (${tags[k].uses || 0} uses)`).join(', ');
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Server Tags (${keys.length}) — ${message.guild.name}`)
      .setDescription(list + (keys.length > 40 ? `\n*...and ${keys.length - 40} more*` : ''))
      .setFooter({ text: 'Use !tag <name> to view any tag' });
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 14f. !tag [add|edit|delete] <name> [content]
  if (cmd === 'tag') {
    const action = args[1]?.toLowerCase();
    if (!action) {
      await message.reply({ content: 'Usage: `!tag <name>` or `!tag add|edit|delete <name> <content>`' });
      return true;
    }

    if (action === 'add' || action === 'create') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to create tags.' });
        return true;
      }
      const name = args[2]?.toLowerCase();
      const tagContent = args.slice(3).join(' ').trim();
      if (!name || !tagContent) {
        await message.reply({ content: 'Usage: `!tag add <name> <content>`' });
        return true;
      }
      setGuildTag(message.guild.id, name, tagContent, message.author.id);
      await message.reply({ content: `Created tag **${name}**.` });
      return true;
    }

    if (action === 'edit') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to edit tags.' });
        return true;
      }
      const name = args[2]?.toLowerCase();
      const tagContent = args.slice(3).join(' ').trim();
      if (!name || !tagContent) {
        await message.reply({ content: 'Usage: `!tag edit <name> <content>`' });
        return true;
      }
      const existing = getGuildTag(message.guild.id, name);
      if (!existing) {
        await message.reply({ content: `Tag "${name}" does not exist. Use \`!tag add\` instead.` });
        return true;
      }
      setGuildTag(message.guild.id, name, tagContent, message.author.id);
      await message.reply({ content: `Updated tag **${name}**.` });
      return true;
    }

    if (action === 'delete' || action === 'remove') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to delete tags.' });
        return true;
      }
      const name = args[2]?.toLowerCase();
      if (!name) {
        await message.reply({ content: 'Usage: `!tag delete <name>`' });
        return true;
      }
      const deleted = deleteGuildTag(message.guild.id, name);
      if (deleted) {
        await message.reply({ content: `Deleted tag **${name}**.` });
      } else {
        await message.reply({ content: `Tag "${name}" was not found.` });
      }
      return true;
    }

    // Direct tag view: !tag <name>
    const tag = getGuildTag(message.guild.id, action);
    if (!tag) {
      await message.reply({ content: `Tag "${action}" was not found. Use \`!tags\` to see all available tags.` });
      return true;
    }
    incrementTagUses(message.guild.id, action);
    await message.reply({ content: tag.content });
    return true;
  }

  // 14g. !suggest / !suggestion <idea>
  if (cmd === 'suggest' || cmd === 'suggestion') {
    if (args[1]?.toLowerCase() === 'channel') {
      if (!isOwnerOrAdmin(message.member, message.guild)) {
        await message.reply({ content: 'Only the Server Owner or an Administrator can configure the suggestions channel.' });
        return true;
      }
      const targetChannel = message.mentions.channels?.first() || (args[2] ? await message.guild.channels.fetch(args[2]).catch(() => null) : null);
      if (args[2]?.toLowerCase() === 'off') {
        setGuildSuggestionsChannel(message.guild.id, null);
        await message.reply({ content: 'Suggestions channel disabled.' });
        return true;
      }
      if (!targetChannel) {
        await message.reply({ content: 'Usage: `!suggest channel #suggestions` or `!suggest channel off`' });
        return true;
      }
      setGuildSuggestionsChannel(message.guild.id, targetChannel.id);
      await message.reply({ content: `Suggestions channel set to <#${targetChannel.id}>.` });
      return true;
    }

    if (!rest) {
      await message.reply({ content: 'Usage: `!suggest <your idea or suggestion>`' });
      return true;
    }

    const sgCfg = getGuildSuggestions(message.guild.id);
    const sgChannelId = sgCfg.channelId || message.channel.id;
    const targetChannel = await message.guild.channels.fetch(sgChannelId).catch(() => null);

    if (!targetChannel || !targetChannel.isTextBased()) {
      await message.reply({ content: 'Suggestions channel is not configured. Staff can set it with `!suggest channel #channel`.' });
      return true;
    }

    const suggestionId = 'sg_' + Math.floor(1000 + Math.random() * 9000);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setAuthor({ name: `${message.author.username} (${message.author.id})`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
      .setTitle(`Suggestion #${suggestionId}`)
      .setDescription(rest)
      .addFields({ name: 'Status', value: 'Pending Community Review', inline: true })
      .setFooter({ text: `Vote using 👍 or 👎 • ID: ${suggestionId}` })
      .setTimestamp();

    const sent = await targetChannel.send({ embeds: [embed] });
    await sent.react('👍').catch(() => null);
    await sent.react('👎').catch(() => null);

    addGuildSuggestion(message.guild.id, {
      id: suggestionId,
      authorId: message.author.id,
      content: rest,
      messageId: sent.id
    });

    if (targetChannel.id !== message.channel.id) {
      await message.reply({ content: `Suggestion submitted to <#${targetChannel.id}> (#${suggestionId}).` });
    }
    return true;
  }

  // 14h. !approve <suggestion_id> [reason]
  if (cmd === 'approve') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to approve suggestions.' });
      return true;
    }
    const id = args[1]?.toLowerCase();
    const reason = args.slice(2).join(' ').trim() || 'Approved by staff';
    if (!id) {
      await message.reply({ content: 'Usage: `!approve <suggestion_id> [reason]`' });
      return true;
    }
    const updated = updateGuildSuggestionStatus(message.guild.id, id, {
      status: 'approved',
      reason,
      moderatorId: message.author.id
    });
    if (!updated) {
      await message.reply({ content: `Suggestion "${id}" was not found.` });
      return true;
    }
    const sgCfg = getGuildSuggestions(message.guild.id);
    if (sgCfg.channelId && updated.messageId) {
      const ch = await message.guild.channels.fetch(sgCfg.channelId).catch(() => null);
      const msg = await ch?.messages.fetch(updated.messageId).catch(() => null);
      if (msg && msg.embeds.length > 0) {
        const oldEmbed = msg.embeds[0];
        const newEmbed = EmbedBuilder.from(oldEmbed)
          .setColor('#57F287')
          .setFields(
            { name: 'Status', value: 'Approved', inline: true },
            { name: 'Staff Reason', value: reason, inline: false }
          );
        await msg.edit({ embeds: [newEmbed] }).catch(() => null);
      }
    }
    await message.reply({ content: `Approved suggestion **#${id}**. Reason: ${reason}` });
    return true;
  }

  // 14i. !deny <suggestion_id> [reason]
  if (cmd === 'deny') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to deny suggestions.' });
      return true;
    }
    const id = args[1]?.toLowerCase();
    const reason = args.slice(2).join(' ').trim() || 'Denied by staff';
    if (!id) {
      await message.reply({ content: 'Usage: `!deny <suggestion_id> [reason]`' });
      return true;
    }
    const updated = updateGuildSuggestionStatus(message.guild.id, id, {
      status: 'denied',
      reason,
      moderatorId: message.author.id
    });
    if (!updated) {
      await message.reply({ content: `Suggestion "${id}" was not found.` });
      return true;
    }
    const sgCfg = getGuildSuggestions(message.guild.id);
    if (sgCfg.channelId && updated.messageId) {
      const ch = await message.guild.channels.fetch(sgCfg.channelId).catch(() => null);
      const msg = await ch?.messages.fetch(updated.messageId).catch(() => null);
      if (msg && msg.embeds.length > 0) {
        const oldEmbed = msg.embeds[0];
        const newEmbed = EmbedBuilder.from(oldEmbed)
          .setColor('#ED4245')
          .setFields(
            { name: 'Status', value: 'Denied', inline: true },
            { name: 'Staff Reason', value: reason, inline: false }
          );
        await msg.edit({ embeds: [newEmbed] }).catch(() => null);
      }
    }
    await message.reply({ content: `Denied suggestion **#${id}**. Reason: ${reason}` });
    return true;
  }

  // 14j. !ticket [reason]
  if (cmd === 'ticket' || cmd === 'newticket') {
    const reason = rest || 'General Assistance';
    try {
      const cleanName = message.author.username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15) || 'user';
      const chName = `ticket-${cleanName.toLowerCase()}`;
      const overwrites = [
        {
          id: message.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: message.author.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory]
        }
      ];

      const clientMember = message.guild.members.me;
      if (clientMember) {
        overwrites.push({
          id: clientMember.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages]
        });
      }

      const ticketChannel = await message.guild.channels.create({
        name: chName,
        type: ChannelType.GuildText,
        permissionOverwrites: overwrites,
        reason: `Ticket created by ${message.author.tag}: ${reason}`
      });

      const ticketRecord = createGuildTicket(message.guild.id, ticketChannel.id, {
        userId: message.author.id,
        reason
      });

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Support Ticket #${ticketRecord.ticketNumber}`)
        .setDescription(`Hello <@${message.author.id}>, staff will assist you shortly.\n\n**Reason:** ${reason}`)
        .setFooter({ text: 'Type !close to close this ticket • !transcript to save history' })
        .setTimestamp();

      await ticketChannel.send({
        content: `<@${message.author.id}>`,
        embeds: [embed]
      });

      await message.reply({ content: `Created your support ticket: <#${ticketChannel.id}>.` });
    } catch (err) {
      await message.reply({ content: `Failed to create ticket: ${err.message}` });
    }
    return true;
  }

  // 14k. !close [reason]
  if (cmd === 'close' || cmd === 'closeticket') {
    const activeTickets = getGuildTickets(message.guild.id).active || {};
    const isTicket = activeTickets[message.channel.id];
    if (!isTicket && !message.channel.name.startsWith('ticket-')) {
      await message.reply({ content: 'This command can only be used inside an active ticket channel.' });
      return true;
    }

    const reason = rest || 'Issue resolved';
    closeGuildTicket(message.guild.id, message.channel.id);

    await message.reply({ content: `Closing ticket in 5 seconds... Reason: ${reason}` });
    setTimeout(async () => {
      await message.channel.delete(`Ticket closed by ${message.author.tag}: ${reason}`).catch(() => null);
    }, 5000);
    return true;
  }

  // 14l. !transcript
  if (cmd === 'transcript') {
    const activeTickets = getGuildTickets(message.guild.id).active || {};
    const isTicket = activeTickets[message.channel.id];
    if (!isTicket && !message.channel.name.startsWith('ticket-')) {
      await message.reply({ content: 'This command can only be used inside a ticket channel.' });
      return true;
    }

    const fetched = await message.channel.messages.fetch({ limit: 100 });
    const ordered = Array.from(fetched.values()).reverse();
    const lines = ordered.map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`);
    const buffer = Buffer.from(lines.join('\n'), 'utf8');

    await message.reply({
      content: `Transcript for #${message.channel.name} (${ordered.length} messages):`,
      files: [{
        attachment: buffer,
        name: `transcript-${message.channel.name}.txt`
      }]
    });
    return true;
  }

  // 14m. !gway / !giveaway <duration> <winners_count> <prize>
  if (cmd === 'gway' || cmd === 'giveaway') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to host giveaways.' });
      return true;
    }
    const timeStr = args[1];
    const winnersCount = parseInt(args[2], 10);
    const prize = args.slice(3).join(' ').trim();

    if (!timeStr || isNaN(winnersCount) || winnersCount < 1 || !prize) {
      await message.reply({ content: 'Usage: `!gway <time> <winners_count> <prize>` (e.g. `!gway 1h 1 Discord Nitro`, `!gway 30m 2 Steam Key`)' });
      return true;
    }

    const match = timeStr.match(/^(\d+)([smhd])$/i);
    if (!match) {
      await message.reply({ content: 'Invalid time format. Use `30s`, `10m`, `2h`, or `1d`.' });
      return true;
    }
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    const delayMs = num * multipliers[unit];

    if (delayMs > 14 * 24 * 60 * 60 * 1000) {
      await message.reply({ content: 'Giveaway duration cannot exceed 14 days.' });
      return true;
    }

    const endsAt = Date.now() + delayMs;
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Giveaway: ${prize}`)
      .setDescription(`React with 🎉 to enter!\n\n**Winners:** ${winnersCount}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:f>)\n**Hosted by:** ${message.author}`)
      .setFooter({ text: `${winnersCount} winner(s) • Ends` })
      .setTimestamp(endsAt);

    const sent = await message.channel.send({ embeds: [embed] });
    await sent.react('🎉').catch(() => null);

    const gwayRecord = addGuildGiveaway(message.guild.id, sent.id, {
      channelId: message.channel.id,
      prize,
      winnersCount,
      endsAt
    });

    setTimeout(() => {
      resolveGiveaway(client, { ...gwayRecord, guildId: message.guild.id });
    }, delayMs);

    return true;
  }

  // 14n. !reroll <message_id>
  if (cmd === 'reroll') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to reroll giveaways.' });
      return true;
    }
    const msgId = args[1]?.trim();
    if (!msgId) {
      await message.reply({ content: 'Usage: `!reroll <giveaway_message_id>`' });
      return true;
    }
    const gways = getGuildGiveaways(message.guild.id);
    const gway = gways[msgId];
    if (!gway) {
      await message.reply({ content: `Giveaway with message ID "${msgId}" was not found.` });
      return true;
    }
    await resolveGiveaway(client, { ...gway, guildId: message.guild.id });
    await message.reply({ content: `Rerolled giveaway for **${gway.prize}**!` });
    return true;
  }

  // 14o. !starboard [setup #channel [threshold] | off]
  if (cmd === 'starboard') {
    if (args[1]?.toLowerCase() === 'setup') {
      if (!isOwnerOrAdmin(message.member, message.guild)) {
        await message.reply({ content: 'Only the Server Owner or an Administrator can configure the starboard.' });
        return true;
      }
      const targetChannel = message.mentions.channels?.first() || (args[2] ? await message.guild.channels.fetch(args[2]).catch(() => null) : null);
      const threshold = parseInt(args[3], 10) || 3;
      if (!targetChannel) {
        await message.reply({ content: 'Usage: `!starboard setup #starboard [threshold]`' });
        return true;
      }
      setGuildStarboard(message.guild.id, { channelId: targetChannel.id, threshold });
      await message.reply({ content: `Starboard enabled in <#${targetChannel.id}> with threshold of **${threshold}** ⭐.` });
      return true;
    }

    if (args[1]?.toLowerCase() === 'off' || args[1]?.toLowerCase() === 'disable') {
      if (!isOwnerOrAdmin(message.member, message.guild)) {
        await message.reply({ content: 'Only the Server Owner or an Administrator can disable the starboard.' });
        return true;
      }
      setGuildStarboard(message.guild.id, { channelId: null });
      await message.reply({ content: 'Starboard disabled for this server.' });
      return true;
    }

    const sb = getGuildStarboard(message.guild.id);
    const status = sb.channelId ? `Active in <#${sb.channelId}> (Threshold: **${sb.threshold || 3}** ⭐)` : 'Disabled';
    const entryCount = Object.keys(sb.entries || {}).length;

    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle(`Starboard Configuration — ${message.guild.name}`)
      .addFields(
        { name: 'Status', value: status, inline: false },
        { name: 'Pinned Messages', value: `${entryCount}`, inline: true },
        { name: 'Commands', value: '`!starboard setup #channel [threshold]`\n`!starboard off`', inline: false }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // !chatter / !yap / !roam
  if (cmd === 'chatter' || cmd === 'yap' || cmd === 'roam') {
    const sub = args[1]?.toLowerCase();

    if (!sub || sub === 'help') {
      await message.reply({
        content: '**Bobby Random Chatter / Yap Scheduler**\n' +
          '- `!chatter set [#channel] <count> <startTime> <endTime>` — Schedule random contextual messages.\n' +
          '  *Example:* `!chatter set #general 2 10am 11pm`\n' +
          '- `!chatter status` — View active schedule and upcoming trigger times.\n' +
          '- `!chatter off` — Disable random chatter.\n' +
          '- `!chatter trigger [#channel]` — Trigger an instant contextual message now.'
      });
      return true;
    }

    if (sub === 'set') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to configure random chatter.' });
        return true;
      }

      // Parse tokens
      let targetChannel = message.mentions?.channels?.first?.();
      let rawTokens = args.slice(2);

      if (targetChannel) {
        rawTokens = rawTokens.filter((t) => !t.includes(targetChannel.id) && !t.startsWith('<#'));
      } else {
        const firstToken = rawTokens[0];
        const chCandidate = message.guild?.channels?.cache?.get?.(firstToken) ||
          message.guild?.channels?.cache?.find?.((c) => c.name.toLowerCase() === firstToken?.toLowerCase().replace(/^#/, ''));
        if (chCandidate && (typeof chCandidate.isTextBased !== 'function' || chCandidate.isTextBased())) {
          targetChannel = chCandidate;
          rawTokens = rawTokens.slice(1);
        } else {
          targetChannel = message.channel;
        }
      }

      if (rawTokens.length < 3) {
        await message.reply({
          content: 'Usage: `!chatter set [#channel] <count> <startTime> <endTime>`\n*Example:* `!chatter set #general 2 10am 11pm`'
        });
        return true;
      }

      const count = parseInt(rawTokens[0], 10);
      if (isNaN(count) || count < 1 || count > 20) {
        await message.reply({ content: 'Message count must be a number between 1 and 20.' });
        return true;
      }

      const startParsed = parseTimeString(rawTokens[1]);
      const endParsed = parseTimeString(rawTokens[2]);

      if (!startParsed || !endParsed) {
        await message.reply({ content: 'Invalid time format. Use format like `10am`, `11pm`, `10:00`, or `23:00`.' });
        return true;
      }

      if (startParsed.totalMinutes >= endParsed.totalMinutes) {
        await message.reply({ content: 'Start time must be strictly before end time.' });
        return true;
      }

      const triggers = calculateNextTriggers(startParsed.totalMinutes, endParsed.totalMinutes, count);
      const chatterData = {
        enabled: true,
        channelId: targetChannel.id,
        channelName: targetChannel.name,
        count,
        startMinutes: startParsed.totalMinutes,
        endMinutes: endParsed.totalMinutes,
        startStr: formatMinutesToTime(startParsed.totalMinutes),
        endStr: formatMinutesToTime(endParsed.totalMinutes),
        triggers
      };

      setGuildChatter(message.guild.id, chatterData);
      scheduleGuildChatter(client, message.guild.id);

      const triggerLines = triggers.map((ts) => `• <t:${Math.floor(ts / 1000)}:t> (<t:${Math.floor(ts / 1000)}:R>)`).join('\n');

      await message.reply({
        content: `**Random Chatter Configured for <#${targetChannel.id}>**\n` +
          `- Messages per day: **${count}**\n` +
          `- Time Window: **${chatterData.startStr}** – **${chatterData.endStr}**\n` +
          `- Next scheduled messages:\n${triggerLines}`
      });
      return true;
    }

    if (sub === 'status' || sub === 'list') {
      const chatter = getGuildChatter(message.guild.id);
      if (!chatter.enabled || !chatter.channelId) {
        await message.reply({ content: 'Random chatter is currently disabled. Use `!chatter set` to configure.' });
        return true;
      }

      const upcoming = (chatter.triggers || []).filter((t) => t > Date.now());
      const triggerLines = upcoming.length > 0
        ? upcoming.map((ts) => `• <t:${Math.floor(ts / 1000)}:t> (<t:${Math.floor(ts / 1000)}:R>)`).join('\n')
        : '• *Rolling over for next cycle*';

      await message.reply({
        content: `**Random Chatter Status — ${message.guild.name}**\n` +
          `- Status: **Active**\n` +
          `- Channel: <#${chatter.channelId}>\n` +
          `- Messages per day: **${chatter.count || 2}**\n` +
          `- Time Window: **${chatter.startStr || formatMinutesToTime(chatter.startMinutes || 600)}** – **${chatter.endStr || formatMinutesToTime(chatter.endMinutes || 1380)}**\n` +
          `- Next upcoming times:\n${triggerLines}`
      });
      return true;
    }

    if (sub === 'off' || sub === 'cancel' || sub === 'disable') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to disable random chatter.' });
        return true;
      }

      setGuildChatter(message.guild.id, { enabled: false, triggers: [] });
      clearGuildChatterTimers(message.guild.id);
      await message.reply({ content: 'Random chatter disabled.' });
      return true;
    }

    if (sub === 'trigger' || sub === 'now') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to trigger random chatter.' });
        return true;
      }

      const target = message.mentions?.channels?.first?.() || message.channel;
      await message.reply({ content: `Triggering chatter message in <#${target.id}>...` });
      await executeChatterTrigger(client, message.guild.id, target.id);
      return true;
    }

    await message.reply({ content: 'Unknown chatter subcommand. Use `!chatter help` for usage.' });
    return true;
  }

  // !aichannel / !autochat / !botchannel / !chatchannel
  if (cmd === 'aichannel' || cmd === 'autochat' || cmd === 'botchannel' || cmd === 'chatchannel') {
    const sub = args[1]?.toLowerCase();

    if (!sub || sub === 'status') {
      const current = getGuildAutoChatChannel(message.guild.id);
      if (current) {
        await message.reply({
          content: `**Auto-Response Channel:** <#${current}>\nBobby responds to every message sent in this channel without needing to be mentioned.`
        });
      } else {
        await message.reply({
          content: 'No auto-response channel is currently set.\nUse `!aichannel #channel` to configure one, or `!aichannel off` to disable.'
        });
      }
      return true;
    }

    if (sub === 'off' || sub === 'disable' || sub === 'clear') {
      if (!isStaffMember(message.member, message.guild)) {
        await message.reply({ content: 'You need staff permissions to configure the auto-response channel.' });
        return true;
      }
      setGuildAutoChatChannel(message.guild.id, null);
      await message.reply({ content: 'Auto-response channel disabled. Bobby will only respond when mentioned or via `!ask`.' });
      return true;
    }

    // Set auto-response channel
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to configure the auto-response channel.' });
      return true;
    }

    let targetChannel = message.mentions?.channels?.first?.();
    if (!targetChannel) {
      if (sub === 'set' || sub === 'here') {
        const nextArg = args[2];
        if (nextArg) {
          const candId = nextArg.replace(/[<#>]/g, '');
          targetChannel = message.guild?.channels?.cache?.get?.(candId) ||
            message.guild?.channels?.cache?.find?.((c) => c.name.toLowerCase() === nextArg.toLowerCase().replace(/^#/, ''));
        }
        if (!targetChannel) {
          targetChannel = message.channel;
        }
      } else {
        const candidateId = args[1]?.replace(/[<#>]/g, '');
        targetChannel = message.guild?.channels?.cache?.get?.(candidateId) ||
          message.guild?.channels?.cache?.find?.((c) => c.name.toLowerCase() === args[1]?.toLowerCase().replace(/^#/, '')) ||
          message.channel;
      }
    }

    if (typeof targetChannel.isTextBased === 'function' && !targetChannel.isTextBased()) {
      await message.reply({ content: 'The auto-response channel must be a text-based channel.' });
      return true;
    }

    setGuildAutoChatChannel(message.guild.id, targetChannel.id);
    await message.reply({
      content: `**Auto-Response Channel Set to <#${targetChannel.id}>**\nBobby will now respond to every message sent in this channel.`
    });
    return true;
  }

  // 15. !unban <id> [reason]
  if (cmd === 'unban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
      await message.reply({ content: 'You need `BanMembers` permission to unban members.' });
      return true;
    }
    const targetId = args[1]?.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d{17,20}$/.test(targetId)) {
      await message.reply({ content: 'Usage: `!unban <user_id> [reason]`' });
      return true;
    }
    const reason = args.slice(2).join(' ') || `Unbanned by ${message.author.tag}`;
    try {
      await message.guild.bans.remove(targetId, reason);
      await message.reply({ content: `Unbanned user ID \`${targetId}\`. Reason: ${reason}` });
    } catch (err) {
      await message.reply({ content: `Failed to unban user: ${err.message}` });
    }
    return true;
  }

  // 16. !untimeout / !unmute <@member>
  if (cmd === 'untimeout' || cmd === 'unmute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply({ content: 'You need `ModerateMembers` permission to remove timeouts.' });
      return true;
    }
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply({ content: 'Usage: `!untimeout <@member> [reason]`' });
      return true;
    }
    const reason = args.slice(2).join(' ') || `Timeout removed by ${message.author.tag}`;
    try {
      await target.timeout(null, reason);
      await message.reply({ content: `Removed timeout for ${target.displayName}.` });
    } catch (err) {
      await message.reply({ content: `Failed to remove timeout: ${err.message}` });
    }
    return true;
  }

  // 17. !nick <@member> <newname | reset>
  if (cmd === 'nick' || cmd === 'nickname') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      await message.reply({ content: 'You need `ManageNicknames` permission to change nicknames.' });
      return true;
    }
    const target = message.mentions.members?.first();
    const newNick = args.slice(2).join(' ').trim();
    if (!target) {
      await message.reply({ content: 'Usage: `!nick <@member> <new_nickname | reset>`' });
      return true;
    }
    if (message.guild.ownerId !== message.member.id && message.member.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot change nickname of ${target.displayName} due to role hierarchy.` });
      return true;
    }
    const botMe = message.guild.members.me;
    if (botMe && botMe.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot change nickname of ${target.displayName} because their role is higher than or equal to mine.` });
      return true;
    }
    try {
      const finalNick = (newNick.toLowerCase() === 'reset' || !newNick) ? null : newNick.slice(0, 32);
      await target.setNickname(finalNick, `Changed by ${message.author.tag}`);
      await message.reply({ content: finalNick ? `Changed nickname of ${target.user.tag} to **${finalNick}**.` : `Reset nickname of ${target.user.tag}.` });
    } catch (err) {
      await message.reply({ content: `Failed to change nickname: ${err.message}` });
    }
    return true;
  }

  // 18. !softban <@member> [reason]
  if (cmd === 'softban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
      await message.reply({ content: 'You need `BanMembers` permission to softban members.' });
      return true;
    }
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply({ content: 'Usage: `!softban <@member> [reason]`' });
      return true;
    }
    if (message.guild.ownerId !== message.member.id && message.member.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot softban ${target.displayName} due to role hierarchy.` });
      return true;
    }
    const botMe = message.guild.members.me;
    if (botMe && botMe.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot softban ${target.displayName} due to bot role hierarchy.` });
      return true;
    }
    const reason = args.slice(2).join(' ') || 'Softban (purge messages)';
    try {
      await message.guild.members.ban(target.id, {
        deleteMessageSeconds: 7 * 24 * 60 * 60,
        reason: `Softban: ${reason}`
      });
      await message.guild.bans.remove(target.id, 'Softban automatic unban');
      await message.reply({ content: `Softbanned ${target.user.tag}. Messages from past 7 days deleted.` });
    } catch (err) {
      await message.reply({ content: `Failed to softban: ${err.message}` });
    }
    return true;
  }

  // 19. !history / !modlog <@member>
  if (cmd === 'history' || cmd === 'modlog') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to view moderation history.' });
      return true;
    }
    const target = message.mentions.members?.first() || message.member;
    const warns = getGuildWarnings(message.guild.id, target.id);
    const isMuted = target.isCommunicationDisabled?.();
    const mutedUntil = isMuted ? `<t:${Math.floor(target.communicationDisabledUntilTimestamp / 1000)}:R>` : 'None';

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Mod History — ${target.displayName} (${target.user.tag})`)
      .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'User ID', value: target.id, inline: true },
        { name: 'Active Timeout', value: isMuted ? `Yes (ends ${mutedUntil})` : 'None', inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Total Warnings', value: `${warns.length}`, inline: true }
      );

    if (warns.length > 0) {
      const list = warns.slice(0, 10).map((w, idx) => `${idx + 1}. \`${new Date(w.timestamp).toLocaleDateString()}\` by <@${w.moderatorId}>: ${w.reason}`).join('\n');
      embed.addFields({ name: 'Recent Infractions', value: list + (warns.length > 10 ? `\n*...and ${warns.length - 10} more*` : ''), inline: false });
    }

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 20. !lockdown (server-wide)
  if (cmd === 'lockdown') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only administrators or staff with `ManageGuild` can initiate a server-wide lockdown.' });
      return true;
    }
    const channels = await message.guild.channels.fetch();
    const lockedIds = [];
    for (const [id, ch] of channels) {
      if (ch && ch.isTextBased() && ch.permissionsFor(message.guild.roles.everyone).has(PermissionFlagsBits.SendMessages)) {
        try {
          await ch.permissionOverwrites.edit(message.guild.roles.everyone, {
            SendMessages: false
          });
          lockedIds.push(id);
        } catch (_) {}
      }
    }
    setGuildLockdown(message.guild.id, lockedIds);
    await message.reply({ content: `**Server Lockdown Initiated**: Locked ${lockedIds.length} public channel(s). Run \`!unlockall\` when the emergency is resolved.` });
    return true;
  }

  // 21. !unlockall (server-wide)
  if (cmd === 'unlockall') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only administrators or staff with `ManageGuild` can lift a server-wide lockdown.' });
      return true;
    }
    const lockedIds = getGuildLockdown(message.guild.id);
    let unlockedCount = 0;
    const channels = await message.guild.channels.fetch();
    for (const id of lockedIds) {
      const ch = channels.get(id);
      if (ch && ch.isTextBased()) {
        try {
          await ch.permissionOverwrites.edit(message.guild.roles.everyone, {
            SendMessages: null
          });
          unlockedCount++;
        } catch (_) {}
      }
    }
    setGuildLockdown(message.guild.id, []);
    await message.reply({ content: `**Server Lockdown Lifted**: Unlocked ${unlockedCount} channel(s).` });
    return true;
  }

  // 22. !hide [#channel]
  if (cmd === 'hide') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'You need `ManageChannels` permission to hide channels.' });
      return true;
    }
    const targetChannel = message.mentions.channels?.first() || message.channel;
    try {
      await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, {
        ViewChannel: false
      });
      await message.reply({ content: `Hidden #${targetChannel.name} from @everyone.` });
    } catch (err) {
      await message.reply({ content: `Failed to hide channel: ${err.message}` });
    }
    return true;
  }

  // 23. !unhide [#channel]
  if (cmd === 'unhide') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'You need `ManageChannels` permission to unhide channels.' });
      return true;
    }
    const targetChannel = message.mentions.channels?.first() || message.channel;
    try {
      await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, {
        ViewChannel: null
      });
      await message.reply({ content: `Unhidden #${targetChannel.name} for @everyone.` });
    } catch (err) {
      await message.reply({ content: `Failed to unhide channel: ${err.message}` });
    }
    return true;
  }

  // 24. !nuke
  if (cmd === 'nuke') {
    if (!isOwnerOrAdmin(message.member, message.guild) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'Only Administrators or managers with `ManageChannels` can nuke channels.' });
      return true;
    }
    const ch = message.channel;
    try {
      const position = ch.position;
      const cloned = await ch.clone({
        name: ch.name,
        reason: `Nuked by ${message.author.tag}`
      });

      await ch.delete(`Nuked by ${message.author.tag}`);
      await cloned.setPosition(position).catch(() => null);
      await cloned.send({ content: `Channel was nuked by <@${message.author.id}>.` });
    } catch (err) {
      await message.reply({ content: `Failed to nuke channel: ${err.message}` });
    }
    return true;
  }

  // 25. !audit
  if (cmd === 'audit') {
    if (!isOwnerOrAdmin(message.member, message.guild)) {
      await message.reply({ content: 'Only the Server Owner or an Administrator can run server security audit.' });
      return true;
    }
    const g = message.guild;
    const members = await g.members.fetch().catch(() => new Map());
    const admins = members.filter((m) => m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot);
    const botAdmins = members.filter((m) => m.permissions.has(PermissionFlagsBits.Administrator) && m.user.bot);
    const botMe = g.members.me;

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Security Audit — ${g.name}`)
      .addFields(
        { name: 'Human Administrators', value: admins.map((m) => `<@${m.id}>`).join(', ') || 'Owner only', inline: false },
        { name: 'Bot Administrators', value: botAdmins.map((m) => `<@${m.id}>`).join(', ') || 'None', inline: false },
        { name: 'Bobby Role Position', value: `Position ${botMe?.roles.highest.position || 0} (${botMe?.roles.highest.name || 'None'})`, inline: true },
        { name: '2FA Requirement', value: g.mfaLevel === 1 ? 'Enabled' : 'Disabled', inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 26. !emojis / !emojilist
  if (cmd === 'emojis' || cmd === 'emojilist') {
    const emojis = await message.guild.emojis.fetch();
    if (emojis.size === 0) {
      await message.reply({ content: 'No custom emojis uploaded on this server yet.' });
      return true;
    }
    const staticList = emojis.filter((e) => !e.animated);
    const animatedList = emojis.filter((e) => Boolean(e.animated));
    const preview = emojis.map((e) => `${e}`).slice(0, 50).join(' ');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Server Emojis — ${message.guild.name}`)
      .setDescription(preview || 'None')
      .addFields(
        { name: 'Total', value: `${emojis.size}`, inline: true },
        { name: 'Static', value: `${staticList.size}`, inline: true },
        { name: 'Animated', value: `${animatedList.size}`, inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 27. !enlarge / !jumbo <emoji>
  if (cmd === 'enlarge' || cmd === 'jumbo') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!enlarge <:emojiname:id>`' });
      return true;
    }
    const match = rest.match(/<(a?):(\w+):(\d+)>/);
    if (!match) {
      await message.reply({ content: 'Please provide a valid custom Discord emoji (e.g. `!enlarge :meimei_vro:`).' });
      return true;
    }
    const isAnimated = Boolean(match[1]);
    const emojiName = match[2];
    const emojiId = match[3];
    const ext = isAnimated ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=1024`;

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Emoji: :${emojiName}:`)
      .setImage(url)
      .setDescription(`[Direct Link](${url})`);
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 28. !addemoji / !uploademoji <name> <url>
  if (cmd === 'addemoji' || cmd === 'uploademoji') {
    if (!isStaffMember(message.member, message.guild)) {
      await message.reply({ content: 'You need staff permissions to add emojis.' });
      return true;
    }
    let name = args[1];
    let imageUrl = args[2] || message.attachments?.first()?.url;
    if (!name || !imageUrl) {
      await message.reply({ content: 'Usage: `!addemoji <name> <image_url_or_attachment>`' });
      return true;
    }
    name = name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
    if (name.length < 2) {
      await message.reply({ content: 'Emoji name must be between 2 and 32 alphanumeric/underscore characters.' });
      return true;
    }
    try {
      const created = await message.guild.emojis.create({
        attachment: imageUrl,
        name,
        reason: `Added by ${message.author.tag} via !addemoji`
      });
      await message.reply({ content: `Uploaded custom emoji: ${created} (\`:${created.name}:\`)` });
    } catch (err) {
      await message.reply({ content: `Failed to create emoji: ${err.message}` });
    }
    return true;
  }

  // 29. !roles / !rolelist
  if (cmd === 'roles' || cmd === 'rolelist') {
    const roles = await message.guild.roles.fetch();
    const sorted = roles
      .filter((r) => r.id !== message.guild.id)
      .sort((a, b) => b.position - a.position);

    if (sorted.size === 0) {
      await message.reply({ content: 'No custom roles found on this server.' });
      return true;
    }

    const lines = sorted.map((r) => `<@&${r.id}> (${r.members.size} members)`).slice(0, 35);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Server Roles (${sorted.size}) — ${message.guild.name}`)
      .setDescription(lines.join('\n') + (sorted.size > 35 ? `\n*...and ${sorted.size - 35} more*` : ''));
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 30. !roleinfo <role>
  if (cmd === 'roleinfo') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!roleinfo <@role | role_name | role_id>`' });
      return true;
    }
    const roles = await message.guild.roles.fetch();
    const cleanQuery = rest.replace(/[<@&>]/g, '').trim().toLowerCase();
    const role = roles.get(cleanQuery) || roles.find((r) => r.name.toLowerCase() === cleanQuery || r.name.toLowerCase().includes(cleanQuery));

    if (!role) {
      await message.reply({ content: `Role "${rest}" not found.` });
      return true;
    }

    const embed = new EmbedBuilder()
      .setColor(role.hexColor === '#000000' ? '#5865F2' : role.hexColor)
      .setTitle(`Role Info — ${role.name}`)
      .addFields(
        { name: 'ID', value: role.id, inline: true },
        { name: 'Color', value: role.hexColor, inline: true },
        { name: 'Position', value: `${role.position}`, inline: true },
        { name: 'Members', value: `${role.members.size}`, inline: true },
        { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 31. !giverole <@member> <role>
  if (cmd === 'giverole' || cmd === 'addrole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await message.reply({ content: 'You need `ManageRoles` permission to assign roles.' });
      return true;
    }
    const target = message.mentions.members?.first();
    const roleArg = args.slice(2).join(' ').trim();
    if (!target || !roleArg) {
      await message.reply({ content: 'Usage: `!giverole <@member> <@role | role_name>`' });
      return true;
    }
    const cleanRoleId = roleArg.replace(/[<@&>]/g, '').trim().toLowerCase();
    const roles = await message.guild.roles.fetch();
    const role = roles.get(cleanRoleId) || roles.find((r) => r.name.toLowerCase() === cleanRoleId || r.name.toLowerCase().includes(cleanRoleId));
    if (!role) {
      await message.reply({ content: `Role "${roleArg}" was not found.` });
      return true;
    }
    if (role.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply({ content: 'Cannot assign Administrator role via command.' });
      return true;
    }
    const botMe = message.guild.members.me;
    if (botMe && botMe.roles.highest.position <= role.position) {
      await message.reply({ content: `Cannot assign ${role.name} because it is higher than or equal to my highest role.` });
      return true;
    }
    if (message.member.roles.highest.position <= role.position && message.guild.ownerId !== message.member.id) {
      await message.reply({ content: `Cannot assign ${role.name} because it is higher than or equal to your highest role.` });
      return true;
    }
    await target.roles.add(role, `Assigned by ${message.author.tag} via !giverole`);
    await message.reply({ content: `Added role **${role.name}** to ${target.displayName}.` });
    return true;
  }

  // 32. !takerole <@member> <role>
  if (cmd === 'takerole' || cmd === 'removerole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await message.reply({ content: 'You need `ManageRoles` permission to remove roles.' });
      return true;
    }
    const target = message.mentions.members?.first();
    const roleArg = args.slice(2).join(' ').trim();
    if (!target || !roleArg) {
      await message.reply({ content: 'Usage: `!takerole <@member> <@role | role_name>`' });
      return true;
    }
    const cleanRoleId = roleArg.replace(/[<@&>]/g, '').trim().toLowerCase();
    const roles = await message.guild.roles.fetch();
    const role = roles.get(cleanRoleId) || roles.find((r) => r.name.toLowerCase() === cleanRoleId || r.name.toLowerCase().includes(cleanRoleId));
    if (!role) {
      await message.reply({ content: `Role "${roleArg}" was not found.` });
      return true;
    }
    const botMe = message.guild.members.me;
    if (botMe && botMe.roles.highest.position <= role.position) {
      await message.reply({ content: `Cannot remove ${role.name} due to role hierarchy.` });
      return true;
    }
    if (message.member.roles.highest.position <= role.position && message.guild.ownerId !== message.member.id) {
      await message.reply({ content: `Cannot remove ${role.name} because it is higher than or equal to your highest role.` });
      return true;
    }
    await target.roles.remove(role, `Removed by ${message.author.tag} via !takerole`);
    await message.reply({ content: `Removed role **${role.name}** from ${target.displayName}.` });
    return true;
  }

  // 33. !channelinfo [#channel]
  if (cmd === 'channelinfo') {
    const ch = message.mentions.channels?.first() || message.channel;
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Channel Info — #${ch.name}`)
      .addFields(
        { name: 'ID', value: ch.id, inline: true },
        { name: 'Type', value: `${ch.type}`, inline: true },
        { name: 'Category', value: ch.parent ? ch.parent.name : 'None', inline: true },
        { name: 'Topic', value: ch.topic || 'No topic set', inline: false },
        { name: 'Slowmode', value: ch.rateLimitPerUser ? `${ch.rateLimitPerUser}s` : 'None', inline: true },
        { name: 'Created', value: `<t:${Math.floor(ch.createdTimestamp / 1000)}:R>`, inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 34. !members / !membercount
  if (cmd === 'members' || cmd === 'membercount') {
    const g = message.guild;
    const total = g.memberCount;
    const cachedMembers = g.members.cache;
    const bots = cachedMembers.filter((m) => m.user.bot).size;
    const humans = Math.max(total - bots, 0);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Member Statistics — ${g.name}`)
      .addFields(
        { name: 'Total Members', value: `${total}`, inline: true },
        { name: 'Humans', value: `${humans}`, inline: true },
        { name: 'Bots', value: `${bots}`, inline: true }
      );
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 35. !poll <question> [| opt1 | opt2]
  if (cmd === 'poll') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!poll <question>` or `!poll <question> | <option 1> | <option 2> | ...`' });
      return true;
    }
    if (rest.includes('|')) {
      const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
      const question = parts[0];
      const options = parts.slice(1, 10);
      if (options.length < 2) {
        await message.reply({ content: 'Please provide at least 2 options when using `|`.' });
        return true;
      }
      const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
      const desc = options.map((opt, i) => `${numberEmojis[i]} ${opt}`).join('\n\n');
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(question)
        .setDescription(desc)
        .setFooter({ text: `Poll started by ${message.author.username}` });

      const pollMsg = await message.channel.send({ embeds: [embed] });
      for (let i = 0; i < options.length; i++) {
        await pollMsg.react(numberEmojis[i]).catch(() => null);
      }
    } else {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(rest)
        .setFooter({ text: `Poll started by ${message.author.username}` });

      const pollMsg = await message.channel.send({ embeds: [embed] });
      await pollMsg.react('👍').catch(() => null);
      await pollMsg.react('👎').catch(() => null);
    }
    return true;
  }

  // 36. !choose <opt1> | <opt2>
  if (cmd === 'choose' || cmd === 'pick') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!choose <opt1> | <opt2> | <opt3>`' });
      return true;
    }
    const sep = rest.includes('|') ? '|' : ',';
    const items = rest.split(sep).map((s) => s.trim()).filter(Boolean);
    if (items.length < 2) {
      await message.reply({ content: 'Please give at least two choices separated by `|`.' });
      return true;
    }
    const chosen = items[Math.floor(Math.random() * items.length)];
    await message.reply({ content: `I choose: **${chosen}**` });
    return true;
  }

  // 37. !lock
  if (cmd === 'lock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'You need `ManageChannels` permission to lock channels.' });
      return true;
    }
    try {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: false
      });
      await message.reply({ content: `Locked #${message.channel.name}. Members cannot send messages here.` });
    } catch (err) {
      await message.reply({ content: `Failed to lock channel: ${err.message}` });
    }
    return true;
  }

  // 38. !unlock
  if (cmd === 'unlock') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'You need `ManageChannels` permission to unlock channels.' });
      return true;
    }
    try {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: null
      });
      await message.reply({ content: `Unlocked #${message.channel.name}.` });
    } catch (err) {
      await message.reply({ content: `Failed to unlock channel: ${err.message}` });
    }
    return true;
  }

  // 39. !warn <@member> [reason]
  if (cmd === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply({ content: 'You need `ModerateMembers` permission to warn members.' });
      return true;
    }
    const target = message.mentions.members?.first();
    const reason = args.slice(2).join(' ').trim() || 'No reason provided';
    if (!target) {
      await message.reply({ content: 'Usage: `!warn <@member> [reason]`' });
      return true;
    }
    const warns = addGuildWarning(message.guild.id, target.id, {
      reason,
      moderatorId: message.author.id,
      timestamp: Date.now()
    });
    await message.reply({ content: `Warned ${target.displayName} (Total warnings: **${warns.length}**). Reason: ${reason}` });
    return true;
  }

  // 40. !warnings <@member>
  if (cmd === 'warnings' || cmd === 'warns') {
    const target = message.mentions.members?.first() || message.member;
    const warns = getGuildWarnings(message.guild.id, target.id);
    if (warns.length === 0) {
      await message.reply({ content: `${target.displayName} has zero warnings.` });
      return true;
    }
    const lines = warns.map((w, idx) => `${idx + 1}. \`${new Date(w.timestamp).toLocaleDateString()}\` by <@${w.moderatorId}>: ${w.reason}`);
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Warnings for ${target.displayName} (${warns.length})`)
      .setDescription(lines.join('\n'));
    await message.reply({ embeds: [embed] });
    return true;
  }

  // 41. !clearwarns <@member>
  if (cmd === 'clearwarns' || cmd === 'clearwarnings') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply({ content: 'You need `ModerateMembers` permission to clear warnings.' });
      return true;
    }
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply({ content: 'Usage: `!clearwarns <@member>`' });
      return true;
    }
    const count = clearGuildWarnings(message.guild.id, target.id);
    await message.reply({ content: `Cleared **${count}** warning(s) for ${target.displayName}.` });
    return true;
  }

  // 42. !remind <duration> <note> (Persistent across bot restarts)
  if (cmd === 'remind' || cmd === 'remindme') {
    const timeStr = args[1];
    const reminderNote = args.slice(2).join(' ').trim();
    if (!timeStr || !reminderNote) {
      await message.reply({ content: 'Usage: `!remind <duration> <message>` (e.g. `!remind 10m study MI`, `!remind 1h check bot`)' });
      return true;
    }
    const match = timeStr.match(/^(\d+)([smhd])$/i);
    if (!match) {
      await message.reply({ content: 'Invalid time format. Use `30s`, `10m`, `2h`, or `1d`.' });
      return true;
    }
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    const delayMs = num * multipliers[unit];

    if (delayMs > 7 * 24 * 60 * 60 * 1000) {
      await message.reply({ content: 'Maximum reminder time is 7 days.' });
      return true;
    }

    const reminderId = 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const dueAt = Date.now() + delayMs;

    addGuildReminder(message.guild.id, {
      id: reminderId,
      channelId: message.channel.id,
      userId: message.author.id,
      note: reminderNote,
      dueAt
    });

    await message.reply({ content: `Reminder set for ${timeStr}: "${reminderNote}". Persisted across restarts.` });

    const channelId = message.channel.id;
    const authorId = message.author.id;
    const guildId = message.guild.id;

    setTimeout(async () => {
      try {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          await ch.send({
            content: `<@${authorId}> **Reminder:** ${reminderNote}`,
            allowedMentions: { users: [authorId] }
          });
        }
      } catch (err) {
        console.error('[Reminder Error]', err.message);
      } finally {
        removeGuildReminder(guildId, reminderId);
      }
    }, delayMs);

    return true;
  }

  // 43. !tole / !vro
  if (cmd === 'tole' || cmd === 'vro') {
    const quotes = [
      'vro...',
      'Zero thoughts, maximum visual contact.',
      'Looking respectfully at the server.',
      'Tole tole paws up in the air.',
      'Saucer eyes locked onto target vro.',
      'No thoughts head empty just tole tole.',
      'Purrito mode activated.',
      'Running at full speed into VC with tragic music playing.'
    ];
    const quote = quotes[Math.floor(Math.random() * quotes.length)];
    const meimeiEmojis = message.guild.emojis?.cache?.filter((e) => e.name.startsWith('meimei_'));
    const chosenEmoji = meimeiEmojis && meimeiEmojis.size > 0
      ? Array.from(meimeiEmojis.values())[Math.floor(Math.random() * meimeiEmojis.size)]
      : message.guild.emojis?.cache?.first?.();
    const prefix = chosenEmoji ? `${chosenEmoji} ` : '';
    await message.reply({ content: `${prefix}${quote}` });
    return true;
  }

  // 44. !serverinfo / ?serverinfo
  if (cmd === 'serverinfo') {
    const g = message.guild;
    const channels = await g.channels.fetch().catch(() => new Map());
    const roles = await g.roles.fetch().catch(() => new Map());

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(g.name)
      .setThumbnail(g.iconURL({ dynamic: true }))
      .addFields(
        { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
        { name: 'Members', value: `${g.memberCount}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Channels', value: `${channels.size}`, inline: true },
        { name: 'Roles', value: `${roles.size}`, inline: true },
        { name: 'Boost Level', value: `Tier ${g.premiumTier} (${g.premiumSubscriptionCount || 0} boosts)`, inline: true }
      );

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 45. !userinfo / ?userinfo [@user]
  if (cmd === 'userinfo' || cmd === 'whois') {
    const target = message.mentions.members?.first() || message.member;
    const u = target.user;
    const roles = target.roles.cache.filter((r) => r.id !== message.guild.id).map((r) => `<@&${r.id}>`).join(' ') || 'None';

    const embed = new EmbedBuilder()
      .setColor(target.displayHexColor || '#5865F2')
      .setTitle(u.username)
      .setThumbnail(u.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'ID', value: u.id, inline: true },
        { name: 'Nickname', value: target.displayName, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Created Account', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Highest Role', value: target.roles.highest.name, inline: true },
        { name: 'Bot?', value: u.bot ? 'Yes' : 'No', inline: true },
        { name: 'Roles', value: roles.slice(0, 1024), inline: false }
      );

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 46. !avatar / ?avatar [@user]
  if (cmd === 'avatar') {
    const target = message.mentions.users?.first() || message.author;
    const url = target.displayAvatarURL({ dynamic: true, size: 1024 });
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`Avatar of ${target.username}`)
      .setImage(url)
      .setDescription(`[Direct Link](${url})`);

    await message.reply({ embeds: [embed] });
    return true;
  }

  // 47. !purge / ?purge <count>
  if (cmd === 'purge' || cmd === 'clear') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply({ content: 'You need `ManageMessages` permission to purge messages.' });
      return true;
    }
    const count = parseInt(args[1], 10);
    if (isNaN(count) || count < 1 || count > 100) {
      await message.reply({ content: 'Usage: `!purge <1-100>`' });
      return true;
    }
    try {
      await message.delete().catch(() => null);
      const deleted = await message.channel.bulkDelete(count, true);
      const msg = await message.channel.send(`Cleared **${deleted.size}** messages.`);
      setTimeout(() => msg.delete().catch(() => null), 3000);
    } catch (err) {
      await message.channel.send(`Failed to purge: ${err.message}`);
    }
    return true;
  }

  // 48. !timeout / ?timeout <@member> <minutes> [reason]
  if (cmd === 'timeout' || cmd === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply({ content: 'You need `ModerateMembers` permission to timeout members.' });
      return true;
    }
    const target = message.mentions.members?.first();
    const mins = parseInt(args[2], 10);
    if (!target || isNaN(mins) || mins < 1) {
      await message.reply({ content: 'Usage: `!timeout <@member> <minutes> [reason]`' });
      return true;
    }
    if (!target.moderatable || message.member.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot timeout ${target.displayName} due to role hierarchy.` });
      return true;
    }
    const reason = args.slice(3).join(' ') || 'Moderator timeout';
    await target.timeout(mins * 60 * 1000, reason);
    await message.reply({ content: `Timed out ${target} for **${mins}** minute(s). Reason: ${reason}` });
    return true;
  }

  // 49. !kick / ?kick <@member> [reason]
  if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
      await message.reply({ content: 'You need `KickMembers` permission to kick members.' });
      return true;
    }
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply({ content: 'Usage: `!kick <@member> [reason]`' });
      return true;
    }
    if (!target.kickable || message.member.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot kick ${target.displayName} due to role hierarchy.` });
      return true;
    }
    const reason = args.slice(2).join(' ') || 'Moderator kick';
    await target.kick(reason);
    await message.reply({ content: `Kicked ${target.user.tag}. Reason: ${reason}` });
    return true;
  }

  // 50. !ban / ?ban <@member> [reason]
  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
      await message.reply({ content: 'You need `BanMembers` permission to ban members.' });
      return true;
    }
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply({ content: 'Usage: `!ban <@member> [reason]`' });
      return true;
    }
    if (!target.bannable || message.member.roles.highest.position <= target.roles.highest.position) {
      await message.reply({ content: `Cannot ban ${target.displayName} due to role hierarchy.` });
      return true;
    }
    const reason = args.slice(2).join(' ') || 'Moderator ban';
    await target.ban({ reason });
    await message.reply({ content: `Banned ${target.user.tag}. Reason: ${reason}` });
    return true;
  }

  // 51. !slowmode / ?slowmode <seconds | off>
  if (cmd === 'slowmode') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply({ content: 'You need `ManageChannels` permission to set slowmode.' });
      return true;
    }
    if (args[1]?.toLowerCase() === 'off' || args[1] === '0') {
      await message.channel.setRateLimitPerUser(0);
      await message.reply({ content: `Slowmode turned off in #${message.channel.name}.` });
      return true;
    }
    const secs = parseInt(args[1], 10);
    if (isNaN(secs) || secs < 0 || secs > 21600) {
      await message.reply({ content: 'Usage: `!slowmode <seconds | off>` (0 to 21600)' });
      return true;
    }
    await message.channel.setRateLimitPerUser(secs);
    await message.reply({ content: `Slowmode set to **${secs}s** in #${message.channel.name}.` });
    return true;
  }

  // 52. !flip / ?flip
  if (cmd === 'flip') {
    const coin = Math.random() < 0.5 ? '**Heads**' : '**Tails**';
    await message.reply({ content: coin });
    return true;
  }

  // 53. !roll / ?roll [sides]
  if (cmd === 'roll') {
    const sides = parseInt(args[1], 10) || 6;
    const roll = Math.floor(Math.random() * Math.max(sides, 1)) + 1;
    await message.reply({ content: `You rolled a **${roll}** (1-${sides}).` });
    return true;
  }

  // 54. !8ball / ?8ball <question>
  if (cmd === '8ball') {
    if (!rest) {
      await message.reply({ content: 'Ask a question. E.g. `!8ball will I pass my exams?`' });
      return true;
    }
    const answers = [
      'It is certain.',
      'Without a doubt.',
      'Yes, absolutely.',
      'Signs point to yes.',
      'Reply hazy, ask again.',
      'Better not tell you now.',
      'Cannot predict now.',
      'Don\'t count on it.',
      'My sources say no.',
      'Outlook not so good.',
      'Very doubtful.'
    ];
    const pick = answers[Math.floor(Math.random() * answers.length)];
    await message.reply({ content: pick });
    return true;
  }

  // 55. !ask / ?ask / !bobby / ?bobby <query>
  if (cmd === 'ask' || cmd === 'bobby') {
    if (!rest) {
      await message.reply({ content: 'Usage: `!ask <your question or order>`' });
      return true;
    }
    return 'ROUTE_TO_AGENT';
  }

  return false;
}
