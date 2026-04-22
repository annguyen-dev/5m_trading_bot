import pino from 'pino';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace } from '@opentelemetry/api';

// Read env directly so this module is self-contained (no cross-app config dep).
const NODE_ENV  = process.env['NODE_ENV']  ?? 'development';
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info';

// ── Pino base logger ────────────────────────────────────────────────────────
// In dev: pretty-print. In prod: JSON to stdout (for log collectors).
const isTest = NODE_ENV === 'test';
const isProduction = NODE_ENV === 'production';

export const logger = pino(
  {
    level: LOG_LEVEL,
    base: { service: 'trading-bot', env: NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  // In test: write to /dev/null so output is suppressed.
  // In prod: JSON to stdout.
  // In dev: pretty-print.
  isTest
    ? pino.destination('/dev/null')
    : isProduction
      ? pino.destination(1)
      : pino.transport({ target: 'pino-pretty', options: { colorize: true } }),
);

// ── OTel bridge ─────────────────────────────────────────────────────────────
// Emits a LogRecord to the OTel LoggerProvider so logs flow to Grafana Loki.
// Automatically injects traceId + spanId from the active OTel context
// so Grafana can link log lines ↔ traces.

const otelLogger = logs.getLogger('trading-bot', '0.1.0');

const SEVERITY: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  msg: string,
  attrs?: Record<string, unknown>,
): void {
  // 1. Pino → stdout / pretty
  logger[level](attrs ?? {}, msg);

  // 2. Inject active span context for trace correlation
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();

  // 3. Emit OTel LogRecord → OTLP → Loki
  otelLogger.emit({
    severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: msg,
    attributes: {
      ...attrs,
      ...(spanCtx && {
        'trace.id': spanCtx.traceId,
        'span.id': spanCtx.spanId,
        'trace.flags': spanCtx.traceFlags,
      }),
    },
  });
}
