/**
 * Logger — writes to BOTH:
 *   1. stdout (pretty in dev, JSON in prod)
 *   2. a rolling log file `<LOG_DIR>/<SERVICE_NAME>.log` for post-hoc debug
 *
 * Plus an OTel bridge so logs ship to Grafana Loki when an OTel SDK is active.
 *
 * Env knobs:
 *   SERVICE_NAME  short app name for the log filename + pino `base` field.
 *                 Defaults: auto-detected from `process.argv[1]` (workers /
 *                 api), falling back to 'app' when uncertain.
 *   LOG_DIR       directory to place log files. Defaults to `<cwd>/logs`.
 *                 Created if missing. Add to .gitignore (already is).
 *   LOG_LEVEL     pino level: debug / info / warn / error. Default 'info'.
 *   NODE_ENV      'production' → JSON stdout. 'test' → silenced. Otherwise pretty.
 *
 * Initialization is LAZY: the first call to `log()` builds the pino instance.
 * This lets entry-point files set `process.env.SERVICE_NAME` before any logger
 * module-load side effects (ES modules evaluate imports first, so setting env
 * *after* import statements was a no-op for eager init).
 */
import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger, type TransportTargetOptions } from 'pino';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace } from '@opentelemetry/api';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info:  SeverityNumber.INFO,
  warn:  SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

// ── Service-name heuristic ──────────────────────────────────────────────────

function inferServiceName(): string {
  if (process.env['SERVICE_NAME']) return process.env['SERVICE_NAME']!;
  const entry = process.argv[1] ?? '';
  if (entry.includes('workers/src/main') || entry.endsWith('workers/main.js')) return 'workers';
  if (entry.includes('api/server')     || entry.endsWith('api/server.js'))     return 'api';
  if (entry.includes('create-admin'))                                          return 'cli-create-admin';
  return 'app';
}

// ── Lazy pino init ──────────────────────────────────────────────────────────

let _logger: Logger | null = null;

function buildLogger(): Logger {
  const NODE_ENV  = process.env['NODE_ENV']  ?? 'development';
  const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';
  const SERVICE   = inferServiceName();
  const isTest    = NODE_ENV === 'test';
  const isProd    = NODE_ENV === 'production';

  if (isTest) {
    // Silence tests entirely.
    return pino({ level: 'silent' }, pino.destination('/dev/null'));
  }

  const logDir = process.env['LOG_DIR']
    ? path.resolve(process.env['LOG_DIR'])
    : path.resolve(process.cwd(), 'logs');

  // Best-effort mkdir — if it fails we still have stdout.
  let fileTarget: TransportTargetOptions | null = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fileTarget = {
      level: LOG_LEVEL as pino.Level,
      target: 'pino/file',
      options: {
        destination: path.join(logDir, `${SERVICE}.log`),
        mkdir:  true,
        append: true,
        sync:   false,
      },
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[logger] failed to create log dir, stdout only:', err);
  }

  const stdoutTarget: TransportTargetOptions = isProd
    ? {
        level: LOG_LEVEL as pino.Level,
        target: 'pino/file',                 // "pino/file" with destination=1 writes JSON to stdout
        options: { destination: 1 },
      }
    : {
        level: LOG_LEVEL as pino.Level,
        target: 'pino-pretty',
        options: { colorize: true, destination: 1 },
      };

  const targets: TransportTargetOptions[] = [stdoutTarget];
  if (fileTarget) targets.push(fileTarget);

  return pino({
    level: LOG_LEVEL,
    base:  { service: SERVICE, env: NODE_ENV, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Note: `transport.targets` forbids a top-level `formatters.level`; each
    // target handles its own label rendering (pino-pretty shows strings,
    // pino/file emits numeric levels, both fine for greppable logs).
    transport: { targets },
  });
}

function getLogger(): Logger {
  if (!_logger) _logger = buildLogger();
  return _logger;
}

// Back-compat export — `logger` used elsewhere. Proxy to lazy-init instance.
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    const inst = getLogger() as unknown as Record<PropertyKey, unknown>;
    const val = inst[prop];
    return typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(inst) : val;
  },
});

// ── OTel bridge ─────────────────────────────────────────────────────────────

const otelLogger = logs.getLogger('trading-bot', '0.1.0');

export function log(
  level: LogLevel,
  msg: string,
  attrs?: Record<string, unknown>,
): void {
  // 1. Pino → stdout + file
  getLogger()[level](attrs ?? {}, msg);

  // 2. OTel LogRecord → Loki (if active)
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();
  otelLogger.emit({
    severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
    severityText:   level.toUpperCase(),
    body:           msg,
    attributes: {
      ...attrs,
      ...(spanCtx && {
        'trace.id':    spanCtx.traceId,
        'span.id':     spanCtx.spanId,
        'trace.flags': spanCtx.traceFlags,
      }),
    },
  });
}
