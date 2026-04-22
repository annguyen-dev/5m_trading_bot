/**
 * src/services/orderPlacement.ts
 *
 * Shared helper: record a Polymarket order in `poly_orders` + sync the
 * legacy `poly_markets` FK row. Used by both:
 *   - HTTP handler POST /api/poly/orders/simulate  (source='manual')
 *   - StreakSignalEngine auto-trade loop           (source='auto')
 *   - (future) BacktestOrderRecorder               (source='backtest')
 *
 * This function DOES NOT broadcast via SSE — callers that have a
 * LiveTradingEngine reference should call `engine.publishOrder(row)` afterwards.
 */
import { randomUUID } from 'crypto';
import { getPool } from '@trading-bot/db';
import { getTradingMode, getAutoOrderTpCents, getAutoOrderSlCents } from './settings.js';
import { getClobExecutor } from './PolymarketClobExecutor.js';

export interface RecordOrderParams {
  conditionId: string;
  direction:   'up' | 'down';
  sharePrice:  number;       // (0, 1)
  sizeUsdc:    number;       // > 0
  source:      'manual' | 'auto' | 'backtest';
  /** Which StreakSignalEngine path placed this (auto orders only). */
  signalPath?: 'boundary' | 'dca' | 'panic' | null;
  /** Optional signal context (for auto orders). */
  pSignal?:    number;
  ev?:         number;
  /**
   * Per-order exit rules, cents in [1, 99]. Null/undefined → resolver falls
   * back to global settings (auto_order_tp_cents / auto_order_sl_cents).
   * Set explicitly for Path B (panic) orders which have their own targets.
   */
  tpCents?:    number | null;
  slCents?:    number | null;
}

export interface RecordOrderResult {
  id:        string;
  ts:        number;
  mode:      'simulate' | 'live';
  source:    'manual' | 'auto' | 'backtest';
  market_id: string;
}

export async function recordOrder(p: RecordOrderParams): Promise<RecordOrderResult> {
  if (!p.conditionId) throw new Error('conditionId required');
  if (p.direction !== 'up' && p.direction !== 'down') throw new Error('direction must be up|down');
  if (!(p.sharePrice > 0 && p.sharePrice < 1)) throw new Error('sharePrice must be in (0, 1)');
  if (!(p.sizeUsdc > 0)) throw new Error('sizeUsdc must be positive');

  const pool = getPool();

  // Find the market row (so we can create the legacy poly_markets FK row)
  // Also grab both token IDs — we need the one matching direction for live CLOB.
  const { rows: mktRows } = await pool.query<{
    window_start: string; window_end: string;
    token_up: string;    token_down: string;
  }>(
    `SELECT window_start::text, window_end::text, token_up, token_down
       FROM poly_clob_markets
      WHERE condition_id = $1`,
    [p.conditionId],
  );
  if (!mktRows[0]) throw new Error(`market not found: ${p.conditionId}`);
  const { window_start, window_end, token_up, token_down } = mktRows[0];
  const tokenID = p.direction === 'up' ? token_up : token_down;

  // Legacy FK satisfier (poly_orders.market_id → poly_markets.id).
  await pool.query(
    `INSERT INTO poly_markets (id, ts_open, ts_close, symbol, share_price_up, share_price_down, spread)
     VALUES ($1, $2, $3, 'BTC/USDT', $4, $5, 0.02)
     ON CONFLICT (id) DO NOTHING`,
    [p.conditionId, Number(window_start), Number(window_end),
     p.direction === 'up' ? p.sharePrice : 1 - p.sharePrice,
     p.direction === 'up' ? 1 - p.sharePrice : p.sharePrice],
  );

  // Force simulate if POLY_PRIVATE_KEY missing.
  const mode: 'simulate' | 'live' = await getTradingMode();

  // LIVE: hit CLOB first. If the market BUY fails (insufficient liquidity at
  // the limit price, balance issues, etc.) we bail BEFORE touching the DB.
  let buyClobID: string | null = null;
  if (mode === 'live') {
    const ex = getClobExecutor();
    if (!ex) throw new Error('live mode but PolymarketClobExecutor not initialized');
    buyClobID = await ex.placeMarketBuy(tokenID, p.sizeUsdc, p.sharePrice);
  }

  const id = randomUUID();
  const ts = Date.now();
  await pool.query(
    `INSERT INTO poly_orders
       (id, market_id, ts_entry, direction, share_price, size_usdc,
        p_signal, ev, mode, source, side, status,
        tp_cents, sl_cents, signal_path, clob_order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'buy','pending',$11,$12,$13,$14)`,
    [id, p.conditionId, ts, p.direction, p.sharePrice, p.sizeUsdc,
     p.pSignal ?? 0, p.ev ?? 0, mode, p.source,
     p.tpCents ?? null, p.slCents ?? null, p.signalPath ?? null, buyClobID],
  );

  // Create pending TP/SL SELL children so they're visible immediately.
  // Both live and simulate now use the same flow: insert DB rows with
  // clob_order_id=NULL. OrderResolver monitors share ticks and fires a
  // MARKET SELL on CLOB (live) or just DB-closes (simulate) when a threshold
  // is crossed. No resting limit orders on CLOB any more.
  await createExitOrders(id, p, ts, mode);

  return { id, ts, mode, source: p.source, market_id: p.conditionId };
}

