import 'dotenv/config';
import { startDiscordClient } from './discord/client.js';
import { getAIConfig } from './agent/config.js';
import { log } from './util/log.js';

process.on('unhandledRejection', (reason) => {
  log.error('process', `Unhandled Rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
  log.error('process', `Uncaught Exception: ${err?.message || err}`);
  if (err?.code === 'ECONNRESET' || err?.message?.includes('handshake has timed out')) {
    return;
  }
  process.exit(1);
});

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    log.error('boot', 'DISCORD_BOT_TOKEN is missing. Add it to your .env or Discloud environment.');
    process.exit(1);
  }

  const ai = getAIConfig();
  if (!ai.hasApiKey && !ai.baseURL) {
    log.error('boot', 'OPENAI_API_KEY is missing (and no custom OPENAI_BASE_URL is set).');
    process.exit(1);
  }

  log.info('boot', `Starting Bobby Bot model=${ai.model} base=${ai.baseURL || 'default'}`);
  await startDiscordClient();
}

main().catch((err) => {
  log.error('boot', `Fatal startup error: ${err?.message || err}`);
  process.exit(1);
});
