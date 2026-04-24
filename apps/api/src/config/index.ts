import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
// Monorepo root .env (single source for api + workers).
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
  override: true,
});

function required(key: string): string {
  // Soft-fail at import time — return empty string. Modules that *actually*
  // need the value will fail at use-time (clearer error trace).
  return process.env[key] ?? '';
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = Number(val);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be a number, got: ${val}`);
  return n;
}

export const config = {
  // Exchange
  exchangeId:    optional('EXCHANGE_ID', 'binance'),
  tradingSymbol: optional('TRADING_SYMBOL', 'BTC/USDT'),

  // Trading execution
  tradingMode:      optional('TRADING_MODE', 'paper') as 'paper' | 'live',
  exchangeApiKey:   process.env['EXCHANGE_API_KEY'],
  exchangeApiSecret: process.env['EXCHANGE_API_SECRET'],
  tradeSizeUsdt:    optionalNumber('TRADE_SIZE_USDT', 100),
  tradeLeverage:    optionalNumber('TRADE_LEVERAGE', 1),

  // Anthropic
  anthropicApiKey: required('ANTHROPIC_API_KEY'),

  // Voyage AI (embeddings for RAG)
  voyageApiKey: required('VOYAGE_API_KEY'),

  // Telegram
  telegramToken: required('TELEGRAM_TOKEN'),
  telegramChannelId: required('TELEGRAM_CHANNEL_ID'),

  // Grafana / OTLP
  grafanaOtlpEndpoint: optional('GRAFANA_OTLP_ENDPOINT', 'http://localhost:4318'),
  grafanaAuthHeader: optional('GRAFANA_AUTH_HEADER', ''),

  // PostgreSQL
  databaseUrl: optional('DATABASE_URL', 'postgresql://trading:trading@localhost:5432/trading'),

  // LanceDB
  lancedbPath: optional('LANCEDB_PATH', './data/lancedb'),

  // News — comma-separated RSS feed URLs (empty = use built-in defaults)
  newsRssFeeds: (process.env['NEWS_RSS_FEEDS'] ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
  newsPollIntervalMs: optionalNumber('NEWS_POLL_INTERVAL_MS', 60_000),

  // App
  logLevel: optional('LOG_LEVEL', 'info'),
  nodeEnv: optional('NODE_ENV', 'development'),
} as const;
