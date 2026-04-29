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
import type { ShareTick } from '@trading-bot/core/PolymarketService';
import type { PriceMonitoringWorker } from './PriceMonitoringWorker.js';

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

/** In-memory view of a pending BUY — source of truth for the WS hot path. */
interface ActiveOrder extends Omit<PendingOrderRow, 'window_start' | 'window_end'> {
  window_start: number;
  window_end:   number;
  tokenId:      string;              // held token (up or down, from direction)
  tpClobId:     string | null;       // resting CLOB TP limit, if any
}

export class OrderResolver {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private unsubscribeShareTick: (() => void) | null = null;

  /** Canonical cache of pending auto BUYs. Refreshed every tick. */
  private activeOrders = new Map<string, ActiveOrder>();
  /** tokenId → set of orderIds holding that token (for O(1) WS tick lookup). */
  private ordersByToken = new Map<string, Set<string>>();

  /**
   * Accepts an optional PriceMonitoringWorker reference. When provided:
   *   - Resolver reads bestBid from PMW's in-memory WS cache (no DB query).
   *   - Resolver subscribes to share_tick events for event-driven SL firing
   *     (fires in ms, not 5s polling latency).
   */
  constructor(private readonly pmw?: PriceMonitoringWorker) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log('info', 'OrderResolver starting', { eventDriven: !!this.pmw });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    if (this.pmw) {
      this.unsubscribeShareTick = this.pmw.onShareTick((tick) => {
        void this.handleShareTick(tick);
      });
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.unsubscribeShareTick) { this.unsubscribeShareTick(); this.unsubscribeShareTick = null; }
    this.running = false;
    this.activeOrders.clear();
    this.ordersByToken.clear();
    log('info', 'OrderResolver stopped');
  }

  /** Remove an order from both caches after it closes. */
  private evict(orderId: string): void {
    const o = this.activeOrders.get(orderId);
    if (!o) return;
    this.activeOrders.delete(orderId);
    this.ordersByToken.get(o.tokenId)?.delete(orderId);
  }

  /** Rebuild in-memory cache from DB. Runs every tick (5s) — covers new
   *  orders placed by PriceMonitoringWorker and orders closed elsewhere. */
  private async reconcileCache(): Promise<void> {
    const pool = getPool();
    const { rows } = await pool.query<PendingOrderRow & {
      token_up: string; token_down: string; tp_clob: string | null;
    }>(
      `SELECT o.id, o.market_id, o.direction, o.share_price, o.size_usdc,
              o.mode, o.source, o.tp_cents, o.sl_cents,
              m.window_start::text, m.window_end::text,
              m.token_up, m.token_down,
              (SELECT c.clob_order_id FROM poly_orders c
                WHERE c.parent_order_id = o.id AND c.close_reason='tp'
                  AND c.side='sell' AND c.status='pending' LIMIT 1) AS tp_clob
         FROM poly_orders o
         JOIN poly_clob_markets m ON m.condition_id = o.market_id
        WHERE o.status='pending' AND o.side='buy'`,
    );
    this.activeOrders.clear();
    this.ordersByToken.clear();
    for (const r of rows) {
      const tokenId = r.direction === 'up' ? r.token_up : r.token_down;
      this.activeOrders.set(r.id, {
        ...r,
        window_start: Number(r.window_start),
        window_end:   Number(r.window_end),
        tokenId,
        tpClobId:     r.tp_clob,
      });
      if (!this.ordersByToken.has(tokenId)) this.ordersByToken.set(tokenId, new Set());
      this.ordersByToken.get(tokenId)!.add(r.id);
    }
  }

  /**
   * Event-driven SL trigger — pure memory lookup, no DB.
   * Flow: WS tick → look up cached orders on this token → check SL threshold
   * → fire market SELL. Latency ≈ handler invocation time (sub-millisecond).
   */
  private async handleShareTick(tick: ShareTick): Promise<void> {
    if (!this.running || tick.bestBid == null) return;
    const ids = this.ordersByToken.get(tick.tokenId);
    if (!ids || ids.size === 0) return;
    const bidCents = tick.bestBid * 100;
    const now = Date.now();
    const slGlobal = await getAutoOrderSlCents();   // cached per-tick (cheap; Postgres hit but rare)

    for (const id of Array.from(ids)) {
      const o = this.activeOrders.get(id);
      if (!o) continue;
      // Only in last 30s of target window + SL enabled + bid ≤ threshold.
      if (o.window_end <= now || o.window_end - 30_000 > now) continue;
      if (o.sl_cents === null) continue;              // SL explicitly disabled (Path B)
      const slCents = o.sl_cents ?? slGlobal;
      if (bidCents > slCents) continue;
      // Evict BEFORE firing so concurrent handler re-entries don't double-fire.
      this.evict(id);
      await this.closeOrderAt(toRow(o), o.tokenId, tick.bestBid, 'sl', o.tpClobId != null, o.tpClobId);
    }
  }

  private async tick(): Promise<void> {
    try {
      // Reconcile cache from DB: picks up orders placed by PMW and removes
      // any that were closed (TP CLOB fill, streak-break cancel, etc.).
      await this.reconcileCache();

      if (this.activeOrders.size === 0) return;

      const now = Date.now();
      const [globalTp, globalSl] = await Promise.all([
        getAutoOrderTpCents(),
        getAutoOrderSlCents(),
      ]);

      for (const order of Array.from(this.activeOrders.values()).map(toRow)) {
        const we = Number(order.window_end);
        // Resolve via BTC outcome once window is fully settled.
        if (we <= now - SETTLE_DELAY_MS) {
          await this.resolveAtClose(order);
          continue;
        }
        // Mid-window: check TP/SL.
        //   TP: active any time during the target window (capture profit ASAP).
        //   SL: active only from T-3s of target window onwards (give the bet
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

  /** Mid-window exit rule (tick-based). TP is normally a resting GTC limit
   *  on CLOB (placed at BUY time) — fills passively, no polling needed.
   *  This path runs for fallbacks (simulate mode, or live mode where
   *  placeLimitSell failed). SL is also handled here as a 5s-polling
   *  fallback; the primary SL path is event-driven in handleShareTick. */
  private async checkTpSl(
    o: PendingOrderRow, tpCents: number, slCents: number, slDisabled: boolean,
  ): Promise<void> {
    const pool = getPool();

    const { rows: tprows } = await pool.query<{ clob_order_id: string | null }>(
      `SELECT clob_order_id FROM poly_orders
        WHERE parent_order_id = $1 AND close_reason = 'tp' AND side = 'sell'
          AND status = 'pending'
        LIMIT 1`,
      [o.id],
    );
    const tpRestingOnClob = tprows[0]?.clob_order_id != null;

    const { rows: mrows } = await pool.query<{ token_up: string; token_down: string }>(
      `SELECT token_up, token_down FROM poly_clob_markets WHERE condition_id = $1`,
      [o.market_id],
    );
    const market = mrows[0];
    if (!market) return;
    const tokenId = o.direction === 'up' ? market.token_up : market.token_down;

    // Prefer live WS cache (from PMW); fall back to DB (covers pending orders
    // for coins no longer enabled in PMW).
    let bid = this.pmw?.getBestBid(tokenId) ?? null;
    if (bid == null) {
      const { rows: brows } = await pool.query<{ best_bid: number | null }>(
        `SELECT best_bid FROM poly_share_ticks
          WHERE token_id = $1 AND best_bid IS NOT NULL
          ORDER BY ts DESC LIMIT 1`,
        [tokenId],
      );
      bid = brows[0]?.best_bid != null ? Number(brows[0].best_bid) : null;
    }
    if (bid == null) return;

    const bidCents = bid * 100;
    let reason: 'tp' | 'sl' | null = null;
    if (!tpRestingOnClob && bidCents >= tpCents) {
      reason = 'tp';
    } else if (!slDisabled && bidCents <= slCents) {
      reason = 'sl';
    }
    if (!reason) return;

    await this.closeOrderAt(o, tokenId, bid, reason, tpRestingOnClob, tprows[0]?.clob_order_id ?? null);
  }

  /** Shared close logic for TP/SL triggers. Handles CLOB market SELL
   *  (live mode, cancelling any resting TP limit first) and DB updates. */
  private async closeOrderAt(
    o: PendingOrderRow, tokenId: string, bid: number,
    reason: 'tp' | 'sl',
    tpResting: boolean, tpClobId: string | null,
  ): Promise<void> {
    const pool = getPool();
    const sharesOwned = o.size_usdc / o.share_price;
    const exitPrice = bid;

    if (o.mode === 'live') {
      const ex = getClobExecutor();
      if (!ex) {
        log('warn', 'OrderResolver: live mode but no executor — skipping', { id: o.id });
        return;
      }
      if (tpResting && tpClobId) {
        try { await ex.cancelOrder(tpClobId); }
        catch (err) {
          log('warn', 'OrderResolver: cancel resting TP failed (continuing)',
            { id: o.id, error: err instanceof Error ? err.message : String(err) });
        }
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
        return;
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

  /** Window-close resolution rule. Cancels any resting CLOB limits before
   *  computing outcome-based PnL. */
  private async resolveAtClose(o: PendingOrderRow): Promise<void> {
    const pool = getPool();
    const ws = Number(o.window_start);
    const we = Number(o.window_end);

    // Cancel any resting TP limit on CLOB before resolution (best-effort).
    // If the limit already filled, cancel will fail — we log + continue.
    // NOTE: this does not distinguish "filled" from "cancel failed for other
    // reasons". User reconciles via Polymarket UI / wallet balance. Future
    // improvement: query getOrder(orderID) to differentiate.
    if (o.mode === 'live') {
      const { rows: tprows } = await pool.query<{ clob_order_id: string | null }>(
        `SELECT clob_order_id FROM poly_orders
          WHERE parent_order_id = $1 AND close_reason = 'tp' AND side = 'sell'
            AND status = 'pending' AND clob_order_id IS NOT NULL
          LIMIT 1`,
        [o.id],
      );
      const tpClobId = tprows[0]?.clob_order_id;
      if (tpClobId) {
        const ex = getClobExecutor();
        if (ex) {
          try { await ex.cancelOrder(tpClobId); }
          catch (err) {
            log('warn', 'resolveAtClose: cancel resting TP failed (may have filled)',
              { id: o.id, tpClobId, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

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

/** Convert in-memory cache entry → the row shape existing helpers expect. */
function toRow(o: ActiveOrder): PendingOrderRow {
  return {
    id:           o.id,
    market_id:    o.market_id,
    direction:    o.direction,
    share_price:  o.share_price,
    size_usdc:    o.size_usdc,
    mode:         o.mode,
    source:       o.source,
    tp_cents:     o.tp_cents,
    sl_cents:     o.sl_cents,
    window_start: String(o.window_start),
    window_end:   String(o.window_end),
  };
}

