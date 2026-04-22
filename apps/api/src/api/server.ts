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
dotenv.config({ override: true }); // override: true so .env wins over empty shell vars
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { listEnvironments } from './environments.js';
import { getSignals, getSummary } from './signals.js';
import { getCandles, getRunCandles } from './candles.js';
import { getCompare, getEquity } from './backtest.js';
import { getPositions } from './positions.js';
import { getSimulateCandles, runSimulate } from './simulate.js';
import { runPolySimulate } from './poly-simulate.js';
import { startBacktest, backtestProgress } from './backtest-runner.js';
import { deleteBacktestRun } from './backtest-delete.js';
import { listFormulaConfigs, getActiveFormulaConfig, createFormulaConfig, updateFormulaConfig, activateFormulaConfig, deleteFormulaConfig } from './formula.js';
import { analyzeFormula } from './formula-analyze.js';
import { listSettings, updateSetting } from './settings.js';
import { getPolyStatus, getUpcomingMarkets, getCurrentMarket,
         getShareHistory, getBtcHistory, getPastWindows,
         placeSimulatedOrder, listOrders, attachLiveEngine,
         resetTestData, getPortfolio } from './poly-status.js';
import { verifyCoinSlugs } from './poly-verify.js';
import { listCoinConfigs, updateCoinConfigHandler } from './coin-configs.js';
import { polyStreamHandler } from './poly-stream.js';
import { PolymarketService } from '@trading-bot/core/PolymarketService';
import { FutureTickScanner } from '../services/FutureTickScanner.js';
import { BinanceFastTicker } from '../services/BinanceFastTicker.js';
import { LiveTradingEngine } from '../services/LiveTradingEngine.js';
import { getSignalBus, type SignalBusEvent } from '@trading-bot/core/SignalBus';
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

// ── Backtest runner ──────────────────────────────────────────────────────────
app.post('/api/backtest/run',                startBacktest);
app.get('/api/backtest/progress/:jobId',     backtestProgress);
app.delete('/api/backtest/runs/:envId',      deleteBacktestRun);

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
app.get('/api/poly/orders',            listOrders);
app.get('/api/poly/portfolio',         getPortfolio);
app.delete('/api/poly/admin/reset-test-data', resetTestData);
app.get('/api/poly/verify-slugs',      verifyCoinSlugs);

// ── Per-coin strategy config ───────────────────────────────────────────────
app.get('/api/coin-configs',           listCoinConfigs);
app.put('/api/coin-configs/:symbol',   updateCoinConfigHandler);

// ── Polymarket — SSE live stream (set up below after engine boots) ─────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start — run migrations, boot engine for FE chart, subscribe to bus
//          and relay to SSE. Workers run in a SEPARATE process (apps/workers)
//          and publish to the same Redis bus + Postgres. ────────────────────
async function bootstrap(): Promise<void> {
  try {
    await migrate();
  } catch (err) {
    console.error('[api] Migration error (DB may be unavailable):', err);
  }

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
    if (ev.type === 'T-30s') engine.emit('coin_t30',    ev);
    if (ev.type === 'T-0')   engine.emit('coin_t0',     ev);
  });

  const server = app.listen(PORT, () => {
    console.log(`\n  Trading Dashboard API at http://localhost:${PORT}`);
    console.log(`  Live engine: PolymarketService(BTC) + FutureTickScanner + BinanceFastTicker`);
    console.log(`  SSE relay:   Redis SignalBus → engine.emit → /api/poly/stream`);
    console.log(`  Workers run in separate process: pnpm --filter @trading-bot/workers dev\n`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[api] ${signal} — shutting down`);
    server.close();
    try { await bus.stop(); }    catch (err) { console.error('[api] bus stop error', err); }
    try { await engine.stop(); } catch (err) { console.error('[api] engine stop error', err); }
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
