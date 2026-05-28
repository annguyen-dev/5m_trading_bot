/**
 * src/services/SignalBus.ts
 *
 * Redis pub/sub wrapper — the decoupling layer between PriceMonitoringWorker
 * (publisher) and the API server (subscriber → SSE + Telegram).
 *
 * Channels:
 *   signal:T+0     — window-start: notify if there's an active order targeting this window
 *   signal:T+4     — streak-based signal emitted at T+4m of a window
 *   signal:T-3s   — order placement check/result at T-3s (target = N+1)
 *   signal:T-0     — window-end: PnL of resolving order + DCA fire OR cancel of N+1
 *
 * Event payloads are JSON. Consumers use onSignal(type, handler) with type
 * narrowed by the discriminated union SignalBusEvent.
 *
 * Emission policy: T+0 and T-0 fire CONDITIONALLY (only when there's something
 * to report — active order, DCA fired, or cancellation). They do NOT fire on
 * "no-op" cases (no order + nothing happening), to avoid spamming Telegram.
 */
import { Redis } from 'ioredis';
import { log } from './observability/logger.js';
import type { CoinSymbol } from './CoinConfig.js';

// ── Event types ────────────────────────────────────────────────────────────

export type VolumeBucket = 'low' | 'mid' | 'high' | 'extreme' | 'unknown';

/** Snapshot of an order for inclusion in lifecycle events. */
export interface OrderRef {
  orderId:     string;
  direction:   'up' | 'down';
  entryPrice:  number;
  sizeUsdc:    number;
  signalPath:  'boundary' | 'dca';
}

/**
 * T+0 — start of window N. Fires ONLY when there's an active (pending) auto
 * order targeting N (placed at T-3s of N-1). "Active order is now live."
 */
export interface SignalT0PlusEvent {
  type:         'T+0';
  coin:         CoinSymbol;
  windowStart:  number;
  windowEnd:    number;
  order:        OrderRef;
  emittedAt:    number;
}

export interface SignalT4Event {
  type:          'T+4';
  coin:          CoinSymbol;
  windowStart:   number;
  windowEnd:     number;
  streak:        number;          // signed
  direction:     'up' | 'down';   // contrarian vs streak
  /** Best ask of the contrarian-side token at emission time. */
  price:         number | null;
  sizeUsdc:      number;
  mode:          'signal_only' | 'signal_and_order';
  /** Icons for the past streak windows (🟢 / 🔴), oldest → newest. */
  pastStreakIcons: string;
  /** Icon for in-progress candle (🟢 / 🔴 / ⚪ if neutral). */
  currentIcon:   string;
  /** Volume bucket per streak candle, oldest → newest, length = |streak|. */
  streakVolumeBuckets: VolumeBucket[];
  /** True if at least 1 streak bar's body > 1.5× the 48-bar avg body.
   *  Used by echo's optional require-high-body gate (V9 from analysis). */
  bodyHasHigh?:  boolean;
  /** True if at least 1 streak bar's body < 0.5× avg (informational). */
  bodyHasTiny?:  boolean;
  /** Mean body ratio across streak bars. Drives edge case A1 (idle override). */
  meanBodyRatio?: number;
  /** True if any streak bar's body > 4× avg (extreme climax candle).
   *  Drives edge case A3 (idle override). */
  bodyHasVeryExtreme?: boolean;
  /**
   * Sum of |close − open| over the LAST 3 closed bars (price USD). Drives
   * the body-conditioned entry gate (CoinConfig.idle_body3_min /
   * armed_body3_min). 0 if fewer than 3 bars loaded.
   */
  body3Sum?:     number;
  limitCents:    number;
  emittedAt:     number;
}

export interface SignalTMinus3Event {
  type:          'T-3s';
  coin:          CoinSymbol;
  windowStart:   number;
  windowEnd:     number;
  action:        'order_placed' | 'order_skipped' | 'signal_only_mode';
  orderId?:      string;
  clobOrderId?:  string;
  direction?:    'up' | 'down';
  price?:        number;
  sizeUsdc?:     number;
  reason?:       string;     // e.g. "ask 60¢ > limit 54¢"
  /** 'boundary' = normal contrarian entry; 'dca' = previous_size × dca_multiplier after a prior loss. */
  signalPath?:   'boundary' | 'dca';
  /** Signed streak at the placement decision (from the cached T+4). */
  streak?:       number;
  /** Streak-window icons (🟢/🔴), oldest→newest, from the cached T+4. */
  pastStreakIcons?: string;
  /** In-progress candle icon at decision time. */
  currentIcon?:  string;
  /** body3 sum (price USD) used by the body gate at the placement decision. */
  body3Sum?:     number;
  /** Which gate matched: 'idle' | 'armed' | edge-case label (e.g. 'streak4'). */
  matchCase?:    string;
  /** True if this placement was retried at T-0 of N (after T-3s failed gates). */
  lateRetry?:    boolean;
  /**
   * Adaptive threshold context. Present whenever the threshold gate is
   * evaluated (both order_placed and order_skipped). Lets UI / Telegram
   * explain why the effective threshold differs from the base config.
   */
  adaptive?: {
    base:      number;          // cfg.auto_order_min_streak
    threshold: number;          // effective threshold used for the gate
    mode:      'aggressive' | 'conservative' | 'default';
    reason:    string;          // human-readable trigger explanation
  };
  emittedAt:     number;
}

