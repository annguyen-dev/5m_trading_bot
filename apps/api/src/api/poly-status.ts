/**
 * src/api/poly-status.ts
 *
 * Read-only + order-record endpoints for the Live page.
 * Backs the FE Live page: current market, price history, simulated orders.
 */

import type { Request, Response } from 'express';
import { getPool } from '@trading-bot/db';
import { recordOrder } from '@trading-bot/core/orderPlacement';
import type { LiveTradingEngine } from '../services/LiveTradingEngine.js';

// Optional live engine — wired in by the dashboard server bootstrap so order
// placements can broadcast through SSE. Stays null in test/CLI contexts.
let _engine: LiveTradingEngine | null = null;
export function attachLiveEngine(engine: LiveTradingEngine): void { _engine = engine; }

// ── Range window helper ────────────────────────────────────────────────────

const RANGE_MS: Record<string, number> = {
  '5m':  5 * 60_000,
  '15m': 15 * 60_000,
  '1h':  60 * 60_000,
  '1d':  24 * 60 * 60_000,
  '3d':  3 * 24 * 60 * 60_000,
};

function parseRange(raw: unknown): number {
  const key = String(raw ?? '5m').toLowerCase();
  return RANGE_MS[key] ?? RANGE_MS['5m']!;
}

// ── GET /api/poly/status ───────────────────────────────────────────────────

