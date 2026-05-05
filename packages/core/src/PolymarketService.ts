/**
 * src/services/PolymarketService.ts
 *
 * Discovers Polymarket BTC 5m up/down markets via Gamma API and streams
 * tick-by-tick share-price updates via the CLOB WebSocket.
 *
 * Phase 2.A scope: data capture only. No decision logic, no order placement.
 *
 * Endpoints:
 *   REST https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{unix_s}
 *   REST https://clob.polymarket.com/book?token_id={id}
 *   WS   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *        subscribe  {"type":"market","assets_ids":[...]}
 *        events     book | price_change | last_trade_price
 *
 * Events emitted:
 *   'market'      (m: PolyClobMarket)  — new market discovered
 *   'share_tick'  (t: ShareTick)       — deduplicated tick (bb/ba changed, or book/trade)
 *   'disconnect'                       — WS closed
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getPool } from '@trading-bot/db';
import { log } from './observability/logger.js';
import type { CoinSymbol } from './CoinConfig.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PolyClobMarket {
  conditionId:    string;
  slug:           string;
  question:       string;
  symbol:         CoinSymbol;
  windowStart:    number;   // unix ms
  windowEnd:      number;   // unix ms
  tokenUp:        string;
  tokenDown:      string;
  resolutionSrc:  string;
}

/**
 * Slug prefix per coin on Polymarket's Gamma API. Discovered by inspecting
 * their public URL patterns. If a coin's 5m market doesn't exist yet, the
 * fetch just returns null and we move on.
 */
export const SLUG_PREFIX: Record<CoinSymbol, string> = {
  BTC:  'btc-updown-5m-',
  ETH:  'eth-updown-5m-',
  SOL:  'sol-updown-5m-',
  XRP:  'xrp-updown-5m-',
  DOGE: 'doge-updown-5m-',
  HYPE: 'hype-updown-5m-',
  BNB:  'bnb-updown-5m-',
};

export type ShareTickEvent = 'book' | 'price_change' | 'last_trade_price';

export interface ShareTick {
  conditionId: string;
  tokenId:     string;
  ts:          number;      // unix ms
  bestBid:     number | null;
  bestAsk:     number | null;
  lastPrice:   number | null;
  event:       ShareTickEvent;
}

// ── Constants ──────────────────────────────────────────────────────────────

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE  = 'https://clob.polymarket.com';
const WS_URL     = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const WINDOW_SECS       = 300;
const WS_RECONNECT_MS   = 250;
const DISCOVERY_POLL_MS = 60_000;   // re-scan upcoming markets every 60s
const FLUSH_INTERVAL_MS = 1000;     // batch DB writes at most every 1s
const FLUSH_BATCH_MAX   = 200;      // or when buffer hits this size
const UPCOMING_TRACK    = 3;        // track current + next 2 windows
// Staleness watchdog — outbound WS to Polymarket can silently zombie behind
// NAT / cloud network filters: TCP stays open, no `close` fires, but no data
// flows. engine.shares freezes at last value, SSE keeps pushing stale snapshot,
// UI shows wrong "live" prices until process restart. Detect by tracking time
// since last message and force-reconnect when idle.
const WS_PING_INTERVAL_MS  = 25_000;   // outbound ping → keeps NAT/proxy from idle-killing
const WS_STALE_MS          = 60_000;   // no DATA message ≥ this → assume zombie, reconnect
const WS_WATCHDOG_TICK_MS  = 15_000;
// Proactive rotation — Polymarket server-side appears to silence the WS data
// stream every ~15 minutes (verified in prod logs: idleMs reaches 60-73s on
// a 15:00 ± 30s cycle). Rotating BEFORE that silent window starts skips the
// 60s of frozen FE prices entirely; only the ~750ms reconnect blackout
// remains. The 60s watchdog above stays as a safety net for unexpected gaps.
const WS_ROTATE_MS         = 780_000;  // 13 min — buffer before Polymarket's ~15min cut

// ── Service ────────────────────────────────────────────────────────────────

export class PolymarketService extends EventEmitter {
  private pool = getPool();
  private ws: WebSocket | null = null;
  private running = false;
  public readonly symbol: CoinSymbol;
  private readonly slugPrefix: string;

  // Active markets we're tracking (keyed by conditionId)
  private activeMarkets = new Map<string, PolyClobMarket>();
  // Tokens to subscribe on WS (superset of active market tokens)
  private subscribedTokens = new Set<string>();

  constructor(symbol: CoinSymbol = 'BTC') {
    super();
    this.symbol = symbol;
    this.slugPrefix = SLUG_PREFIX[symbol];
  }