/**
 * T-0 — end of window N. Fires ONLY when something actionable happened:
 *   - `order` set: an active order resolved here (PnL reported)
 *   - `dca` set: a DCA was placed for N+1 in response to this window's loss
 *   - `cancelled` set: the N+1 outgoing order was cancelled (current reversed)
 * If none of the above, no T-0 event is published (avoids notification spam).
 */
export interface SignalT0Event {
  type:          'T-0';
  coin:          CoinSymbol;
  windowStart:   number;
  windowEnd:     number;
  outcome:       'up' | 'down' | 'unknown';
  /** The order that just resolved at this window (incoming, targeting N). */
  order?:        OrderRef & { pnlUsdc: number; exitPrice: number };
  /** A DCA order placed for N+1 in response to a loss at this window. */
  dca?:          OrderRef;
  /** The N+1 outgoing order we cancelled because current candle reversed. */
  cancelled?:    OrderRef & { pnlUsdc: number; exitPrice: number };
  emittedAt:     number;
}

/**
 * Stats over inter-event gaps between consecutive extreme streaks observed in
 * the backfill window. Used by the FE to calibrate `echo_defensive_overdue_minutes`
 * (e.g. setting overdue ≈ p90 means defensive only fires when the gap is in the
 * worst 10% of historical gaps). All durations in ms; FE picks display unit.
 */
export interface DefensiveGapStats {
  /** Number of inter-event gaps measured (= events - 1). */
  count:  number;
  p10Ms:  number;
  p50Ms:  number;
  p90Ms:  number;
  maxMs:  number;
  meanMs: number;
}

/**
 * Echo Hunt arm-window state. Published by PMW whenever the state transitions
 * (idle → armed, armed → expired, or arm refreshed by a fresh trigger). NOT
 * emitted on every tick — only on changes — so the channel stays quiet
 * (~1-2 events per coin per arm cycle, vs hundreds of T+4/T-3s).
 */
export interface SignalEchoStateEvent {
  type:           'echo_state';
  coin:           CoinSymbol;
  /** true when now ≤ armEndAt (in arm window). */
  armed:          boolean;
  /** ms timestamp of the most recent trigger (run end ≥ echo_trigger_streak). */
  lastTriggerAt:  number | null;
  /** ms timestamp when arm window expires (= lastTriggerAt + window_minutes×60s). */
  armEndAt:       number | null;
  // Threshold context — included so the FE can show the live state without
  // re-fetching coin_configs. All three are streak length values.
  /** Current effective placement threshold (= armedThreshold if armed, else baselineThreshold). */
  threshold:        number;
  /** echo_baseline_streak (idle threshold). */
  baselineThreshold: number;
  /** echo_signal_min_streak (armed threshold). */
  armedThreshold:   number;
  /** echo_trigger_streak. */
  triggerThreshold: number;
  // ── Defensive layer state ──────────────────────────────────────────────
  /** Whether the defensive layer is enabled in cfg. */
  defensiveEnabled: boolean;
  /** Whether bot is CURRENTLY in defensive mode. */
  defensiveActive:  boolean;
  /** Action taken when defensive: 'disable_armed' or 'skip_all'. */
  defensiveAction:  'disable_armed' | 'skip_all';
  /** ms timestamp of last extreme streak observed (≥ defensive threshold).
   *  null = never observed (treated as overdue). */
  lastExtremeStreakAt: number | null;
  /** ms timestamp when defensive will activate (= lastExtremeStreakAt +
   *  overdue_minutes × 60_000). null when lastExtremeStreakAt is null. */
  defensiveActivatesAt: number | null;
  /** Streak threshold that resets the defensive timer. */
  defensiveStreakThreshold: number;
  /** Configured overdue duration (minutes) for defensive activation. Mirrors
   *  `cfg.echo_defensive_overdue_minutes` so FE doesn't have to fetch the
   *  config separately. */
  defensiveOverdueMinutes: number;
  /** Inter-event gap percentiles from the 30-day backfill at startup. null
   *  when the backfill saw fewer than 2 extreme events (no gaps to measure). */
  defensiveGapStats: DefensiveGapStats | null;

