import { PermissionFlagsBits } from 'discord.js';
import { guildScope } from '../discord/client.js';
import {
  toolsRegistry,
  getToolsForMember,
  assertMemberToolAccess,
  isOwnerOrAdmin,
  isStaffMember
} from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { getOpenAIClient, getAIConfig } from './config.js';
import { resolveMemberId } from '../discord/ops.js';
import { getSnapshot } from '../discord/snapshot.js';
import { log } from '../util/log.js';

// Rolling per-channel+caller conversation store with TTL cleanup
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 16;
const CONVERSATION_TTL_MS = 30 * 60 * 1000;

function pruneStaleConversations() {
  const now = Date.now();
  for (const [key, entry] of conversations.entries()) {
    if (now - entry.updatedAt > CONVERSATION_TTL_MS) {
      conversations.delete(key);
    }
  }
}

export function getConversation(sessionKey) {
  pruneStaleConversations();
  if (!conversations.has(sessionKey)) {
    conversations.set(sessionKey, { messages: [], updatedAt: Date.now() });
  }
  const entry = conversations.get(sessionKey);
  entry.updatedAt = Date.now();
  return entry.messages;
}

function trimHistory(messages) {
  while (messages.length > MAX_HISTORY_MESSAGES) {
    messages.shift();
  }
  while (messages.length > 0 && messages[0].role === 'tool') {
    messages.shift();
  }
}

function truncateString(str, max = 4000) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '... [truncated]';
}

function stripThinkTags(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Safely resolves tool names even if a model emits a repeated name (e.g. "create_channelcreate_channel").
 * Does NOT do loose substring matching so unrelated tools are never confused.
 */
export function resolveToolName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (toolsRegistry.has(trimmed)) return trimmed;

  for (const known of toolsRegistry.keys()) {
    if (trimmed === known + known) {
      return known;
    }
  }

  return trimmed;
}

/**
 * Safely parse JSON or split multiple concatenated JSON objects emitted by some models.
 */
export function parseAndSplitToolArguments(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'string') return [{}];
  const trimmed = rawArgs.trim();
  if (!trimmed) return [{}];

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return [parsed];
    }
  } catch (_) {}

  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          const chunk = trimmed.slice(start, i + 1);
          try {
            const obj = JSON.parse(chunk);
            if (typeof obj === 'object' && obj !== null) {
              objects.push(obj);
            }
          } catch (_) {}
          start = -1;
        }
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

function sanitizeMessagesForProvider(messages = []) {
  const sanitized = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const cleanToolCalls = [];
      for (const tc of msg.tool_calls) {
        const argsStr = tc.function?.arguments || '{}';
        const cleanName = resolveToolName(tc.function?.name) || tc.function?.name;
        try {
          JSON.parse(argsStr);
          cleanToolCalls.push({
            ...tc,
            function: { ...tc.function, name: cleanName }
          });
        } catch (_) {
          const extracted = parseAndSplitToolArguments(argsStr);
          if (extracted && extracted[0]) {
            cleanToolCalls.push({
              ...tc,
              function: { name: cleanName, arguments: JSON.stringify(extracted[0]) }
            });
          }
        }
      }
      sanitized.push({
        ...msg,
        tool_calls: cleanToolCalls.length > 0 ? cleanToolCalls : undefined
      });
    } else {
      sanitized.push(msg);
    }
  }
  return sanitized;
}

function checkPermissionListSubset(member, permNames = []) {
  if (!Array.isArray(permNames) || permNames.length === 0) return { ok: true };
  for (const permName of permNames) {
    const flag = PermissionFlagsBits[permName];
    if (flag === undefined || !member.permissions?.has(flag)) {
      return {
        ok: false,
        error: `You cannot grant or modify the '${permName}' permission because you lack '${permName}' yourself.`
      };
    }
  }
  return { ok: true };
}

async function resolveRoleObject(guild, roleIdentifier) {
  if (!roleIdentifier || !guild?.roles) return null;
  const cleaned = String(roleIdentifier).trim();
  if (cleaned === '@everyone' || cleaned === guild.id) {
    return guild.roles.fetch(guild.id).catch(() => null);
  }
  if (/^\d{17,20}$/.test(cleaned)) {
    return guild.roles.fetch(cleaned).catch(() => null);
  }
  const roles = await guild.roles.fetch().catch(() => null);
  if (!roles) return null;
  const target = cleaned.replace(/^@/, '').toLowerCase();
  return roles.find((r) => r.name.toLowerCase() === target || r.name.toLowerCase() === cleaned.toLowerCase()) || null;
}

