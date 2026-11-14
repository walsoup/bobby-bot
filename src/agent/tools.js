import { z } from 'zod';
import vm from 'node:vm';
import { PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getSnapshot } from '../discord/snapshot.js';
import {
  getGuild,
  parseTimeString,
  formatMinutesToTime,
  calculateNextTriggers,
  scheduleGuildChatter,
  clearGuildChatterTimers
} from '../discord/client.js';
import { bitfieldToKeyNames, WHITELISTED_PERMISSIONS } from '../discord/permissions.js';
import {
  getGuildConfig,
  updateGuildConfig,
  getGuildMemories,
  setGuildMemory,
  deleteGuildMemory,
  getGuildReactionRoles,
  setReactionRole,
  setBatchReactionRoles,
  removeReactionRole,
  setGuildAIConfig,
  resetGuildAIConfig,
  setGuildPersona,
  setGuildModmail,
  getGuildChatter,
  setGuildChatter,
  getGuildAutoChatChannel,
  setGuildAutoChatChannel
} from '../util/storage.js';
import { summarizeMessages, translateText } from './aiServices.js';
import {
  resolveRoleId,
  resolveChannelId,
  createCategoryOp,
  createChannelOp,
  editChannelOp,
  deleteChannelOp,
  moveChannelOp,
  reorderChannelsOp,
  createRoleOp,
  editRoleOp,
  deleteRoleOp,
  setChannelPermissionsOp,
  sendMessageOp,
  editGuildOp,
  batchCreateStructureOp,
  batchCreateCategoriesOp,
  batchCreateChannelsOp,
  batchCreateRolesOp,
  batchEditChannelsOp,
  batchDeleteChannelsOp,
  batchMoveChannelsOp,
  batchEditRolesOp,
  batchDeleteRolesOp,
  batchSetChannelPermissionsOp,
  batchSendMessagesOp,
  listMembersOp,
  assignMemberRoleOp,
  removeMemberRoleOp,
  setMemberNicknameOp,
  timeoutMemberOp,
  kickMemberOp,
  banMemberOp,
  unbanMemberOp,
  listBansOp,
  getChannelMessagesOp,
  editMessageOp,
  deleteMessageOp,
  purgeMessagesOp,
  pinMessageOp,
  listEmojisOp,
  createEmojiOp,
  editEmojiOp,
  deleteEmojiOp,
  listStickersOp,
  createStickerOp,
  editStickerOp,
  deleteStickerOp,
  listSoundboardSoundsOp,
  createSoundboardSoundOp,
  editSoundboardSoundOp,
  deleteSoundboardSoundOp,
  listAutomodRulesOp,
  createAutomodRuleOp,
  editAutomodRuleOp,
  deleteAutomodRuleOp,
  listWebhooksOp,
  createWebhookOp,
  editWebhookOp,
  deleteWebhookOp,
  sendWebhookMessageOp,
  listIntegrationsOp
} from '../discord/ops.js';

// Flexible snowflake or identifier schema (allows numeric snowflakes or name lookups)
export const identifierSchema = z.string().min(1).max(100);

