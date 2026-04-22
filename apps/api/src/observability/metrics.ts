import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { metrics, Counter, Histogram, UpDownCounter } from '@opentelemetry/api';

let meterProvider: MeterProvider | null = null;

export function initMetrics(): void {
  const endpoint = process.env.GRAFANA_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const authHeader = process.env.GRAFANA_AUTH_HEADER ?? '';

  const headers: Record<string, string> = authHeader
    ? { Authorization: authHeader }
    : {};

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: 'trading-bot',
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
    headers,
  });

  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 15_000,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);
}

export async function shutdownMetrics(): Promise<void> {
  await meterProvider?.shutdown();
}

// ── Instrument singletons ──────────────────────────────────────────────────

const meter = () => metrics.getMeter('trading-bot', '0.1.0');

let _signalCounter: UpDownCounter | null = null;
export function getSignalCounter(): UpDownCounter {
  if (!_signalCounter) {
    _signalCounter = meter().createUpDownCounter('signal_count', {
      description: 'Number of trading signals generated',
      unit: '{signal}',
    });
  }
  return _signalCounter;
}

let _apiLatency: Histogram | null = null;
export function getApiLatencyHistogram(): Histogram {
  if (!_apiLatency) {
    _apiLatency = meter().createHistogram('api_latency', {
      description: 'Latency of external API calls in milliseconds',
      unit: 'ms',
    });
  }
  return _apiLatency;
}

let _trapCounter: Counter | null = null;
export function getTrapCounter(): Counter {
  if (!_trapCounter) {
    _trapCounter = meter().createCounter('mm_trap_detected_total', {
      description: 'Total number of Market Maker traps detected',
      unit: '{trap}',
    });
  }
  return _trapCounter;
}
