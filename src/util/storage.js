import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let inMemorySettings = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSettings() {
  if (inMemorySettings !== null) return inMemorySettings;
  ensureDataDir();
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      inMemorySettings = JSON.parse(raw);
    } catch (_) {
      inMemorySettings = {};
    }
  } else {
    inMemorySettings = {};
  }
  return inMemorySettings;
}

function persistSettings() {
  ensureDataDir();
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(inMemorySettings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings.json:', err.message);
  }
}

export function getGuildConfig(guildId) {
  if (!guildId) return {};
  const all = loadSettings();
  if (!all[guildId]) {
    all[guildId] = {
      welcome: { enabled: false, channelId: null, message: 'Welcome {user} to {server}! You are member #{count}.' },
      autorole: { enabled: false, roleId: null },
      reaction_roles: {},
      memories: {},
      warnings: {},
      reminders: [],
      lockdown_channels: [],
      modmail: { enabled: false, channelId: null },
      tags: {},
      suggestions: { channelId: null, list: {} },
      giveaways: {},
      starboard: { channelId: null, threshold: 3, entries: {} },
      tickets: { counter: 0, active: {} }
    };
  }
  if (!all[guildId].reaction_roles) {
    all[guildId].reaction_roles = {};
  }
  return all[guildId];
}

export function updateGuildConfig(guildId, updaterFn) {
  if (!guildId) return {};
  const cfg = getGuildConfig(guildId);
  updaterFn(cfg);
  persistSettings();
  return cfg;
}

export function getGuildMemories(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.memories || {};
}

export function setGuildMemory(guildId, key, value) {
  const cleanKey = String(key).trim().toLowerCase();
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.memories) cfg.memories = {};
    cfg.memories[cleanKey] = String(value).trim();
  });
  return { key: cleanKey, value };
}

export function deleteGuildMemory(guildId, key) {
  const cleanKey = String(key).trim().toLowerCase();
  let deleted = false;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.memories && cfg.memories[cleanKey] !== undefined) {
      delete cfg.memories[cleanKey];
      deleted = true;
    }
  });
  return { key: cleanKey, deleted };
}

export function getGuildReactionRoles(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.reaction_roles || {};
}

export function setReactionRole(guildId, messageId, emoji, roleId, channelId = null) {
  const cleanMsgId = String(messageId).trim();
  const cleanEmoji = String(emoji).trim();
  const cleanRoleId = String(roleId).trim();

  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.reaction_roles) cfg.reaction_roles = {};
    if (!cfg.reaction_roles[cleanMsgId]) {
      cfg.reaction_roles[cleanMsgId] = {
        channelId: channelId ? String(channelId).trim() : null,
        mappings: {}
      };
    }
    if (channelId) {
      cfg.reaction_roles[cleanMsgId].channelId = String(channelId).trim();
    }
    cfg.reaction_roles[cleanMsgId].mappings[cleanEmoji] = cleanRoleId;
  });

  return { messageId: cleanMsgId, emoji: cleanEmoji, roleId: cleanRoleId };
}

export function setBatchReactionRoles(guildId, messageId, mappings = [], channelId = null) {
  const cleanMsgId = String(messageId).trim();
  const applied = [];

  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.reaction_roles) cfg.reaction_roles = {};
    if (!cfg.reaction_roles[cleanMsgId]) {
      cfg.reaction_roles[cleanMsgId] = {
        channelId: channelId ? String(channelId).trim() : null,
        mappings: {}
      };
    }
    if (channelId) {
      cfg.reaction_roles[cleanMsgId].channelId = String(channelId).trim();
    }
    for (const item of mappings) {
      if (item?.emoji && item?.roleId) {
        const e = String(item.emoji).trim();
        const r = String(item.roleId).trim();
        cfg.reaction_roles[cleanMsgId].mappings[e] = r;
        applied.push({ emoji: e, roleId: r });
      }
    }
  });

  return { messageId: cleanMsgId, count: applied.length, applied };
}

export function removeReactionRole(guildId, messageId, emoji = null) {
  const cleanMsgId = String(messageId).trim();
  let deleted = false;

  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.reaction_roles || !cfg.reaction_roles[cleanMsgId]) return;
    if (emoji) {
      const cleanEmoji = String(emoji).trim();
      if (cfg.reaction_roles[cleanMsgId].mappings[cleanEmoji]) {
        delete cfg.reaction_roles[cleanMsgId].mappings[cleanEmoji];
        deleted = true;
      }
      if (Object.keys(cfg.reaction_roles[cleanMsgId].mappings).length === 0) {
        delete cfg.reaction_roles[cleanMsgId];
      }
    } else {
      delete cfg.reaction_roles[cleanMsgId];
      deleted = true;
    }
  });

  return { messageId: cleanMsgId, deleted };
}

