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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
// Load .env from monorepo root so workers + api share one config file.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

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

// ── Single-instance lock ─────────────────────────────────────────────────────
// Prevents two workers from running simultaneously and placing duplicate orders.
// PID-based file lock at OS temp dir; uses O_EXCL for atomic create.

const LOCK_PATH = path.join(os.tmpdir(), 'trading-bot-workers.lock');

function acquireLock(): void {
  // Atomic create: throws if file already exists.
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    log('info', `acquired lock at ${LOCK_PATH} (PID ${process.pid})`);
    return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    // Lock already held — check if owner is alive
  }

  const raw = fs.readFileSync(LOCK_PATH, 'utf-8').trim();
  const existingPid = parseInt(raw, 10);
  if (Number.isFinite(existingPid) && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 0);   // signal 0 = alive check, no-op if alive
      log('error',
        `Another workers process is already running (PID ${existingPid}). ` +
        `Refusing to start.\n` +
        `To force restart:\n` +
        `  pkill -9 -f "workers/src/main"\n` +
        `  rm ${LOCK_PATH}\n` +
        `  pnpm --filter @trading-bot/workers dev`,
      );
      process.exit(1);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        log('warn', `stale lock from dead PID ${existingPid} — reclaiming`);
      } else {
        log('error', `Lock held by PID ${existingPid} (${code ?? 'unknown'}). Refusing to start.`);
        process.exit(1);
      }
    }
  }

  // Reclaim: rewrite with our PID
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  log('info', `reclaimed stale lock at ${LOCK_PATH} (PID ${process.pid})`);
}

function releaseLock(): void {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf-8').trim(), 10);
    if (pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch { /* ignore */ }
}

// Crash-safety: run cleanup on any exit (sync hook only — no await possible)
process.on('exit', releaseLock);

async function main(): Promise<void> {
  log('info', 'workers: starting');

  // Acquire single-instance lock BEFORE any heavy init (WS, CLOB, migrate).
  // If another instance is already running, this exits with code 1.
  acquireLock();

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

  // PMW owns the per-coin Polymarket WS subscriptions. OrderResolver takes
  // a reference so it can:
  //   - read bestBid directly from the live WS cache (no DB query)
  //   - subscribe to share_tick events for event-driven SL triggers (fires
  //     within ms of bid hitting SL, not 5s-polling latency)
  const worker = new PriceMonitoringWorker(bus);
  const resolver = new OrderResolver(worker);
  await worker.start();
  resolver.start();

  log('info', 'workers: ready');

  // Graceful shutdown with hard timeout. ioredis quit() and WS close can hang
  // indefinitely if the remote is unreachable — without a timeout the process
  // never reaches process.exit(), so Ctrl+C appears to do nothing. After 5s
  // we force-exit and let `process.on('exit', releaseLock)` clean the lock.
  // Second Ctrl+C bypasses graceful path entirely.
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log('warn', `workers: ${signal} received twice — force exit`);
      releaseLock();
      process.exit(1);
    }
    shuttingDown = true;
    log('info', `workers: ${signal} — shutting down (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

    const hardKill = setTimeout(() => {
      log('warn', `workers: graceful shutdown timed out — force exit`);
      releaseLock();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardKill.unref();   // don't keep the event loop alive just for this

    resolver.stop();
    try { await worker.stop(); } catch (err) { log('warn', 'worker stop error', { error: String(err) }); }
    try { await bus.stop();    } catch (err) { log('warn', 'bus stop error',    { error: String(err) }); }
    clearTimeout(hardKill);
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch(err => {
  log('error', 'workers: fatal startup error', { error: String(err) });
  process.exit(1);
});
