import OpenAI from 'openai';
import { getGuildConfig } from '../util/storage.js';

/**
 * Get current AI provider configuration from environment variables or per-guild override.
 */
export function getAIConfig(guildId = null) {
  const baseConfig = {
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    baseURL: (process.env.OPENAI_BASE_URL || '').trim(),
    model: (process.env.OPENAI_MODEL || 'deepseek-v4.1-flash-1017').trim(),
    reasoningEffort: (process.env.OPENAI_REASONING_EFFORT || 'none').trim().toLowerCase(),
    hasApiKey: Boolean((process.env.OPENAI_API_KEY || '').trim()),
    isCustom: false
  };

  if (!guildId) return baseConfig;

  try {
    const guildCfg = getGuildConfig(guildId);
    if (guildCfg?.ai_config) {
      return {
        apiKey: (guildCfg.ai_config.apiKey || baseConfig.apiKey).trim(),
        baseURL: (guildCfg.ai_config.baseURL || baseConfig.baseURL).trim(),
        model: (guildCfg.ai_config.model || baseConfig.model).trim(),
        reasoningEffort: (guildCfg.ai_config.reasoningEffort || baseConfig.reasoningEffort).trim().toLowerCase(),
        hasApiKey: Boolean((guildCfg.ai_config.apiKey || baseConfig.apiKey).trim()),
        isCustom: true
      };
    }
  } catch (_) {}

  return baseConfig;
}

/**
 * Create an OpenAI SDK instance with the effective config for a guild or global.
 */
export function getOpenAIClient(overrides = {}, guildId = null) {
  const current = getAIConfig(guildId);
  const rawKey = overrides.apiKey !== undefined ? overrides.apiKey : current.apiKey;
  const baseURL = overrides.baseURL !== undefined ? overrides.baseURL : current.baseURL;
  const apiKey = rawKey && rawKey.trim() !== '' ? rawKey.trim() : 'not-needed';

  const clientOptions = { apiKey };
  if (baseURL && baseURL.trim() !== '') {
    clientOptions.baseURL = baseURL.trim();
  }

  return new OpenAI(clientOptions);
}