  // ── Chain predictive defensive state ──────────────────────────────────
  /** Whether chain predictive defensive is enabled in config. */
  chainEnabled:               boolean;
  /** Whether defensive is CURRENTLY active (gap > overdue OR never observed). */
  chainActive:                boolean;
  /** ms timestamp of last chain event (≥N arms in window). null = never. */
  chainLastEventAt:           number | null;
  /** Minutes since last chain event (informational; null when never). */
  chainGapMinutes:            number | null;
  /** Live arm count in current event window (counts toward next chain event). */
  chainArmsInWindow:          number;
  /** Mirrors cfg: how many arms in window define a chain event. */
  chainEventArmCount:         number;
  /** Mirrors cfg: event window length (minutes). */
  chainEventWindowMinutes:    number;
  /** Mirrors cfg: gap that triggers defensive (minutes). */
  chainOverdueMinutes:        number;
  /** ms timestamp when defensive activates (null when already active or never). */
  chainActivatesAt:           number | null;
  /** Effective threshold delta currently applied (0 when inactive). */
  chainSignalBumpApplied:     number;
  chainBaselineBumpApplied:   number;

  emittedAt:      number;
}

/**
 * Data quality alert: Binance close-vs-open disagreed with Polymarket
 * resolution for a specific 5m window. Bot uses Poly truth (commit 1769269)
 * for streak detection, but the disagreement may surprise users who expect
 * streak to match the chart visual. Telegram-routable so user is informed
 * the moment a mismatch shifts streak interpretation.
 *
 * Emitted ONCE per (coin, windowStart) pair to avoid spam on retries.
 */
export interface SignalStreakDataMismatchEvent {
  type:               'streak_data_mismatch';
  coin:               CoinSymbol;
  /** The 5m window where Binance and Poly disagree. */
  windowStart:        number;
  windowEnd:          number;
  /** Binance close-vs-open verdict for this bar. */
  binanceDirection:   'up' | 'down';
  /** Polymarket midpoint-at-T-0 / cached resolution for this bar. */
  polyDirection:      'up' | 'down';
  /** Binance bar's close-open as % of open (positive = up move). Tiny
   *  values (< 0.05%) flag near-flat bars where small price-feed differences
   *  inherently can yield different binary verdicts. */
  binanceMovePct:     number;
  /** Streak the bot would have seen with Binance-only logic. */
  binanceStreak:      number;
  /** Streak the bot actually used (Poly truth). */
  effectiveStreak:    number;
  emittedAt:          number;
}

export type SignalBusEvent =
  | SignalT0PlusEvent | SignalT4Event | SignalTMinus3Event | SignalT0Event
  | SignalEchoStateEvent | SignalStreakDataMismatchEvent;

// ── Channel names ──────────────────────────────────────────────────────────

const CHANNEL_T0PLUS    = 'signal:T+0';
const CHANNEL_T4        = 'signal:T+4';
const CHANNEL_T3        = 'signal:T-3s';
const CHANNEL_T0        = 'signal:T-0';
const CHANNEL_ECHO      = 'signal:echo_state';
const CHANNEL_MISMATCH  = 'signal:streak_data_mismatch';
const ALL_CHANNELS      = [CHANNEL_T0PLUS, CHANNEL_T4, CHANNEL_T3, CHANNEL_T0, CHANNEL_ECHO, CHANNEL_MISMATCH] as const;

function channelFor(ev: SignalBusEvent): string {
  switch (ev.type) {
    case 'T+0':        return CHANNEL_T0PLUS;
    case 'T+4':        return CHANNEL_T4;
    case 'T-3s':       return CHANNEL_T3;
    case 'T-0':        return CHANNEL_T0;
    case 'echo_state': return CHANNEL_ECHO;
    case 'streak_data_mismatch': return CHANNEL_MISMATCH;
  }
}

// ── SignalBus ──────────────────────────────────────────────────────────────

export class SignalBus {
  private pub: Redis;
  private sub: Redis;
  private handlers: Set<(ev: SignalBusEvent) => void> = new Set();
  private connected = false;

  constructor(private readonly url: string) {
    // Dual clients: ioredis requires separate connections for pub and sub.
    this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }

  async start(): Promise<void> {
    if (this.connected) return;
    await this.pub.connect();
    await this.sub.connect();
    await this.sub.subscribe(...ALL_CHANNELS);
    this.sub.on('message', (_channel: string, raw: string) => {
      let ev: SignalBusEvent;
      try { ev = JSON.parse(raw) as SignalBusEvent; }
      catch { return; }
      for (const h of this.handlers) {
        try { h(ev); } catch (err) {
          log('warn', 'SignalBus handler threw', { error: String(err) });
        }
      }
    });
    this.connected = true;
    log('info', 'SignalBus connected', { url: this.url, channels: ALL_CHANNELS });
  }

  async stop(): Promise<void> {
    if (!this.connected) return;
    await this.sub.unsubscribe(...ALL_CHANNELS);
    await this.sub.quit();
    await this.pub.quit();
    this.connected = false;
  }

  async publish<T extends SignalBusEvent = SignalBusEvent>(event: T): Promise<void> {
    if (!this.connected) throw new Error('SignalBus not started');
    await this.pub.publish(channelFor(event), JSON.stringify(event));
  }

  onSignal(handler: (ev: SignalBusEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let instance: SignalBus | null = null;

export function getSignalBus(): SignalBus {
  if (!instance) {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    instance = new SignalBus(url);
  }
  return instance;
}
