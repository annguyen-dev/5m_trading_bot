import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, Tracer } from '@opentelemetry/api';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { logs } from '@opentelemetry/api-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

let tracerProvider: NodeTracerProvider | null = null;
let loggerProvider: LoggerProvider | null = null;

export function initTracing(): void {
  // Bot pushes to local Grafana Agent (localhost:4318).
  // The agent handles auth and forwarding to Grafana Cloud.
  const endpoint = process.env.GRAFANA_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const headers: Record<string, string> = {};

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: 'trading-bot',
    [ATTR_SERVICE_VERSION]: '0.1.0',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });

  // ── Traces ─────────────────────────────────────────────────────────────────
  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });

  // Auto-instrument HTTP, Express, net, etc. — register before provider.register()
  const autoInstrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs':  { enabled: false }, // too noisy
    '@opentelemetry/instrumentation-dns': { enabled: false }, // too noisy
  });
  autoInstrumentations.forEach(i => i.setTracerProvider(tracerProvider!));
  autoInstrumentations.forEach(i => i.enable());

  tracerProvider.register();

  // ── Logs ───────────────────────────────────────────────────────────────────
  const logExporter = new OTLPLogExporter({
    url: `${endpoint}/v1/logs`,
    headers,
  });

  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
  logs.setGlobalLoggerProvider(loggerProvider);
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name, '0.1.0');
}

export async function shutdownTracing(): Promise<void> {
  await Promise.all([
    tracerProvider?.shutdown(),
    loggerProvider?.shutdown(),
  ]);
}