/**
 * After a BUY is inserted, create its pending TP/SL SELL children (DB-only).
 *   TP SELL: close_reason='tp', status='pending', clob_order_id=NULL
 *   SL SELL: close_reason='sl', status='pending', clob_order_id=NULL
 *
 * No resting limit on CLOB. OrderResolver watches share ticks and — when a
 * threshold is crossed — fires a MARKET SELL (live) or just DB-closes
 * (simulate). This gives actual market fills instead of missed limit fills
 * (previous FOK SELL attempts kept failing due to on-chain settlement race).
 *
 * TP/SL cents fall back to global settings when not explicitly set on the BUY.
 * A null SL cent value means "no SL" — skip the SL SELL entirely (DCA case).
 */
async function createExitOrders(
  buyId: string, p: RecordOrderParams, ts: number,
  mode: 'simulate' | 'live',
): Promise<void> {
  const pool = getPool();
  const [globalTp, globalSl] = await Promise.all([
    getAutoOrderTpCents(),
    getAutoOrderSlCents(),
  ]);
  const tpCents = p.tpCents ?? globalTp;
  const slCents = p.slCents === null ? null : (p.slCents ?? globalSl);

  const shares = p.sizeUsdc / p.sharePrice;

  async function insertPendingSell(price: number, reason: 'tp' | 'sl'): Promise<void> {
    await pool.query(
      `INSERT INTO poly_orders
         (id, parent_order_id, market_id, ts_entry, direction, share_price,
          size_usdc, p_signal, ev, mode, source, side, status,
          signal_path, close_reason, clob_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 'auto', 'sell', 'pending',
               $9, $10, NULL)`,
      [randomUUID(), buyId, p.conditionId, ts + 1, p.direction, price,
       shares * price, mode, p.signalPath ?? null, reason],
    );
  }

  await insertPendingSell(tpCents / 100, 'tp');
  if (slCents != null && slCents > 0) {
    await insertPendingSell(slCents / 100, 'sl');
  }
}

/**
 * Check whether an auto BUY exists for a given market, optionally filtered
 * by signal_path. Used by StreakSignalEngine for per-path idempotency:
 *   BOUNDARY: once per market with signal_path='boundary'
 *   DCA:      once per market with signal_path='dca'
 *   PANIC:    once per market with signal_path='panic'
 */
export async function hasAutoOrderFor(
  conditionId: string,
  signalPath?: 'boundary' | 'dca' | 'panic',
): Promise<boolean> {
  const pathFilter = signalPath ? `AND signal_path = $2` : '';
  const params = signalPath ? [conditionId, signalPath] : [conditionId];
  const { rows } = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM poly_orders
        WHERE market_id = $1 AND source = 'auto' AND side = 'buy' ${pathFilter}
     ) AS exists`,
    params,
  );
  return Boolean(rows[0]?.exists);
}

/**
 * Find the most recent PENDING Path A BUY for a given market.
 * Path B (DCA-add) uses this: only fires if we already hold a position on
 * the current window from the previous boundary's Path A fire.
 */
export async function findPendingPathABuyFor(
  conditionId: string,
): Promise<{ id: string; direction: 'up' | 'down'; share_price: number } | null> {
  const { rows } = await getPool().query<{
    id: string; direction: 'up' | 'down'; share_price: number;
  }>(
    `SELECT id, direction, share_price FROM poly_orders
       WHERE market_id   = $1
         AND source      = 'auto'
         AND signal_path = 'boundary'
         AND side        = 'buy'
         AND status      = 'pending'
       ORDER BY ts_entry DESC
       LIMIT 1`,
    [conditionId],
  );
  return rows[0] ?? null;
}