const permissionNameSchema = z.enum(WHITELISTED_PERMISSIONS);
const hexColorSchema = z.string().regex(/^#([A-Fa-f0-9]{6})$/, 'Color must be a 6-digit hex string like #FF5733');

/**
 * Tool registry holding all tool definitions.
 */
export const toolsRegistry = new Map();

function registerTool(toolDef) {
  toolsRegistry.set(toolDef.name, toolDef);
}

// -------------------------------------------------------------
// Tool: get_guild_snapshot (Read)
// -------------------------------------------------------------
registerTool({
  name: 'get_guild_snapshot',
  description: 'Retrieve a compact, token-efficient snapshot of the entire guild structure, including roles, categories, channels, and non-default permission overwrites. Call this first before planning or modifying anything.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async (_args, context = {}) => {
    try {
      const snapshot = await getSnapshot(context.guildId || null, context.member || null);
      return { ok: true, result: snapshot };
    } catch (err) {
      return { ok: false, error: `Failed to get guild snapshot: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_roles (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_roles',
  description: 'Get an updated list of all server roles with their IDs, names, positions, colors, and key permissions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async (_args, context = {}) => {
    try {
      const guild = await getGuild(context.guildId || null);
      const rolesCache = await guild.roles.fetch();
      const roles = rolesCache
        .map((r) => ({
          id: String(r.id),
          name: r.name,
          position: r.position,
          color: r.hexColor,
          hoist: r.hoist,
          keyPerms: bitfieldToKeyNames(r.permissions)
        }))
        .sort((a, b) => b.position - a.position);
      return { ok: true, result: { roles } };
    } catch (err) {
      return { ok: false, error: `Failed to list roles: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_category
// -------------------------------------------------------------
registerTool({
  name: 'create_category',
  description: 'Create a new channel category. Can optionally be made private with initial role access.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Category name (1-100 chars)' },
      position: { type: 'integer', description: 'Sorting position (0 is highest at top)' },
      private: { type: 'boolean', description: 'If true, denies ViewChannel for @everyone' },
      visible_to_role_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of role ID strings (or role names) allowed to view if private is true'
      }
    },
    required: ['name'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    position: z.number().int().min(0).optional(),
    private: z.boolean().optional(),
    visible_to_role_ids: z.array(identifierSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createCategoryOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create category "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_channel
// -------------------------------------------------------------
registerTool({
  name: 'create_channel',
  description: 'Create a new text, voice, announcement, forum, or stage channel. Announcement/forum/stage channels require the Community feature.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Channel name (1-100 chars, e.g. "general" or "voice-chat")' },
      type: {
        type: 'string',
        enum: ['text', 'voice', 'announcement', 'forum', 'stage'],
        description: 'Type of channel'
      },
      parent_id: { type: 'string', description: 'ID or name of the category to place this channel in' },
      topic: { type: 'string', description: 'Channel topic/description (max 1024 chars)' },
      slowmode_seconds: { type: 'integer', description: 'Slowmode delay per user in seconds (0-21600)' },
      nsfw: { type: 'boolean', description: 'Whether the channel is age-restricted (NSFW)' },
      position: { type: 'integer', description: 'Sorting position within category/server' }
    },
    required: ['name', 'type'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']),
    parent_id: identifierSchema.optional(),
    topic: z.string().max(1024).optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    nsfw: z.boolean().optional(),
    position: z.number().int().min(0).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create channel "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_channel
// -------------------------------------------------------------
registerTool({
  name: 'edit_channel',
  description: 'Edit properties of an existing channel (name, topic, slowmode, nsfw).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel to edit' },
      name: { type: 'string', description: 'New channel name (1-100 chars)' },
      topic: { type: 'string', description: 'New topic (max 1024 chars)' },
      slowmode_seconds: { type: 'integer', description: 'Slowmode in seconds (0-21600)' },
      nsfw: { type: 'boolean', description: 'Age-restricted flag' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    topic: z.string().max(1024).optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    nsfw: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_channel (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_channel',
  description: 'Permanently delete a channel or category.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID of the channel or category to delete' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema
  }),
  handler: async (args) => {
    try {
      const res = await deleteChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: move_channel
// -------------------------------------------------------------
registerTool({
  name: 'move_channel',
  description: 'Move a channel into a category (or uncategorized) and set its position.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID of the channel to move' },
      parent_id: {
        type: 'string',
        description: 'ID or name of the destination category (empty or omit to make uncategorized)'
      },
      position: { type: 'integer', description: 'Target position within category or server' }
    },
    required: ['channel_id', 'position'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    parent_id: identifierSchema.nullable().optional(),
    position: z.number().int().min(0)
  }),
  handler: async (args) => {
    try {
      const res = await moveChannelOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to move channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: reorder_channels
// -------------------------------------------------------------
registerTool({
  name: 'reorder_channels',
  description: 'Reorder multiple channels at once within a category or at the root level.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      parent_id: {
        type: 'string',
        description: 'Category ID (empty or omit for uncategorized root channels)'
      },
      ordered_channel_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of channel IDs in desired order from top to bottom'
      }
    },
    required: ['ordered_channel_ids'],
    additionalProperties: false
  },
  schema: z.object({
    parent_id: identifierSchema.nullable().optional(),
    ordered_channel_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args) => {
    try {
      const res = await reorderChannelsOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to reorder channels: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_role
// -------------------------------------------------------------
registerTool({
  name: 'create_role',
  description: 'Create a new server role with optional color, hoist, mentionable status, and whitelisted permissions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Role name (1-100 chars)' },
      color: { type: 'string', description: 'Hex color string (e.g. "#FF5733")' },
      hoist: { type: 'boolean', description: 'Whether role is displayed separately in the member list' },
      mentionable: { type: 'boolean', description: 'Whether anyone can @mention this role' },
      permissions: {
        type: 'array',
        items: {
          type: 'string',
          enum: WHITELISTED_PERMISSIONS
        },
        description: 'Array of whitelisted permission name strings'
      }
    },
    required: ['name'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    color: hexColorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await createRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create role "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_role
// -------------------------------------------------------------
registerTool({
  name: 'edit_role',
  description: 'Edit properties and permissions of an existing role. Cannot edit roles higher than bot highest role.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      role_id: { type: 'string', description: 'ID or name of the role to edit' },
      name: { type: 'string', description: 'New role name (cannot rename @everyone)' },
      color: { type: 'string', description: 'Hex color string (e.g. "#5865F2")' },
      hoist: { type: 'boolean', description: 'Hoist in member sidebar' },
      mentionable: { type: 'boolean', description: 'Mentionable by all members' },
      permissions: {
        type: 'array',
        items: {
          type: 'string',
          enum: WHITELISTED_PERMISSIONS
        },
        description: 'Array of whitelisted permission names'
      }
    },
    required: ['role_id'],
    additionalProperties: false
  },
  schema: z.object({
    role_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    color: hexColorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await editRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit role ${args.role_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_role (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_role',
  description: 'Permanently delete a role.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      role_id: { type: 'string', description: 'ID or name of the role to delete' }
    },
    required: ['role_id'],
    additionalProperties: false
  },
  schema: z.object({
    role_id: identifierSchema
  }),
  handler: async (args) => {
    try {
      const res = await deleteRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete role ${args.role_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_channel_permissions
// -------------------------------------------------------------
registerTool({
  name: 'set_channel_permissions',
  description: 'Set explicit permission overwrites on a channel or category for a specific role or member. Prefer setting on categories so channels inherit.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel or category' },
      target_id: { type: 'string', description: 'ID or name of the target role or member (for @everyone, use guild ID or "@everyone")' },
      target_type: { type: 'string', enum: ['role', 'member'], description: 'Whether target is a role or member' },
      allow: {
        type: 'array',
        items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
        description: 'Array of whitelisted permissions to explicitly ALLOW'
      },
      deny: {
        type: 'array',
        items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
        description: 'Array of whitelisted permissions to explicitly DENY'
      }
    },
    required: ['channel_id', 'target_id', 'target_type'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    target_id: identifierSchema,
    target_type: z.enum(['role', 'member']),
    allow: z.array(permissionNameSchema).optional(),
    deny: z.array(permissionNameSchema).optional()
  }),
  handler: async (args) => {
    try {
      const res = await setChannelPermissionsOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to set permissions on ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: send_message
// -------------------------------------------------------------
registerTool({
  name: 'send_message',
  description: 'Send a message to a text channel, e.g. for server rules, welcome info, or category guides. Optionally pin the message.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the text channel' },
      content: { type: 'string', description: 'Message content (1-2000 chars)' },
      pin: { type: 'boolean', description: 'Whether to pin the message in the channel' }
    },
    required: ['channel_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    content: z.string().min(1).max(2000),
    pin: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await sendMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to send message to channel ${args.channel_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_guild
// -------------------------------------------------------------
registerTool({
  name: 'edit_guild',
  description: 'Edit server name, visual assets (icon, banner, splash), description, vanity URL code, system channel, rules channel, AFK channel/timeout, verification level, or moderation settings.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'New guild name (2-100 chars)' },
      icon: { type: 'string', description: 'Server icon image (HTTPS URL or base64 data URI, or empty to remove)' },
      banner: { type: 'string', description: 'Server banner image (HTTPS URL or base64 data URI, or empty to remove)' },
      splash: { type: 'string', description: 'Server invite splash image (HTTPS URL or base64 data URI, or empty to remove)' },
      description: { type: 'string', description: 'Server description for discovery / community (max 120 chars)' },
      vanity_code: { type: 'string', description: 'Custom vanity invite URL code (if server has sufficient boost level)' },
      system_channel_id: { type: 'string', description: 'System message channel ID or name (where welcome/boost messages go)' },
      rules_channel_id: { type: 'string', description: 'Rules channel ID or name' },
      afk_channel_id: { type: 'string', description: 'AFK voice channel ID or name' },
      afk_timeout: { type: 'integer', description: 'AFK timeout in seconds (60, 300, 900, 1800, or 3600)' },
      verification_level: { type: 'integer', description: '0=None, 1=Low, 2=Medium, 3=High, 4=VeryHigh' },
      explicit_content_filter: { type: 'integer', description: '0=Disabled, 1=MembersWithoutRoles, 2=AllMembers' },
      default_message_notifications: { type: 'integer', description: '0=AllMessages, 1=OnlyMentions' }
    },
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(100).optional(),
    icon: z.string().nullable().optional(),
    banner: z.string().nullable().optional(),
    splash: z.string().nullable().optional(),
    description: z.string().max(120).nullable().optional(),
    vanity_code: z.string().max(32).nullable().optional(),
    system_channel_id: identifierSchema.nullable().optional(),
    rules_channel_id: identifierSchema.nullable().optional(),
    afk_channel_id: identifierSchema.nullable().optional(),
    afk_timeout: z.number().int().optional(),
    verification_level: z.number().int().min(0).max(4).optional(),
    explicit_content_filter: z.number().int().min(0).max(2).optional(),
    default_message_notifications: z.number().int().min(0).max(1).optional()
  }),
  handler: async (args) => {
    try {
      const res = await editGuildOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit guild: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_structure (All-in-one full server deployment)
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_structure',
  description: 'Deploy an entire Discord server layout in a single high-efficiency command. Creates all specified roles, categories, and channels at once with proper permissions and relationships.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Role name' },
            color: { type: 'string', description: 'Hex color string (e.g. #3498DB)' },
            hoist: { type: 'boolean' },
            mentionable: { type: 'boolean' },
            permissions: { type: 'array', items: { type: 'string' } }
          },
          required: ['name']
        },
        description: 'List of server roles to create'
      },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Category name' },
            position: { type: 'integer' },
            private: { type: 'boolean', description: 'If true, hides from @everyone' },
            visible_to_roles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Role names or IDs allowed to view if private'
            },
            channels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['text', 'voice', 'announcement', 'forum', 'stage'] },
                  topic: { type: 'string' },
                  slowmode_seconds: { type: 'integer' },
                  nsfw: { type: 'boolean' },
                  position: { type: 'integer' }
                },
                required: ['name']
              },
              description: 'Channels to create under this category'
            }
          },
          required: ['name']
        },
        description: 'Categories to create with their nested channels'
      },
      uncategorized_channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['text', 'voice', 'announcement', 'forum', 'stage'] },
            topic: { type: 'string' }
          },
          required: ['name']
        },
        description: 'Uncategorized channels at root level'
      }
    },
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      name: z.string().min(1),
      color: z.string().optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(z.string()).optional()
    })).optional(),
    categories: z.array(z.object({
      name: z.string().min(1),
      position: z.number().int().optional(),
      private: z.boolean().optional(),
      visible_to_roles: z.array(z.string()).optional(),
      visible_to_role_ids: z.array(z.string()).optional(),
      channels: z.array(z.object({
        name: z.string().min(1),
        type: z.string().optional(),
        topic: z.string().optional(),
        slowmode_seconds: z.number().int().optional(),
        nsfw: z.boolean().optional(),
        position: z.number().int().optional()
      })).optional()
    })).optional(),
    uncategorized_channels: z.array(z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      topic: z.string().optional()
    })).optional()
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateStructureOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch creation failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_edit_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_edit_channels',
  description: 'Edit properties (names, topics, slowmode, nsfw) of multiple channels at once in a single command.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or current name of the channel' },
            name: { type: 'string', description: 'New channel name' },
            topic: { type: 'string', description: 'New channel topic' },
            slowmode_seconds: { type: 'integer' },
            nsfw: { type: 'boolean' }
          },
          required: ['channel_id']
        },
        description: 'Array of channel updates'
      }
    },
    required: ['channels'],
    additionalProperties: false
  },
  schema: z.object({
    channels: z.array(z.object({
      channel_id: identifierSchema,
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      nsfw: z.boolean().optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchEditChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch edit channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_delete_channels (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'batch_delete_channels',
  description: 'Delete multiple channels or categories at once.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of channel or category IDs (or names) to delete'
      }
    },
    required: ['channel_ids'],
    additionalProperties: false
  },
  schema: z.object({
    channel_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchDeleteChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch delete channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_move_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_move_channels',
  description: 'Move, reparent, and position multiple channels at once in a single command.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      moves: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'Channel ID or name to move' },
            parent_id: { type: 'string', description: 'Destination category ID/name (empty or omit for root)' },
            position: { type: 'integer', description: 'Position within parent/server' }
          },
          required: ['channel_id']
        },
        description: 'Array of move operations'
      }
    },
    required: ['moves'],
    additionalProperties: false
  },
  schema: z.object({
    moves: z.array(z.object({
      channel_id: identifierSchema,
      parent_id: identifierSchema.nullable().optional(),
      position: z.number().int().min(0).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchMoveChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch move channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_edit_roles
// -------------------------------------------------------------
registerTool({
  name: 'batch_edit_roles',
  description: 'Edit properties (names, colors, hoist, mentionable, permissions) of multiple roles at once.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role_id: { type: 'string', description: 'Role ID or name' },
            name: { type: 'string' },
            color: { type: 'string' },
            hoist: { type: 'boolean' },
            mentionable: { type: 'boolean' },
            permissions: { type: 'array', items: { type: 'string' } }
          },
          required: ['role_id']
        },
        description: 'Array of role edits'
      }
    },
    required: ['roles'],
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      role_id: identifierSchema,
      name: z.string().min(1).max(100).optional(),
      color: hexColorSchema.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchEditRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch edit roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_delete_roles (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'batch_delete_roles',
  description: 'Delete multiple roles at once.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      role_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of role IDs (or names) to delete'
      }
    },
    required: ['role_ids'],
    additionalProperties: false
  },
  schema: z.object({
    role_ids: z.array(identifierSchema).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchDeleteRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch delete roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_categories
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_categories',
  description: 'Create multiple channel categories at once in a single command. Reduces token use and turn overhead.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Category name (1-100 chars)' },
            position: { type: 'integer', description: 'Sorting position (0 is top)' },
            private: { type: 'boolean', description: 'If true, denies ViewChannel for @everyone' },
            visible_to_role_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Role IDs or names allowed to view if private'
            }
          },
          required: ['name']
        },
        description: 'Array of categories to create'
      }
    },
    required: ['categories'],
    additionalProperties: false
  },
  schema: z.object({
    categories: z.array(z.object({
      name: z.string().min(1).max(100),
      position: z.number().int().min(0).optional(),
      private: z.boolean().optional(),
      visible_to_role_ids: z.array(identifierSchema).optional(),
      visible_to_roles: z.array(identifierSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateCategoriesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create categories failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_channels
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_channels',
  description: 'Create multiple channels at once in a single command. Reduces token use and turn overhead.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Channel name (1-100 chars)' },
            type: {
              type: 'string',
              enum: ['text', 'voice', 'announcement', 'forum', 'stage'],
              description: 'Channel type'
            },
            parent_id: { type: 'string', description: 'Category ID or category name' },
            topic: { type: 'string', description: 'Topic/description (max 1024 chars)' },
            slowmode_seconds: { type: 'integer', description: 'Slowmode delay in seconds (0-21600)' },
            nsfw: { type: 'boolean', description: 'Age-restricted flag' },
            position: { type: 'integer', description: 'Sorting position' }
          },
          required: ['name', 'type']
        },
        description: 'Array of channels to create'
      }
    },
    required: ['channels'],
    additionalProperties: false
  },
  schema: z.object({
    channels: z.array(z.object({
      name: z.string().min(1).max(100),
      type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']),
      parent_id: identifierSchema.optional(),
      topic: z.string().max(1024).optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      nsfw: z.boolean().optional(),
      position: z.number().int().min(0).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateChannelsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create channels failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_create_roles
// -------------------------------------------------------------
registerTool({
  name: 'batch_create_roles',
  description: 'Create multiple server roles at once with optional colors, hoist, mentionable status, and permissions. Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Role name (1-100 chars)' },
            color: { type: 'string', description: 'Hex color string (e.g. "#FF5733")' },
            hoist: { type: 'boolean', description: 'Display separately in member list' },
            mentionable: { type: 'boolean', description: 'Mentionable by all members' },
            permissions: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Array of whitelisted permission names'
            }
          },
          required: ['name']
        },
        description: 'Array of roles to create'
      }
    },
    required: ['roles'],
    additionalProperties: false
  },
  schema: z.object({
    roles: z.array(z.object({
      name: z.string().min(1).max(100),
      color: hexColorSchema.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchCreateRolesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch create roles failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_set_channel_permissions
// -------------------------------------------------------------
registerTool({
  name: 'batch_set_channel_permissions',
  description: 'Set explicit permission overwrites on multiple channels or categories for roles or members in a single command. Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      overwrites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or name of channel or category' },
            target_id: { type: 'string', description: 'Target role/member ID or name ("@everyone" for default)' },
            target_type: { type: 'string', enum: ['role', 'member'] },
            allow: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Permissions to explicitly ALLOW'
            },
            deny: {
              type: 'array',
              items: { type: 'string', enum: WHITELISTED_PERMISSIONS },
              description: 'Permissions to explicitly DENY'
            }
          },
          required: ['channel_id', 'target_id', 'target_type']
        },
        description: 'Array of permission overwrites'
      }
    },
    required: ['overwrites'],
    additionalProperties: false
  },
  schema: z.object({
    overwrites: z.array(z.object({
      channel_id: identifierSchema,
      target_id: identifierSchema,
      target_type: z.enum(['role', 'member']),
      allow: z.array(permissionNameSchema).optional(),
      deny: z.array(permissionNameSchema).optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchSetChannelPermissionsOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch set channel permissions failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_send_messages
// -------------------------------------------------------------
registerTool({
  name: 'batch_send_messages',
  description: 'Send multiple messages to one or more text channels in a single command (e.g. posting server rules, welcome text, category guides). Highly token efficient.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            channel_id: { type: 'string', description: 'ID or name of text channel' },
            content: { type: 'string', description: 'Message content (1-2000 chars)' },
            pin: { type: 'boolean', description: 'Whether to pin the message' }
          },
          required: ['channel_id', 'content']
        },
        description: 'Array of messages to send'
      }
    },
    required: ['messages'],
    additionalProperties: false
  },
  schema: z.object({
    messages: z.array(z.object({
      channel_id: identifierSchema,
      content: z.string().min(1).max(2000),
      pin: z.boolean().optional()
    })).min(1)
  }),
  handler: async (args, context) => {
    try {
      const res = await batchSendMessagesOp(args, context);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Batch send messages failed: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_members (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_members',
  description: 'Search or list server members with their roles, nicknames, joined dates, and moderation status. Use this to find member IDs before managing roles or moderating.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query to filter members by username or nickname' },
      limit: { type: 'integer', description: 'Max number of members to return (1-100, default 50)' },
      after: { type: 'string', description: 'Snowflake ID to paginate after' }
    },
    additionalProperties: false
  },
  schema: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    after: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await listMembersOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list members: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: assign_member_role
// -------------------------------------------------------------
registerTool({
  name: 'assign_member_role',
  description: 'Assign a role to a specific guild member.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      role_id: { type: 'string', description: 'ID or name of the role to assign' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id', 'role_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    role_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await assignMemberRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to assign role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: remove_member_role
// -------------------------------------------------------------
registerTool({
  name: 'remove_member_role',
  description: 'Remove a role from a specific guild member.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      role_id: { type: 'string', description: 'ID or name of the role to remove' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id', 'role_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    role_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await removeMemberRoleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to remove role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_member_nickname
// -------------------------------------------------------------
registerTool({
  name: 'set_member_nickname',
  description: 'Change or reset a member\'s nickname in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      nickname: { type: 'string', description: 'New nickname (empty string or omit to reset to default username)' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    nickname: z.string().nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await setMemberNicknameOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to set nickname: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: timeout_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'timeout_member',
  description: 'Temporarily timeout/mute a member or remove an existing timeout.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member' },
      duration_minutes: { type: 'integer', description: 'Duration in minutes (1 to 40320 = 28 days, or 0 to remove timeout)' },
      reason: { type: 'string', description: 'Audit log reason for timeout' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    duration_minutes: z.number().int().min(0).max(40320).nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await timeoutMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to timeout member: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: kick_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'kick_member',
  description: 'Kick a member from the server.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      member_id: { type: 'string', description: 'ID, username, or nickname of the member to kick' },
      reason: { type: 'string', description: 'Reason for kicking the member' }
    },
    required: ['member_id'],
    additionalProperties: false
  },
  schema: z.object({
    member_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await kickMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to kick member: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: ban_member (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'ban_member',
  description: 'Permanently ban a user from the server and optionally delete their recent messages.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'ID, username, or nickname of the user to ban' },
      delete_message_seconds: { type: 'integer', description: 'Number of seconds of message history to delete (0 to 604800 = 7 days, e.g. 86400 for 1 day)' },
      reason: { type: 'string', description: 'Reason for the ban' }
    },
    required: ['user_id'],
    additionalProperties: false
  },
  schema: z.object({
    user_id: identifierSchema,
    delete_message_seconds: z.number().int().min(0).max(604800).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await banMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to ban user: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: unban_member
// -------------------------------------------------------------
registerTool({
  name: 'unban_member',
  description: 'Unban a previously banned user by their user ID.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'ID of the banned user' },
      reason: { type: 'string', description: 'Reason for unbanning' }
    },
    required: ['user_id'],
    additionalProperties: false
  },
  schema: z.object({
    user_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await unbanMemberOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to unban user: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_bans (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_bans',
  description: 'List all banned users in the server with their recorded ban reasons.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Maximum number of bans to fetch (1-100, default 50)' }
    },
    additionalProperties: false
  },
  schema: z.object({
    limit: z.number().int().min(1).max(100).optional()
  }),
  handler: async (args) => {
    try {
      const res = await listBansOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list bans: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: get_channel_messages (Read)
// -------------------------------------------------------------
registerTool({
  name: 'get_channel_messages',
  description: 'Read recent message history in a channel to analyze user activity, verify bot posts, or inspect discussions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      limit: { type: 'integer', description: 'Number of messages to retrieve (1-100, default 50)' },
      before_id: { type: 'string', description: 'Snowflake message ID to fetch messages before' },
      after_id: { type: 'string', description: 'Snowflake message ID to fetch messages after' },
      around_id: { type: 'string', description: 'Snowflake message ID to fetch messages around' }
    },
    required: ['channel_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    limit: z.number().int().min(1).max(100).optional(),
    before_id: identifierSchema.optional(),
    after_id: identifierSchema.optional(),
    around_id: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await getChannelMessagesOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to get channel messages: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_message
// -------------------------------------------------------------
registerTool({
  name: 'edit_message',
  description: 'Edit a previously sent message in a channel (e.g. updating server rules, welcome banners, or category guides).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message to edit' },
      content: { type: 'string', description: 'New message content (1-2000 chars)' }
    },
    required: ['channel_id', 'message_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    content: z.string().min(1).max(2000)
  }),
  handler: async (args) => {
    try {
      const res = await editMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_message (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_message',
  description: 'Permanently delete a specific message from a channel.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'message_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: purge_messages (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'purge_messages',
  description: 'Bulk delete multiple messages (2-100) in a channel, optionally filtering by author or bot-only.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      count: { type: 'integer', description: 'Number of recent messages to inspect/delete (2-100, default 10)' },
      filter_user_id: { type: 'string', description: 'Only delete messages sent by this user ID or username' },
      bot_only: { type: 'boolean', description: 'If true, only deletes bot messages' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'count'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    count: z.number().int().min(2).max(100),
    filter_user_id: identifierSchema.optional(),
    bot_only: z.boolean().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await purgeMessagesOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to purge messages: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: pin_message
// -------------------------------------------------------------
registerTool({
  name: 'pin_message',
  description: 'Pin or unpin a message in a text channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'ID or name of the channel' },
      message_id: { type: 'string', description: 'ID of the message' },
      pinned: { type: 'boolean', description: 'True to pin, false to unpin (default true)' }
    },
    required: ['channel_id', 'message_id'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    pinned: z.boolean().optional()
  }),
  handler: async (args) => {
    try {
      const res = await pinMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to pin/unpin message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_emojis (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_emojis',
  description: 'List all custom emojis in the server with IDs, names, animated flags, and URLs.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listEmojisOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list emojis: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_emoji
// -------------------------------------------------------------
registerTool({
  name: 'create_emoji',
  description: 'Upload and create a new custom emoji for the server from an image URL or data URI.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Emoji name (2-32 alphanumeric/underscore characters)' },
      image: { type: 'string', description: 'HTTPS image URL or base64 data URI (PNG, JPEG, GIF)' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of role IDs or names allowed to use this emoji'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'image'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(32),
    image: z.string().min(1),
    roles: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create emoji "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_emoji
// -------------------------------------------------------------
registerTool({
  name: 'edit_emoji',
  description: 'Edit a custom emoji\'s name or restricted roles.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      emoji_id: { type: 'string', description: 'ID or current name of the emoji' },
      name: { type: 'string', description: 'New emoji name (2-32 chars)' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of role IDs/names allowed to use this emoji'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['emoji_id'],
    additionalProperties: false
  },
  schema: z.object({
    emoji_id: identifierSchema,
    name: z.string().min(2).max(32).optional(),
    roles: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit emoji ${args.emoji_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_emoji (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_emoji',
  description: 'Permanently delete a custom emoji.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      emoji_id: { type: 'string', description: 'ID or name of the emoji to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['emoji_id'],
    additionalProperties: false
  },
  schema: z.object({
    emoji_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteEmojiOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete emoji ${args.emoji_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_stickers (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_stickers',
  description: 'List all custom stickers in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listStickersOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list stickers: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_sticker
// -------------------------------------------------------------
registerTool({
  name: 'create_sticker',
  description: 'Create a new custom sticker for the server (PNG, APNG, Lottie).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Sticker name (2-30 chars)' },
      file: { type: 'string', description: 'HTTPS file URL or data URI' },
      tags: { type: 'string', description: 'Related emoji string (e.g. "👍" or "wave")' },
      description: { type: 'string', description: 'Description of the sticker (max 100 chars)' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'file', 'tags'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(30),
    file: z.string().min(1),
    tags: z.string().min(1),
    description: z.string().max(100).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create sticker "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_sticker
// -------------------------------------------------------------
registerTool({
  name: 'edit_sticker',
  description: 'Edit a custom sticker\'s name, description, or tags.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      sticker_id: { type: 'string', description: 'ID or name of the sticker' },
      name: { type: 'string', description: 'New sticker name (2-30 chars)' },
      description: { type: 'string', description: 'New description (max 100 chars)' },
      tags: { type: 'string', description: 'New related emoji tags' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sticker_id'],
    additionalProperties: false
  },
  schema: z.object({
    sticker_id: identifierSchema,
    name: z.string().min(2).max(30).optional(),
    description: z.string().max(100).optional(),
    tags: z.string().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit sticker ${args.sticker_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_sticker (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_sticker',
  description: 'Permanently delete a custom sticker.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      sticker_id: { type: 'string', description: 'ID or name of the sticker to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sticker_id'],
    additionalProperties: false
  },
  schema: z.object({
    sticker_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteStickerOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete sticker ${args.sticker_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_soundboard_sounds (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_soundboard_sounds',
  description: 'List all custom soundboard sounds in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listSoundboardSoundsOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list soundboard sounds: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_soundboard_sound
// -------------------------------------------------------------
registerTool({
  name: 'create_soundboard_sound',
  description: 'Upload and create a new custom soundboard sound for the guild (MP3/OGG audio up to 512KB).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Sound name (2-32 chars)' },
      sound: { type: 'string', description: 'Audio file HTTPS URL or base64 data URI' },
      volume: { type: 'number', description: 'Default playback volume (0.0 to 1.0, default 1.0)' },
      emoji_name: { type: 'string', description: 'Unicode emoji string (e.g. "👏")' },
      emoji_id: { type: 'string', description: 'Custom emoji ID' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'sound'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(2).max(32),
    sound: z.string().min(1),
    volume: z.number().min(0).max(1).optional(),
    emoji_name: z.string().optional(),
    emoji_id: identifierSchema.optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create soundboard sound "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_soundboard_sound
// -------------------------------------------------------------
registerTool({
  name: 'edit_soundboard_sound',
  description: 'Edit a soundboard sound\'s name, volume, or associated emoji.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      sound_id: { type: 'string', description: 'ID or name of the soundboard sound' },
      name: { type: 'string', description: 'New sound name (2-32 chars)' },
      volume: { type: 'number', description: 'New volume (0.0 to 1.0)' },
      emoji_name: { type: 'string', description: 'Unicode emoji string' },
      emoji_id: { type: 'string', description: 'Custom emoji ID' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sound_id'],
    additionalProperties: false
  },
  schema: z.object({
    sound_id: identifierSchema,
    name: z.string().min(2).max(32).optional(),
    volume: z.number().min(0).max(1).optional(),
    emoji_name: z.string().nullable().optional(),
    emoji_id: identifierSchema.nullable().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit soundboard sound ${args.sound_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_soundboard_sound (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_soundboard_sound',
  description: 'Permanently delete a soundboard sound.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      sound_id: { type: 'string', description: 'ID or name of the sound to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['sound_id'],
    additionalProperties: false
  },
  schema: z.object({
    sound_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteSoundboardSoundOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete soundboard sound ${args.sound_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_automod_rules (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_automod_rules',
  description: 'List all auto-moderation rules configured in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listAutomodRulesOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list auto-mod rules: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_automod_rule
// -------------------------------------------------------------
registerTool({
  name: 'create_automod_rule',
  description: 'Create an Auto-Moderation rule (e.g. blocking forbidden words, regex patterns, anti-spam, or mention spam).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Rule name (1-100 chars)' },
      trigger_type: {
        type: 'string',
        enum: ['keyword', 'harmful_link', 'spam', 'mention_spam', 'keyword_preset'],
        description: 'Trigger type'
      },
      keyword_filter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of keyword string filters (wildcards allowed, e.g. "*badword*")'
      },
      regex_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of regex pattern strings (max 10)'
      },
      mention_total_limit: {
        type: 'integer',
        description: 'Total mention limit for mention_spam trigger (1-50)'
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['block_message', 'send_alert_message', 'timeout'] },
            channel_id: { type: 'string', description: 'Alert channel ID for send_alert_message action' },
            duration_seconds: { type: 'integer', description: 'Timeout duration in seconds for timeout action' }
          },
          required: ['type']
        },
        description: 'Array of actions to take when rule triggers'
      },
      enabled: { type: 'boolean', description: 'Whether rule is initially active (default true)' },
      exempt_roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Role IDs or names exempt from this rule'
      },
      exempt_channels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Channel IDs or names exempt from this rule'
      },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['name', 'trigger_type'],
    additionalProperties: false
  },
  schema: z.object({
    name: z.string().min(1).max(100),
    trigger_type: z.enum(['keyword', 'harmful_link', 'spam', 'mention_spam', 'keyword_preset']),
    keyword_filter: z.array(z.string()).optional(),
    regex_patterns: z.array(z.string()).optional(),
    presets: z.array(z.number().int()).optional(),
    mention_total_limit: z.number().int().min(1).max(50).optional(),
    actions: z.array(z.object({
      type: z.enum(['block_message', 'send_alert_message', 'timeout']),
      channel_id: identifierSchema.optional(),
      duration_seconds: z.number().int().optional()
    })).optional(),
    enabled: z.boolean().optional(),
    exempt_roles: z.array(identifierSchema).optional(),
    exempt_channels: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create auto-mod rule "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_automod_rule
// -------------------------------------------------------------
registerTool({
  name: 'edit_automod_rule',
  description: 'Edit an existing Auto-Moderation rule\'s name, status, filters, actions, or exemptions.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', description: 'ID or name of the auto-mod rule' },
      name: { type: 'string', description: 'New rule name' },
      enabled: { type: 'boolean', description: 'Enable or disable the rule' },
      keyword_filter: { type: 'array', items: { type: 'string' } },
      regex_patterns: { type: 'array', items: { type: 'string' } },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['block_message', 'send_alert_message', 'timeout'] },
            channel_id: { type: 'string' },
            duration_seconds: { type: 'integer' }
          },
          required: ['type']
        }
      },
      exempt_roles: { type: 'array', items: { type: 'string' } },
      exempt_channels: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['rule_id'],
    additionalProperties: false
  },
  schema: z.object({
    rule_id: identifierSchema,
    name: z.string().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    keyword_filter: z.array(z.string()).optional(),
    regex_patterns: z.array(z.string()).optional(),
    actions: z.array(z.object({
      type: z.enum(['block_message', 'send_alert_message', 'timeout']),
      channel_id: identifierSchema.optional(),
      duration_seconds: z.number().int().optional()
    })).optional(),
    exempt_roles: z.array(identifierSchema).optional(),
    exempt_channels: z.array(identifierSchema).optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit auto-mod rule ${args.rule_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_automod_rule (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_automod_rule',
  description: 'Permanently delete an Auto-Moderation rule.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      rule_id: { type: 'string', description: 'ID or name of the auto-mod rule to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['rule_id'],
    additionalProperties: false
  },
  schema: z.object({
    rule_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteAutomodRuleOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete auto-mod rule ${args.rule_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_webhooks (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_webhooks',
  description: 'List webhooks in the server or for a specific channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Optional channel ID/name to filter webhooks' }
    },
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema.optional()
  }),
  handler: async (args) => {
    try {
      const res = await listWebhooksOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list webhooks: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_webhook
// -------------------------------------------------------------
registerTool({
  name: 'create_webhook',
  description: 'Create a new webhook for a text/announcement channel to enable external bot or API integrations.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel ID or name to create the webhook in' },
      name: { type: 'string', description: 'Webhook name (1-80 chars)' },
      avatar: { type: 'string', description: 'Avatar HTTPS URL or data URI' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['channel_id', 'name'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    name: z.string().min(1).max(80),
    avatar: z.string().optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await createWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to create webhook "${args.name}": ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: edit_webhook
// -------------------------------------------------------------
registerTool({
  name: 'edit_webhook',
  description: 'Edit a webhook\'s name, avatar, or move it to a different channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name' },
      name: { type: 'string', description: 'New webhook name (1-80 chars)' },
      avatar: { type: 'string', description: 'New avatar HTTPS URL or empty to remove' },
      channel_id: { type: 'string', description: 'New destination channel ID/name' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['webhook_id'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    name: z.string().min(1).max(80).optional(),
    avatar: z.string().nullable().optional(),
    channel_id: identifierSchema.optional(),
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await editWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to edit webhook ${args.webhook_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: delete_webhook (Destructive)
// -------------------------------------------------------------
registerTool({
  name: 'delete_webhook',
  description: 'Permanently delete a webhook.',
  destructive: true,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name to delete' },
      reason: { type: 'string', description: 'Audit log reason' }
    },
    required: ['webhook_id'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    reason: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await deleteWebhookOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to delete webhook ${args.webhook_id}: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: send_webhook_message
// -------------------------------------------------------------
registerTool({
  name: 'send_webhook_message',
  description: 'Send a message through a webhook with custom display name and avatar.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      webhook_id: { type: 'string', description: 'Webhook ID or name' },
      content: { type: 'string', description: 'Message content (1-2000 chars)' },
      username: { type: 'string', description: 'Override webhook username' },
      avatar_url: { type: 'string', description: 'Override webhook avatar URL' }
    },
    required: ['webhook_id', 'content'],
    additionalProperties: false
  },
  schema: z.object({
    webhook_id: identifierSchema,
    content: z.string().min(1).max(2000),
    username: z.string().optional(),
    avatar_url: z.string().optional()
  }),
  handler: async (args) => {
    try {
      const res = await sendWebhookMessageOp(args);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to send webhook message: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_integrations (Read)
// -------------------------------------------------------------
registerTool({
  name: 'list_integrations',
  description: 'List active integrations, bots, and connected apps in the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).passthrough(),
  handler: async () => {
    try {
      const res = await listIntegrationsOp();
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: `Failed to list integrations: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: finish
// -------------------------------------------------------------
registerTool({
  name: 'finish',
  description: 'Call this tool when all requested actions are complete, providing a concise final summary for Discord.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Concise summary of the actions taken' }
    },
    required: ['summary'],
    additionalProperties: false
  },
  schema: z.object({
    summary: z.string().min(1)
  }),
  handler: async (args) => {
    return { ok: true, result: { finished: true, summary: args.summary } };
  }
});

// -------------------------------------------------------------
// Tool: read_channel_history (Safe Read-Only, bound to current channel or ViewChannel+ReadMessageHistory)
// -------------------------------------------------------------
registerTool({
  name: 'read_channel_history',
  description: 'Read older messages in the current channel (beyond the default 25 attached messages) if you need more context to answer a question or summarize an earlier conversation. Pass before_id to paginate further back.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'Number of messages to read (1-100, default 50)' },
      before_id: { type: 'string', description: 'Optional message ID to read messages older than that message' }
    },
    additionalProperties: false
  },
  schema: z.object({
    limit: z.number().int().min(1).max(100).optional(),
    before_id: identifierSchema.optional()
  }),
  handler: async (args, context = {}) => {
    try {
      if (!context.channelId) {
        return { ok: false, error: 'Current channel context is unavailable.' };
      }
      const res = await getChannelMessagesOp({
        channel_id: context.channelId,
        limit: Math.min(args.limit || 50, 100),
        before_id: args.before_id
      });
      return {
        ok: true,
        result: {
          channel_name: res.channel_name,
          count: res.count,
          messages: (res.messages || []).map((m) => ({
            id: m.id,
            author: m.author.displayName || m.author.username,
            content: m.content.slice(0, 400),
            created_at: m.created_at
          }))
        }
      };
    } catch (err) {
      return { ok: false, error: `Failed to read channel history: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: configure_welcome (Carl-bot Replacement)
// -------------------------------------------------------------
registerTool({
  name: 'configure_welcome',
  description: 'Configure or update the server welcome message and the welcome channel. When a new member joins, Bobby will automatically announce them in this channel with dynamic placeholders: {user}, {username}, {server}, {count}.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Target welcome channel (name, #mention, or channel ID)' },
      message: { type: 'string', description: 'Custom welcome message template. Supports {user}, {username}, {server}, {count}.' },
      enabled: { type: 'boolean', description: 'Whether the welcome announcement is enabled (default: true)' }
    },
    required: ['channel'],
    additionalProperties: false
  },
  schema: z.object({
    channel: identifierSchema,
    message: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const channelId = await resolveChannelId(guild, args.channel);
      if (!channelId) {
        return { ok: false, error: `Could not find channel "${args.channel}".` };
      }
      const ch = await guild.channels.fetch(channelId).catch(() => null);
      if (!ch) {
        return { ok: false, error: `Channel "${args.channel}" does not exist in this server.` };
      }
      if (!ch.isTextBased()) {
        return { ok: false, error: `Channel "${ch.name}" is not a text channel.` };
      }

      const enabled = args.enabled !== false;
      const defaultMsg = 'Welcome {user} to {server}! 🎉 You are member #{count}.';
      const updated = updateGuildConfig(guild.id, (cfg) => {
        cfg.welcome = {
          enabled,
          channelId: ch.id,
          message: args.message || cfg.welcome?.message || defaultMsg
        };
      });

      return {
        ok: true,
        welcome: {
          enabled: updated.welcome.enabled,
          channel: `<#${ch.id}>`,
          channel_name: ch.name,
          message_template: updated.welcome.message
        },
        message: `Welcome messages ${enabled ? 'enabled' : 'disabled'} in #${ch.name}.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to configure welcome settings: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: configure_autorole (Carl-bot Replacement)
// -------------------------------------------------------------
registerTool({
  name: 'configure_autorole',
  description: 'Configure or update the default auto-role automatically assigned to every new member when they join the server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Target auto-role (name, @mention, or role ID)' },
      enabled: { type: 'boolean', description: 'Whether auto-role on join is enabled (default: true)' }
    },
    required: ['role'],
    additionalProperties: false
  },
  schema: z.object({
    role: identifierSchema,
    enabled: z.boolean().optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const roleId = await resolveRoleId(guild, args.role);
      if (!roleId) {
        return { ok: false, error: `Could not find role "${args.role}".` };
      }
      if (roleId === guild.id) {
        return { ok: false, error: 'Cannot set @everyone as an auto-role.' };
      }

      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        return { ok: false, error: `Role "${args.role}" does not exist in this server.` };
      }

      if (role.permissions?.has(PermissionFlagsBits.Administrator)) {
        return { ok: false, error: `Cannot set "${role.name}" as an auto-role because it grants Administrator permission.` };
      }

      const client = guild.client;
      if (client?.user?.id) {
        const botMember = await guild.members.fetch(client.user.id).catch(() => null);
        if (botMember && botMember.roles?.highest && botMember.roles.highest.position <= role.position) {
          return {
            ok: false,
            error: `Bobby's highest role "${botMember.roles.highest.name}" is positioned below or equal to "${role.name}". Discord prevents assigning roles above the bot. Please reorder Bobby's role higher in Server Settings > Roles.`
          };
        }
      }

      if (context.member && !context.isOwnerOrAdmin) {
        if (context.member.roles?.highest && context.member.roles.highest.position <= role.position) {
          return {
            ok: false,
            error: `Cannot configure auto-role "${role.name}" because it is positioned at or above your highest role.`
          };
        }
      }

      const enabled = args.enabled !== false;
      const updated = updateGuildConfig(guild.id, (cfg) => {
        cfg.autorole = {
          enabled,
          roleId: role.id
        };
      });

      return {
        ok: true,
        autorole: {
          enabled: updated.autorole.enabled,
          role: `@${role.name}`,
          role_id: role.id
        },
        message: `Auto-role ${enabled ? 'enabled' : 'disabled'} for @${role.name}.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to configure auto-role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: get_server_config (Inspection)
// -------------------------------------------------------------
registerTool({
  name: 'get_server_config',
  description: 'Retrieve the current server configuration including welcome message settings, auto-roles, and stored scratchpad memories.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).optional(),
  handler: async (_args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const cfg = getGuildConfig(guild.id);
      let welcomeChannelName = null;
      if (cfg?.welcome?.channelId) {
        const ch = await guild.channels.fetch(cfg.welcome.channelId).catch(() => null);
        welcomeChannelName = ch ? `#${ch.name}` : cfg.welcome.channelId;
      }
      let autoRoleName = null;
      if (cfg?.autorole?.roleId) {
        const r = await guild.roles.fetch(cfg.autorole.roleId).catch(() => null);
        autoRoleName = r ? `@${r.name}` : cfg.autorole.roleId;
      }

      return {
        ok: true,
        server_id: guild.id,
        server_name: guild.name,
        welcome: {
          enabled: Boolean(cfg?.welcome?.enabled),
          channel: welcomeChannelName,
          channel_id: cfg?.welcome?.channelId || null,
          message: cfg?.welcome?.message || null
        },
        autorole: {
          enabled: Boolean(cfg?.autorole?.enabled),
          role: autoRoleName,
          role_id: cfg?.autorole?.roleId || null
        },
        memories_count: Object.keys(cfg?.memories || {}).length,
        memory_keys: Object.keys(cfg?.memories || {})
      };
    } catch (err) {
      return { ok: false, error: `Failed to get server config: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: save_memory (Persistent Scratchpad)
// -------------------------------------------------------------
registerTool({
  name: 'save_memory',
  description: 'Save a key-value fact, note, or piece of server information to Bobby’s persistent scratchpad memory for this server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Unique identifier or topic name for this memory (e.g. "rules_summary", "faq", "stream_schedule")' },
      value: { type: 'string', description: 'Content or information to remember' }
    },
    required: ['key', 'value'],
    additionalProperties: false
  },
  schema: z.object({
    key: z.string().min(1).max(100),
    value: z.string().min(1).max(2000)
  }),
  handler: async (args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      const memory = setGuildMemory(guildId, args.key, args.value);
      return {
        ok: true,
        key: memory.key,
        value: memory.value,
        message: `Saved memory for "${memory.key}".`
      };
    } catch (err) {
      return { ok: false, error: `Failed to save memory: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: recall_memory (Persistent Scratchpad - Available to all members)
// -------------------------------------------------------------
registerTool({
  name: 'recall_memory',
  description: 'Search or retrieve saved facts, notes, or server information from Bobby’s scratchpad memory.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key or topic to look up. If omitted, returns all memories.' }
    },
    additionalProperties: false
  },
  schema: z.object({
    key: z.string().min(1).max(100).optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      const memories = getGuildMemories(guildId);
      if (!memories || Object.keys(memories).length === 0) {
        return { ok: true, count: 0, memories: {}, message: 'No memories saved yet for this server.' };
      }

      if (!args.key || args.key.trim() === '') {
        return { ok: true, count: Object.keys(memories).length, memories };
      }

      const q = args.key.trim().toLowerCase();
      if (memories[q] !== undefined) {
        return { ok: true, match: 'exact', key: q, value: memories[q] };
      }

      const matched = {};
      for (const [k, v] of Object.entries(memories)) {
        if (k.includes(q) || v.toLowerCase().includes(q)) {
          matched[k] = v;
        }
      }

      if (Object.keys(matched).length > 0) {
        return { ok: true, match: 'partial', count: Object.keys(matched).length, results: matched };
      }

      return {
        ok: true,
        match: 'none',
        count: 0,
        message: `No memory found matching "${args.key}". Available keys: ${Object.keys(memories).join(', ')}`
      };
    } catch (err) {
      return { ok: false, error: `Failed to recall memory: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: forget_memory (Persistent Scratchpad)
// -------------------------------------------------------------
registerTool({
  name: 'forget_memory',
  description: 'Delete a fact, note, or key from Bobby’s scratchpad memory for this server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key or topic to delete from memory' }
    },
    required: ['key'],
    additionalProperties: false
  },
  schema: z.object({
    key: z.string().min(1).max(100)
  }),
  handler: async (args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      const res = deleteGuildMemory(guildId, args.key);
      return {
        ok: true,
        key: res.key,
        deleted: res.deleted,
        message: res.deleted ? `Forgotten memory "${res.key}".` : `Key "${res.key}" was not found in memory.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to forget memory: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_memories (Persistent Scratchpad - Available to all members)
// -------------------------------------------------------------
registerTool({
  name: 'list_memories',
  description: 'List all saved memory keys and facts currently stored in Bobby’s scratchpad for this server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).optional(),
  handler: async (_args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      const memories = getGuildMemories(guildId);
      const keys = Object.keys(memories);
      return {
        ok: true,
        count: keys.length,
        keys,
        memories
      };
    } catch (err) {
      return { ok: false, error: `Failed to list memories: ${err.message}` };
    }
  }
});

export function safeEvaluateMath(expression) {
  try {
    const expr = String(expression || '').trim();
    const forbidden = /\b(constructor|prototype|__proto__|global|process|import|require|eval|Function|this|window|globalThis|fetch|Buffer)\b/i;
    if (forbidden.test(expr)) {
      return { ok: false, error: 'Forbidden keyword or pattern in math expression.' };
    }

    const sandbox = Object.create(null);
    sandbox.Math = Math;
    sandbox.Number = Number;
    sandbox.parseInt = parseInt;
    sandbox.parseFloat = parseFloat;
    sandbox.isFinite = isFinite;
    sandbox.isNaN = isNaN;
    sandbox.BigInt = BigInt;

    const vmContext = vm.createContext(sandbox);
    const rawResult = vm.runInContext(expr, vmContext, {
      timeout: 100,
      displayErrors: false
    });

    if (typeof rawResult === 'function' || typeof rawResult === 'symbol') {
      return { ok: false, error: 'Expression did not return a valid numeric or value result.' };
    }

    return {
      ok: true,
      expression: expr,
      result: String(rawResult)
    };
  } catch (err) {
    return { ok: false, error: `Math evaluation failed: ${err.message}` };
  }
}

// -------------------------------------------------------------
// Tool: evaluate_math (Sandboxed Math Sandbox - Available to all members)
// -------------------------------------------------------------
registerTool({
  name: 'evaluate_math',
  description: 'Safely calculate a mathematical expression or perform numeric computation in an isolated sandbox. Supports Math.* functions, arithmetic operators (+, -, *, /, %, **), bitwise operations, trigonometry, logarithms, etc.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematical expression to calculate, e.g. "Math.sqrt(144) + 10 * 5", "2 ** 10", "Math.sin(Math.PI / 4)"' }
    },
    required: ['expression'],
    additionalProperties: false
  },
  schema: z.object({
    expression: z.string().min(1).max(300)
  }),
  handler: async (args) => {
    return safeEvaluateMath(args.expression);
  }
});

// -------------------------------------------------------------
// Tool: add_reaction_role (Self-Assign Roles on Emoji Click)
// -------------------------------------------------------------
registerTool({
  name: 'add_reaction_role',
  description: 'Attach a reaction-role trigger to a specific message. When any member reacts with this emoji, Bobby will automatically grant the role, and remove it when unreacted. Bobby will also automatically add the initial emoji reaction to the message.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel name, #mention, or ID where the message is located' },
      message_id: { type: 'string', description: 'Discord snowflake ID of the message to react to' },
      emoji: { type: 'string', description: 'Emoji to react with (e.g. "🎓", "🧪", or custom emoji name)' },
      role: { type: 'string', description: 'Target role name, @mention, or role ID to assign' }
    },
    required: ['channel_id', 'message_id', 'emoji', 'role'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    emoji: z.string().min(1).max(100),
    role: identifierSchema
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const channelId = await resolveChannelId(guild, args.channel_id);
      if (!channelId) return { ok: false, error: `Could not find channel "${args.channel_id}".` };

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return { ok: false, error: `Channel "${args.channel_id}" is not a valid text channel.` };

      const roleId = await resolveRoleId(guild, args.role);
      if (!roleId) return { ok: false, error: `Could not find role "${args.role}".` };
      if (roleId === guild.id) return { ok: false, error: 'Cannot set @everyone as a reaction role.' };

      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) return { ok: false, error: `Role "${args.role}" does not exist in this server.` };
      if (role.permissions?.has(PermissionFlagsBits.Administrator)) {
        return { ok: false, error: `Cannot set "${role.name}" as a reaction role because it grants Administrator permission.` };
      }

      const client = guild.client;
      if (client?.user?.id) {
        const botMember = await guild.members.fetch(client.user.id).catch(() => null);
        if (botMember && botMember.roles?.highest && botMember.roles.highest.position <= role.position) {
          return {
            ok: false,
            error: `Bobby's highest role is positioned below or equal to "${role.name}". Discord prevents assigning roles above the bot.`
          };
        }
      }

      const message = await channel.messages.fetch(args.message_id).catch(() => null);
      if (!message) return { ok: false, error: `Could not find message "${args.message_id}" in channel #${channel.name}.` };

      // Add reaction to message
      await message.react(args.emoji).catch((e) => {
        console.warn(`[ReactionRole] Failed to react with ${args.emoji}:`, e.message);
      });

      setReactionRole(guild.id, message.id, args.emoji, role.id, channel.id);

      return {
        ok: true,
        message_id: message.id,
        channel: `#${channel.name}`,
        emoji: args.emoji,
        role: `@${role.name}`,
        role_id: role.id,
        status: `Attached reaction role ${args.emoji} -> @${role.name} on message ${message.id}.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to add reaction role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: batch_add_reaction_roles (Multi-Role Emoji Reaction Setup)
// -------------------------------------------------------------
registerTool({
  name: 'batch_add_reaction_roles',
  description: 'Attach multiple reaction-role triggers to a specific message at once (e.g. for level or department selection). Bobby will react with all emojis in order and register the triggers.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Channel name, #mention, or ID where the message is located' },
      message_id: { type: 'string', description: 'Discord snowflake ID of the message to react to' },
      mappings: {
        type: 'array',
        description: 'Array of emoji-to-role mappings',
        items: {
          type: 'object',
          properties: {
            emoji: { type: 'string', description: 'Emoji (e.g. "🎓", "1️⃣", "🧪")' },
            role: { type: 'string', description: 'Target role name, @mention, or role ID' }
          },
          required: ['emoji', 'role']
        }
      }
    },
    required: ['channel_id', 'message_id', 'mappings'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    message_id: identifierSchema,
    mappings: z.array(z.object({
      emoji: z.string().min(1).max(100),
      role: identifierSchema
    })).min(1).max(25)
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const channelId = await resolveChannelId(guild, args.channel_id);
      if (!channelId) return { ok: false, error: `Could not find channel "${args.channel_id}".` };

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return { ok: false, error: `Channel "${args.channel_id}" is not a valid text channel.` };

      const message = await channel.messages.fetch(args.message_id).catch(() => null);
      if (!message) return { ok: false, error: `Could not find message "${args.message_id}" in channel #${channel.name}.` };

      const client = guild.client;
      const botMember = client?.user?.id ? await guild.members.fetch(client.user.id).catch(() => null) : null;
      const validMappings = [];

      for (const item of args.mappings) {
        const roleId = await resolveRoleId(guild, item.role);
        if (!roleId || roleId === guild.id) continue;
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.permissions?.has(PermissionFlagsBits.Administrator)) continue;
        if (botMember && botMember.roles?.highest && botMember.roles.highest.position <= role.position) continue;

        // React on the message
        await message.react(item.emoji).catch((e) => {
          console.warn(`[ReactionRole] Failed to react with ${item.emoji}:`, e.message);
        });

        validMappings.push({ emoji: item.emoji, roleId: role.id });
      }

      const res = setBatchReactionRoles(guild.id, message.id, validMappings, channel.id);

      return {
        ok: true,
        message_id: message.id,
        channel: `#${channel.name}`,
        configured_count: res.count,
        mappings: res.applied
      };
    } catch (err) {
      return { ok: false, error: `Failed to batch add reaction roles: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: remove_reaction_role
// -------------------------------------------------------------
registerTool({
  name: 'remove_reaction_role',
  description: 'Remove reaction-role trigger(s) from a message.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Discord snowflake ID of the message' },
      emoji: { type: 'string', description: 'Specific emoji to remove from triggers. If omitted, removes all reaction triggers for this message.' }
    },
    required: ['message_id'],
    additionalProperties: false
  },
  schema: z.object({
    message_id: identifierSchema,
    emoji: z.string().min(1).max(100).optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      const res = removeReactionRole(guildId, args.message_id, args.emoji);
      return {
        ok: true,
        message_id: args.message_id,
        deleted: res.deleted,
        message: res.deleted ? `Removed reaction role trigger(s) for message ${args.message_id}.` : `No triggers found for message ${args.message_id}.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to remove reaction role: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: list_reaction_roles
// -------------------------------------------------------------
registerTool({
  name: 'list_reaction_roles',
  description: 'List all active reaction-role messages and their emoji-to-role mappings in this server.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  schema: z.object({}).optional(),
  handler: async (_args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const entries = getGuildReactionRoles(guild.id);
      const summary = {};

      for (const [msgId, data] of Object.entries(entries)) {
        summary[msgId] = {
          channel_id: data.channelId,
          mappings_count: Object.keys(data.mappings || {}).length,
          mappings: data.mappings
        };
      }

      return {
        ok: true,
        total_messages: Object.keys(summary).length,
        reaction_roles: summary
      };
    } catch (err) {
      return { ok: false, error: `Failed to list reaction roles: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: create_role_menu (Interactive Dropdown Menu)
// -------------------------------------------------------------
registerTool({
  name: 'create_role_menu',
  description: 'Create and send a modern interactive Discord Select Menu (dropdown) for self-assignable roles in a channel. Members click the dropdown to select their roles with instant ephemeral feedback.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Target channel name, #mention, or ID' },
      title: { type: 'string', description: 'Title or heading for the role menu (e.g. "🎓 Choisis ton Niveau / Level")' },
      description: { type: 'string', description: 'Optional description or instructions' },
      placeholder: { type: 'string', description: 'Dropdown placeholder text (e.g. "Clique ici pour choisir ton niveau...")' },
      max_values: { type: 'integer', description: 'Maximum roles selectable (1-25, default 1)' },
      options: {
        type: 'array',
        description: 'List of role options in the dropdown menu (max 25)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Display name for this option (e.g. "L1 (Première année)")' },
            role: { type: 'string', description: 'Role name, @mention, or ID' },
            description: { type: 'string', description: 'Optional short description under the label' },
            emoji: { type: 'string', description: 'Optional emoji for this option' }
          },
          required: ['label', 'role']
        }
      }
    },
    required: ['channel_id', 'title', 'options'],
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    placeholder: z.string().max(100).optional(),
    max_values: z.number().int().min(1).max(25).optional(),
    options: z.array(z.object({
      label: z.string().min(1).max(100),
      role: identifierSchema,
      description: z.string().max(100).optional(),
      emoji: z.string().max(100).optional()
    })).min(1).max(25)
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const channelId = await resolveChannelId(guild, args.channel_id);
      if (!channelId) return { ok: false, error: `Could not find channel "${args.channel_id}".` };

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return { ok: false, error: `Channel "${args.channel_id}" is not a text channel.` };

      const client = guild.client;
      const botMember = client?.user?.id ? await guild.members.fetch(client.user.id).catch(() => null) : null;

      const menuOptions = [];
      for (const opt of args.options) {
        const roleId = await resolveRoleId(guild, opt.role);
        if (!roleId || roleId === guild.id) continue;
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role || role.permissions?.has(PermissionFlagsBits.Administrator)) continue;
        if (botMember && botMember.roles?.highest && botMember.roles.highest.position <= role.position) continue;

        const optBuilder = new StringSelectMenuOptionBuilder()
          .setLabel(opt.label.slice(0, 100))
          .setValue(role.id);

        if (opt.description) optBuilder.setDescription(opt.description.slice(0, 100));
        if (opt.emoji) optBuilder.setEmoji(opt.emoji);

        menuOptions.push(optBuilder);
      }

      if (menuOptions.length === 0) {
        return { ok: false, error: 'None of the provided roles could be verified or managed by Bobby.' };
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`bobby_role_select_${Date.now()}`)
        .setPlaceholder(args.placeholder || 'Sélectionne un rôle...')
        .setMinValues(0)
        .setMaxValues(Math.min(args.max_values || 1, menuOptions.length))
        .addOptions(menuOptions);

      const row = new ActionRowBuilder().addComponents(selectMenu);
      let content = `### ${args.title}`;
      if (args.description) content += `\n${args.description}`;

      const sentMsg = await channel.send({
        content,
        components: [row]
      });

      return {
        ok: true,
        message_id: sentMsg.id,
        channel: `#${channel.name}`,
        options_count: menuOptions.length,
        status: `Created role menu in #${channel.name}.`
      };
    } catch (err) {
      return { ok: false, error: `Failed to create role menu: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_ai_model (On-the-fly Model Switcher)
// -------------------------------------------------------------
registerTool({
  name: 'set_ai_model',
  description: 'Change the AI model used by Bobby for this server (e.g. "deepseek-v4.1-flash-1017", "gpt-4o-mini", "claude-3-5-haiku", "llama-3.3-70b-instruct"). Pass "reset" to revert to default.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Name of the model to switch to, or "reset" to restore default' }
    },
    required: ['model'],
    additionalProperties: false
  },
  schema: z.object({
    model: z.string().min(1).max(100)
  }),
  handler: async (args, context = {}) => {
    try {
      if (!isBotOwner(context.member?.user || context.member, context.client)) {
        return { ok: false, error: "Only the Bot Owner can change the AI model." };
      }
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      if (args.model.toLowerCase() === 'reset') {
        resetGuildAIConfig(guildId);
        return { ok: true, status: 'Reset AI model to default (.env).' };
      }
      setGuildAIConfig(guildId, { model: args.model.trim() });
      return { ok: true, model: args.model.trim(), status: `Switched AI model to "${args.model.trim()}".` };
    } catch (err) {
      return { ok: false, error: `Failed to set AI model: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: set_persona_mode (Persona Customization)
// -------------------------------------------------------------
registerTool({
  name: 'set_persona_mode',
  description: 'Change Bobby’s personality/persona mode for this server. Options: "vro" (default casual Mei Mei cat), "serious" (professional server executive), "pirate" (witty pirate captain).',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['vro', 'serious', 'pirate'], description: 'Persona mode to activate' }
    },
    required: ['mode'],
    additionalProperties: false
  },
  schema: z.object({
    mode: z.enum(['vro', 'serious', 'pirate'])
  }),
  handler: async (args, context = {}) => {
    try {
      const guildId = context.guildId || context.guild?.id || (await getGuild()).id;
      setGuildPersona(guildId, args.mode);
      return { ok: true, mode: args.mode, status: `Bobby persona set to ${args.mode.toUpperCase()} mode.` };
    } catch (err) {
      return { ok: false, error: `Failed to set persona mode: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: summarize_channel
// -------------------------------------------------------------
registerTool({
  name: 'summarize_channel',
  description: 'Summarize recent messages from a channel or thread using AI.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'Target channel or thread ID (defaults to current channel)' },
      message_count: { type: 'integer', description: 'Number of messages to summarize (10 to 100, default 30)' }
    },
    additionalProperties: false
  },
  schema: z.object({
    channel_id: identifierSchema.optional(),
    message_count: z.number().int().min(10).max(100).optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      const targetChannelId = args.channel_id
        ? await resolveChannelId(guild, args.channel_id)
        : (context.channel?.id || (await getGuild()).channels.cache.first()?.id);

      const ch = await guild.channels.fetch(targetChannelId);
      if (!ch || !ch.isTextBased()) {
        return { ok: false, error: 'Target channel was not found or is not a text channel.' };
      }

      const limit = args.message_count || 30;
      const fetched = await ch.messages.fetch({ limit });
      const ordered = Array.from(fetched.values()).reverse().map((m) => ({
        author: m.author.username,
        content: m.content,
        timestamp: m.createdTimestamp
      }));

      const summary = await summarizeMessages({ messages: ordered, guildId: guild.id });
      return { ok: true, channel: ch.name, count: ordered.length, summary };
    } catch (err) {
      return { ok: false, error: `Failed to summarize channel: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: translate_message
// -------------------------------------------------------------
registerTool({
  name: 'translate_message',
  description: 'Translate a message or text into a target language using AI.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to translate' },
      message_id: { type: 'string', description: 'Optional message ID to fetch and translate' },
      channel_id: { type: 'string', description: 'Channel ID if message_id is provided' },
      target_language: { type: 'string', description: 'Target language (e.g. "French", "English", "Spanish", "Arabic")' }
    },
    required: ['target_language'],
    additionalProperties: false
  },
  schema: z.object({
    text: z.string().optional(),
    message_id: identifierSchema.optional(),
    channel_id: identifierSchema.optional(),
    target_language: z.string().min(2).max(50)
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      let textToTranslate = args.text;

      if (!textToTranslate && args.message_id) {
        const targetChannelId = args.channel_id
          ? await resolveChannelId(guild, args.channel_id)
          : context.channel?.id;
        const ch = await guild.channels.fetch(targetChannelId);
        const msg = await ch?.messages.fetch(args.message_id);
        if (msg) textToTranslate = msg.content;
      }

      if (!textToTranslate || !textToTranslate.trim()) {
        return { ok: false, error: 'No text or message found to translate.' };
      }

      const translation = await translateText({
        text: textToTranslate,
        targetLang: args.target_language,
        guildId: guild.id
      });

      return {
        ok: true,
        original_text: textToTranslate,
        target_language: args.target_language,
        translation
      };
    } catch (err) {
      return { ok: false, error: `Failed to translate: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: configure_modmail
// -------------------------------------------------------------
registerTool({
  name: 'configure_modmail',
  description: 'Configure DM modmail forwarding to a staff channel.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'Whether modmail is enabled' },
      channel_id: { type: 'string', description: 'Staff channel ID where incoming DMs are forwarded' }
    },
    required: ['enabled'],
    additionalProperties: false
  },
  schema: z.object({
    enabled: z.boolean(),
    channel_id: identifierSchema.optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      let channelId = null;
      if (args.enabled) {
        if (!args.channel_id) {
          return { ok: false, error: 'A staff channel_id is required when enabling modmail.' };
        }
        channelId = await resolveChannelId(guild, args.channel_id);
      }
      setGuildModmail(guild.id, { enabled: args.enabled, channelId });
      return {
        ok: true,
        enabled: args.enabled,
        channel_id: channelId,
        status: args.enabled ? `Modmail enabled in <#${channelId}>.` : 'Modmail disabled.'
      };
    } catch (err) {
      return { ok: false, error: `Failed to configure modmail: ${err.message}` };
    }
  }
});

// -------------------------------------------------------------
// Tool: configure_chatter
// -------------------------------------------------------------
registerTool({
  name: 'configure_chatter',
  description: 'Configure random chat chatter where Bobby periodically reads recent chat context and drops a casual, natural message in the channel between specified hours.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'Whether random chatter is enabled' },
      channel_id: { type: 'string', description: 'Target channel ID for chatter' },
      count: { type: 'integer', description: 'Number of messages to drop per day (1-20)' },
      start_time: { type: 'string', description: 'Start of active window (e.g. "10:00" or "10am")' },
      end_time: { type: 'string', description: 'End of active window (e.g. "23:00" or "11pm")' }
    },
    required: ['enabled'],
    additionalProperties: false
  },
  schema: z.object({
    enabled: z.boolean(),
    channel_id: identifierSchema.optional(),
    count: z.number().int().min(1).max(20).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      if (!args.enabled) {
        setGuildChatter(guild.id, { enabled: false, triggers: [] });
        clearGuildChatterTimers(guild.id);
        return { ok: true, enabled: false, message: 'Random chatter disabled.' };
      }

      const channelId = args.channel_id ? await resolveChannelId(guild, args.channel_id) : context.channel?.id;
      if (!channelId) {
        return { ok: false, error: 'A valid text channel_id is required.' };
      }

      const count = args.count || 2;
      const startParsed = parseTimeString(args.start_time || '10:00');
      const endParsed = parseTimeString(args.end_time || '23:00');

      if (!startParsed || !endParsed || startParsed.totalMinutes >= endParsed.totalMinutes) {
        return { ok: false, error: 'Invalid time range. Start time must be before end time.' };
      }

      const triggers = calculateNextTriggers(startParsed.totalMinutes, endParsed.totalMinutes, count);
      const chatterData = {
        enabled: true,
        channelId,
        count,
        startMinutes: startParsed.totalMinutes,
        endMinutes: endParsed.totalMinutes,
        startStr: formatMinutesToTime(startParsed.totalMinutes),
        endStr: formatMinutesToTime(endParsed.totalMinutes),
        triggers
      };

      setGuildChatter(guild.id, chatterData);
      const client = context.client || guild.client;
      if (client) {
        scheduleGuildChatter(client, guild.id);
      }

      return {
        ok: true,
        enabled: true,
        channel_id: channelId,
        count,
        window: `${chatterData.startStr} - ${chatterData.endStr}`,
        scheduled_triggers_count: triggers.length,
        message: `Configured random chatter in <#${channelId}>: ${count} message(s)/day between ${chatterData.startStr} and ${chatterData.endStr}.`
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

// -------------------------------------------------------------
// Tool: configure_auto_chat_channel
// -------------------------------------------------------------
registerTool({
  name: 'configure_auto_chat_channel',
  description: 'Configure a dedicated text channel where Bobby automatically responds to every message without needing to be mentioned.',
  destructive: false,
  parameters: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'Whether auto-chat in a dedicated channel is enabled' },
      channel_id: { type: 'string', description: 'Text channel ID where Bobby responds to all messages' }
    },
    required: ['enabled'],
    additionalProperties: false
  },
  schema: z.object({
    enabled: z.boolean(),
    channel_id: identifierSchema.optional()
  }),
  handler: async (args, context = {}) => {
    try {
      const guild = context.guild || (await getGuild(context.guildId));
      if (!args.enabled) {
        setGuildAutoChatChannel(guild.id, null);
        return { ok: true, enabled: false, message: 'Dedicated auto-response channel disabled.' };
      }

      const channelId = args.channel_id ? await resolveChannelId(guild, args.channel_id) : context.channel?.id;
      if (!channelId) {
        return { ok: false, error: 'A valid text channel_id is required.' };
      }

      setGuildAutoChatChannel(guild.id, channelId);
      return {
        ok: true,
        enabled: true,
        channel_id: channelId,
        message: `Set dedicated auto-response channel to <#${channelId}>. Bobby will respond to every message there.`
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

/**
 * Dynamic Permission Mimicking Map:
 * - If a tool maps to an array of permission names, ANY of those permissions grants access
 *   (and the first one is reported if missing).
 * - Server Owner (guild.ownerId === member.id) or Administrator bypasses per-tool perm checks
 *   (while Administrator role creation remains blocked in permissions.js).
 */
export const STAFF_PERMISSION_FLAGS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageWebhooks
];

export const TOOL_REQUIRED_PERMS = {
  // Safe current-channel history pagination (requires ReadMessageHistory, which normal members have)
  read_channel_history: ['ReadMessageHistory'],

  // Inspection / Read tools
  get_guild_snapshot: ['ManageChannels', 'ManageRoles', 'ManageGuild', 'ModerateMembers', 'BanMembers', 'KickMembers', 'ManageMessages'],
  list_roles: ['ManageRoles', 'ManageChannels'],
  list_members: ['ModerateMembers', 'KickMembers', 'BanMembers', 'ManageRoles', 'ManageNicknames', 'ManageMessages'],
  list_bans: ['BanMembers'],
  get_channel_messages: ['ManageMessages', 'ModerateMembers', 'KickMembers', 'BanMembers', 'ManageChannels'],
  list_emojis: ['ManageGuildExpressions'],
  list_stickers: ['ManageGuildExpressions'],
  list_soundboard_sounds: ['ManageGuildExpressions'],
  list_automod_rules: ['ManageGuild'],
  list_webhooks: ['ManageWebhooks'],
  list_integrations: ['ManageGuild'],

  // Channel management (ManageChannels)
  create_category: ['ManageChannels'],
  create_channel: ['ManageChannels'],
  edit_channel: ['ManageChannels'],
  delete_channel: ['ManageChannels'],
  move_channel: ['ManageChannels'],
  reorder_channels: ['ManageChannels'],
  batch_create_categories: ['ManageChannels'],
  batch_create_channels: ['ManageChannels'],
  batch_edit_channels: ['ManageChannels'],
  batch_delete_channels: ['ManageChannels'],
  batch_move_channels: ['ManageChannels'],

  // Channel overwrites (ManageRoles + ManageChannels, or ManageRoles)
  set_channel_permissions: ['ManageRoles'],
  batch_set_channel_permissions: ['ManageRoles'],

  // Role management (ManageRoles)
  create_role: ['ManageRoles'],
  edit_role: ['ManageRoles'],
  delete_role: ['ManageRoles'],
  assign_member_role: ['ManageRoles'],
  remove_member_role: ['ManageRoles'],
  batch_create_roles: ['ManageRoles'],
  batch_edit_roles: ['ManageRoles'],
  batch_delete_roles: ['ManageRoles'],

  // Full server deployment (Owner / Administrator only)
  batch_create_structure: ['Administrator'],

  // Member moderation
  timeout_member: ['ModerateMembers'],
  kick_member: ['KickMembers'],
  ban_member: ['BanMembers'],
  unban_member: ['BanMembers'],
  set_member_nickname: ['ManageNicknames'],

  // Message management (ManageMessages)
  send_message: ['ManageMessages'],
  edit_message: ['ManageMessages'],
  delete_message: ['ManageMessages'],
  purge_messages: ['ManageMessages'],
  pin_message: ['ManageMessages'],
  batch_send_messages: ['ManageMessages'],

  // Guild settings & AutoMod (ManageGuild)
  edit_guild: ['ManageGuild'],
  create_automod_rule: ['ManageGuild'],
  edit_automod_rule: ['ManageGuild'],
  delete_automod_rule: ['ManageGuild'],

  // Expressions (ManageGuildExpressions)
  create_emoji: ['ManageGuildExpressions'],
  edit_emoji: ['ManageGuildExpressions'],
  delete_emoji: ['ManageGuildExpressions'],
  create_sticker: ['ManageGuildExpressions'],
  edit_sticker: ['ManageGuildExpressions'],
  delete_sticker: ['ManageGuildExpressions'],
  create_soundboard_sound: ['ManageGuildExpressions'],
  edit_soundboard_sound: ['ManageGuildExpressions'],
  delete_soundboard_sound: ['ManageGuildExpressions'],

  // Webhooks (ManageWebhooks)
  create_webhook: ['ManageWebhooks'],
  edit_webhook: ['ManageWebhooks'],
  delete_webhook: ['ManageWebhooks'],
  send_webhook_message: ['ManageWebhooks'],

  // Server Config & Memory tools
  configure_welcome: ['ManageGuild', 'ManageChannels'],
  configure_autorole: ['ManageRoles', 'ManageGuild'],
  get_server_config: ['ManageGuild', 'ManageChannels', 'ManageRoles', 'ModerateMembers'],
  save_memory: ['ManageGuild', 'ManageMessages', 'ModerateMembers'],
  forget_memory: ['ManageGuild', 'ManageMessages', 'ModerateMembers'],
  recall_memory: ['ReadMessageHistory'],
  list_memories: ['ReadMessageHistory'],
  evaluate_math: ['ReadMessageHistory'],

  // Reaction Roles & Role Menus
  add_reaction_role: ['ManageRoles', 'ManageGuild'],
  batch_add_reaction_roles: ['ManageRoles', 'ManageGuild'],
  remove_reaction_role: ['ManageRoles', 'ManageGuild'],
  list_reaction_roles: ['ManageRoles', 'ManageGuild', 'ModerateMembers'],
  create_role_menu: ['ManageRoles', 'ManageGuild'],

  // AI & Persona Configuration
  set_ai_model: ['Administrator', 'ManageGuild'],
  set_persona_mode: ['ManageGuild'],

  // AI Superpowers
  summarize_channel: ['ReadMessageHistory', 'ManageMessages'],
  translate_message: ['ReadMessageHistory'],
  configure_modmail: ['ManageGuild'],
  configure_chatter: ['ManageGuild'],
  configure_auto_chat_channel: ['ManageGuild']
};

export const SAFE_MEMBER_TOOLS = new Set([
  'read_channel_history',
  'recall_memory',
  'list_memories',
  'evaluate_math'
]);

let cachedBotOwnerIds = new Set();

export function clearCachedBotOwnerIds() {
  cachedBotOwnerIds.clear();
}

export function setCachedBotOwnerId(id) {
  if (id) cachedBotOwnerIds.add(String(id));
}

export function isBotOwner(userOrMember, client = null) {
  const userId = String(userOrMember?.id || userOrMember?.user?.id || userOrMember || '');
  if (!userId) return false;
  if (process.env.OWNER_DISCORD_ID && userId === process.env.OWNER_DISCORD_ID.trim()) return true;
  if (cachedBotOwnerIds.has(userId)) return true;
  if (client?.application?.owner) {
    if (client.application.owner.id === userId) {
      cachedBotOwnerIds.add(userId);
      return true;
    }
    if (client.application.owner.members?.has?.(userId)) {
      cachedBotOwnerIds.add(userId);
      return true;
    }
  }
  return false;
}

export function isServerOwner(member, guild, client = null) {
  if (!member) return false;
  if (isBotOwner(member, client)) return true;
  if (guild && guild.ownerId === member.id) return true;
  return false;
}

export function isOwnerOrAdmin(member, guild, client = null) {
  if (!member) return false;
  if (isServerOwner(member, guild, client)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (member.roles?.cache?.some?.((r) => /^(admin|administrator|head admin|owner)$/i.test(r.name))) return true;
  if (member.roles?.highest?.name && /^(admin|administrator|head admin|owner)$/i.test(member.roles.highest.name)) return true;
  return false;
}

export function isStaffMember(member, guild) {
  if (!member) return false;
  if (isOwnerOrAdmin(member, guild)) return true;
  return STAFF_PERMISSION_FLAGS.some((flag) => member.permissions?.has(flag));
}

/**
 * Assert whether a Discord member has permission to execute a specific tool.
 * Returns { ok: true } or { ok: false, error: "You lack the '...' permission on this server." }
 */
export function assertMemberToolAccess(member, guild, toolName, channel = null) {
  if (!member) {
    return { ok: false, error: "You lack the 'Administrator' permission on this server." };
  }

  if (isOwnerOrAdmin(member, guild)) {
    return { ok: true };
  }

  if (SAFE_MEMBER_TOOLS.has(toolName)) {
    const perms = channel?.permissionsFor ? channel.permissionsFor(member) : member.permissions;
    const canRead = Boolean(
      perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms?.has(PermissionFlagsBits.ReadMessageHistory)
    );
    if (!canRead) {
      return { ok: false, error: "You lack the 'ReadMessageHistory' permission on this server." };
    }
    return { ok: true };
  }

  if (toolName === 'finish') {
    if (isStaffMember(member, guild)) return { ok: true };
    return { ok: false, error: "You lack the 'Administrator' permission on this server." };
  }

  const requiredPerms = TOOL_REQUIRED_PERMS[toolName];
  if (!requiredPerms || requiredPerms.length === 0) {
    return { ok: false, error: "You lack the 'Administrator' permission on this server." };
  }

  const hasAny = requiredPerms.some((permName) => {
    const flag = PermissionFlagsBits[permName];
    return flag !== undefined && member.permissions?.has(flag);
  });

  if (!hasAny) {
    return {
      ok: false,
      error: `You lack the '${requiredPerms[0]}' permission on this server.`
    };
  }

  return { ok: true };
}

/**
 * Compute the set of tool names a Discord member is permitted to invoke.
 * - Regular members with ReadMessageHistory get safe utility tools:
 *   read_channel_history, recall_memory, list_memories, evaluate_math (strictly zero mutation tools).
 * - Members without even ReadMessageHistory get an empty Set.
 */
export function getAllowedToolNamesForMember(member, guild, channel = null) {
  const allowed = new Set();
  if (!member) return allowed;

  const ownerOrAdmin = isOwnerOrAdmin(member, guild);
  const staff = isStaffMember(member, guild);

  if (!staff) {
    const perms = channel?.permissionsFor ? channel.permissionsFor(member) : member.permissions;
    if (perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.ReadMessageHistory)) {
      for (const tool of SAFE_MEMBER_TOOLS) {
        allowed.add(tool);
      }
    }
    return allowed;
  }

  for (const toolName of toolsRegistry.keys()) {
    if (toolName === 'finish' || toolName === 'read_channel_history') continue;
    if (ownerOrAdmin) {
      allowed.add(toolName);
      continue;
    }

    const requiredPerms = TOOL_REQUIRED_PERMS[toolName];
    if (!requiredPerms) continue;

    const hasAny = requiredPerms.some((permName) => {
      const flag = PermissionFlagsBits[permName];
      return flag !== undefined && member.permissions?.has(flag);
    });
    if (hasAny) {
      allowed.add(toolName);
    }
  }

  // Every staff member also gets current-channel history reading if they don't already have get_channel_messages
  if (!allowed.has('get_channel_messages')) {
    allowed.add('read_channel_history');
  }

  // Safe tools are always available to all staff members
  for (const tool of SAFE_MEMBER_TOOLS) {
    if (tool !== 'read_channel_history' || !allowed.has('get_channel_messages')) {
      allowed.add(tool);
    }
  }

  if (allowed.size > 0) {
    allowed.add('finish');
  }

  return allowed;
}

/**
 * Recursively cleans JSON schema so that upstream OpenAI/Gemini providers
 * never reject tool definitions with invalid enum types or union type arrays.
 */
function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchema);
  }

  const clean = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(value)) {
      const primaryType = value.find((t) => t !== 'null') || 'string';
      clean.type = primaryType;
    } else if (key === 'enum' && Array.isArray(value)) {
      clean.enum = value.map((v) => String(v));
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitizeJsonSchema(value);
    } else {
      clean[key] = value;
    }
  }

  // Gemini and OpenAPI require all enum values to be strings.
  // If property is integer or number, delete enum to avoid type mismatch errors.
  if ((clean.type === 'integer' || clean.type === 'number') && clean.enum) {
    delete clean.enum;
  }

  return clean;
}

/**
 * Returns OpenAI-formatted tools array dynamically filtered to the caller's Discord permissions.
 * Returns [] for regular members without staff permissions.
 */
export function getToolsForMember(member, guild, channel = null) {
  const allowedNames = getAllowedToolNamesForMember(member, guild, channel);
  if (allowedNames.size === 0) {
    return [];
  }

  return Array.from(toolsRegistry.values())
    .filter((tool) => allowedNames.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeJsonSchema(tool.parameters)
      }
    }));
}

/**
 * Returns all OpenAI-formatted tools (unfiltered).
 */
export function getOpenAITools() {
  return Array.from(toolsRegistry.values()).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeJsonSchema(tool.parameters)
    }
  }));
}
