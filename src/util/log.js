import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.resolve(__dirname, '../../logs');

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

const LEVEL_COLOR = {
  INFO: colors.cyan,
  WARN: colors.yellow,
  ERROR: colors.red
};

const SENSITIVE_KEY = /token|secret|apikey|api_key|password|webhookurl|webhook_url|^url$/i;
const MAX_VALUE_LEN = 180;
const WRITE_FILES = process.env.BOBBY_FILE_LOGS === '1';

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function compactValue(value, depth = 0) {
  if (value == null) return String(value);
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (depth > 1) return `[${value.length}]`;
    return `[${value.slice(0, 6).map((v) => compactValue(v, depth + 1)).join(', ')}${value.length > 6 ? `, +${value.length - 6}` : ''}]`;
  }
  if (typeof value === 'object') {
    if (depth > 1) return '{…}';
    const entries = Object.entries(value).slice(0, 8).map(([k, v]) => {
      if (SENSITIVE_KEY.test(k)) return `${k}=[redacted]`;
      return `${k}=${compactValue(v, depth + 1)}`;
    });
    return `{${entries.join(' ')}${Object.keys(value).length > 8 ? ' …' : ''}}`;
  }
  return String(value);
}

function summarizeArgs(args = {}) {
  return Object.entries(args)
    .map(([k, v]) => (SENSITIVE_KEY.test(k) ? `${k}=[redacted]` : `${k}=${compactValue(v)}`))
    .join(' ');
}

function summarizeResult(result) {
  if (result == null) return '';
  if (typeof result !== 'object') return compactValue(result);
  if (result.error) return `error=${compactValue(result.error)}`;
  const keys = Object.keys(result).filter((k) => k !== 'ok');
  if (keys.length === 0) return 'ok';
  return summarizeArgs(result);
}

function writeLine(level, tag, message, extra) {
  const color = LEVEL_COLOR[level] || colors.cyan;
  const extraText = extra ? ` ${colors.dim}${compactValue(extra)}${colors.reset}` : '';
  console.log(
    `${colors.dim}[${stamp()}]${colors.reset} ${color}${level.padEnd(5)}${colors.reset} ${colors.bold}[${tag}]${colors.reset} ${message}${extraText}`
  );
}

function appendJsonl(filename, entry) {
  if (!WRITE_FILES) return;
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.appendFileSync(path.join(LOGS_DIR, filename), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

export const log = {
  info(tag, message, extra) {
    writeLine('INFO', tag, message, extra);
  },
  warn(tag, message, extra) {
    writeLine('WARN', tag, message, extra);
  },
  error(tag, message, extra) {
    writeLine('ERROR', tag, message, extra);
  }
};

/**
 * Append an audit entry (stdout always; JSONL only if BOBBY_FILE_LOGS=1).
 */
export function auditLog({ tool, args, ok, result, error, caller, guild, channel }) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    tool,
    args,
    ok,
    result: ok ? result : undefined,
    error: !ok ? error : undefined,
    caller,
    guild,
    channel
  };

  appendJsonl(`audit-${timestamp.slice(0, 10)}.jsonl`, logEntry);

  const status = ok
    ? `${colors.green}OK${colors.reset}`
    : `${colors.red}FAIL ${error || 'unknown'}${colors.reset}`;
  const who = caller ? ` by ${caller}` : '';
  const where = channel ? ` #${channel}` : '';
  console.log(
    `${colors.dim}[${stamp()}]${colors.reset} ${colors.magenta}TOOL ${colors.reset}${colors.cyan}${colors.bold}${tool}${colors.reset}${who}${where} (${summarizeArgs(args)}) -> ${status}${ok && result ? ` ${colors.dim}${summarizeResult(result)}${colors.reset}` : ''}`
  );
}
