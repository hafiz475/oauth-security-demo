const SENSITIVE_KEY = /token|secret|password|passwd|api[_-]?key|authorization|code|state|credentials/i;
const MAX_DEPTH = 8;

export const REDACTED = '[REDACTED]';

/** Returns a copy with every value under a sensitive-looking key replaced. */
export function redactObject<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactObject(v, depth + 1);
  }
  return out as T;
}

/** Strips the query string so codes, states and handles never reach a log line. */
export function requestPath(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export type LogSink = (level: Level, line: string) => void;

const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(level = 'info', sink: LogSink = consoleSink): Logger {
  const threshold = RANK[level] ?? RANK.info!;
  const emit = (lvl: Level) => (msg: string, ctx?: Record<string, unknown>) => {
    if (RANK[lvl]! < threshold) return;
    sink(lvl, JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...redactObject(ctx ?? {}) }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
