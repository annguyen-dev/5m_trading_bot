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
import { log } from './observability/logger.js';

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
  /**
   * |streak| value at the moment of signal — persisted to `streak_5m` column.
   * Used by the DCA gate to honor `cfg.dca_streak_whitelist` (only fire DCA
   * when parent's streak is in the allowed set). For DCA orders themselves,
   * pass the parent's streak so the DB row remains traceable.
   */
  streakAtSignal?: number;
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

  // LIVE: hit CLOB first (FAK — partial fills accepted). If 0 shares filled,
  // throw and don't touch DB. For partial fills, record ACTUAL amounts:
  //   size_usdc  = filled USDC      (may be < requested)
  //   share_price = avg price paid  (filledUsdc / filledShares)
  let buyClobID: string | null = null;
  let recordedSize  = p.sizeUsdc;
  let recordedPrice = p.sharePrice;
  if (mode === 'live') {
    const ex = getClobExecutor();
    if (!ex) throw new Error('live mode but PolymarketClobExecutor not initialized');
    const fill = await ex.placeMarketBuy(tokenID, p.sizeUsdc, p.sharePrice);
    buyClobID     = fill.orderID;
    recordedSize  = fill.filledUsdc;
    recordedPrice = fill.filledUsdc / fill.filledShares;
  }

  const id = randomUUID();
  const ts = Date.now();
  await pool.query(
    `INSERT INTO poly_orders
       (id, market_id, ts_entry, direction, share_price, size_usdc,
        p_signal, ev, mode, source, side, status,
        tp_cents, sl_cents, signal_path, clob_order_id, streak_5m)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'buy','pending',$11,$12,$13,$14,$15)`,
    [id, p.conditionId, ts, p.direction, recordedPrice, recordedSize,
     p.pSignal ?? 0, p.ev ?? 0, mode, p.source,
     p.tpCents ?? null, p.slCents ?? null, p.signalPath ?? null, buyClobID,
     Math.abs(p.streakAtSignal ?? 0)],
  );

  // Create pending TP/SL SELL children so they're visible immediately.
  // Both live and simulate now use the same flow: insert DB rows with
  // clob_order_id=NULL. OrderResolver monitors share ticks and fires a
  // MARKET SELL on CLOB (live) or just DB-closes (simulate) when a threshold
  // is crossed. No resting limit orders on CLOB any more.
  //
  // Use ACTUAL filled amounts (important for live partial fills) when computing
  // child share sizes. Pass tokenID so createExitOrders can place the GTC
  // limit SELL for TP on the correct token.
  await createExitOrders(id, p, ts, mode, recordedSize, recordedPrice, tokenID);

  return { id, ts, mode, source: p.source, market_id: p.conditionId };
}

/**
 * After a BUY is inserted, create its TP/SL SELL children.
 *
 *   TP SELL: resting GTC limit on CLOB (live) — passive fill when the book
 *            reaches TP price. clob_order_id set so we can cancel on
 *            window close / SL trigger / streak-break. In simulate mode
 *            the row is DB-only; OrderResolver DB-closes when bid ≥ TP.
 *   SL SELL: DB-only with clob_order_id=NULL. OrderResolver watches the
 *            bid and fires a MARKET SELL on CLOB (live) or DB-closes
 *            (simulate) when bid ≤ SL — this is a stop-style trigger.
 *            Can't be a resting limit: a SELL limit at a price BELOW market
 *            would fill immediately.
 *
 * TP/SL cents fall back to global settings when not explicitly set on the BUY.
 * `p.slCents === null` (not undefined) means "no SL" — skip SL entirely.
 */
