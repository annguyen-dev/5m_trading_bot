/**
 * Dashboard API server
 *
 * Serves the trading history web dashboard on port 3000 (default).
 *
 * Usage:
 *   npm run dashboard           # start on :3000
 *   PORT=8080 npm run dashboard # custom port
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
// Load .env from monorepo root so api + workers share one config file.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
  override: true,
});
import express from 'express';
import { listEnvironments } from './environments.js';
import { getSignals, getSummary } from './signals.js';
import { getCandles, getRunCandles } from './candles.js';
import { getCompare, getEquity } from './backtest.js';
import { getPositions } from './positions.js';
import { getSimulateCandles, runSimulate } from './simulate.js';
import { runPolySimulate } from './poly-simulate.js';
import { startBacktest, backtestProgress } from './backtest-runner.js';
import { deleteBacktestRun } from './backtest-delete.js';
import { startPolyBacktest, streamPolyBacktest } from '../backtest/poly/handler.js';
import { listFormulaConfigs, getActiveFormulaConfig, createFormulaConfig, updateFormulaConfig, activateFormulaConfig, deleteFormulaConfig } from './formula.js';
import { analyzeFormula } from './formula-analyze.js';
import { listSettings, updateSetting } from './settings.js';
import { getPolyStatus, getUpcomingMarkets, getCurrentMarket,
         getShareHistory, getBtcHistory, getPastWindows,
         placeSimulatedOrder, listOrders, attachLiveEngine,
         resetTestData, getPortfolio,
         getPolyPositions, sellPosition, getBalance } from './poly-status.js';
import { verifyCoinSlugs } from './poly-verify.js';
import { listCoinConfigs, updateCoinConfigHandler } from './coin-configs.js';
import { listTelegramChannels, replaceTelegramChannels } from './telegram-channels.js';
import { getStreakStats } from './analyze-streaks.js';
import { polyStreamHandler } from './poly-stream.js';
import { loginHandler, meHandler } from './auth.js';
import { requireAuth } from '../auth/middleware.js';
import { PolymarketService } from '@trading-bot/core/PolymarketService';
import { FutureTickScanner } from '../services/FutureTickScanner.js';
import { BinanceFastTicker } from '../services/BinanceFastTicker.js';
import { LiveTradingEngine } from '../services/LiveTradingEngine.js';
import { getSignalBus, type SignalBusEvent } from '@trading-bot/core/SignalBus';
import { initClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';
import { migrate } from '@trading-bot/db/migrate';

// Silence OTel / logger (dashboard server doesn't need tracing)
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'dashboard-placeholder';
process.env.VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? 'dashboard-placeholder';
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? 'dashboard-placeholder';
process.env.TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID ?? '-100000000000';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = process.env['FRONTEND_DIST'] ?? path.resolve(__dirname, '../../../fe/dist');
const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(express.json());

// ── HTTP request logger ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? '\x1b[31m'   // red
                : res.statusCode >= 400 ? '\x1b[33m'   // yellow
                : res.statusCode >= 300 ? '\x1b[36m'   // cyan
                : '\x1b[32m';                           // green
    console.log(`${color}${req.method} ${req.path} → ${res.statusCode}\x1b[0m  ${ms}ms`);
  });
  next();
});

// ── API routes ──────────────────────────────────────────────────────────────

// ── Public: health + login (no auth required) ──────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.post('/api/auth/login', loginHandler);

// ── Auth gate: everything under /api/* BELOW requires a valid admin JWT ────
// Routes registered above this line are public. Routes below are protected.
app.use('/api', requireAuth);

// Protected: return the authenticated user (used by FE to verify session).
app.get('/api/auth/me', meHandler);

// ── Backtest runner ──────────────────────────────────────────────────────────
app.post('/api/backtest/run',                startBacktest);
app.get('/api/backtest/progress/:jobId',     backtestProgress);
app.delete('/api/backtest/runs/:envId',      deleteBacktestRun);

// Poly-driven backtest (mirrors live PMW strategy on historical Poly ticks)
app.post('/api/backtest/poly/run',                  startPolyBacktest);
app.get('/api/backtest/poly/progress/:jobId',       streamPolyBacktest);

// ── Formula configs ──────────────────────────────────────────────────────────
app.get('/api/formula/configs',              listFormulaConfigs);
app.get('/api/formula/configs/active',       getActiveFormulaConfig);
app.post('/api/formula/configs',             createFormulaConfig);
app.put('/api/formula/configs/:id',          updateFormulaConfig);
app.put('/api/formula/configs/:id/activate', activateFormulaConfig);
app.delete('/api/formula/configs/:id',       deleteFormulaConfig);
app.post('/api/formula/analyze',             analyzeFormula);

app.get('/api/environments',           listEnvironments);
app.get('/api/signals/:envId',         getSignals);
app.get('/api/summary/:envId',         getSummary);
app.get('/api/candles/:envId',         getCandles);
app.get('/api/run-candles/:runId',     getRunCandles);
app.get('/api/backtest/compare',       getCompare);
app.get('/api/backtest/equity/:runId', getEquity);
app.get('/api/positions',             getPositions);
app.get('/api/simulate/candles',  getSimulateCandles);
app.post('/api/simulate/run',     runSimulate);
app.post('/api/poly-simulate/run', runPolySimulate);

// ── Settings ────────────────────────────────────────────────────────────────
app.get('/api/settings',        listSettings);
app.put('/api/settings/:key',   updateSetting);

// ── Polymarket — REST (history, orders) ────────────────────────────────────
app.get('/api/poly/status',            getPolyStatus);
app.get('/api/poly/markets/upcoming',  getUpcomingMarkets);
app.get('/api/poly/market/current',    getCurrentMarket);
app.get('/api/poly/share-history',     getShareHistory);
app.get('/api/poly/btc-history',       getBtcHistory);
app.get('/api/poly/past-windows',      getPastWindows);
app.post('/api/poly/orders/simulate',  placeSimulatedOrder);
app.post('/api/poly/orders/sell',      sellPosition);
app.get('/api/poly/balance',           getBalance);
app.get('/api/poly/positions/:conditionId', getPolyPositions);
app.get('/api/poly/orders',            listOrders);
app.get('/api/poly/portfolio',         getPortfolio);
app.delete('/api/poly/admin/reset-test-data', resetTestData);
app.get('/api/poly/verify-slugs',      verifyCoinSlugs);

// ── Per-coin strategy config ───────────────────────────────────────────────
app.get('/api/coin-configs',           listCoinConfigs);
app.put('/api/coin-configs/:symbol',   updateCoinConfigHandler);

// ── Telegram channel routing ──────────────────────────────────────────────
app.get('/api/telegram-channels',      listTelegramChannels);
app.put('/api/telegram-channels',      replaceTelegramChannels);

// ── Streak pattern analyzer ────────────────────────────────────────────────
app.get('/api/analyze/streak-stats',   getStreakStats);

// ── Polymarket — SSE live stream (set up below after engine boots) ─────────
//    SSE needs auth too — polyStreamHandler is mounted under /api, so the
//    global requireAuth middleware protects it. EventSource can't send
//    Authorization headers, so FE passes `?token=...` and the middleware
//    accepts either source.

// ── Start — run migrations, boot engine for FE chart, subscribe to bus
//          and relay to SSE. Workers run in a SEPARATE process (apps/workers)
//          and publish to the same Redis bus + Postgres. ────────────────────
async function bootstrap(): Promise<void> {
  try {
    await migrate();
  } catch (err) {
    console.error('[api] Migration error (DB may be unavailable):', err);
  }

  // CLOB executor needed for manual live orders (POST /api/poly/orders/simulate
  // routes through recordOrder → ClobExecutor when trading_mode=live). Workers
  // initialize their own instance for auto orders.
  await initClobExecutor();

  // Live trading engine — owns BTC ticker / scanner / Polymarket(BTC) ONLY
  // for FE chart purposes (real-time SSE feed). Decision logic + per-coin
  // monitoring lives in apps/workers.
  const engine = new LiveTradingEngine(
    new PolymarketService(),
    new FutureTickScanner('BTC/USDT:USDT'),
    new BinanceFastTicker(),
  );
  app.get('/api/poly/stream', polyStreamHandler(engine));
  attachLiveEngine(engine);    // lets POST /orders/simulate broadcast 'order' events

  // Static files — only in production (dev uses Vite dev server).
  // Must register AFTER the SSE route so the catch-all doesn't swallow it.
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(PUBLIC_DIR));
    app.get('*path', (_req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  }

  try {
    await engine.start();
  } catch (err) {
    console.error('[api] LiveTradingEngine start failed:', err);
  }

  // Subscribe to Redis SignalBus (workers publish here). Relay events onto
  // engine emitter so the existing SSE handler forwards them to the FE.
  // NOTE: TelegramService is NOT instantiated here — workers send Telegram
  // (single source of truth so we don't get duplicate messages).
  const bus = getSignalBus();
  try { await bus.start(); } catch (err) {
    console.error('[api] SignalBus start failed:', err);
  }
  bus.onSignal((ev: SignalBusEvent) => {
    if (ev.type === 'T+0')   engine.emit('coin_t0plus', ev);
    if (ev.type === 'T+4')   engine.emit('coin_t4',     ev);
    if (ev.type === 'T-3s')  engine.emit('coin_t3',     ev);
    if (ev.type === 'T-0')   engine.emit('coin_t0',     ev);
  });

  const server = app.listen(PORT, () => {
    console.log(`\n  Trading Dashboard API at http://localhost:${PORT}`);
    console.log(`  Live engine: PolymarketService(BTC) + FutureTickScanner + BinanceFastTicker`);
    console.log(`  SSE relay:   Redis SignalBus → engine.emit → /api/poly/stream`);
    console.log(`  Workers run in separate process: pnpm --filter @trading-bot/workers dev\n`);
  });

  // Hard-timeout graceful shutdown. ioredis quit() can hang if Redis is
  // unreachable; without a timeout the process never exits and Ctrl+C
  // appears to do nothing. Second Ctrl+C bypasses graceful path entirely.
  let shuttingDown = false;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      console.warn(`[api] ${signal} received twice — force exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[api] ${signal} — shutting down (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

    const hardKill = setTimeout(() => {
      console.warn('[api] graceful shutdown timed out — force exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardKill.unref();

    server.close();
    try { await bus.stop(); }    catch (err) { console.error('[api] bus stop error', err); }
    try { await engine.stop(); } catch (err) { console.error('[api] engine stop error', err); }
    clearTimeout(hardKill);
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