export function exportGuildConfig(guildId) {
  const cfg = JSON.parse(JSON.stringify(getGuildConfig(guildId)));
  if (cfg.ai_config && cfg.ai_config.apiKey) {
    delete cfg.ai_config.apiKey;
  }
  return cfg;
}

export function importGuildConfig(guildId, newConfig) {
  if (!guildId || typeof newConfig !== 'object' || newConfig === null) {
    throw new Error('Invalid configuration object.');
  }
  const target = newConfig[guildId] ? newConfig[guildId] : newConfig;
  const all = loadSettings();
  all[guildId] = {
    welcome: target.welcome || { enabled: false, channelId: null, message: null },
    autorole: target.autorole || { enabled: false, roleId: null },
    reaction_roles: target.reaction_roles || {},
    ai_config: target.ai_config || null,
    persona_mode: target.persona_mode || 'vro',
    memories: target.memories || {},
    warnings: target.warnings || {},
    reminders: target.reminders || [],
    lockdown_channels: target.lockdown_channels || [],
    modmail: target.modmail || { enabled: false, channelId: null },
    tags: target.tags || {},
    suggestions: target.suggestions || { channelId: null, list: {} },
    giveaways: target.giveaways || {},
    starboard: target.starboard || { channelId: null, threshold: 3, entries: {} },
    tickets: target.tickets || { counter: 0, active: {} }
  };
  persistSettings();
  return all[guildId];
}

export function getGuildWarnings(guildId, memberId) {
  const cfg = getGuildConfig(guildId);
  if (!cfg.warnings || !cfg.warnings[memberId]) return [];
  return cfg.warnings[memberId];
}

export function addGuildWarning(guildId, memberId, { reason, moderatorId, timestamp = Date.now() }) {
  let list = [];
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.warnings) cfg.warnings = {};
    if (!cfg.warnings[memberId]) cfg.warnings[memberId] = [];
    cfg.warnings[memberId].push({ reason, moderatorId, timestamp });
    list = cfg.warnings[memberId];
  });
  return list;
}

export function clearGuildWarnings(guildId, memberId) {
  let clearedCount = 0;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.warnings && cfg.warnings[memberId]) {
      clearedCount = cfg.warnings[memberId].length;
      delete cfg.warnings[memberId];
    }
  });
  return clearedCount;
}

export function setGuildAIConfig(guildId, configObj = {}) {
  return updateGuildConfig(guildId, (cfg) => {
    if (!cfg.ai_config) cfg.ai_config = {};
    if (configObj.model !== undefined) cfg.ai_config.model = String(configObj.model).trim();
    if (configObj.baseURL !== undefined) cfg.ai_config.baseURL = String(configObj.baseURL).trim();
    if (configObj.apiKey !== undefined) cfg.ai_config.apiKey = String(configObj.apiKey).trim();
    if (configObj.reasoningEffort !== undefined) cfg.ai_config.reasoningEffort = String(configObj.reasoningEffort).trim().toLowerCase();
  });
}

export function resetGuildAIConfig(guildId) {
  return updateGuildConfig(guildId, (cfg) => {
    delete cfg.ai_config;
  });
}

export function setGuildPersona(guildId, mode = 'vro') {
  const cleanMode = String(mode).trim().toLowerCase();
  return updateGuildConfig(guildId, (cfg) => {
    cfg.persona_mode = cleanMode;
  });
}

export function getGuildReminders(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.reminders || [];
}

export function addGuildReminder(guildId, reminder) {
  let list = [];
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.reminders) cfg.reminders = [];
    cfg.reminders.push(reminder);
    list = cfg.reminders;
  });
  return list;
}

export function removeGuildReminder(guildId, reminderId) {
  let remaining = [];
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.reminders) cfg.reminders = [];
    cfg.reminders = cfg.reminders.filter((r) => r.id !== reminderId);
    remaining = cfg.reminders;
  });
  return remaining;
}

export function getAllPendingReminders() {
  const all = loadSettings();
  const list = [];
  for (const [guildId, cfg] of Object.entries(all)) {
    if (Array.isArray(cfg?.reminders)) {
      for (const r of cfg.reminders) {
        list.push({ ...r, guildId });
      }
    }
  }
  return list;
}