/** Health/freshness view for PolymarketService + FutureTickScanner. */
export async function getPolyStatus(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const [markets, shareTicks, futureTicks] = await Promise.all([
      pool.query<{ count: string; latest: string | null }>(
        `SELECT COUNT(*)::text AS count, MAX(fetched_at)::text AS latest
           FROM poly_clob_markets`,
      ),
      pool.query<{ count: string; latest: string | null }>(
        `SELECT COUNT(*)::text AS count, MAX(ts)::text AS latest
           FROM poly_share_ticks`,
      ),
      pool.query<{ count: string; latest: string | null }>(
        `SELECT COUNT(*)::text AS count, MAX(ts)::text AS latest
           FROM future_ticks_5s`,
      ),
    ]);
    const now = Date.now();
    const shareLatestMs  = Number(shareTicks.rows[0]?.latest ?? 0);
    const futureLatestMs = Number(futureTicks.rows[0]?.latest ?? 0);
    res.json({
      now,
      polymarket: {
        markets:        Number(markets.rows[0]?.count ?? 0),
        shareTicks:     Number(shareTicks.rows[0]?.count ?? 0),
        latestTickMs:   shareLatestMs || null,
        latestTickAgoSec: shareLatestMs ? Math.round((now - shareLatestMs) / 1000) : null,
        healthy:        shareLatestMs > 0 && now - shareLatestMs < 60_000,
      },
      futureTicks: {
        count:          Number(futureTicks.rows[0]?.count ?? 0),
        latestTickMs:   futureLatestMs || null,
        latestTickAgoSec: futureLatestMs ? Math.round((now - futureLatestMs) / 1000) : null,
        healthy:        futureLatestMs > 0 && now - futureLatestMs < 30_000,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/markets/upcoming ─────────────────────────────────────────

/** List the next N BTC 5m markets whose window hasn't closed yet. */
export async function getUpcomingMarkets(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.max(1, Math.min(10, Number(req.query['limit'] ?? 5)));
    const { rows } = await getPool().query(
      `SELECT condition_id, slug, question, window_start, window_end,
              token_up, token_down, resolution_src
         FROM poly_clob_markets
        WHERE window_end >= $1
        ORDER BY window_start ASC
        LIMIT $2`,
      [Date.now(), limit],
    );
    res.json({ markets: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/market/current ───────────────────────────────────────────

/**
 * Returns the BTC 5m market whose window is currently open, plus the latest
 * share prices for each outcome (derived from poly_share_ticks).
 */
export async function getCurrentMarket(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const now = Date.now();
    const { rows } = await pool.query(
      `SELECT condition_id, slug, question, window_start, window_end,
              token_up, token_down, resolution_src
         FROM poly_clob_markets
        WHERE window_start <= $1 AND window_end >= $1
        ORDER BY window_start ASC
        LIMIT 1`,
      [now],
    );
    const market = rows[0];
    if (!market) {
      res.json({ market: null });
      return;
    }

    const latestTick = async (tokenId: string) => {
      const r = await pool.query<{
        ts: string; best_bid: number | null; best_ask: number | null; last_price: number | null
      }>(
        `SELECT ts::text, best_bid, best_ask, last_price
           FROM poly_share_ticks
          WHERE token_id = $1
          ORDER BY ts DESC
          LIMIT 1`,
        [tokenId],
      );
      return r.rows[0] ?? null;
    };
    const [upTick, downTick] = await Promise.all([
      latestTick(market.token_up),
      latestTick(market.token_down),
    ]);

    res.json({
      market,
      shares: {
        up:   upTick,
        down: downTick,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/share-history?tokenId=X&range=5m|15m|1h|1d|3d ────────────

/**
 * Share-price history for a single token. Returns rows ordered by ts ascending.
 * Note: large ranges (1d, 3d) may return many thousands of rows — FE should
 * downsample for display.
 */
export async function getShareHistory(req: Request, res: Response): Promise<void> {
  try {
    const tokenId = String(req.query['tokenId'] ?? '');
    if (!tokenId) {
      res.status(400).json({ error: 'tokenId required' });
      return;
    }
    const windowMs = parseRange(req.query['range']);
    const cutoff = Date.now() - windowMs;
    const { rows } = await getPool().query(
      `SELECT ts::text, best_bid, best_ask, last_price, event_type
         FROM poly_share_ticks
        WHERE token_id = $1 AND ts >= $2
        ORDER BY ts ASC`,
      [tokenId, cutoff],
    );
    res.json({ ticks: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/btc-history?range=5m|15m|1h|1d|3d ────────────────────────

/** BTC 5s scanner history for overlaying on the share-price chart. */
export async function getBtcHistory(req: Request, res: Response): Promise<void> {
  try {
    const windowMs = parseRange(req.query['range']);
    const cutoff = Date.now() - windowMs;
    const { rows } = await getPool().query(
      `SELECT ts::text, price, volume_5s, price_change_5s,
              ob_imbalance, vol_spike_z
         FROM future_ticks_5s
        WHERE ts >= $1
        ORDER BY ts ASC`,
      [cutoff],
    );
    res.json({ ticks: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── POST /api/poly/orders/simulate ─────────────────────────────────────────

/**
 * Records a simulated order against the current 5m market.
 * Body: { conditionId, direction: 'up'|'down', sharePrice, sizeUsdc }
 */
export async function placeSimulatedOrder(req: Request, res: Response): Promise<void> {
  try {
    const { conditionId, direction, sharePrice, sizeUsdc } = req.body as {
      conditionId?: string; direction?: string;
      sharePrice?: number;  sizeUsdc?: number;
    };
    if (!conditionId || (direction !== 'up' && direction !== 'down')) {
      res.status(400).json({ error: 'conditionId + direction (up|down) required' });
      return;
    }
    const price = Number(sharePrice);
    const size  = Number(sizeUsdc);

    const result = await recordOrder({
      conditionId,
      direction,
      sharePrice: price,
      sizeUsdc:   size,
      source:     'manual',
    });

    // Broadcast so SSE clients pick it up instantly.
    _engine?.publishOrder({
      id:           result.id,
      market_id:    conditionId,
      ts_entry:     result.ts,
      direction,
      share_price:  price,
      size_usdc:    size,
      mode:         result.mode,
      source:       result.source,
      status:       'pending',
    });
    res.json({ id: result.id, mode: result.mode, source: result.source, ts: result.ts });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    // Validation errors → 400; everything else → 500
    if (/required|must be|not found/i.test(msg)) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
}

// ── GET /api/poly/past-windows ─────────────────────────────────────────────

/**
 * Returns outcome for the last N 5m BTC windows.
 *
 * Data source:  Binance SPOT 5m klines REST (fresh each call, independent of
 *   our capture bot — so past-window dots don't show gaps when the bot was
 *   off). Spot matches what we display live (BinanceFastTicker) and is close
 *   to Polymarket's Chainlink resolution source.
 *
 * Fallback: future_ticks_5s (captured perp) if Binance REST fails.
 *
 * Query:
 *   count  (default 5, max 20)
 *
 * Response:
 *   { windows: [{ windowStart, windowEnd, btcOpen, btcClose, outcome }, …] }
 */

interface PastWindow {
  windowStart: number;
  windowEnd:   number;
  btcOpen:     number | null;
  btcClose:    number | null;
  outcome:     'up' | 'down' | null;
}

// Cache keyed by "latest closed window start" — invalidates every 5min.
const pastCache = new Map<string, { ts: number; windows: PastWindow[] }>();
const PAST_CACHE_TTL_MS = 60_000;

export async function getPastWindows(req: Request, res: Response): Promise<void> {
  try {
    const count     = Math.max(1, Math.min(20, Number(req.query['count'] ?? 5)));
    const WINDOW_MS = 300_000;
    const nowWindowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;

    const cacheKey = `${nowWindowStart}-${count}`;
    const cached = pastCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PAST_CACHE_TTL_MS) {
      res.json({ windows: cached.windows, source: 'cache' });
      return;
    }

    const startTime = nowWindowStart - count * WINDOW_MS;
    const endTime   = nowWindowStart;        // exclusive — don't fetch current (unclosed) window

    // Primary: Binance spot klines (same source as BinanceFastTicker).
    let windows = await fetchPastFromBinance(count, startTime, endTime, WINDOW_MS);
    let source: 'binance' | 'db' | 'binance+db' = 'binance';

    // Backfill any still-null outcomes from DB (rare — only if Binance missed
    // a window entirely, which shouldn't happen for active hours).
    const hasGaps = windows.some(w => w.outcome === null);
    if (hasGaps) {
      const dbWindows = await fetchPastFromDb(count, nowWindowStart, WINDOW_MS);
      windows = windows.map(w => {
        if (w.outcome !== null) return w;
        const db = dbWindows.find(d => d.windowStart === w.windowStart);
        return db ?? w;
      });
      source = 'binance+db';
    }

    pastCache.set(cacheKey, { ts: Date.now(), windows });
    res.json({ windows, source });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

/** Binance spot 5m klines — [openTime, open, high, low, close, volume, closeTime, ...] */
async function fetchPastFromBinance(
  count: number, startTime: number, endTime: number, windowMs: number,
): Promise<PastWindow[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=BTCUSDT&interval=5m`
      + `&startTime=${startTime}&endTime=${endTime - 1}&limit=${count + 2}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`binance klines ${resp.status}`);
    const klines = await resp.json() as Array<Array<string | number>>;

    const byStart = new Map<number, { open: number; close: number }>();
    for (const k of klines) {
      byStart.set(Number(k[0]), { open: Number(k[1]), close: Number(k[4]) });
    }

    const windows: PastWindow[] = [];
    for (let i = 1; i <= count; i++) {
      const start = endTime - i * windowMs;
      const kline = byStart.get(start);
      const btcOpen  = kline?.open  ?? null;
      const btcClose = kline?.close ?? null;
      windows.push({
        windowStart: start,
        windowEnd:   start + windowMs,
        btcOpen, btcClose,
        outcome: btcOpen != null && btcClose != null
          ? (btcClose >= btcOpen ? 'up' : 'down')
          : null,
      });
    }
    return windows;    // newest first → oldest (loop from i=1 to count)
  } catch {
    return Array.from({ length: count }, (_, i) => ({
      windowStart: endTime - (i + 1) * windowMs,
      windowEnd:   endTime - i * windowMs,
      btcOpen:     null,
      btcClose:    null,
      outcome:     null,
    }));
  }
}

async function fetchPastFromDb(
  count: number, nowWindowStart: number, windowMs: number,
): Promise<PastWindow[]> {
  const pool = getPool();
  const queries = Array.from({ length: count }, (_, i) => {
    const start = nowWindowStart - (i + 1) * windowMs;
    const end   = start + windowMs;
    return pool.query<{ open_price: number | null; close_price: number | null }>(
      `SELECT
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC  LIMIT 1) AS open_price,
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts DESC LIMIT 1) AS close_price`,
      [start, end],
    ).then(r => ({ start, end, row: r.rows[0] }));
  });
  const results = await Promise.all(queries);
  return results.map(({ start, end, row }) => {
    const btcOpen  = row?.open_price  ?? null;
    const btcClose = row?.close_price ?? null;
    return {
      windowStart: start,
      windowEnd:   end,
      btcOpen, btcClose,
      outcome: btcOpen != null && btcClose != null
        ? (btcClose >= btcOpen ? 'up' as const : 'down' as const)
        : null,
    };
  });
}

// ── DELETE /api/poly/admin/reset-test-data ─────────────────────────────────

/**
 * Wipe all non-live orders (simulate + backtest). Keeps live orders untouched
 * so user can reset sim experiments without losing real-money trading history.
 */
export async function resetTestData(_req: Request, res: Response): Promise<void> {
  try {
    const pool = getPool();
    const { rows: liveRows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM poly_orders WHERE mode = 'live'`,
    );
    const keptLive = Number(liveRows[0]?.c ?? 0);
    const { rowCount } = await pool.query(
      `DELETE FROM poly_orders WHERE mode <> 'live'`,
    );
    res.json({ deleted: rowCount ?? 0, kept_live: keptLive });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/portfolio ────────────────────────────────────────────────

/**
 * Portfolio metrics filtered by mode (simulate | live). Excludes backtest by
 * default. All aggregates on BUY rows only (side='buy') to avoid double-
 * counting PnL from SELL rows.
 */
export async function getPortfolio(req: Request, res: Response): Promise<void> {
  try {
    const mode = String(req.query['mode'] ?? 'simulate').toLowerCase();
    if (mode !== 'simulate' && mode !== 'live') {
      res.status(400).json({ error: 'mode must be simulate | live' });
      return;
    }
    const pool = getPool();
    const [totals, byReason, byPath, recent] = await Promise.all([
      pool.query<{
        total: string; pending: string; closed: string;
        wins: string; losses: string;
        realized_pnl: string; total_size: string;
      }>(`
        SELECT
          COUNT(*)::text                                                   AS total,
          COUNT(*) FILTER (WHERE status='pending')::text                   AS pending,
          COUNT(*) FILTER (WHERE status='closed')::text                    AS closed,
          COUNT(*) FILTER (WHERE status='closed' AND pnl_usdc > 0)::text   AS wins,
          COUNT(*) FILTER (WHERE status='closed' AND pnl_usdc <= 0)::text  AS losses,
          COALESCE(SUM(pnl_usdc) FILTER (WHERE status='closed'), 0)::text  AS realized_pnl,
          COALESCE(SUM(size_usdc), 0)::text                                AS total_size
        FROM poly_orders
        WHERE side='buy' AND mode=$1
      `, [mode]),
      pool.query<{ close_reason: string; count: string; avg_pnl: string }>(`
        SELECT close_reason,
               COUNT(*)::text                    AS count,
               COALESCE(AVG(pnl_usdc), 0)::text  AS avg_pnl
          FROM poly_orders
         WHERE side='buy' AND mode=$1 AND status='closed' AND close_reason IS NOT NULL
         GROUP BY close_reason
      `, [mode]),
      pool.query<{ signal_path: string | null; count: string; total_pnl: string }>(`
        SELECT COALESCE(signal_path, 'manual') AS signal_path,
               COUNT(*)::text                  AS count,
               COALESCE(SUM(pnl_usdc) FILTER (WHERE status='closed'), 0)::text AS total_pnl
          FROM poly_orders
         WHERE side='buy' AND mode=$1
         GROUP BY signal_path
      `, [mode]),
      pool.query<{
        id: string; direction: string; share_price: number; pnl_usdc: number | null;
        close_reason: string | null; ts_entry: string; status: string;
      }>(`
        SELECT id, direction, share_price, pnl_usdc, close_reason,
               ts_entry::text, status
          FROM poly_orders
         WHERE side='buy' AND mode=$1
         ORDER BY ts_entry DESC
         LIMIT 30
      `, [mode]),
    ]);
    res.json({
      mode,
      totals: {
        total:       Number(totals.rows[0]?.total ?? 0),
        pending:     Number(totals.rows[0]?.pending ?? 0),
        closed:      Number(totals.rows[0]?.closed ?? 0),
        wins:        Number(totals.rows[0]?.wins ?? 0),
        losses:      Number(totals.rows[0]?.losses ?? 0),
        realizedPnl: Number(totals.rows[0]?.realized_pnl ?? 0),
        totalSize:   Number(totals.rows[0]?.total_size ?? 0),
      },
      byCloseReason: byReason.rows.map(r => ({
        reason: r.close_reason, count: Number(r.count), avgPnl: Number(r.avg_pnl),
      })),
      bySignalPath: byPath.rows.map(r => ({
        path: r.signal_path, count: Number(r.count), totalPnl: Number(r.total_pnl),
      })),
      recent: recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── GET /api/poly/orders ───────────────────────────────────────────────────

/**
 * Lists orders, newest first.
 * Query params (all optional):
 *   status  'pending' | 'closed'
 *   mode    'simulate' | 'live'
 *   source  'manual' | 'auto' | 'backtest'
 *   limit   1-500 (default 100)
 */
export async function listOrders(req: Request, res: Response): Promise<void> {
  try {
    const status = String(req.query['status'] ?? '').toLowerCase();
    const mode   = String(req.query['mode']   ?? '').toLowerCase();
    const source = String(req.query['source'] ?? '').toLowerCase();
    const limit  = Math.max(1, Math.min(500, Number(req.query['limit'] ?? 100)));

    const conds:  string[]  = [];
    const params: unknown[] = [];
    if (status === 'pending' || status === 'closed') {
      conds.push(`o.status = $${params.length + 1}`);
      params.push(status);
    }
    if (mode === 'simulate' || mode === 'live') {
      conds.push(`o.mode = $${params.length + 1}`);
      params.push(mode);
    }
    if (source === 'manual' || source === 'auto' || source === 'backtest') {
      conds.push(`o.source = $${params.length + 1}`);
      params.push(source);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await getPool().query(
      `SELECT o.id, o.market_id, o.ts_entry, o.direction, o.share_price,
              o.size_usdc, o.mode, o.source, o.side, o.parent_order_id,
              o.status, o.pnl_usdc,
              o.exit_price, o.close_reason, o.resolved_at,
              o.tp_cents, o.sl_cents, o.signal_path,
              m.slug, m.question, m.window_start, m.window_end
         FROM poly_orders o
         LEFT JOIN poly_clob_markets m ON m.condition_id = o.market_id
        ${where}
        ORDER BY o.ts_entry DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
