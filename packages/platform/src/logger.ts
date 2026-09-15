/**
 * PII-safe structured logging (US-8.9, DoD D7).
 *
 * Scrubbing happens at the SINK, not at the call site. If it were the caller's
 * responsibility, a single forgotten `logger.info(pan)` would leak — and that call
 * is exactly the one nobody reviews. Every string that reaches a sink, including
 * nested fields and error `cause` chains, is masked first.
 */
import { RegexRules } from '@vantagepoint/pii-masker';
import type { IsoDateTime } from '@vantagepoint/shared-kernel';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: IsoDateTime;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/** Recursively masks every string reachable from `value`. */
function scrub(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return RegexRules.mask(value).masked;
  if (value === null || typeof value !== 'object') return value;

  // Cyclic structures are reachable through error `cause` chains.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrub(item, seen));

  if (value instanceof Error) {
    return {
      name: value.name,
      message: RegexRules.mask(value.message).masked,
      ...(value.cause === undefined ? {} : { cause: scrub(value.cause, seen) }),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrub(item, seen);
  return out;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly now: () => IsoDateTime;
  readonly minLevel?: LogLevel;
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = ORDER[options.minLevel ?? 'debug'];

  const emit = (level: LogLevel, message: string, context: Record<string, unknown> = {}): void => {
    if (ORDER[level] < threshold) return;
    options.sink.write({
      level,
      message: RegexRules.mask(message).masked,
      timestamp: options.now(),
      context: scrub(context) as Readonly<Record<string, unknown>>,
    });
  };

  return {
    debug: (message, context) => {
      emit('debug', message, context);
    },
    info: (message, context) => {
      emit('info', message, context);
    },
    warn: (message, context) => {
      emit('warn', message, context);
    },
    error: (message, context) => {
      emit('error', message, context);
    },
  };
}

/** Exported for tests and for callers that need to scrub before serialising. */
export const Logger = { scrub };