  // Dedup cache for top-of-book: tokenId → last {bid, ask}
  private lastTopOfBook = new Map<string, { bid: number | null; ask: number | null }>();

  // Last time the WS produced a message (any type). Used by the staleness
  // watchdog to detect silent zombie connections.
  private lastWsEventAt = 0;

  // Write buffer
  private buf: ShareTick[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log('info', 'PolymarketService starting');
    void this.discoveryLoop();
    void this.wsLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.flush();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    log('info', 'PolymarketService stopped');
  }

  // ── Public helpers ───────────────────────────────────────────────────────

  /** 5m market for this coin whose window contains `unixSec`. Null if not found. */
  async findMarketAt(unixSec: number): Promise<PolyClobMarket | null> {
    const windowStart = Math.floor(unixSec / WINDOW_SECS) * WINDOW_SECS;
    return this.fetchBySlug(`${this.slugPrefix}${windowStart}`);
  }

  /** Next `count` 5m markets for this coin starting from the current window. */
  async findUpcoming(count: number): Promise<PolyClobMarket[]> {
    const startSec = Math.floor(Date.now() / 1000 / WINDOW_SECS) * WINDOW_SECS;
    const slugs = Array.from(
      { length: count },
      (_, i) => `${this.slugPrefix}${startSec + i * WINDOW_SECS}`,
    );
    const results = await Promise.all(slugs.map(s => this.fetchBySlug(s)));
    return results.filter((m): m is PolyClobMarket => m !== null);
  }

