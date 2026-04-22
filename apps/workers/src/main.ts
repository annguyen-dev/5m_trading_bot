/**
 * apps/workers — entry point
 *
 * Single Node process that runs:
 *   - SignalBus (Redis pub/sub publisher)
 *   - PriceMonitoringWorker (multi-coin signal pipeline)
 *   - OrderResolver (TP/SL/resolution)
 *
 * No HTTP server, no SSE. Communicates with apps/api via Redis (SignalBus)
 * and shared Postgres tables (poly_orders, poly_share_ticks, etc.).
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { migrate } from '@trading-bot/db/migrate';
import { getSignalBus, type SignalBusEvent } from '@trading-bot/core/SignalBus';
import { initClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';
import { TelegramService } from '@trading-bot/core/TelegramService';
import { log } from '@trading-bot/core/logger';

import { PriceMonitoringWorker } from './PriceMonitoringWorker.js';
import { OrderResolver } from './OrderResolver.js';

// Silence noisy defaults if env not set
process.env['NODE_ENV']   = process.env['NODE_ENV']   ?? 'development';
process.env['LOG_LEVEL']  = process.env['LOG_LEVEL']  ?? 'info';

async function main(): Promise<void> {
  log('info', 'workers: starting');

  try { await migrate(); }
  catch (err) {
    log('warn', 'workers: migrate failed (DB may be unavailable)', { error: String(err) });
  }

  // CLOB executor — initialized once if POLY_PRIVATE_KEY is set; otherwise
  // OrderResolver/PriceMonitoringWorker fall back to simulate mode.
  await initClobExecutor();

  const bus = getSignalBus();
  await bus.start();

  // Telegram — workers own the Telegram channel (single sender, no duplicates).
  const telegram = new TelegramService();
  bus.onSignal((ev: SignalBusEvent) => { void telegram.send(ev); });

  const resolver = new OrderResolver();
  resolver.start();

  const worker = new PriceMonitoringWorker(bus);
  await worker.start();

  log('info', 'workers: ready');

  const shutdown = async (signal: string): Promise<void> => {
    log('info', `workers: ${signal} — shutting down`);
    resolver.stop();
    try { await worker.stop(); } catch (err) { log('warn', 'worker stop error', { error: String(err) }); }
    try { await bus.stop();    } catch (err) { log('warn', 'bus stop error',    { error: String(err) }); }
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch(err => {
  log('error', 'workers: fatal startup error', { error: String(err) });
  process.exit(1);
});
