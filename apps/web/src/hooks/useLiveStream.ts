/**
 * useLiveStream — single SSE connection to backend `/api/poly/stream`.
 *
 * Backend is the source of truth. This hook just renders state pushed by the
 * LiveTradingEngine: BTC price, share prices, current market, signals, orders.
 *
 * Wire format (named events) — see backend src/api/poly-stream.ts.
 *
 * Returns:
 *   {
 *     connected:   boolean,
 *     currentMarket: { conditionId, slug, question, windowStart, windowEnd, tokenUp, tokenDown, resolutionSrc } | null,
 *     upcoming:    same shape array (engine-tracked windows),
 *     btc:         { price, ts } | null,
 *     shares:      Record<tokenId, { bestBid, bestAsk, lastPrice, ts }>,
 *     scan:        { ts, price, vol_spike_z, ob_imbalance, … } | null,
 *     lastOrder:   order row | null   (most recent order broadcast),
 *   }
 */

import { useEffect, useRef, useState } from 'react';

export interface LiveMarket {
  conditionId:   string;
  slug:          string;
  question:      string;
  windowStart:   number;   // unix ms
  windowEnd:     number;
  tokenUp:       string;
  tokenDown:     string;
  resolutionSrc: string;
}

export interface LiveShare {
  bestBid:   number | null;
  bestAsk:   number | null;
  lastPrice: number | null;
  ts:        number;
}

export interface LiveScan {
  ts:               number;
  price:            number;
  volume5s:         number;
  priceChange5s:    number;
  obImbalance:      number;
  volSpikeZ:        number;
}

export interface LiveOrder {
  id:           string;
  market_id:    string;
  ts_entry:     number;
  direction:    'up' | 'down';
  share_price:  number;
  size_usdc:    number;
  mode:         string;
  status:       string;
}

export type LiveSignalPath = 'boundary' | 'dca' | 'panic';

export interface LiveSignal {
  emittedAt:          number;
  /** Strategy path: boundary (next window), dca (average-down), panic (bottom-fish current). */
  path:               LiveSignalPath;
  windowStart:        number;
  windowEnd:          number;
  marketConditionId:  string;
  marketSlug:         string;
  streak:             number;                // signed: + up, − down
  direction:          'up' | 'down';         // contrarian recommendation
  signalMinStreak:    number;
  autoOrderMinStreak: number;
  autoLimitPriceCents: number;
  /** Best ask for the signal direction at emit time. */
  signalSharePrice:   number | null;
  /** TP applied to the auto-placed order (cents). 0 = use global setting. */
  orderTpCents:       number;
  /** SL applied to the auto-placed order (cents). null = no SL (Path B). 0 = global. */
  orderSlCents:       number | null;
  isAuto:             boolean;
  auto?: {
    placed:      boolean;
    orderId?:    string;
    sharePrice?: number;
    sizeUsdc?:   number;
    skipReason?: string;
  };
}

export interface LiveStreamStats {
  /** total events received since connect */
  totalEvents:  number;
  /** events received in the last second (rough rate) */
  eventsPerSec: number;
  /** ms since last event of any type */
  ageMs:        number;
}

// ── Multi-coin worker events (PriceMonitoringWorker → SignalBus → SSE) ─────

export type CoinSymbol = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | 'HYPE' | 'BNB';
export type VolumeBucket = 'low' | 'mid' | 'high' | 'extreme' | 'unknown';

export interface OrderRef {
  orderId:    string;
  direction:  'up' | 'down';
  entryPrice: number;
  sizeUsdc:   number;
  signalPath: 'boundary' | 'dca';
}

/** T+0 — start of window N. Fires only when an active order targets N. */
export interface CoinT0PlusEvent {
  type:        'T+0';
  coin:        CoinSymbol;
  windowStart: number;
  windowEnd:   number;
  order:       OrderRef;
  emittedAt:   number;
}

export interface CoinT4Event {
  type:                'T+4';
  coin:                CoinSymbol;
  windowStart:         number;
  windowEnd:           number;
  streak:              number;
  direction:           'up' | 'down';
  price:               number | null;
  sizeUsdc:            number;
  mode:                'signal_only' | 'signal_and_order';
  pastStreakIcons:     string;
  currentIcon:         string;
  /** Volume bucket per streak candle, oldest → newest. */
  streakVolumeBuckets: VolumeBucket[];
  limitCents:          number;
  emittedAt:           number;
}

export interface CoinT30Event {
  type:        'T-30s';
  coin:        CoinSymbol;
  windowStart: number;
  windowEnd:   number;
  action:      'order_placed' | 'order_skipped' | 'signal_only_mode';
  orderId?:    string;
  direction?:  'up' | 'down';
  price?:      number;
  sizeUsdc?:   number;
  reason?:     string;
  /** 'dca' → 1.5× size after prior boundary loss. */
  signalPath?: 'boundary' | 'dca';
  emittedAt:   number;
}