  /** Fetch full order book snapshot for a token (REST). */
  async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  } | null> {
    try {
      const resp = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
      if (!resp.ok) return null;
      const j = await resp.json() as { bids?: RawLevel[]; asks?: RawLevel[] };
      return {
        bids: (j.bids ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
        asks: (j.asks ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })),
      };
    } catch {
      return null;
    }
  }

  // ── Market discovery ─────────────────────────────────────────────────────

  private async fetchBySlug(slug: string): Promise<PolyClobMarket | null> {
    try {
      const resp = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
      if (!resp.ok) return null;
      const arr = await resp.json() as GammaEvent[];
      if (!arr?.length) return null;
      const event = arr[0];
      if (!event) return null;
      const mkt = event.markets?.[0];
      if (!mkt?.clobTokenIds) return null;
      const tokens = JSON.parse(mkt.clobTokenIds) as [string, string];

      // Map tokens to outcomes by NAME, not array index — Gamma is not guaranteed
      // to keep `clobTokenIds[0]` aligned with `outcomes[0]` across all markets.
      const outcomes: string[] = mkt.outcomes
        ? (typeof mkt.outcomes === 'string' ? JSON.parse(mkt.outcomes) : mkt.outcomes)
        : ['Up', 'Down'];
      const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
      const dnIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
      const tokenUp   = upIdx >= 0 ? tokens[upIdx]! : tokens[0];
      const tokenDown = dnIdx >= 0 ? tokens[dnIdx]! : tokens[1];

      // Derive window_start from slug (unix seconds) — more reliable than
      // event.startDate, which is market-creation time (~24h earlier).
      const wsSec = Number(slug.slice(this.slugPrefix.length));
      const fallbackDate = event.startDate ?? event.endDate ?? '';
      const windowStartMs = Number.isFinite(wsSec) && wsSec > 0
        ? wsSec * 1000
        : fallbackDate ? new Date(fallbackDate).getTime() : 0;
      const windowEndMs = event.endDate ? new Date(event.endDate).getTime() : 0;

      const market: PolyClobMarket = {
        conditionId:   mkt.conditionId,
        slug:          event.slug ?? slug,
        question:      mkt.question ?? '',
        symbol:        this.symbol,
        windowStart:   windowStartMs,
        windowEnd:     windowEndMs,
        tokenUp,
        tokenDown,
        resolutionSrc: mkt.resolutionSource ?? '',
      };
      await this.upsertMarket(market);
      return market;
    } catch (err) {
      log('warn', 'Polymarket fetchBySlug failed', { slug, error: String(err) });
      return null;
    }
  }

  private async upsertMarket(m: PolyClobMarket): Promise<void> {
    await this.pool.query(
      `INSERT INTO poly_clob_markets
         (condition_id, slug, question, symbol, window_start, window_end,
          token_up, token_down, resolution_src, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (condition_id) DO UPDATE SET
         slug           = EXCLUDED.slug,
         question       = EXCLUDED.question,
         window_start   = EXCLUDED.window_start,
         window_end     = EXCLUDED.window_end,
         token_up       = EXCLUDED.token_up,
         token_down     = EXCLUDED.token_down,
         resolution_src = EXCLUDED.resolution_src,
         fetched_at     = EXCLUDED.fetched_at`,
      [m.conditionId, m.slug, m.question, m.symbol,
       m.windowStart, m.windowEnd, m.tokenUp, m.tokenDown,
       m.resolutionSrc, Date.now()],
    );
  }

  private async discoveryLoop(): Promise<void> {
    while (this.running) {
      try {
        const markets = await this.findUpcoming(UPCOMING_TRACK);
        for (const m of markets) {
          if (!this.activeMarkets.has(m.conditionId)) {
            this.activeMarkets.set(m.conditionId, m);
            this.emit('market', m);
            log('info', 'Polymarket: tracking market', {
              slug:        m.slug,
              windowStart: new Date(m.windowStart).toISOString(),
            });
          }
          this.addTokenSubscription(m.tokenUp);
          this.addTokenSubscription(m.tokenDown);
        }
        // Prune markets whose window ended > 5min ago
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [id, m] of this.activeMarkets.entries()) {
          if (m.windowEnd < cutoff) {
            this.activeMarkets.delete(id);
            this.subscribedTokens.delete(m.tokenUp);
            this.subscribedTokens.delete(m.tokenDown);
            this.lastTopOfBook.delete(m.tokenUp);
            this.lastTopOfBook.delete(m.tokenDown);
          }
        }
      } catch (err) {
        log('warn', 'Polymarket discoveryLoop error', { error: String(err) });
      }
      await sleep(DISCOVERY_POLL_MS);
    }
  }

  private addTokenSubscription(token: string): void {
    if (this.subscribedTokens.has(token)) return;
    this.subscribedTokens.add(token);
    if (this.ws?.readyState === WebSocket.OPEN) {
      // CLOB accepts incremental subscribes on the same connection.
      this.ws.send(JSON.stringify({ type: 'market', assets_ids: [token] }));
    }
    // CLOB's WS subscribe doesn't always trigger a `book` event back —
    // especially on freshly-opened or low-liquidity markets. Without an
    // initial book the engine's shares Map stays empty for this token until
    // the first price_change (could be many minutes), so the UI shows blank
    // and a page refresh doesn't fix it (server state is also empty).
    // REST-seed proactively to guarantee shares have data within ~200ms.
    void this.seedInitialBook(token);
  }

  /**
   * REST-fetch a token's order book and emit it as a synthetic `book` tick.
   *
   * Two modes:
   * - `force=false` (default): one-shot lazy seed. No-op if the token already
   *   has cached top-of-book — used when adding a new token subscription.
   * - `force=true`: always overwrite, regardless of cached state. Used on WS
   *   reconnect to refresh tokens whose data has gone stale.
   *
   * Why force=true is needed on reconnect: empirically (verified via DB query
   * on prod), Polymarket's WS subscribe DOES NOT replay `book` events for
   * inactive tokens — only for ones with current activity. So tokens that
   * were seeded once with placeholder 49/50, 50/51 and never received a
   * price_change keep their stale value forever despite repeated reconnects.
   * Forcing a REST refresh on every WS open closes that gap.
   *
   * Does NOT write to poly_share_ticks (that table is for real ticks; REST
   * snapshots would falsely look like exchange-driven events).
   */
  private async seedInitialBook(token: string, force = false): Promise<void> {
    if (!force && this.lastTopOfBook.has(token)) return;
    const book = await this.getOrderBook(token);
    if (!book) return;
    // Lazy path: re-check after the awaited REST in case WS raced ahead. On
    // the force path the goal IS to overwrite, so we skip this re-check.
    if (!force && this.lastTopOfBook.has(token)) return;
    const bestBid = book.bids.length ? Math.max(...book.bids.map(b => b.price)) : null;
    const bestAsk = book.asks.length ? Math.min(...book.asks.map(a => a.price)) : null;
    if (bestBid == null && bestAsk == null) return;
    this.lastTopOfBook.set(token, { bid: bestBid, ask: bestAsk });
    const cond = Array.from(this.activeMarkets.values())
      .find(m => m.tokenUp === token || m.tokenDown === token);
    const tick: ShareTick = {
      conditionId: cond?.conditionId ?? '',
      tokenId:     token,
      ts:          Date.now(),
      bestBid,
      bestAsk,
      lastPrice:   null,
      event:       'book',
    };
    this.emit('share_tick', tick);
    // Demote re-seed log to debug — fires for every token on every reconnect
    // (~30 tokens × every 15 min ≈ 120/h per service). Keep info for the
    // first-time path so initial population is still visible.
    log(force ? 'debug' : 'info', 'Polymarket REST-seeded initial book',
        { token: token.slice(0, 8), bestBid, bestAsk, force });
  }

  // ── WebSocket loop ───────────────────────────────────────────────────────

  private async wsLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runWs();
      } catch (err) {
        log('warn', 'Polymarket WS threw', { error: String(err) });
      }
      if (this.running) await sleep(WS_RECONNECT_MS);
    }
  }

  private runWs(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const openedAt = Date.now();
      // Start the staleness clock fresh; if the open handshake itself stalls,
      // the watchdog will close us out within WS_STALE_MS.
      this.lastWsEventAt = openedAt;

      // Outbound ping keeps NAT/proxy/Polymarket from idle-killing the socket
      // during quiet periods (no book updates). Pong is auto-handled by `ws`.
      const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* ignore — close handler runs cleanup */ }
        }
      }, WS_PING_INTERVAL_MS);

      // Watchdog: detect zombie connections (TCP open, no data flowing).
      // Polymarket WS normally produces ≥1 message every few seconds across
      // all subscribed tokens; WS_STALE_MS of total silence almost always
      // means the connection is dead. Force-close to break out of the
      // resolve-on-close pattern so wsLoop reconnects.
      const watchdog = setInterval(() => {
        if (this.ws !== ws) return;             // we've been superseded
        const idle = Date.now() - this.lastWsEventAt;
        if (idle > WS_STALE_MS) {
          log('warn', 'Polymarket WS stale — forcing reconnect', {
            idleMs: idle, tokens: this.subscribedTokens.size,
          });
          try { ws.terminate(); } catch { /* ignore */ }
        }
      }, WS_WATCHDOG_TICK_MS);

      // Proactive rotation: terminate before Polymarket's ~15min server-side
      // silent timeout so we never enter the 60s "zombie" window. Reconnect
      // happens cleanly within ~750ms vs ~62s of frozen FE prices otherwise.
      const rotateTimer = setTimeout(() => {
        if (this.ws !== ws) return;             // already superseded
        log('info', 'Polymarket WS proactive rotate', {
          ageMs: Date.now() - openedAt,
          tokens: this.subscribedTokens.size,
        });
        try { ws.terminate(); } catch { /* ignore */ }
      }, WS_ROTATE_MS);

      ws.on('open', () => {
        log('info', 'Polymarket WS open', { tokens: this.subscribedTokens.size });
        this.lastWsEventAt = Date.now();
        const assets = Array.from(this.subscribedTokens);
        if (assets.length > 0) {
          ws.send(JSON.stringify({ type: 'market', assets_ids: assets }));
        }
        // Force-refresh ALL token books via REST on every WS open. Polymarket
        // WS subscribe does not replay book events for inactive tokens (verified
        // against prod DB), so without this, tokens seeded once at market open
        // with placeholder 49/50, 50/51 stay stale across every 15-min
        // reconnect. The force=true overwrites cached state.
        for (const t of this.subscribedTokens) {
          void this.seedInitialBook(t, true);
        }
      });

      // Intentionally NOT updating lastWsEventAt on pong. Polymarket's WS
      // sometimes goes silent on real DATA (book/price_change) for minutes
      // before closing, while still auto-responding to our pings — pong-as-
      // alive made the watchdog blind to those silent stretches. Verified
      // 209s + 175s data gaps in prod despite no watchdog firings. Now only
      // real exchange messages reset the staleness clock; if Polymarket stops
      // sending data for WS_STALE_MS, we terminate and reconnect to recover
      // the FE display.
      // ws.on('pong', () => { /* noop — see above */ });

      ws.on('message', (data) => this.handleWsMessage(data.toString()));

      ws.on('close', () => {
        log('warn', 'Polymarket WS closed');
        clearInterval(pingTimer);
        clearInterval(watchdog);
        clearTimeout(rotateTimer);
        if (this.ws === ws) this.ws = null;
        this.emit('disconnect');
        resolve();
      });

      ws.on('error', (err: Error) => {
        log('warn', 'Polymarket WS error', { error: err.message });
        // close fires after error; cleanup happens there
      });
    });
  }

  private handleWsMessage(raw: string): void {
    // Any incoming message — even if it's an unknown type — counts as proof
    // the connection is alive. Update before parsing so the watchdog can't
    // trigger on a parse-error edge case.
    this.lastWsEventAt = Date.now();
    let msgs: unknown;
    try { msgs = JSON.parse(raw); } catch { return; }
    const arr = Array.isArray(msgs) ? msgs : [msgs];
    for (const m of arr) this.processEvent(m as WsMessage);
  }

  private processEvent(m: WsMessage): void {
    const type = m.event_type ?? m.type;

    if (type === 'book') {
      const bids = m.bids ?? [];
      const asks = m.asks ?? [];
      // Polymarket CLOB book: both arrays sorted ascending by price.
      //   Best BID  = highest  = last entry.
      //   Best ASK  = lowest   = first entry in ASCENDING order, but the
      //   feed sometimes arrives DESCENDING. Use min/max directly so we're
      //   robust to either order (verified against price_change ticks).
      const bestBid = bids.length
        ? Math.max(...bids.map(b => Number(b.price))) : null;
      const bestAsk = asks.length
        ? Math.min(...asks.map(a => Number(a.price))) : null;
      const tokenId = m.asset_id ?? '';
      if (tokenId) this.lastTopOfBook.set(tokenId, { bid: bestBid, ask: bestAsk });
      this.record({
        conditionId: m.market ?? '',
        tokenId,
        ts:          Number(m.timestamp ?? Date.now()),
        bestBid,
        bestAsk,
        lastPrice:   null,
        event:       'book',
      });
      return;
    }

    if (type === 'price_change') {
      // price_change bundles per-asset updates. Only record when top-of-book moved.
      const market = m.market ?? '';
      const nowMs  = Date.now();
      for (const pc of (m.price_changes ?? [])) {
        const tokenId = pc.asset_id ?? '';
        if (!tokenId) continue;
        const bb = pc.best_bid != null ? Number(pc.best_bid) : null;
        const ba = pc.best_ask != null ? Number(pc.best_ask) : null;
        const prev = this.lastTopOfBook.get(tokenId);
        if (prev && prev.bid === bb && prev.ask === ba) continue;
        this.lastTopOfBook.set(tokenId, { bid: bb, ask: ba });
        this.record({
          conditionId: market,
          tokenId,
          ts:          nowMs,
          bestBid:     bb,
          bestAsk:     ba,
          lastPrice:   null,
          event:       'price_change',
        });
      }
      return;
    }

    if (type === 'last_trade_price') {
      this.record({
        conditionId: m.market ?? '',
        tokenId:     m.asset_id ?? '',
        ts:          Number(m.timestamp ?? Date.now()),
        bestBid:     null,
        bestAsk:     null,
        lastPrice:   m.price != null ? Number(m.price) : null,
        event:       'last_trade_price',
      });
    }
  }

  // ── Persistence (batched) ────────────────────────────────────────────────

  private record(tick: ShareTick): void {
    this.emit('share_tick', tick);
    this.buf.push(tick);
    if (this.buf.length >= FLUSH_BATCH_MAX) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const batch = this.buf;
    this.buf = [];
    if (!batch.length) return;

    const placeholders: string[] = [];
    const values: unknown[] = [];
    batch.forEach((t, i) => {
      const o = i * 7;
      placeholders.push(`($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7})`);
      values.push(t.conditionId, t.tokenId, t.ts, t.bestBid, t.bestAsk, t.lastPrice, t.event);
    });
    try {
      await this.pool.query(
        `INSERT INTO poly_share_ticks
           (condition_id, token_id, ts, best_bid, best_ask, last_price, event_type)
         VALUES ${placeholders.join(',')}`,
        values,
      );
    } catch (err) {
      log('warn', 'poly_share_ticks batch insert failed', {
        size: batch.length, error: String(err),
      });
    }
  }

  // ── Introspection (for /api/poly/status) ────────────────────────────────

  getActiveMarkets(): PolyClobMarket[] {
    return Array.from(this.activeMarkets.values());
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ── Internal types for gamma + WS payload shapes ───────────────────────────

interface RawLevel { price: string; size: string }

interface GammaEvent {
  slug?:      string;
  startDate?: string;
  endDate?:   string;
  markets?:   Array<{
    conditionId:       string;
    question?:         string;
    clobTokenIds?:     string;          // JSON-stringified [tokenA, tokenB]
    outcomes?:         string | string[];   // e.g. '["Up","Down"]' — index aligns with clobTokenIds
    resolutionSource?: string;
  }>;
}

interface WsMessage {
  event_type?:     string;
  type?:           string;
  market?:         string;
  asset_id?:       string;
  timestamp?:      string | number;
  bids?:           RawLevel[];
  asks?:           RawLevel[];
  price?:          string | number;
  price_changes?:  Array<{
    asset_id?: string;
    best_bid?: string | number;
    best_ask?: string | number;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