async function createExitOrders(
  buyId: string, p: RecordOrderParams, ts: number,
  mode: 'simulate' | 'live',
  actualSizeUsdc: number, actualSharePrice: number, tokenID: string,
): Promise<void> {
  const pool = getPool();
  const [globalTp, globalSl] = await Promise.all([
    getAutoOrderTpCents(),
    getAutoOrderSlCents(),
  ]);
  const tpCents = p.tpCents ?? globalTp;
  const slCents = p.slCents === null ? null : (p.slCents ?? globalSl);

  // Round shares DOWN to 2 decimals — Polymarket CLOB rejects high-precision
  // sizes ("orderType - error - matching size required"). Loses ≤ $0.01 vs
  // FAK fill but ensures the TP limit accepts.
  const sharesExact = actualSizeUsdc / actualSharePrice;
  const shares = Math.floor(sharesExact * 100) / 100;
  const tpPrice = tpCents / 100;

  // TP = resting GTC limit SELL on CLOB at tpPrice. Filed alongside the BUY
  // so the exit price floor is enforced by CLOB matching engine — eliminates
  // the "TP fired at bid but actually filled lower" bug from market-sell exits
  // during last-second price flicker.
  //
  // SKIPPED for DCA orders: boundary BUY at T-3s of N already placed a TP
  // limit that locks the YES token pool for that market+direction. DCA at
  // T+0 of N adds shares to the SAME pool; placing a 2nd TP limit fails with
  // "balance is not enough" because the boundary's TP has all shares locked.
  // For DCA, OrderResolver's market-sell-on-trigger path handles exit (with
  // the P0 accounting fix that captures actual FAK fill price).
  //
  // Failure modes (all fall back to tpClobId=null → OrderResolver's bid-trigger
  // market-sell path runs as before):
  //   - Polymarket rejects size (e.g. share count below tick floor)
  //   - CTF balance hasn't settled in time (waitForTokenBalance timeout)
  //   - Network / CLOB transient error
  let tpClobId: string | null = null;
  const isDca = p.signalPath === 'dca';
  if (mode === 'live' && shares > 0 && tpCents > 0 && !isDca) {
    const ex = getClobExecutor();
    if (ex) {
      try {
        // Polymarket has 1-3s lag between BUY fill and CTF balance credit;
        // limit SELL would otherwise reject with "not enough balance".
        // Bumped from 8s → 15s after observing settled=0 cases on prod.
        const settled = await ex.waitForTokenBalance(tokenID, shares * 0.99, 15000);
        const sellSize = Math.floor(settled * 100) / 100;
        if (sellSize > 0) {
          tpClobId = await ex.placeLimitSell(tokenID, tpPrice, sellSize);
          log('info', 'TP resting limit placed', {
            buyId, tokenID, tpPrice, sellSize, clobOrderId: tpClobId,
          });
        } else {
          log('warn', 'TP resting limit skipped: balance not settled', {
            buyId, tokenID, expected: shares, settled,
          });
        }
      } catch (err) {
        log('warn', 'TP resting limit failed, will fall back to market-sell on trigger', {
          buyId, tokenID, tpPrice, shares,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else if (mode === 'live' && isDca) {
    log('info', 'TP resting limit skipped for DCA order (boundary holds the pool lock)', {
      buyId, tokenID,
    });
  }
  const tpShares = shares;
  const tpSizeUsdc = shares * tpPrice;

  await pool.query(
    `INSERT INTO poly_orders
       (id, parent_order_id, market_id, ts_entry, direction, share_price,
        size_usdc, p_signal, ev, mode, source, side, status,
        signal_path, close_reason, clob_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 'auto', 'sell', 'pending',
             $9, 'tp', $10)`,
    [randomUUID(), buyId, p.conditionId, ts + 1, p.direction, tpPrice,
     tpSizeUsdc, mode, p.signalPath ?? null, tpClobId],
  );

  if (slCents != null && slCents > 0) {
    const slPrice = slCents / 100;
    await pool.query(
      `INSERT INTO poly_orders
         (id, parent_order_id, market_id, ts_entry, direction, share_price,
          size_usdc, p_signal, ev, mode, source, side, status,
          signal_path, close_reason, clob_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 'auto', 'sell', 'pending',
               $9, 'sl', NULL)`,
      [randomUUID(), buyId, p.conditionId, ts + 2, p.direction, slPrice,
       shares * slPrice, mode, p.signalPath ?? null],
    );
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