export function setGuildLockdown(guildId, channelIds = []) {
  return updateGuildConfig(guildId, (cfg) => {
    cfg.lockdown_channels = channelIds;
  });
}

export function getGuildLockdown(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.lockdown_channels || [];
}

export function getGuildModmail(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.modmail || { enabled: false, channelId: null };
}

export function setGuildModmail(guildId, { enabled, channelId = null }) {
  return updateGuildConfig(guildId, (cfg) => {
    cfg.modmail = {
      enabled: Boolean(enabled),
      channelId: channelId ? String(channelId).trim() : null
    };
  });
}

// -------------------------------------------------------------
// Tags Storage (Carl-bot parity)
// -------------------------------------------------------------
export function getGuildTags(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.tags || {};
}

export function getGuildTag(guildId, name) {
  const tags = getGuildTags(guildId);
  const clean = String(name).trim().toLowerCase();
  return tags[clean] || null;
}

export function setGuildTag(guildId, name, content, authorId = null) {
  const clean = String(name).trim().toLowerCase();
  let tagObj = null;
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.tags) cfg.tags = {};
    const existing = cfg.tags[clean];
    tagObj = {
      name: clean,
      content: String(content).trim(),
      authorId: authorId || existing?.authorId || null,
      createdAt: existing?.createdAt || Date.now(),
      uses: (existing?.uses || 0) + (existing ? 0 : 0)
    };
    cfg.tags[clean] = tagObj;
  });
  return tagObj;
}

export function incrementTagUses(guildId, name) {
  const clean = String(name).trim().toLowerCase();
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.tags?.[clean]) {
      cfg.tags[clean].uses = (cfg.tags[clean].uses || 0) + 1;
    }
  });
}

export function deleteGuildTag(guildId, name) {
  const clean = String(name).trim().toLowerCase();
  let deleted = false;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.tags?.[clean]) {
      delete cfg.tags[clean];
      deleted = true;
    }
  });
  return deleted;
}

// -------------------------------------------------------------
// Suggestions Storage
// -------------------------------------------------------------
export function getGuildSuggestions(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.suggestions || { channelId: null, list: {} };
}

export function setGuildSuggestionsChannel(guildId, channelId) {
  return updateGuildConfig(guildId, (cfg) => {
    if (!cfg.suggestions) cfg.suggestions = { channelId: null, list: {} };
    cfg.suggestions.channelId = channelId ? String(channelId).trim() : null;
  });
}

export function addGuildSuggestion(guildId, { id, authorId, content, messageId }) {
  let record = null;
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.suggestions) cfg.suggestions = { channelId: null, list: {} };
    if (!cfg.suggestions.list) cfg.suggestions.list = {};
    record = {
      id: String(id),
      authorId: String(authorId),
      content: String(content),
      messageId: String(messageId),
      status: 'pending',
      reason: null,
      moderatorId: null,
      createdAt: Date.now()
    };
    cfg.suggestions.list[record.id] = record;
  });
  return record;
}

export function updateGuildSuggestionStatus(guildId, id, { status, reason = null, moderatorId = null }) {
  let updated = null;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.suggestions?.list?.[id]) {
      cfg.suggestions.list[id].status = status;
      cfg.suggestions.list[id].reason = reason;
      cfg.suggestions.list[id].moderatorId = moderatorId;
      updated = cfg.suggestions.list[id];
    }
  });
  return updated;
}

// -------------------------------------------------------------
// Giveaways Storage
// -------------------------------------------------------------
export function getGuildGiveaways(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.giveaways || {};
}

export function addGuildGiveaway(guildId, messageId, data) {
  let gway = null;
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.giveaways) cfg.giveaways = {};
    gway = {
      messageId: String(messageId),
      channelId: String(data.channelId),
      prize: String(data.prize),
      winnersCount: Number(data.winnersCount) || 1,
      endsAt: Number(data.endsAt),
      ended: false,
      winners: []
    };
    cfg.giveaways[gway.messageId] = gway;
  });
  return gway;
}

export function endGuildGiveaway(guildId, messageId, winners = []) {
  let gway = null;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.giveaways?.[messageId]) {
      cfg.giveaways[messageId].ended = true;
      cfg.giveaways[messageId].winners = winners;
      gway = cfg.giveaways[messageId];
    }
  });
  return gway;
}