export interface CoinT0Event {
  type:         'T-0';
  coin:         CoinSymbol;
  windowStart:  number;
  windowEnd:    number;
  outcome:      'up' | 'down' | 'unknown';
  /** Active order that resolved at this window (PnL reported). */
  order?:       OrderRef & { pnlUsdc: number; exitPrice: number };
  /** DCA order placed for N+1 in response to a loss at this window. */
  dca?:         OrderRef;
  /** N+1 outgoing order cancelled because current candle reversed. */
  cancelled?:   OrderRef & { pnlUsdc: number; exitPrice: number };
  emittedAt:    number;
}

/** Latest worker event per phase for one coin. */
export interface CoinEventsEntry {
  t0plus?: CoinT0PlusEvent;
  t4?:     CoinT4Event;
  t30?:    CoinT30Event;
  t0?:     CoinT0Event;
}

const SIGNAL_HISTORY_MAX = 20;

export interface LiveStreamState {
  connected:     boolean;
  currentMarket: LiveMarket | null;
  upcoming:      LiveMarket[];
  btc:           { price: number; ts: number } | null;
  shares:        Record<string, LiveShare>;
  scan:          LiveScan | null;
  lastOrder:     LiveOrder | null;
  lastSignal:    LiveSignal | null;
  /** Session-scoped signal history (newest first, capped). */
  signals:       LiveSignal[];
  /** Latest worker event per phase, keyed by coin. Updated by coin_t4/t30/t0. */
  coinEvents:    Partial<Record<CoinSymbol, CoinEventsEntry>>;
  stats:         LiveStreamStats;
}

const INITIAL: LiveStreamState = {
  connected:     false,
  currentMarket: null,
  upcoming:      [],
  btc:           null,
  shares:        {},
  scan:          null,
  lastOrder:     null,
  lastSignal:    null,
  signals:       [],
  coinEvents:    {},
  stats:         { totalEvents: 0, eventsPerSec: 0, ageMs: 0 },
};

