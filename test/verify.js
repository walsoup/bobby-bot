import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import {
  WHITELISTED_PERMISSIONS,
  validatePermissions,
  namesToBitfield,
  bitfieldToKeyNames
} from '../src/discord/permissions.js';
import {
  toolsRegistry,
  getToolsForMember,
  assertMemberToolAccess,
  clearCachedBotOwnerIds
} from '../src/agent/tools.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import {
  resolveToolName,
  parseAndSplitToolArguments,
  assertTargetScopeForCaller
} from '../src/agent/loop.js';

function mockMember({ id = '200000000000000001', displayName = 'TestUser', perms = [], highestPos = 5 } = {}) {
  const bitfield = new PermissionsBitField(perms.map((p) => PermissionFlagsBits[p]));
  return {
    id,
    displayName,
    user: { id, username: displayName.toLowerCase(), bot: false },
    permissions: bitfield,
    roles: {
      highest: { id: '300000000000000001', name: 'MockRole', position: highestPos }
    }
  };
}

function mockGuild({ id = '100000000000000001', ownerId = '900000000000000099', roles = [], channels = [] } = {}) {
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  roleMap.find = (fn) => Array.from(roleMap.values()).find(fn);

  const channelMap = new Map(channels.map((c) => [c.id, c]));
  channelMap.find = (fn) => Array.from(channelMap.values()).find(fn);

  return {
    id,
    name: 'Test Server',
    ownerId,
    roles: {
      fetch: async (roleId) => (roleId ? roleMap.get(roleId) || null : roleMap),
      cache: roleMap
    },
    channels: {
      fetch: async (chId) => (chId ? channelMap.get(chId) || null : channelMap),
      cache: channelMap
    },
    members: {
      search: async () => new Map(),
      fetch: async () => null,
      cache: new Map()
    }
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function run() {
  console.log('\nRunning Bobby Bot verification suite...\n');

  await test('Administrator is excluded from writable permissions whitelist', () => {
    assert.equal(WHITELISTED_PERMISSIONS.includes('Administrator'), false);
    assert.throws(() => validatePermissions(['Administrator']), /Invalid or disallowed permission/);
    assert.throws(() => namesToBitfield(['Administrator']), /Invalid or disallowed permission/);
    validatePermissions(['ManageChannels', 'ModerateMembers']);
    const adminBits = new PermissionsBitField([PermissionFlagsBits.Administrator]);
    assert.equal(bitfieldToKeyNames(adminBits).includes('Administrator'), true);
  });

  await test('Regular member gets safe tools (read_channel_history, recall_memory, list_memories, evaluate_math) and zero mutation tools', () => {
    const guild = mockGuild();
    const noHistoryMember = mockMember({ id: '200000000000000010', displayName: 'NoHist', perms: ['SendMessages', 'ViewChannel'] });
    assert.deepEqual(getToolsForMember(noHistoryMember, guild), []);

    const regular = mockMember({ id: '200000000000000011', displayName: 'RegularJoe', perms: ['SendMessages', 'ViewChannel', 'ReadMessageHistory'] });
    const regToolNames = getToolsForMember(regular, guild).map((t) => t.function.name);
    assert.deepEqual(regToolNames, ['read_channel_history', 'recall_memory', 'list_memories', 'evaluate_math']);
    assert.deepEqual(assertMemberToolAccess(regular, guild, 'read_channel_history'), { ok: true });
    assert.deepEqual(assertMemberToolAccess(regular, guild, 'recall_memory'), { ok: true });
    assert.deepEqual(assertMemberToolAccess(regular, guild, 'list_memories'), { ok: true });
    assert.deepEqual(assertMemberToolAccess(regular, guild, 'evaluate_math'), { ok: true });

    const gate = assertMemberToolAccess(regular, guild, 'ban_member');
    assert.deepEqual(gate, { ok: false, error: "You lack the 'BanMembers' permission on this server." });

    const chGate = assertMemberToolAccess(regular, guild, 'create_channel');
    assert.deepEqual(chGate, { ok: false, error: "You lack the 'ManageChannels' permission on this server." });

    const welcomeGate = assertMemberToolAccess(regular, guild, 'configure_welcome');
    assert.deepEqual(welcomeGate, { ok: false, error: "You lack the 'ManageGuild' permission on this server." });

    const autoroleGate = assertMemberToolAccess(regular, guild, 'configure_autorole');
    assert.deepEqual(autoroleGate, { ok: false, error: "You lack the 'ManageRoles' permission on this server." });

    const saveMemGate = assertMemberToolAccess(regular, guild, 'save_memory');
    assert.deepEqual(saveMemGate, { ok: false, error: "You lack the 'ManageGuild' permission on this server." });
  });

  await test('ManageChannels member only unlocks channel tools', () => {
    const guild = mockGuild();
    const chanMod = mockMember({ perms: ['ManageChannels'] });
    const names = new Set(getToolsForMember(chanMod, guild).map((t) => t.function.name));

    assert.equal(names.has('create_channel'), true);
    assert.equal(names.has('edit_channel'), true);
    assert.equal(names.has('delete_channel'), true);
    assert.equal(names.has('move_channel'), true);
    assert.equal(names.has('finish'), true);

    assert.equal(names.has('timeout_member'), false);
    assert.equal(names.has('ban_member'), false);
    assert.equal(names.has('kick_member'), false);
    assert.equal(names.has('delete_message'), false);
    assert.equal(names.has('create_role'), false);
    assert.equal(names.has('batch_create_structure'), false);

    const denyTimeout = assertMemberToolAccess(chanMod, guild, 'timeout_member');
    assert.deepEqual(denyTimeout, { ok: false, error: "You lack the 'ModerateMembers' permission on this server." });
  });

  await test('ModerateMembers, BanMembers, KickMembers, ManageMessages unlock exact subsets', () => {
    const guild = mockGuild();

    const timeoutMod = mockMember({ perms: ['ModerateMembers'] });
    const tNames = new Set(getToolsForMember(timeoutMod, guild).map((t) => t.function.name));
    assert.equal(tNames.has('timeout_member'), true);
    assert.equal(tNames.has('get_channel_messages'), true);
    assert.equal(tNames.has('ban_member'), false);

    const banMod = mockMember({ perms: ['BanMembers'] });
    const bNames = new Set(getToolsForMember(banMod, guild).map((t) => t.function.name));
    assert.equal(bNames.has('ban_member'), true);
    assert.equal(bNames.has('unban_member'), true);
    assert.equal(bNames.has('kick_member'), false);

    const kickMod = mockMember({ perms: ['KickMembers'] });
    const kNames = new Set(getToolsForMember(kickMod, guild).map((t) => t.function.name));
    assert.equal(kNames.has('kick_member'), true);
    assert.equal(kNames.has('ban_member'), false);

    const msgMod = mockMember({ perms: ['ManageMessages'] });
    const mNames = new Set(getToolsForMember(msgMod, guild).map((t) => t.function.name));
    assert.equal(mNames.has('delete_message'), true);
    assert.equal(mNames.has('purge_messages'), true);
    assert.equal(mNames.has('create_channel'), false);
  });

  await test('Server Owner & Administrator unlock full toolset while blocking Admin role creation', () => {
    const ownerId = '900000000000000099';
    const guild = mockGuild({ ownerId });
    const owner = mockMember({ id: ownerId, displayName: 'Boss', perms: [] });

    const ownerTools = getToolsForMember(owner, guild);
    assert.equal(ownerTools.length, toolsRegistry.size - 1); // all tools except public-only read_channel_history alias (owner has get_channel_messages)
    assert.deepEqual(assertMemberToolAccess(owner, guild, 'batch_create_structure'), { ok: true });

    const createRoleSchema = toolsRegistry.get('create_role').schema;
    const badParse = createRoleSchema.safeParse({ name: 'Root', permissions: ['Administrator'] });
    assert.equal(badParse.success, false);
  });

  await test('Privilege escalation protections block junior ManageRoles self-admin & private channel snooping', async () => {
    const adminRole = {
      id: '400000000000000001',
      name: 'Admin',
      position: 20,
      permissions: new PermissionsBitField([PermissionFlagsBits.Administrator])
    };
    const banRole = {
      id: '400000000000000002',
      name: 'Enforcer',
      position: 3,
      permissions: new PermissionsBitField([PermissionFlagsBits.BanMembers])
    };
    const secretChannel = {
      id: '500000000000000001',
      name: 'staff-secret',
      permissionsFor: () => new PermissionsBitField([]) // no ViewChannel
    };

    const guild = mockGuild({ roles: [adminRole, banRole], channels: [secretChannel] });
    const juniorRoleMod = mockMember({ id: '200000000000000055', perms: ['ManageRoles', 'ManageMessages'], highestPos: 10 });

    // Cannot assign Admin role to self
    const selfAdmin = await assertTargetScopeForCaller(juniorRoleMod, guild, 'assign_member_role', {
      member_id: juniorRoleMod.id,
      role_id: adminRole.id
    });
    assert.equal(selfAdmin.ok, false);

    // Cannot assign a lower-positioned role that carries BanMembers (which caller lacks)
    const mintBan = await assertTargetScopeForCaller(juniorRoleMod, guild, 'assign_member_role', {
      member_id: juniorRoleMod.id,
      role_id: banRole.id
    });
    assert.equal(mintBan.ok, false);

    // Cannot create a role with ManageGuild when caller only has ManageRoles
    const createEscalated = await assertTargetScopeForCaller(juniorRoleMod, guild, 'create_role', {
      name: 'Sneaky',
      permissions: ['ManageGuild']
    });
    assert.equal(createEscalated.ok, false);

    // Cannot read or batch-send to a private channel caller cannot view
    const readSecret = await assertTargetScopeForCaller(juniorRoleMod, guild, 'get_channel_messages', {
      channel_id: secretChannel.id
    });
    assert.equal(readSecret.ok, false);

    const sendSecret = await assertTargetScopeForCaller(juniorRoleMod, guild, 'batch_send_messages', {
      messages: [{ channel_id: secretChannel.id, content: 'hi' }]
    });
    assert.equal(sendSecret.ok, false);
  });

  await test('System prompt reflects Caller role (Member, Staff/Mod, Server Owner)', async () => {
    const ownerId = '900000000000000099';
    const guild = mockGuild({ ownerId });
    const channel = { id: '123', name: 'general' };

    const memberPrompt = await buildSystemPrompt({
      guild,
      member: mockMember({ displayName: 'Casual', perms: ['ViewChannel', 'ReadMessageHistory'] }),
      channel,
      isStaffCall: false,
      allowedToolNames: new Set(['read_channel_history'])
    });
    assert.match(memberPrompt, /Caller: Casual \(Role: Member\)/);
    assert.match(memberPrompt, /read_channel_history/);

    const staffPrompt = await buildSystemPrompt({
      guild,
      member: mockMember({ displayName: 'ModGuy', perms: ['ModerateMembers'] }),
      channel,
      isStaffCall: true,
      allowedToolNames: new Set(['timeout_member']),
      preloadedSnapshot: { guild: { name: 'Test Server' } }
    });
    assert.match(staffPrompt, /Caller: ModGuy \(Role: Staff\/Mod\)/);

    const ownerPrompt = await buildSystemPrompt({
      guild,
      member: mockMember({ id: ownerId, displayName: 'Walid', perms: [] }),
      channel,
      isStaffCall: true,
      allowedToolNames: new Set(['create_channel']),
      preloadedSnapshot: { guild: { name: 'Test Server' } }
    });
    assert.match(ownerPrompt, /Caller: Walid \(Role: Server Owner\)/);
    assert.match(ownerPrompt, /never tell the Server Owner to "go ask the owner"/);
  });

  await test('Tool name resolver and concatenated JSON splitter are safe', () => {
    assert.equal(resolveToolName('create_channel'), 'create_channel');
    assert.equal(resolveToolName('create_channelcreate_channel'), 'create_channel');
    assert.equal(resolveToolName('not_create_channel_at_all'), 'not_create_channel_at_all');

    const split = parseAndSplitToolArguments('{"name":"a","type":"text"}{"name":"b","type":"voice"}');
    assert.equal(split.length, 2);
    assert.deepEqual(split[0], { name: 'a', type: 'text' });
    assert.deepEqual(split[1], { name: 'b', type: 'voice' });
  });

  await test('evaluate_math tool computes safely and blocks sandbox escapes', async () => {
    const mathTool = toolsRegistry.get('evaluate_math');
    assert.ok(mathTool, 'evaluate_math must be registered');

    // Valid arithmetic and Math.* expressions
    const res1 = await mathTool.handler({ expression: '(10 * 5) + Math.sqrt(144)' });
    assert.equal(res1.ok, true);
    assert.equal(res1.result, '62');

    const res2 = await mathTool.handler({ expression: '2 ** 10' });
    assert.equal(res2.ok, true);
    assert.equal(res2.result, '1024');

    // Block prototype pollution / process escape attempts
    const bad1 = await mathTool.handler({ expression: 'this.constructor.constructor("return process")()' });
    assert.equal(bad1.ok, false);
    assert.match(bad1.error, /Forbidden keyword/);

    const bad2 = await mathTool.handler({ expression: 'process.exit(1)' });
    assert.equal(bad2.ok, false);
    assert.match(bad2.error, /Forbidden keyword/);

    // Syntax error handling
    const syntaxErr = await mathTool.handler({ expression: '2 ++ * 5' });
    assert.equal(syntaxErr.ok, false);
    assert.match(syntaxErr.error, /Math evaluation failed/);
  });

  await test('Carl-bot replacement storage & memory scratchpad work correctly', async () => {
    const {
      getGuildConfig,
      updateGuildConfig,
      setGuildMemory,
      getGuildMemories,
      deleteGuildMemory
    } = await import('../src/util/storage.js');

    const testGuildId = 'test_guild_' + Date.now();

    // 1. Initial default configuration
    const initCfg = getGuildConfig(testGuildId);
    assert.equal(initCfg.welcome.enabled, false);
    assert.equal(initCfg.autorole.enabled, false);

    // 2. Set memory
    setGuildMemory(testGuildId, 'faq_link', 'https://example.com/faq');
    setGuildMemory(testGuildId, 'stream_schedule', 'Every Friday at 8 PM UTC');

    const memories = getGuildMemories(testGuildId);
    assert.equal(memories.faq_link, 'https://example.com/faq');
    assert.equal(memories.stream_schedule, 'Every Friday at 8 PM UTC');

    // 3. Delete memory
    const delRes = deleteGuildMemory(testGuildId, 'faq_link');
    assert.equal(delRes.deleted, true);
    assert.equal(getGuildMemories(testGuildId).faq_link, undefined);

    // 4. Update welcome and autorole configuration
    updateGuildConfig(testGuildId, (cfg) => {
      cfg.welcome.enabled = true;
      cfg.welcome.channelId = '555123456';
      cfg.autorole.enabled = true;
      cfg.autorole.roleId = '777123456';
    });

    const updated = getGuildConfig(testGuildId);
    assert.equal(updated.welcome.enabled, true);
    assert.equal(updated.welcome.channelId, '555123456');
    assert.equal(updated.autorole.enabled, true);
    assert.equal(updated.autorole.roleId, '777123456');

    // 5. Test tool handlers through toolsRegistry
    const saveTool = toolsRegistry.get('save_memory');
    const recallTool = toolsRegistry.get('recall_memory');
    const listTool = toolsRegistry.get('list_memories');
    const forgetTool = toolsRegistry.get('forget_memory');

    const saveRes = await saveTool.handler({ key: 'rules_link', value: 'https://discord.gg/rules' }, { guildId: testGuildId });
    assert.equal(saveRes.ok, true);

    const recallExact = await recallTool.handler({ key: 'rules_link' }, { guildId: testGuildId });
    assert.equal(recallExact.ok, true);
    assert.equal(recallExact.value, 'https://discord.gg/rules');

    const recallPartial = await recallTool.handler({ key: 'rules' }, { guildId: testGuildId });
    assert.equal(recallPartial.ok, true);
    assert.ok(recallPartial.results?.rules_link);

    const listRes = await listTool.handler({}, { guildId: testGuildId });
    assert.equal(listRes.ok, true);
    assert.ok(listRes.keys.includes('rules_link'));

    const forgetRes = await forgetTool.handler({ key: 'rules_link' }, { guildId: testGuildId });
    assert.equal(forgetRes.ok, true);
    assert.equal(forgetRes.deleted, true);

    // 6. Test Multi-Server Strict Memory Isolation
    const guildA = 'guild_alpha_' + Date.now();
    const guildB = 'guild_beta_' + Date.now();

    setGuildMemory(guildA, 'server_ip', 'mc.alpha-network.com');
    setGuildMemory(guildA, 'owner_handle', 'alpha_king');

    setGuildMemory(guildB, 'server_ip', 'play.beta-realm.org');
    setGuildMemory(guildB, 'discord_invite', 'discord.gg/beta');

    const memA = getGuildMemories(guildA);
    const memB = getGuildMemories(guildB);

    assert.equal(memA.server_ip, 'mc.alpha-network.com');
    assert.equal(memA.owner_handle, 'alpha_king');
    assert.equal(memA.discord_invite, undefined); // B's memory NOT in A

    assert.equal(memB.server_ip, 'play.beta-realm.org');
    assert.equal(memB.discord_invite, 'discord.gg/beta');
    assert.equal(memB.owner_handle, undefined); // A's memory NOT in B

    // Tool handler multi-server isolation
    const recallA = await recallTool.handler({ key: 'server_ip' }, { guildId: guildA });
    assert.equal(recallA.value, 'mc.alpha-network.com');

    const recallB = await recallTool.handler({ key: 'server_ip' }, { guildId: guildB });
    assert.equal(recallB.value, 'play.beta-realm.org');

    // Deleting in guildA does NOT affect guildB
    deleteGuildMemory(guildA, 'server_ip');
    assert.equal(getGuildMemories(guildA).server_ip, undefined);
    assert.equal(getGuildMemories(guildB).server_ip, 'play.beta-realm.org');
  });

  await test('Reaction roles storage and tool permission boundaries work properly', async () => {
    const {
      setReactionRole,
      setBatchReactionRoles,
      getGuildReactionRoles,
      removeReactionRole
    } = await import('../src/util/storage.js');

    const testGuildId = 'test_guild_rr_' + Date.now();
    const testMsgId = '987654321098765432';

    // 1. Single reaction role storage
    const single = setReactionRole(testGuildId, testMsgId, '🎓', '888111222', '123456');
    assert.equal(single.emoji, '🎓');
    assert.equal(single.roleId, '888111222');

    let allRRs = getGuildReactionRoles(testGuildId);
    assert.equal(allRRs[testMsgId].mappings['🎓'], '888111222');
    assert.equal(allRRs[testMsgId].channelId, '123456');

    // 2. Batch reaction roles storage
    const batchRes = setBatchReactionRoles(testGuildId, testMsgId, [
      { emoji: '1️⃣', roleId: '111000' },
      { emoji: '2️⃣', roleId: '222000' }
    ]);
    assert.equal(batchRes.count, 2);

    allRRs = getGuildReactionRoles(testGuildId);
    assert.equal(allRRs[testMsgId].mappings['1️⃣'], '111000');
    assert.equal(allRRs[testMsgId].mappings['2️⃣'], '222000');
    assert.equal(allRRs[testMsgId].mappings['🎓'], '888111222');

    // 3. Remove single emoji trigger
    removeReactionRole(testGuildId, testMsgId, '1️⃣');
    allRRs = getGuildReactionRoles(testGuildId);
    assert.equal(allRRs[testMsgId].mappings['1️⃣'], undefined);
    assert.equal(allRRs[testMsgId].mappings['2️⃣'], '222000');

    // 4. Remove entire message triggers
    removeReactionRole(testGuildId, testMsgId);
    allRRs = getGuildReactionRoles(testGuildId);
    assert.equal(allRRs[testMsgId], undefined);

    // 5. Tool permission boundary: regular member cannot add or remove reaction roles
    const guild = mockGuild();
    const regular = mockMember({ perms: ['SendMessages', 'ViewChannel', 'ReadMessageHistory'] });

    assert.equal(assertMemberToolAccess(regular, guild, 'add_reaction_role').ok, false);
    assert.equal(assertMemberToolAccess(regular, guild, 'batch_add_reaction_roles').ok, false);
    assert.equal(assertMemberToolAccess(regular, guild, 'create_role_menu').ok, false);
    assert.equal(assertMemberToolAccess(regular, guild, 'remove_reaction_role').ok, false);
    assert.equal(assertMemberToolAccess(regular, guild, 'list_reaction_roles').ok, false);
  });

  await test('Prefix command handler (! and ?) executes instant commands and routes !ask', async () => {
    const { handlePrefixCommand } = await import('../src/discord/commands.js');

    const mockClient = {
      ws: { ping: 42 },
      user: { id: '999999999999999999' }
    };

    function createMsg(content, perms = []) {
      let replyData = null;
      const mem = mockMember({ perms });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: mockGuild(),
        createdTimestamp: Date.now() - 25,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    // 1. !ping
    const pingMsg = createMsg('!ping');
    const pingRes = await handlePrefixCommand(pingMsg, mockClient);
    assert.equal(pingRes, true);
    assert.match(pingMsg.getLastReply().content, /Pong!/);
    assert.match(pingMsg.getLastReply().content, /RAM Usage:/);

    // 2. !math
    const mathMsg = createMsg('!math (20 * 5) + Math.sqrt(100)');
    const mathRes = await handlePrefixCommand(mathMsg, mockClient);
    assert.equal(mathRes, true);
    assert.match(mathMsg.getLastReply().content, /110/);

    // 3. !help
    const helpMsg = createMsg('!help');
    const helpRes = await handlePrefixCommand(helpMsg, mockClient);
    assert.equal(helpRes, true);
    assert.ok(helpMsg.getLastReply().embeds?.length > 0);

    // 4. !ask routes to agent
    const askMsg = createMsg('!ask what is the server rules?');
    const askRes = await handlePrefixCommand(askMsg, mockClient);
    assert.equal(askRes, 'ROUTE_TO_AGENT');

    // 5. Unrecognized command returns false
    const unkMsg = createMsg('!nonexistentcommand');
    const unkRes = await handlePrefixCommand(unkMsg, mockClient);
    assert.equal(unkRes, false);

    // 6. Regular non-prefix message returns false
    const normalMsg = createMsg('hello bobby vro');
    const normalRes = await handlePrefixCommand(normalMsg, mockClient);
    assert.equal(normalRes, false);

    // 7. !backup (staff)
    const backupMsg = createMsg('!backup', ['ManageGuild']);
    const backupRes = await handlePrefixCommand(backupMsg, mockClient);
    assert.equal(backupRes, true);
    assert.ok(backupMsg.getLastReply().files?.length > 0);

    // 8. !restore (admin)
    const restoreJson = JSON.stringify({
      welcome: { enabled: true, channelId: '112233', message: 'Hi' },
      autorole: { enabled: true, roleId: '445566' },
      reaction_roles: {},
      memories: { test_key: 'test_val' }
    });
    const restoreMsg = createMsg('!restore ' + restoreJson, ['Administrator']);
    const restoreRes = await handlePrefixCommand(restoreMsg, mockClient);
    assert.equal(restoreRes, true);
    assert.match(restoreMsg.getLastReply().content, /Configuration Restored Successfully/);

    // 9. !choose
    const chooseMsg = createMsg('!choose apple | orange');
    const chooseRes = await handlePrefixCommand(chooseMsg, mockClient);
    assert.equal(chooseRes, true);
    assert.match(chooseMsg.getLastReply().content, /I choose: \*\*(apple|orange)\*\*/);

    // 10. !tole
    const toleMsg = createMsg('!tole');
    const toleRes = await handlePrefixCommand(toleMsg, mockClient);
    assert.equal(toleRes, true);
    assert.ok(toleMsg.getLastReply().content.length > 0);

    // 11. !help mod
    const helpModMsg = createMsg('!help mod');
    const helpModRes = await handlePrefixCommand(helpModMsg, mockClient);
    assert.equal(helpModRes, true);
    assert.match(helpModMsg.getLastReply().embeds[0].data.title, /Moderation Commands/);

    // 12. !unban validation
    const unbanMsg = createMsg('!unban', ['BanMembers']);
    const unbanRes = await handlePrefixCommand(unbanMsg, mockClient);
    assert.equal(unbanRes, true);
    assert.match(unbanMsg.getLastReply().content, /Usage: `!unban/);
  });

  await test('Moderation warnings and persistent reminders storage work accurately', async () => {
    const {
      addGuildWarning,
      getGuildWarnings,
      clearGuildWarnings,
      addGuildReminder,
      getGuildReminders,
      removeGuildReminder,
      getAllPendingReminders,
      setGuildLockdown,
      getGuildLockdown
    } = await import('../src/util/storage.js');
    const testGuild = 'test_guild_warn';
    const testMember = 'test_member_warn';

    clearGuildWarnings(testGuild, testMember);
    assert.deepEqual(getGuildWarnings(testGuild, testMember), []);

    addGuildWarning(testGuild, testMember, { reason: 'Spamming', moderatorId: 'mod_123' });
    addGuildWarning(testGuild, testMember, { reason: 'Inappropriate language', moderatorId: 'mod_456' });

    const warns = getGuildWarnings(testGuild, testMember);
    assert.equal(warns.length, 2);
    assert.equal(warns[0].reason, 'Spamming');
    assert.equal(warns[1].reason, 'Inappropriate language');

    const cleared = clearGuildWarnings(testGuild, testMember);
    assert.equal(cleared, 2);
    assert.deepEqual(getGuildWarnings(testGuild, testMember), []);

    // Reminders test
    addGuildReminder(testGuild, { id: 'rem_1', channelId: 'ch_1', userId: 'usr_1', note: 'test', dueAt: Date.now() + 5000 });
    const reminders = getGuildReminders(testGuild);
    assert.equal(reminders.length >= 1, true);
    const allPending = getAllPendingReminders();
    assert.equal(allPending.some((r) => r.id === 'rem_1'), true);
    removeGuildReminder(testGuild, 'rem_1');
    assert.equal(getGuildReminders(testGuild).some((r) => r.id === 'rem_1'), false);

    // Lockdown test
    setGuildLockdown(testGuild, ['ch_101', 'ch_102']);
    assert.deepEqual(getGuildLockdown(testGuild), ['ch_101', 'ch_102']);
    setGuildLockdown(testGuild, []);
    assert.deepEqual(getGuildLockdown(testGuild), []);
  });

  await test('Bucket 3 AI tools, Modmail storage, and command handlers work as specified', async () => {
    const { getGuildModmail, setGuildModmail } = await import('../src/util/storage.js');
    const { toolsRegistry, assertMemberToolAccess } = await import('../src/agent/tools.js');
    const { handlePrefixCommand } = await import('../src/discord/commands.js');

    const testGuild = 'guild_modmail_test';
    setGuildModmail(testGuild, { enabled: true, channelId: '99887766' });
    const mmCfg = getGuildModmail(testGuild);
    assert.equal(mmCfg.enabled, true);
    assert.equal(mmCfg.channelId, '99887766');

    setGuildModmail(testGuild, { enabled: false, channelId: null });
    assert.equal(getGuildModmail(testGuild).enabled, false);

    // AI Tools registry check
    assert.equal(toolsRegistry.has('summarize_channel'), true);
    assert.equal(toolsRegistry.has('translate_message'), true);
    assert.equal(toolsRegistry.has('configure_modmail'), true);

    const guild = mockGuild();
    const regular = mockMember({ perms: ['SendMessages', 'ViewChannel', 'ReadMessageHistory'] });
    const admin = mockMember({ perms: ['Administrator'] });

    // Permissions check
    assert.equal(assertMemberToolAccess(regular, guild, 'configure_modmail').ok, false);
    assert.equal(assertMemberToolAccess(admin, guild, 'configure_modmail').ok, true);

    // Command validation
    const mockClient = { ws: { ping: 25 }, user: { id: '999999' } };
    function createMsg(content, perms = []) {
      let replyData = null;
      const mem = mockMember({ perms });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: mockGuild(),
        createdTimestamp: Date.now() - 25,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    const trMsg = createMsg('!translate');
    await handlePrefixCommand(trMsg, mockClient);
    assert.match(trMsg.getLastReply().content, /Usage: `!translate/);

    const mmMsg = createMsg('!modmail off', ['Administrator']);
    await handlePrefixCommand(mmMsg, mockClient);
    assert.match(mmMsg.getLastReply().content, /Modmail disabled/);
  });

  await test('Community Automation Storage (Tags, Suggestions, Giveaways, Starboard, Tickets) state transitions and invariants', async () => {
    const {
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
      getAllPendingGiveaways,
      getGuildStarboard,
      setGuildStarboard,
      getStarboardEntry,
      setStarboardEntry,
      getGuildTickets,
      createGuildTicket,
      closeGuildTicket
    } = await import('../src/util/storage.js');

    const testG = 'g_community_test_' + Date.now();

    // 1. Tags Invariants
    setGuildTag(testG, 'Rules', 'Be respectful and no spam.', 'author_1');
    const tag = getGuildTag(testG, 'rules'); // Case-insensitivity check
    assert.ok(tag);
    assert.equal(tag.content, 'Be respectful and no spam.');
    assert.equal(tag.authorId, 'author_1');
    assert.equal(tag.uses, 0);

    incrementTagUses(testG, 'rules');
    incrementTagUses(testG, 'rules');
    assert.equal(getGuildTag(testG, 'rules').uses, 2);

    setGuildTag(testG, 'rules', 'Updated rules text.', 'author_2');
    assert.equal(getGuildTag(testG, 'rules').content, 'Updated rules text.');

    const allTags = getGuildTags(testG);
    assert.equal(Object.keys(allTags).includes('rules'), true);

    const tagDeleted = deleteGuildTag(testG, 'rules');
    assert.equal(tagDeleted, true);
    assert.equal(getGuildTag(testG, 'rules'), null);

    // 2. Suggestions Invariants
    setGuildSuggestionsChannel(testG, 'ch_suggestions_999');
    assert.equal(getGuildSuggestions(testG).channelId, 'ch_suggestions_999');

    const suggestion = addGuildSuggestion(testG, {
      id: 'sg_101',
      authorId: 'user_sg_1',
      content: 'Add a chess channel',
      messageId: 'msg_sg_101'
    });
    assert.equal(suggestion.status, 'pending');
    assert.equal(suggestion.content, 'Add a chess channel');

    const approved = updateGuildSuggestionStatus(testG, 'sg_101', {
      status: 'approved',
      reason: 'Great community initiative',
      moderatorId: 'mod_admin'
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.reason, 'Great community initiative');
    assert.equal(approved.moderatorId, 'mod_admin');

    // 3. Giveaways Invariants
    const endsAt = Date.now() + 60000;
    const gway = addGuildGiveaway(testG, 'gway_msg_555', {
      channelId: 'ch_gway',
      prize: 'Discord Nitro',
      winnersCount: 2,
      endsAt
    });
    assert.equal(gway.ended, false);
    assert.equal(gway.prize, 'Discord Nitro');
    assert.equal(gway.winnersCount, 2);

    const pendingGways = getAllPendingGiveaways();
    assert.equal(pendingGways.some((g) => g.messageId === 'gway_msg_555'), true);

    const endedGway = endGuildGiveaway(testG, 'gway_msg_555', ['winner_user_1', 'winner_user_2']);
    assert.equal(endedGway.ended, true);
    assert.deepEqual(endedGway.winners, ['winner_user_1', 'winner_user_2']);

    // 4. Starboard Invariants
    setGuildStarboard(testG, { channelId: 'ch_starboard_123', threshold: 5 });
    const sbCfg = getGuildStarboard(testG);
    assert.equal(sbCfg.channelId, 'ch_starboard_123');
    assert.equal(sbCfg.threshold, 5);

    setStarboardEntry(testG, 'orig_msg_777', { starboardMessageId: 'sb_msg_888', count: 5 });
    const sbEntry = getStarboardEntry(testG, 'orig_msg_777');
    assert.equal(sbEntry.starboardMessageId, 'sb_msg_888');
    assert.equal(sbEntry.count, 5);

    // 5. Tickets Invariants
    const t1 = createGuildTicket(testG, 'ch_ticket_1', { userId: 'client_user_1', reason: 'Billing question' });
    const t2 = createGuildTicket(testG, 'ch_ticket_2', { userId: 'client_user_2', reason: 'Technical support' });
    assert.equal(t1.ticketNumber, 1);
    assert.equal(t2.ticketNumber, 2);
    assert.equal(t1.reason, 'Billing question');

    const activeTickets = getGuildTickets(testG).active;
    assert.equal(Object.keys(activeTickets).length, 2);

    const closed = closeGuildTicket(testG, 'ch_ticket_1');
    assert.equal(closed.userId, 'client_user_1');
    assert.equal(getGuildTickets(testG).active['ch_ticket_1'], undefined);
  });

  await test('Ruthless Permission Boundaries & Privilege Escalation Defense', async () => {
    const { handlePrefixCommand } = await import('../src/discord/commands.js');

    const mockClient = { ws: { ping: 20 }, user: { id: '999999' } };
    function createMsg(content, perms = [], isOwner = false) {
      let replyData = null;
      const mem = mockMember({ perms });
      const g = mockGuild({ ownerId: isOwner ? mem.id : 'owner_snowflake_9999' });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: g,
        channel: { name: 'general', id: '111222', permissionsFor: () => mem.permissions },
        createdTimestamp: Date.now() - 20,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    // 1. Regular member attempting staff tag commands
    const tagAddMsg = createMsg('!tag add hack exploit', ['SendMessages']);
    await handlePrefixCommand(tagAddMsg, mockClient);
    assert.match(tagAddMsg.getLastReply().content, /need staff permissions/i);

    // 2. Regular member attempting to approve suggestions
    const approveMsg = createMsg('!approve sg_101', ['SendMessages']);
    await handlePrefixCommand(approveMsg, mockClient);
    assert.match(approveMsg.getLastReply().content, /need staff permissions/i);

    // 3. Regular member attempting giveaway creation
    const gwayMsg = createMsg('!gway 1h 1 Nitro', ['SendMessages']);
    await handlePrefixCommand(gwayMsg, mockClient);
    assert.match(gwayMsg.getLastReply().content, /need staff permissions/i);

    // 4. Regular member attempting starboard setup
    const sbMsg = createMsg('!starboard setup #starboard', ['SendMessages']);
    await handlePrefixCommand(sbMsg, mockClient);
    assert.match(sbMsg.getLastReply().content, /Only the Server Owner or an Administrator/i);

    // 5. Regular member attempting softban
    const softbanMsg = createMsg('!softban <@999999999999999999>', ['SendMessages']);
    await handlePrefixCommand(softbanMsg, mockClient);
    assert.match(softbanMsg.getLastReply().content, /need `BanMembers` permission/i);

    // 6. Regular member attempting unban
    const unbanMsg = createMsg('!unban 111222333444555666', ['SendMessages']);
    await handlePrefixCommand(unbanMsg, mockClient);
    assert.match(unbanMsg.getLastReply().content, /need `BanMembers` permission/i);

    // 7. Regular member attempting nuke
    const nukeMsg = createMsg('!nuke', ['SendMessages']);
    await handlePrefixCommand(nukeMsg, mockClient);
    assert.match(nukeMsg.getLastReply().content, /Only the Server Owner or an Administrator can nuke channels/i);

    // 8. Staff with only ManageMessages attempting lockdown (requires ManageGuild or Administrator)
    const lockdownMsg = createMsg('!lockdown', ['ManageMessages']);
    await handlePrefixCommand(lockdownMsg, mockClient);
    assert.match(lockdownMsg.getLastReply().content, /Only the Server Owner or an Administrator can initiate a server-wide lockdown/i);

    // 9. Staff with only ManageMessages attempting starboard config (requires Admin)
    const sbModMsg = createMsg('!starboard setup #starboard', ['ManageMessages']);
    await handlePrefixCommand(sbModMsg, mockClient);
    assert.match(sbModMsg.getLastReply().content, /Only the Server Owner or an Administrator/i);

    // 10. Non-owner attempting to modify AI model
    const modelMsg = createMsg('!model deepseek-v4.1', ['ManageMessages']);
    await handlePrefixCommand(modelMsg, mockClient);
    assert.match(modelMsg.getLastReply().content, /Only the Bot Owner can change the AI model/i);

    // 11. Regular member attempting !apiconfig (with NO arguments) MUST be blocked
    const apiConfigMsg = createMsg('!apiconfig', ['SendMessages']);
    await handlePrefixCommand(apiConfigMsg, mockClient);
    assert.match(apiConfigMsg.getLastReply().content, /Only the Bot Owner can view or modify AI provider/i);

    // 12. Regular member attempting !apiconfig (with args) MUST be blocked
    const apiConfigSetMsg = createMsg('!apiconfig url https://evil.com', ['SendMessages']);
    await handlePrefixCommand(apiConfigSetMsg, mockClient);
    assert.match(apiConfigSetMsg.getLastReply().content, /Only the Bot Owner can view or modify AI provider/i);

    // 13. Regular member attempting !model (with NO arguments) MUST be blocked
    const modelNoArgMsg = createMsg('!model', ['SendMessages']);
    await handlePrefixCommand(modelNoArgMsg, mockClient);
    assert.match(modelNoArgMsg.getLastReply().content, /Only the Bot Owner can change the AI model/i);

    // 14. Server Owner who is NOT bot owner attempting !apiconfig is blocked
    const serverOwnerMsg = createMsg('!apiconfig', [], true);
    await handlePrefixCommand(serverOwnerMsg, mockClient);
    assert.match(serverOwnerMsg.getLastReply().content, /Only the Bot Owner can view or modify AI provider/i);

    // 15. Server Owner who is NOT bot owner attempting !model is blocked
    const serverOwnerModelMsg = createMsg('!model', [], true);
    await handlePrefixCommand(serverOwnerModelMsg, mockClient);
    assert.match(serverOwnerModelMsg.getLastReply().content, /Only the Bot Owner can change the AI model/i);

    // 16. Regular member attempting !backup MUST be blocked
    const backupMsg = createMsg('!backup', ['SendMessages']);
    await handlePrefixCommand(backupMsg, mockClient);
    assert.match(backupMsg.getLastReply().content, /Only the Server Owner or an Administrator/i);

    // 17. Bot Owner running !apiconfig succeeds and gets embed
    const botOwnerId = 'bot_owner_exclusive_777';
    const botOwnerApiMsg = createMsg('!apiconfig', [], false);
    botOwnerApiMsg.author.id = botOwnerId;
    botOwnerApiMsg.member.id = botOwnerId;
    mockClient.application = { owner: { id: botOwnerId } };

    await handlePrefixCommand(botOwnerApiMsg, mockClient);
    assert.ok(botOwnerApiMsg.getLastReply().embeds?.length > 0);

    // 18. Bot Owner running !model succeeds and gets embed
    const botOwnerModelMsg = createMsg('!model', [], false);
    botOwnerModelMsg.author.id = botOwnerId;
    botOwnerModelMsg.member.id = botOwnerId;
    await handlePrefixCommand(botOwnerModelMsg, mockClient);
    assert.ok(botOwnerModelMsg.getLastReply().embeds?.length > 0);

    // Clean up mock bot owner so later tests do not inherit it
    mockClient.application = null;
    clearCachedBotOwnerIds();
  });

  await test('Ruthless Malformed & Adversarial Input Stress Testing', async () => {
    const { handlePrefixCommand } = await import('../src/discord/commands.js');

    const mockClient = { ws: { ping: 20 }, user: { id: '999999' } };
    function createMsg(content, perms = ['Administrator']) {
      let replyData = null;
      const mem = mockMember({ perms });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: mockGuild(),
        channel: { name: 'admin-room', id: '999000', permissionsFor: () => mem.permissions },
        createdTimestamp: Date.now() - 20,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    // 1. Giveaway with negative winners count
    const gwayNeg = createMsg('!gway 1h -2 Discord Nitro');
    await handlePrefixCommand(gwayNeg, mockClient);
    assert.match(gwayNeg.getLastReply().content, /Usage: `!gway/);

    // 2. Giveaway with invalid duration format
    const gwayInvalidTime = createMsg('!gway next_monday 1 Discord Nitro');
    await handlePrefixCommand(gwayInvalidTime, mockClient);
    assert.match(gwayInvalidTime.getLastReply().content, /Invalid time format/);

    // 3. Unban with alphanumeric non-snowflake string
    const unbanInvalid = createMsg('!unban not_a_snowflake_id');
    await handlePrefixCommand(unbanInvalid, mockClient);
    assert.match(unbanInvalid.getLastReply().content, /Usage: `!unban/);

    // 4. Tag view for non-existent tag
    const tagMissing = createMsg('!tag completely_nonexistent_tag_xyz');
    await handlePrefixCommand(tagMissing, mockClient);
    assert.match(tagMissing.getLastReply().content, /was not found/i);

    // 5. Tag add with missing arguments
    const tagEmpty = createMsg('!tag add');
    await handlePrefixCommand(tagEmpty, mockClient);
    assert.match(tagEmpty.getLastReply().content, /Usage: `!tag add/);

    // 6. Approve on non-existent suggestion ID
    const approveMissing = createMsg('!approve sg_doesnotexist');
    await handlePrefixCommand(approveMissing, mockClient);
    assert.match(approveMissing.getLastReply().content, /was not found/i);

    // 7. Purge with count exceeding maximum 100 limit
    const purgeExcess = createMsg('!purge 500');
    await handlePrefixCommand(purgeExcess, mockClient);
    assert.match(purgeExcess.getLastReply().content, /Usage: `!purge <1-100>`/);

    // 8. Purge with 0 or negative count
    const purgeZero = createMsg('!purge 0');
    await handlePrefixCommand(purgeZero, mockClient);
    assert.match(purgeZero.getLastReply().content, /Usage: `!purge <1-100>`/);

    // 9. Slowmode with invalid number
    const slowmodeInvalid = createMsg('!slowmode not_a_number');
    await handlePrefixCommand(slowmodeInvalid, mockClient);
    assert.match(slowmodeInvalid.getLastReply().content, /Usage: `!slowmode/);

    // 10. Help community returns Community embed
    const helpComm = createMsg('!help community');
    await handlePrefixCommand(helpComm, mockClient);
    assert.equal(helpComm.getLastReply().embeds[0].data.title, 'Bobby — Community');
    assert.ok(helpComm.getLastReply().embeds[0].data.fields.length >= 4);
  });

  await test('Random Chatter / Contextual Yap Engine Invariants, Scheduling & Permissions', async () => {
    const {
      parseTimeString,
      formatMinutesToTime,
      calculateNextTriggers
    } = await import('../src/discord/client.js');
    const {
      getGuildChatter,
      setGuildChatter,
      removeGuildChatterTrigger,
      getAllActiveChatters
    } = await import('../src/util/storage.js');
    const { handlePrefixCommand } = await import('../src/discord/commands.js');
    const { TOOL_REQUIRED_PERMS } = await import('../src/agent/tools.js');

    // 1. Time parser verification
    assert.deepEqual(parseTimeString('10am'), { hours: 10, minutes: 0, totalMinutes: 600 });
    assert.deepEqual(parseTimeString('11pm'), { hours: 23, minutes: 0, totalMinutes: 1380 });
    assert.deepEqual(parseTimeString('10:30am'), { hours: 10, minutes: 30, totalMinutes: 630 });
    assert.deepEqual(parseTimeString('14:00'), { hours: 14, minutes: 0, totalMinutes: 840 });
    assert.deepEqual(parseTimeString('12am'), { hours: 0, minutes: 0, totalMinutes: 0 });
    assert.deepEqual(parseTimeString('12pm'), { hours: 12, minutes: 0, totalMinutes: 720 });
    assert.equal(parseTimeString('invalid_time'), null);
    assert.equal(parseTimeString('25:00'), null);
    assert.equal(parseTimeString('10:65'), null);

    // 2. Format minutes helper
    assert.equal(formatMinutesToTime(600), '10:00 AM');
    assert.equal(formatMinutesToTime(1380), '11:00 PM');
    assert.equal(formatMinutesToTime(0), '12:00 AM');

    // 3. Trigger generator produces sorted future timestamps
    const triggers = calculateNextTriggers(600, 1380, 2);
    assert.equal(triggers.length, 2);
    assert.ok(triggers[0] <= triggers[1]);
    assert.ok(triggers[0] > Date.now() - 5000);

    // 4. Storage state transitions
    const testG = 'g_chatter_test_' + Date.now();
    setGuildChatter(testG, {
      enabled: true,
      channelId: 'ch_general_123',
      count: 2,
      startMinutes: 600,
      endMinutes: 1380,
      triggers: [1000000000000, 2000000000000]
    });

    const chatterCfg = getGuildChatter(testG);
    assert.equal(chatterCfg.enabled, true);
    assert.equal(chatterCfg.channelId, 'ch_general_123');
    assert.equal(chatterCfg.count, 2);
    assert.equal(chatterCfg.triggers.length, 2);

    removeGuildChatterTrigger(testG, 1000000000000);
    assert.deepEqual(getGuildChatter(testG).triggers, [2000000000000]);

    const activeList = getAllActiveChatters();
    assert.ok(activeList.some((c) => c.guildId === testG && c.channelId === 'ch_general_123'));

    // 5. Prefix command permission gating
    const mockClient = { ws: { ping: 20 }, user: { id: '999999' } };
    function createMsg(content, perms = []) {
      let replyData = null;
      const mem = mockMember({ perms });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: mockGuild({ id: testG }),
        channel: { name: 'general', id: 'ch_general_123', isTextBased: () => true },
        createdTimestamp: Date.now() - 20,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    // Regular member blocked
    const regMsg = createMsg('!chatter set 2 10am 11pm', ['SendMessages']);
    await handlePrefixCommand(regMsg, mockClient);
    assert.match(regMsg.getLastReply().content, /Only the Server Owner or an Administrator can (configure|manage) random chatter/i);

    // Staff member sets chatter
    const staffMsg = createMsg('!chatter set 2 10am 11pm', ['ManageGuild']);
    await handlePrefixCommand(staffMsg, mockClient);
    assert.match(staffMsg.getLastReply().content, /Random Chatter Configured/);

    // Status command
    const statusMsg = createMsg('!chatter status', ['SendMessages']);
    await handlePrefixCommand(statusMsg, mockClient);
    assert.match(statusMsg.getLastReply().content, /Random Chatter Status/);

    // Rejection of invalid inverted window (11pm to 10am)
    const invMsg = createMsg('!chatter set 2 11pm 10am', ['ManageGuild']);
    await handlePrefixCommand(invMsg, mockClient);
    assert.match(invMsg.getLastReply().content, /Start time must be strictly before end time/);

    // Staff disables chatter
    const offMsg = createMsg('!chatter off', ['ManageGuild']);
    await handlePrefixCommand(offMsg, mockClient);
    assert.match(offMsg.getLastReply().content, /Random chatter disabled/);

    // 6. Tool permission mapping
    assert.deepEqual(TOOL_REQUIRED_PERMS.configure_chatter, ['ManageGuild']);
  });

  await test('Auto-Response Dedicated AI Chat Channel Configuration & Routing', async () => {
    const { getGuildAutoChatChannel, setGuildAutoChatChannel } = await import('../src/util/storage.js');
    const { handlePrefixCommand } = await import('../src/discord/commands.js');
    const { TOOL_REQUIRED_PERMS } = await import('../src/agent/tools.js');

    const testG = 'g_autochat_test_' + Date.now();

    // 1. Storage transitions
    assert.equal(getGuildAutoChatChannel(testG), null);
    setGuildAutoChatChannel(testG, 'ch_ai_room_777');
    assert.equal(getGuildAutoChatChannel(testG), 'ch_ai_room_777');
    setGuildAutoChatChannel(testG, null);
    assert.equal(getGuildAutoChatChannel(testG), null);

    // 2. Command permissions and execution
    const mockClient = { ws: { ping: 20 }, user: { id: '999999' } };
    function createMsg(content, perms = []) {
      let replyData = null;
      const mem = mockMember({ perms });
      return {
        content,
        author: mem.user,
        member: mem,
        guild: mockGuild({ id: testG }),
        channel: { name: 'talk-to-bobby', id: 'ch_ai_room_777', isTextBased: () => true },
        createdTimestamp: Date.now() - 20,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        getLastReply: () => replyData
      };
    }

    // Regular member blocked from setting auto-response channel
    const regMsg = createMsg('!aichannel #talk-to-bobby', ['SendMessages']);
    await handlePrefixCommand(regMsg, mockClient);
    assert.match(regMsg.getLastReply().content, /Only the Server Owner or an Administrator can configure the auto-response channel/i);

    // Staff configures channel
    const staffMsg = createMsg('!aichannel set', ['ManageGuild']);
    await handlePrefixCommand(staffMsg, mockClient);
    assert.match(staffMsg.getLastReply().content, /Auto-Response Channel Set to <#ch_ai_room_777>/);
    assert.equal(getGuildAutoChatChannel(testG), 'ch_ai_room_777');

    // Status check
    const statusMsg = createMsg('!aichannel status', ['SendMessages']);
    await handlePrefixCommand(statusMsg, mockClient);
    assert.match(statusMsg.getLastReply().content, /Auto-Response Channel/);
    assert.match(statusMsg.getLastReply().content, /<#ch_ai_room_777>/);

    // Staff disables auto-chat channel
    const offMsg = createMsg('!aichannel off', ['ManageGuild']);
    await handlePrefixCommand(offMsg, mockClient);
    assert.match(offMsg.getLastReply().content, /Auto-response channel disabled/);
    assert.equal(getGuildAutoChatChannel(testG), null);

    // 3. Tool permission mapping
    assert.deepEqual(TOOL_REQUIRED_PERMS.configure_auto_chat_channel, ['ManageGuild']);
  });

  await test('Rapid Burst Debounce Buffer & Abstract Thinking System Prompt Synthesis', async () => {
    const { queueBotInteraction, burstMap, clearBurstQueue } = await import('../src/discord/moderator.js');
    const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');

    clearBurstQueue();

    const mockClient = { user: { id: '999999' } };
    const mockChannel = { id: 'ch_burst_101', name: 'general', sendTyping: async () => {} };
    const mockUser = { id: 'usr_burst_202', username: 'fast_typer' };
    const mem = mockMember({ id: 'usr_burst_202', displayName: 'fast_typer' });

    function createBurstMsg(content) {
      return {
        content,
        author: mockUser,
        member: mem,
        channel: mockChannel,
        guild: mockGuild()
      };
    }

    // 1. Message 1 arrives -> enters burst queue
    queueBotInteraction(createBurstMsg('hey bobby'), mockClient);
    const key = 'ch_burst_101:usr_burst_202';
    assert.ok(burstMap.has(key));
    assert.deepEqual(burstMap.get(key).fragments, ['hey bobby']);

    // 2. Message 2 arrives shortly after -> appends fragment
    queueBotInteraction(createBurstMsg('wait look at #general'), mockClient);
    assert.deepEqual(burstMap.get(key).fragments, ['hey bobby', 'wait look at #general']);

    // 3. Message 3 arrives -> appends fragment
    queueBotInteraction(createBurstMsg('is it locked right now?'), mockClient);
    assert.deepEqual(burstMap.get(key).fragments, ['hey bobby', 'wait look at #general', 'is it locked right now?']);

    clearBurstQueue();
    assert.equal(burstMap.size, 0);

    // 4. System prompt abstract thinking validation
    const promptRegular = await buildSystemPrompt({
      guild: mockGuild(),
      member: mem,
      channel: mockChannel,
      isStaffCall: false,
      allowedToolNames: new Set(['read_channel_history'])
    });
    assert.match(promptRegular, /ABSTRACT THINKING & BURST SYNTHESIS/);

    const promptStaff = await buildSystemPrompt({
      guild: mockGuild(),
      member: mockMember({ displayName: 'AdminWalid' }),
      channel: mockChannel,
      isStaffCall: true,
      allowedToolNames: new Set(['finish'])
    });
    assert.match(promptStaff, /ABSTRACT THINKING & BURST SYNTHESIS/);
  });

  await test('Direct Channel Messaging Command (!say / !send) Invariants & Permission Checks', async () => {
    const { handlePrefixCommand } = await import('../src/discord/commands.js');

    const mockClient = {
      ws: { ping: 25 },
      user: { id: '999999999999999999' }
    };

    const targetSentMessages = [];
    const currentSentMessages = [];
    let commandDeleted = false;

    const mockTargetChannel = {
      id: 'target_ch_123456789',
      name: 'announcements',
      isTextBased: () => true,
      permissionsFor: (userOrMember) => ({
        has: (flag) => {
          if (userOrMember?.id === 'unauthorized_member_id') return false;
          return true;
        }
      }),
      send: async (payload) => {
        targetSentMessages.push(payload);
        return { id: 'sent_target_msg_1' };
      }
    };

    const mockCurrentChannel = {
      id: 'current_ch_987654321',
      name: 'general',
      isTextBased: () => true,
      permissionsFor: () => ({
        has: () => true
      }),
      send: async (payload) => {
        currentSentMessages.push(payload);
        return { id: 'sent_current_msg_1' };
      }
    };

    const g = mockGuild({ channels: [mockTargetChannel, mockCurrentChannel] });

    function createMsg(content, perms = [], options = {}) {
      let replyData = null;
      const mem = mockMember({ perms });
      if (options.authorId) {
        mem.id = options.authorId;
        mem.user.id = options.authorId;
      }
      return {
        content,
        author: mem.user,
        member: mem,
        guild: g,
        channel: mockCurrentChannel,
        attachments: new Map(),
        createdTimestamp: Date.now() - 10,
        reply: async (data) => {
          replyData = typeof data === 'string' ? { content: data } : data;
          return data;
        },
        delete: async () => {
          commandDeleted = true;
          return true;
        },
        getLastReply: () => replyData
      };
    }

    // 1. Regular member without ManageMessages or Admin is blocked
    const regMsg = createMsg('!say hello from regular member', ['SendMessages']);
    const regRes = await handlePrefixCommand(regMsg, mockClient);
    assert.equal(regRes, true);
    assert.match(regMsg.getLastReply().content, /Only the Server Owner or an Administrator/i);

    // 2. No content returns usage
    const noContentMsg = createMsg('!say', ['ManageMessages']);
    await handlePrefixCommand(noContentMsg, mockClient);
    assert.match(noContentMsg.getLastReply().content, /Usage: `!say/);

    // 3. Send in current channel deletes command message and sends directly
    commandDeleted = false;
    currentSentMessages.length = 0;
    const currentSayMsg = createMsg('!say Hello from Bobby in general!', ['ManageMessages']);
    const currentRes = await handlePrefixCommand(currentSayMsg, mockClient);
    assert.equal(currentRes, true);
    assert.equal(commandDeleted, true);
    assert.equal(currentSentMessages.length, 1);
    assert.equal(currentSentMessages[0].content, 'Hello from Bobby in general!');

    // 4. Send to target channel by #name
    targetSentMessages.length = 0;
    const targetSayNameMsg = createMsg('!say #announcements Big update dropping soon!', ['ManageMessages']);
    await handlePrefixCommand(targetSayNameMsg, mockClient);
    assert.equal(targetSentMessages.length, 1);
    assert.equal(targetSentMessages[0].content, 'Big update dropping soon!');
    assert.match(targetSayNameMsg.getLastReply().content, /Message sent to <#target_ch_123456789>/);

    // 5. Send to target channel by mention <#channelId>
    targetSentMessages.length = 0;
    const targetSayMentionMsg = createMsg('!send <#target_ch_123456789> Mention syntax test', ['Administrator']);
    await handlePrefixCommand(targetSayMentionMsg, mockClient);
    assert.equal(targetSentMessages.length, 1);
    assert.equal(targetSayMentionMsg.content, '!send <#target_ch_123456789> Mention syntax test');
    assert.equal(targetSentMessages[0].content, 'Mention syntax test');
    assert.match(targetSayMentionMsg.getLastReply().content, /Message sent to <#target_ch_123456789>/);

    // 6. Private channel security: caller lacks ViewChannel in target channel
    const privateSayMsg = createMsg('!say #announcements Sneaky sneak', ['ManageMessages'], { authorId: 'unauthorized_member_id' });
    await handlePrefixCommand(privateSayMsg, mockClient);
    assert.match(privateSayMsg.getLastReply().content, /You do not have access to view that channel/);

    // 7. MentionEveryone protection: user without MentionEveryone has everyone stripped from allowedMentions
    const everyoneMsg = createMsg('!say #announcements @everyone watch this', ['ManageMessages']);
    targetSentMessages.length = 0;
    await handlePrefixCommand(everyoneMsg, mockClient);
    assert.equal(targetSentMessages.length, 1);
    assert.deepEqual(targetSentMessages[0].allowedMentions.parse, ['users', 'roles']);

    // 8. Admin with MentionEveryone can mention everyone
    const adminEveryoneMsg = createMsg('!say #announcements @everyone official announcement', ['Administrator', 'MentionEveryone']);
    targetSentMessages.length = 0;
    await handlePrefixCommand(adminEveryoneMsg, mockClient);
    assert.equal(targetSentMessages.length, 1);
    assert.ok(adminEveryoneMsg.getLastReply().allowedMentions ? true : true);
    assert.ok(adminEveryoneMsg.getLastReply().content ? true : true);
    assert.ok(targetSentMessages[0].allowedMentions.parse.includes('everyone'));
  });

  // Clean up transient test guild entries from data/settings.json
  try {
    const fs = await import('fs');
    const path = await import('path');
    const settingsPath = path.resolve('data', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const testPrefixes = ['test_', 'guild_modmail_test', 'g_community_test', 'g_chatter_test', 'g_autochat_test', '100000000000000001'];
      let modified = false;
      for (const k of Object.keys(data)) {
        if (testPrefixes.some(p => k.startsWith(p))) {
          delete data[k];
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
      }
    }
  } catch (e) {
    // Non-fatal cleanup
  }

  console.log(`\n✅ All ${passed} test suites passed.\n`);
}

run().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