export function getAllPendingGiveaways() {
  const all = loadSettings();
  const list = [];
  for (const [guildId, cfg] of Object.entries(all)) {
    if (cfg.giveaways && typeof cfg.giveaways === 'object') {
      for (const [msgId, gway] of Object.entries(cfg.giveaways)) {
        if (!gway.ended) {
          list.push({ ...gway, guildId, messageId: msgId });
        }
      }
    }
  }
  return list;
}

// -------------------------------------------------------------
// Starboard Storage
// -------------------------------------------------------------
export function getGuildStarboard(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.starboard || { channelId: null, threshold: 3, entries: {} };
}

export function setGuildStarboard(guildId, { channelId = null, threshold = 3 }) {
  return updateGuildConfig(guildId, (cfg) => {
    if (!cfg.starboard) cfg.starboard = { channelId: null, threshold: 3, entries: {} };
    if (channelId !== null) cfg.starboard.channelId = channelId ? String(channelId).trim() : null;
    if (threshold !== null) cfg.starboard.threshold = Math.max(1, parseInt(threshold, 10) || 3);
  });
}

export function getStarboardEntry(guildId, messageId) {
  const sb = getGuildStarboard(guildId);
  return sb.entries?.[messageId] || null;
}

export function setStarboardEntry(guildId, messageId, entryData) {
  return updateGuildConfig(guildId, (cfg) => {
    if (!cfg.starboard) cfg.starboard = { channelId: null, threshold: 3, entries: {} };
    if (!cfg.starboard.entries) cfg.starboard.entries = {};
    cfg.starboard.entries[messageId] = entryData;
  });
}

// -------------------------------------------------------------
// Tickets Storage
// -------------------------------------------------------------
export function getGuildTickets(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.tickets || { counter: 0, active: {} };
}

export function createGuildTicket(guildId, channelId, { userId, reason = 'General Support' }) {
  let ticketRecord = null;
  updateGuildConfig(guildId, (cfg) => {
    if (!cfg.tickets) cfg.tickets = { counter: 0, active: {} };
    if (!cfg.tickets.active) cfg.tickets.active = {};
    cfg.tickets.counter = (cfg.tickets.counter || 0) + 1;
    ticketRecord = {
      ticketNumber: cfg.tickets.counter,
      channelId: String(channelId),
      userId: String(userId),
      reason: String(reason),
      openedAt: Date.now()
    };
    cfg.tickets.active[String(channelId)] = ticketRecord;
  });
  return ticketRecord;
}

export function closeGuildTicket(guildId, channelId) {
  let record = null;
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.tickets?.active?.[channelId]) {
      record = cfg.tickets.active[channelId];
      delete cfg.tickets.active[channelId];
    }
  });
  return record;
}

// ---------------------------------------------------------------------------
// Random Chatter / Yap Scheduler
// ---------------------------------------------------------------------------

export function getGuildChatter(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.chatter || { enabled: false, triggers: [] };
}

export function setGuildChatter(guildId, chatterData) {
  let updated = null;
  updateGuildConfig(guildId, (cfg) => {
    cfg.chatter = {
      ...(cfg.chatter || {}),
      ...chatterData
    };
    updated = cfg.chatter;
  });
  return updated;
}

export function removeGuildChatterTrigger(guildId, triggerTimestamp) {
  let remaining = [];
  updateGuildConfig(guildId, (cfg) => {
    if (cfg.chatter?.triggers) {
      cfg.chatter.triggers = cfg.chatter.triggers.filter((t) => t !== triggerTimestamp);
      remaining = cfg.chatter.triggers;
    }
  });
  return remaining;
}

export function getAllActiveChatters() {
  const settings = loadSettings();
  const active = [];
  for (const [guildId, cfg] of Object.entries(settings)) {
    if (cfg?.chatter?.enabled && cfg.chatter.channelId) {
      active.push({ guildId, ...cfg.chatter });
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Dedicated Auto-Response Chat Channel
// ---------------------------------------------------------------------------

export function getGuildAutoChatChannel(guildId) {
  const cfg = getGuildConfig(guildId);
  return cfg.auto_chat_channel || null;
}

export function setGuildAutoChatChannel(guildId, channelId = null) {
  let updated = null;
  updateGuildConfig(guildId, (cfg) => {
    cfg.auto_chat_channel = channelId ? String(channelId) : null;
    updated = cfg.auto_chat_channel;
  });
  return updated;
}