async function checkCallerCanViewChannel(member, guild, channelIdentifier) {
  if (!channelIdentifier || !guild?.channels) return { ok: true };
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return { ok: true };
  const cleaned = String(channelIdentifier).trim().replace(/^#/, '').toLowerCase();
  const ch = channels.find(
    (c) => c && (String(c.id) === String(channelIdentifier).trim() || c.name.toLowerCase() === cleaned)
  );
  if (ch && ch.permissionsFor) {
    const permsInChannel = ch.permissionsFor(member);
    if (!permsInChannel || !permsInChannel.has(PermissionFlagsBits.ViewChannel)) {
      return { ok: false, error: `You lack permission to view #${ch.name} on this server.` };
    }
  }
  return { ok: true };
}

/**
 * Prevent horizontal/upward privilege escalation when non-owner/non-admin staff
 * invoke tools through Bobby.
 */
export async function assertTargetScopeForCaller(member, guild, toolName, args = {}) {
  if (!member || !guild) return { ok: true };
  if (guild.ownerId === member.id) return { ok: true };

  const isCallerAdmin = Boolean(member.permissions?.has(PermissionFlagsBits.Administrator));
  const callerTopPos = member.roles?.highest?.position ?? 0;

  // 1. Member-targeting hierarchy check
  const memberTargetField =
    args.member_id ? 'member_id' :
    args.user_id ? 'user_id' :
    null;

  if (memberTargetField && ['timeout_member', 'kick_member', 'ban_member', 'set_member_nickname', 'assign_member_role', 'remove_member_role'].includes(toolName)) {
    const resolvedId = await resolveMemberId(guild, args[memberTargetField]).catch(() => null);
    if (resolvedId) {
      const targetMember = await guild.members.fetch(resolvedId).catch(() => null);
      if (targetMember) {
        if (targetMember.id === guild.ownerId) {
          return { ok: false, error: 'Cannot target the Server Owner.' };
        }
        // Only allow self-targeting for nickname changes; moderation & role grants on peers/seniors are blocked
        const allowSelf = toolName === 'set_member_nickname' && targetMember.id === member.id;
        if (!isCallerAdmin && !allowSelf && targetMember.id !== member.id && callerTopPos <= targetMember.roles.highest.position) {
          return {
            ok: false,
            error: `You cannot target "${targetMember.user.username}" because their highest role is at or above yours.`
          };
        }
      }
    }
  }

  if (isCallerAdmin) {
    return { ok: true };
  }

  // 2. Role hierarchy & permission subset checks for non-admin ManageRoles callers
  const checkTargetRole = async (roleIdent) => {
    const role = await resolveRoleObject(guild, roleIdent);
    if (!role) return { ok: true };
    if (role.id === guild.id) {
      return { ok: false, error: 'Only the Server Owner or an Administrator can modify @everyone permissions.' };
    }
    if (role.permissions?.has(PermissionFlagsBits.Administrator)) {
      return { ok: false, error: `Cannot assign, modify, or delete Administrator role "${role.name}".` };
    }
    if (callerTopPos <= role.position) {
      return {
        ok: false,
        error: `Cannot manage role "${role.name}" because it is positioned at or above your highest role.`
      };
    }
    // Caller must possess all permissions already on a role before assigning it
    if (role.permissions) {
      const missingBit = member.permissions ? role.permissions.missing(member.permissions) : ['Administrator'];
      if (missingBit.length > 0) {
        return {
          ok: false,
          error: `Cannot manage or assign role "${role.name}" because it grants permissions you do not hold (${missingBit[0]}).`
        };
      }
    }
    return { ok: true };
  };

  if (['assign_member_role', 'remove_member_role', 'edit_role', 'delete_role'].includes(toolName) && args.role_id) {
    const rc = await checkTargetRole(args.role_id);
    if (!rc.ok) return rc;
  }

  if (toolName === 'batch_delete_roles' && Array.isArray(args.role_ids)) {
    for (const rid of args.role_ids) {
      const rc = await checkTargetRole(rid);
      if (!rc.ok) return rc;
    }
  }

  if (toolName === 'batch_edit_roles' && Array.isArray(args.roles)) {
    for (const r of args.roles) {
      const rc = await checkTargetRole(r.role_id);
      if (!rc.ok) return rc;
      const pc = checkPermissionListSubset(member, r.permissions);
      if (!pc.ok) return pc;
    }
  }

  if ((toolName === 'create_role' || toolName === 'edit_role') && args.permissions) {
    const pc = checkPermissionListSubset(member, args.permissions);
    if (!pc.ok) return pc;
  }

  if (toolName === 'batch_create_roles' && Array.isArray(args.roles)) {
    for (const r of args.roles) {
      const pc = checkPermissionListSubset(member, r.permissions);
      if (!pc.ok) return pc;
    }
  }

  // 3. Overwrite permission subset + channel visibility checks
  if (toolName === 'set_channel_permissions') {
    const vc = await checkCallerCanViewChannel(member, guild, args.channel_id);
    if (!vc.ok) return vc;
    const pc = checkPermissionListSubset(member, [...(args.allow || []), ...(args.deny || [])]);
    if (!pc.ok) return pc;
  }

  if (toolName === 'batch_set_channel_permissions' && Array.isArray(args.overwrites)) {
    for (const ow of args.overwrites) {
      const vc = await checkCallerCanViewChannel(member, guild, ow.channel_id);
      if (!vc.ok) return vc;
      const pc = checkPermissionListSubset(member, [...(ow.allow || []), ...(ow.deny || [])]);
      if (!pc.ok) return pc;
    }
  }

  // 4. Channel visibility checks across single & batch channel/message/webhook tools
  const channelTargets = [];
  if (args.channel_id) channelTargets.push(args.channel_id);
  if (args.channel) channelTargets.push(args.channel);
  if (Array.isArray(args.channel_ids)) channelTargets.push(...args.channel_ids);
  if (Array.isArray(args.channels)) {
    for (const c of args.channels) {
      if (c?.channel_id) channelTargets.push(c.channel_id);
    }
  }
  if (Array.isArray(args.moves)) {
    for (const m of args.moves) {
      if (m?.channel_id) channelTargets.push(m.channel_id);
    }
  }
  if (Array.isArray(args.messages)) {
    for (const m of args.messages) {
      if (m?.channel_id) channelTargets.push(m.channel_id);
    }
  }

  for (const chIdent of channelTargets) {
    const vc = await checkCallerCanViewChannel(member, guild, chIdent);
    if (!vc.ok) return vc;
  }

  return { ok: true };
}

const READ_ONLY_TOOLS = new Set([
  'read_channel_history',
  'get_guild_snapshot',
  'list_roles',
  'list_members',
  'list_bans',
  'get_channel_messages',
  'list_emojis',
  'list_stickers',
  'list_soundboard_sounds',
  'list_automod_rules',
  'list_webhooks',
  'list_integrations',
  'get_server_config',
  'recall_memory',
  'list_memories',
  'evaluate_math',
  'list_reaction_roles',
  'finish'
]);

/**
 * Run a single Discord turn for Bobby with dynamic permission mimicking.
 */
export async function runDiscordAgent({ userMessage, sessionKey, member, guild, channel }) {
  const targetGuildId = String(guild?.id || '');
  return guildScope.run(targetGuildId, async () => {
    // Dynamically lock process.env.DISCORD_GUILD_ID to the invoking guild
    if (targetGuildId) {
      process.env.DISCORD_GUILD_ID = targetGuildId;
    }

    const aiConfig = getAIConfig(guild?.id);
    const openai = getOpenAIClient({}, guild?.id);
    const model = aiConfig.model;

  const tools = getToolsForMember(member, guild, channel);
  const allowedToolNames = new Set(tools.map((t) => t.function.name));
  const staffCall = isStaffMember(member, guild);
  const callerLabel = `${member?.displayName || member?.user?.username || 'unknown'} (${member?.id || '?'})`;
  const channelLabel = channel?.name || channel?.id || 'unknown';
  log.info('agent', `start ${staffCall ? 'staff' : 'member'} ${callerLabel} #${channelLabel} tools=${tools.length} model=${model}`);

  const history = getConversation(sessionKey);
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS || '20', 10);
  let iteration = 0;
  let lastAssistantText = '';
  let finishedSummary = null;
  let cachedSnapshot = null;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    if (staffCall && !cachedSnapshot) {
      cachedSnapshot = await getSnapshot(guild?.id, member).catch(() => null);
    }

    const systemPrompt = await buildSystemPrompt({
      guild,
      member,
      channel,
      isStaffCall: staffCall,
      allowedToolNames,
      preloadedSnapshot: cachedSnapshot
    });

    const messages = sanitizeMessagesForProvider([
      { role: 'system', content: systemPrompt },
      ...history
    ]);

    const requestPayload = {
      model,
      messages,
      temperature: staffCall ? 0.3 : 0.7,
      max_tokens: staffCall ? 20000 : 2000
    };

    if (tools.length > 0) {
      requestPayload.tools = tools;
    }

    if (aiConfig.reasoningEffort && aiConfig.reasoningEffort !== 'none' && aiConfig.reasoningEffort !== 'off') {
      requestPayload.reasoning_effort = aiConfig.reasoningEffort;
    }

    let response;
    try {
      response = await openai.chat.completions.create(requestPayload);
    } catch (err) {
      if (requestPayload.reasoning_effort && (err.message?.includes('reasoning_effort') || err.code === 'unsupported_parameter')) {
        delete requestPayload.reasoning_effort;
        response = await openai.chat.completions.create(requestPayload);
      } else {
        log.error('agent', `LLM error for ${callerLabel}: ${err.message || err}`);
        throw err;
      }
    }

    const choice = response.choices?.[0]?.message;
    const rawContent = choice?.content || '';
    const cleanText = stripThinkTags(rawContent);
    if (cleanText) {
      lastAssistantText = cleanText;
    }

    const rawToolCalls = Array.isArray(choice?.tool_calls) ? choice.tool_calls : [];

    if (rawToolCalls.length === 0) {
      if (cleanText) {
        history.push({ role: 'assistant', content: cleanText });
        trimHistory(history);
      }
      break;
    }

    const formattedToolCalls = [];
    const parsedCallsToExecute = [];

    rawToolCalls.forEach((tc, idx) => {
      const toolName = resolveToolName(tc.function?.name) || tc.function?.name;
      const rawArgs = tc.function?.arguments || '{}';
      const parsedList = parseAndSplitToolArguments(rawArgs);

      if (!parsedList || parsedList.length === 0) {
        const callId = tc.id && tc.id.trim() !== '' ? tc.id : `call_${Date.now()}_${idx}`;
        formattedToolCalls.push({
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: rawArgs }
        });
        parsedCallsToExecute.push({
          id: callId,
          name: toolName,
          args: null,
          parseError: 'Invalid JSON arguments'
        });
      } else {
        parsedList.forEach((parsedObj, subIdx) => {
          const callId = parsedList.length === 1 && tc.id && tc.id.trim() !== ''
            ? tc.id
            : `call_${Date.now()}_${idx}_${subIdx}_${Math.random().toString(36).slice(2, 6)}`;
          const cleanArgsStr = JSON.stringify(parsedObj);
          formattedToolCalls.push({
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: cleanArgsStr }
          });
          parsedCallsToExecute.push({
            id: callId,
            name: toolName,
            args: parsedObj,
            parseError: null
          });
        });
      }
    });

    history.push({
      role: 'assistant',
      content: cleanText || null,
      tool_calls: formattedToolCalls
    });
    trimHistory(history);

    let mutatedServer = false;

    for (const callItem of parsedCallsToExecute) {
      const { id: callId, name: toolName, args: parsedArgs, parseError } = callItem;

      if (parseError) {
        log.warn('tool', `${toolName} skipped: ${parseError}`);
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ ok: false, error: parseError })
        });
        continue;
      }

      // Code-Level Execution Gate
      const access = assertMemberToolAccess(member, guild, toolName, channel);
      if (!access.ok) {
        log.warn('tool', `denied ${toolName} for ${callerLabel}: ${access.error}`);
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ ok: false, error: access.error })
        });
        continue;
      }

      const tool = toolsRegistry.get(toolName);
      if (!tool) {
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ ok: false, error: `Unknown tool: "${toolName}"` })
        });
        continue;
      }

      const validation = tool.schema.safeParse(parsedArgs);
      if (!validation.success) {
        const zodErrors = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ ok: false, error: `Schema validation failed: ${zodErrors}` })
        });
        continue;
      }

      const scopeCheck = await assertTargetScopeForCaller(member, guild, toolName, validation.data);
      if (!scopeCheck.ok) {
        log.warn('tool', `scope-blocked ${toolName} for ${callerLabel}: ${scopeCheck.error}`);
        history.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ ok: false, error: scopeCheck.error })
        });
        continue;
      }

      log.info('tool', `${callerLabel} -> ${toolName}`, validation.data);
      const result = await tool.handler(validation.data, {
        guildId: guild?.id,
        guild,
        channelId: channel?.id,
        channel,
        callerId: member?.id,
        member,
        isOwnerOrAdmin: isOwnerOrAdmin(member, guild)
      });

      if (result.ok && !READ_ONLY_TOOLS.has(toolName)) {
        mutatedServer = true;
      }

      if (toolName === 'finish' && result.ok) {
        finishedSummary = validation.data.summary;
      }

      if (!result.ok) {
        log.warn('tool', `${toolName} failed: ${result.error || 'unknown'}`);
      } else {
        log.info('tool', `${toolName} ok`);
      }

      history.push({
        role: 'tool',
        tool_call_id: callId,
        content: truncateString(JSON.stringify(result))
      });
    }

    if (mutatedServer) {
      cachedSnapshot = null; // Refresh snapshot on next step only if server structure changed
    }

    trimHistory(history);

    if (finishedSummary) {
      history.push({ role: 'assistant', content: finishedSummary });
      trimHistory(history);
      return finishedSummary;
    }
  }

    return lastAssistantText || 'Done vro.';
  });
}