export function useLiveStream(url = '/api/poly/stream'): LiveStreamState {
  const [state, setState] = useState<LiveStreamState>(INITIAL);
  // Refs hold the working copy so handlers can patch without rebuilding deps
  const stateRef = useRef<LiveStreamState>(INITIAL);
  const flushFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    // Sliding-window event counter (last 1s) for rate display
    const eventTimes: number[] = [];
    let totalEvents = 0;

    // Coalesce by browser frame (~16ms @ 60fps). Pass-through latency ≤ 1 frame
    // — the browser caps at one paint per frame anyway, so flushing more often
    // than this is wasted React work.
    const scheduleFlush = (): void => {
      if (flushFrameRef.current != null) return;
      flushFrameRef.current = window.requestAnimationFrame(() => {
        flushFrameRef.current = null;
        const now = Date.now();
        while (eventTimes.length && eventTimes[0]! < now - 1000) eventTimes.shift();
        const ageMs = eventTimes.length ? now - eventTimes[eventTimes.length - 1]! : 0;
        setState({
          ...stateRef.current,
          shares: { ...stateRef.current.shares },
          stats:  { totalEvents, eventsPerSec: eventTimes.length, ageMs },
        });
      });
    };

    const tickStat = (): void => {
      totalEvents++;
      eventTimes.push(Date.now());
    };

    const patch = (delta: Partial<LiveStreamState>): void => {
      stateRef.current = { ...stateRef.current, ...delta };
      scheduleFlush();
    };

    function connect(): void {
      if (cancelled) return;
      es = new EventSource(url);

      es.onopen = () => patch({ connected: true });
      es.onerror = () => {
        // EventSource reconnects automatically; surface "disconnected" until next open.
        patch({ connected: false });
      };

      es.addEventListener('snapshot', (ev) => {
        try {
          const snap = JSON.parse((ev as MessageEvent).data);
          const lastSignal = (snap.lastSignal ?? null) as LiveSignal | null;
          stateRef.current = {
            ...stateRef.current,
            currentMarket: snap.currentMarket
              ? normalizeMarket(snap.currentMarket)
              : null,
            upcoming: Array.isArray(snap.upcoming)
              ? snap.upcoming.map(normalizeMarket)
              : [],
            shares:     snap.shares ?? {},
            btc:        snap.btc ?? null,
            scan:       snap.scan ? normalizeScan(snap.scan) : null,
            lastSignal,
            // Seed history with the current signal (if any) so the panel isn't empty
            // right after page load.
            signals:    lastSignal && stateRef.current.signals.length === 0
              ? [lastSignal]
              : stateRef.current.signals,
          };
          scheduleFlush();
        } catch (err) { console.warn('snapshot parse', err); }
      });

      es.addEventListener('btc', (ev) => {
        try {
          const t = JSON.parse((ev as MessageEvent).data);
          stateRef.current = { ...stateRef.current, btc: { price: Number(t.price), ts: Number(t.ts) } };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('share', (ev) => {
        try {
          const s = JSON.parse((ev as MessageEvent).data);
          if (!s.tokenId) return;
          stateRef.current = {
            ...stateRef.current,
            shares: {
              ...stateRef.current.shares,
              [s.tokenId]: {
                bestBid:   s.bestBid   ?? null,
                bestAsk:   s.bestAsk   ?? null,
                lastPrice: s.lastPrice ?? null,
                ts:        Number(s.ts ?? Date.now()),
              },
            },
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('current', (ev) => {
        try {
          const m = JSON.parse((ev as MessageEvent).data);
          stateRef.current = {
            ...stateRef.current,
            currentMarket: m ? normalizeMarket(m) : null,
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('market', (ev) => {
        try {
          const m = normalizeMarket(JSON.parse((ev as MessageEvent).data));
          const upc = stateRef.current.upcoming;
          const filtered = upc.filter(x => x.conditionId !== m.conditionId);
          stateRef.current = {
            ...stateRef.current,
            upcoming: [...filtered, m].sort((a, b) => a.windowStart - b.windowStart),
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('scan5s', (ev) => {
        try {
          const t = normalizeScan(JSON.parse((ev as MessageEvent).data));
          stateRef.current = { ...stateRef.current, scan: t };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('order', (ev) => {
        try {
          const o = JSON.parse((ev as MessageEvent).data) as LiveOrder;
          stateRef.current = { ...stateRef.current, lastOrder: o };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('signal', (ev) => {
        try {
          const s = JSON.parse((ev as MessageEvent).data) as LiveSignal;
          // Dedup on (emittedAt, marketConditionId) so server retries don't inflate history
          const exists = stateRef.current.signals.some(
            prev => prev.emittedAt === s.emittedAt && prev.marketConditionId === s.marketConditionId,
          );
          stateRef.current = {
            ...stateRef.current,
            lastSignal: s,
            signals: exists
              ? stateRef.current.signals
              : [s, ...stateRef.current.signals].slice(0, SIGNAL_HISTORY_MAX),
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      // Multi-coin worker events
      es.addEventListener('coin_t0plus', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as CoinT0PlusEvent;
          const prev = stateRef.current.coinEvents[e.coin] ?? {};
          stateRef.current = {
            ...stateRef.current,
            coinEvents: { ...stateRef.current.coinEvents, [e.coin]: { ...prev, t0plus: e } },
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('coin_t4', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as CoinT4Event;
          const prev = stateRef.current.coinEvents[e.coin] ?? {};
          stateRef.current = {
            ...stateRef.current,
            coinEvents: { ...stateRef.current.coinEvents, [e.coin]: { ...prev, t4: e } },
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('coin_t30', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as CoinT30Event;
          const prev = stateRef.current.coinEvents[e.coin] ?? {};
          stateRef.current = {
            ...stateRef.current,
            coinEvents: { ...stateRef.current.coinEvents, [e.coin]: { ...prev, t30: e } },
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      es.addEventListener('coin_t0', (ev) => {
        try {
          const e = JSON.parse((ev as MessageEvent).data) as CoinT0Event;
          const prev = stateRef.current.coinEvents[e.coin] ?? {};
          stateRef.current = {
            ...stateRef.current,
            coinEvents: { ...stateRef.current.coinEvents, [e.coin]: { ...prev, t0: e } },
          };
          tickStat();
          scheduleFlush();
        } catch { /* ignore */ }
      });

      // 'spike' and 'ping' — currently no UI consumer; accept silently
    }

    connect();

    return () => {
      cancelled = true;
      if (flushFrameRef.current != null) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      es?.close();
    };
  }, [url]);

  return state;
}

// ── Normalizers ────────────────────────────────────────────────────────────
// Engine emits camelCase + numeric ms; some payloads may arrive serialized
// differently — be tolerant.

function normalizeMarket(m: any): LiveMarket {
  return {
    conditionId:   String(m.conditionId   ?? m.condition_id   ?? ''),
    slug:          String(m.slug          ?? ''),
    question:      String(m.question      ?? ''),
    windowStart:   Number(m.windowStart   ?? m.window_start   ?? 0),
    windowEnd:     Number(m.windowEnd     ?? m.window_end     ?? 0),
    tokenUp:       String(m.tokenUp       ?? m.token_up       ?? ''),
    tokenDown:     String(m.tokenDown     ?? m.token_down     ?? ''),
    resolutionSrc: String(m.resolutionSrc ?? m.resolution_src ?? ''),
  };
}

function normalizeScan(t: any): LiveScan {
  return {
    ts:            Number(t.ts ?? 0),
    price:         Number(t.price ?? 0),
    volume5s:      Number(t.volume5s ?? t.volume_5s ?? 0),
    priceChange5s: Number(t.priceChange5s ?? t.price_change_5s ?? 0),
    obImbalance:   Number(t.obImbalance ?? t.ob_imbalance ?? 0),
    volSpikeZ:     Number(t.volSpikeZ ?? t.vol_spike_z ?? 0),
  };
}
