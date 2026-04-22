/**
 * src/services/OrderResolver.ts
 *
 * Background worker that closes pending Polymarket sim orders via 3 rules:
 *
 *   1. TP hit       (bestBid of held side ≥ TP cents, mid-window)
 *   2. SL hit       (bestBid of held side ≤ SL cents, mid-window)
 *   3. Resolution   (window_end passed, derive outcome from BTC klines)
 *
 * For TP/SL: uses the LiveTradingEngine's in-memory snapshot for the latest
 * bestBid on the held token — instant response to share WS tick-throughs,
 * no DB scan required.
 *
 * For resolution: reads future_ticks_5s for open/close of the closed window.
 *
 * Thresholds come from /api/settings (auto_order_tp_cents, auto_order_sl_cents)
 * and apply to ALL pending orders (manual + auto). User can effectively
 * disable by setting TP=99 / SL=1.
 *
 * Broadcasts updates through engine.publishOrder so the FE SSE picks them up
 * without re-polling /api/poly/orders.
 */

import { getPool } from '@trading-bot/db';
import { log } from '@trading-bot/core/logger';
import { getAutoOrderTpCents, getAutoOrderSlCents } from '@trading-bot/core/settings';
import { getClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';

const TICK_MS         = 5_000;      // faster loop — TP/SL needs mid-window responsiveness
const SETTLE_DELAY_MS = 30_000;     // wait this long after window_end before resolving

interface PendingOrderRow {
  id:           string;
  market_id:    string;
  direction:    'up' | 'down';
  share_price:  number;
  size_usdc:    number;
  mode:         'simulate' | 'live';
  source:       'manual' | 'auto' | 'backtest';
  tp_cents:     number | null;       // per-order override; null → global setting
  sl_cents:     number | null;       // per-order override; null → global setting (1 = effectively disabled)
  window_start: string;
  window_end:   string;
}

export class OrderResolver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor() {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log('info', 'OrderResolver starting');
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.running = false;
    log('info', 'OrderResolver stopped');
  }

  private async tick(): Promise<void> {
    try {
      const pool = getPool();
      const now = Date.now();
      // Only pending BUY orders — the SELL children are closed via parent.
      const { rows } = await pool.query<PendingOrderRow>(
        `SELECT o.id, o.market_id, o.direction, o.share_price, o.size_usdc,
                o.mode, o.source, o.tp_cents, o.sl_cents,
                m.window_start::text, m.window_end::text
           FROM poly_orders o
           JOIN poly_clob_markets m ON m.condition_id = o.market_id
          WHERE o.status = 'pending' AND o.side = 'buy'`,
      );
      if (!rows.length) return;

      // Global TP/SL defaults used when order row has null tp_cents/sl_cents.
      const [globalTp, globalSl] = await Promise.all([
        getAutoOrderTpCents(),
        getAutoOrderSlCents(),
      ]);

      for (const order of rows) {
        const we = Number(order.window_end);
        // Resolve via BTC outcome once window is fully settled.
        if (we <= now - SETTLE_DELAY_MS) {
          await this.resolveAtClose(order);
          continue;
        }
        // Mid-window: check TP/SL.
        //   TP: active any time during the target window (capture profit ASAP).
        //   SL: active only from T-30s of target window onwards (give the bet
        //       time to play out before stop-loss kicks in).
        if (we >= now) {
          const tp = order.tp_cents ?? globalTp;
          const sl = order.sl_cents;    // null = disabled (Path B default)
          const slPerOrderDisabled = sl === null;
          const slBeforeT30s       = now < we - 30_000;
          const slDisabled         = slPerOrderDisabled || slBeforeT30s;
          await this.checkTpSl(order, tp, sl ?? globalSl, slDisabled);
        }
      }
    } catch (err) {
      log('warn', 'OrderResolver tick failed', { error: String(err) });
    }
  }

  /** Mid-window exit rule. Reads bestBid of held side from DB (poly_share_ticks
   *  is fed by PriceMonitoringWorker's Polymarket WS subscriptions). */
  private async checkTpSl(
    o: PendingOrderRow, tpCents: number, slCents: number, slDisabled: boolean,
  ): Promise<void> {
    const pool = getPool();
    const { rows: mrows } = await pool.query<{ token_up: string; token_down: string }>(
      `SELECT token_up, token_down FROM poly_clob_markets WHERE condition_id = $1`,
      [o.market_id],
    );
    const market = mrows[0];
    if (!market) return;     // market not tracked (stale) — resolution will handle at close
    const tokenId = o.direction === 'up' ? market.token_up : market.token_down;

    // Latest bestBid from share-ticks table (most recent non-null bid for this token).
    const { rows: brows } = await pool.query<{ best_bid: number | null }>(
      `SELECT best_bid FROM poly_share_ticks
        WHERE token_id = $1 AND best_bid IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
      [tokenId],
    );
    const bid = brows[0]?.best_bid != null ? Number(brows[0].best_bid) : null;
    if (bid == null) return;

    const bidCents = bid * 100;
    // MARKET semantics: threshold trigger → fire a market SELL (live) or DB
    // close (simulate). Use current bid as estimated exit price. In live, the
    // real fill from CLOB response would be slightly different due to slippage
    // — accepted as a tradeoff for guaranteed execution vs resting limits.
    let reason: 'tp' | 'sl' | null = null;
    if (bidCents >= tpCents) {
      reason = 'tp';
    } else if (!slDisabled && bidCents <= slCents) {
      reason = 'sl';
    }
    if (!reason) return;

    const sharesOwned = o.size_usdc / o.share_price;
    const exitPrice = bid;   // start with live bid; overwrite if CLOB response gives better info

    // LIVE: fire market SELL on CLOB. If it fails, DON'T close the DB row —
    // let the next tick retry (or fall through to resolution at window-end).
    if (o.mode === 'live') {
      const ex = getClobExecutor();
      if (!ex) {
        log('warn', 'OrderResolver: live mode but no executor — skipping', { id: o.id });
        return;
      }
      try {
        await ex.placeMarketSell(tokenId, sharesOwned);
        log('info', `OrderResolver ${reason.toUpperCase()} live-sold`, {
          id: o.id, bid, shares: sharesOwned,
        });
      } catch (err) {
        log('warn', 'OrderResolver market SELL failed, will retry next tick', {
          id: o.id, reason, error: err instanceof Error ? err.message : String(err),
        });
        return;   // do not mark closed — try again next tick
      }
    }

    const pnl = (exitPrice - o.share_price) * sharesOwned;

    const now = Date.now();
    // 1. Close BUY with the realized pnl + exit price
    await pool.query(
      `UPDATE poly_orders
          SET status       = 'closed',
              pnl_usdc     = $1,
              exit_price   = $2,
              close_reason = $3,
              resolved_at  = $4
        WHERE id = $5 AND status = 'pending' AND side = 'buy'`,
      [pnl, exitPrice, reason, now, o.id],
    );
    // 2. Fill the matching SELL child (close_reason stays 'tp' or 'sl')
    await pool.query(
      `UPDATE poly_orders
          SET status       = 'closed',
              resolved_at  = $1
        WHERE parent_order_id = $2 AND side = 'sell' AND status = 'pending'
          AND close_reason = $3`,
      [now, o.id, reason],
    );
    // 3. Cancel the OCO sibling (the OTHER SELL child that didn't fire)
    await pool.query(
      `UPDATE poly_orders
          SET status       = 'closed',
              close_reason = 'cancelled',
              resolved_at  = $1
        WHERE parent_order_id = $2 AND side = 'sell' AND status = 'pending'`,
      [now, o.id],
    );
    log('info', `OrderResolver ${reason.toUpperCase()} (limit)`, {
      id: o.id, direction: o.direction,
      entry: o.share_price, exit_limit: exitPrice, bid_at_trigger: bid,
      pnl: pnl.toFixed(2),
    });
    // FE polls /api/poly/orders every 5s → picks up the closed row.
  }

  /** Window-close resolution rule — same as before but now sets close_reason='resolution'. */
  private async resolveAtClose(o: PendingOrderRow): Promise<void> {
    const pool = getPool();
    const ws = Number(o.window_start);
    const we = Number(o.window_end);

    const { rows } = await pool.query<{ open_price: number | null; close_price: number | null }>(
      `SELECT
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC  LIMIT 1) AS open_price,
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts DESC LIMIT 1) AS close_price`,
      [ws, we],
    );
    const openP  = rows[0]?.open_price  ?? null;
    const closeP = rows[0]?.close_price ?? null;
    if (openP == null || closeP == null) {
      log('warn', 'OrderResolver: no btc ticks for window, skipping', {
        order: o.id, window_start: ws, window_end: we,
      });
      return;
    }

    const outcome: 'up' | 'down' = closeP >= openP ? 'up' : 'down';
    const sharesOwned = o.size_usdc / o.share_price;
    const won  = outcome === o.direction;
    const pnl  = won ? sharesOwned - o.size_usdc : -o.size_usdc;
    const exitPrice = won ? 1.0 : 0.0;

    const now = Date.now();
    // 1. Close BUY via resolution
    await pool.query(
      `UPDATE poly_orders
          SET status       = 'closed',
              pnl_usdc     = $1,
              exit_price   = $2,
              close_reason = 'resolution',
              resolved_at  = $3
        WHERE id = $4 AND status = 'pending' AND side = 'buy'`,
      [pnl, exitPrice, now, o.id],
    );
    // 2. Cancel ALL pending SELL children (they never filled — window ended)
    await pool.query(
      `UPDATE poly_orders
          SET status       = 'closed',
              close_reason = 'cancelled',
              resolved_at  = $1
        WHERE parent_order_id = $2 AND side = 'sell' AND status = 'pending'`,
      [now, o.id],
    );
    log('info', 'OrderResolver resolution', {
      id: o.id, direction: o.direction, outcome, pnl: pnl.toFixed(2),
      btc_open: openP, btc_close: closeP,
    });
    // FE polls /api/poly/orders every 5s → picks up the closed row.
  }
}

