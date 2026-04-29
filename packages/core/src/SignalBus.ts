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

export type SignalBusEvent =
  | SignalT0PlusEvent | SignalT4Event | SignalTMinus3Event | SignalT0Event;

// ── Channel names ──────────────────────────────────────────────────────────

const CHANNEL_T0PLUS = 'signal:T+0';
const CHANNEL_T4     = 'signal:T+4';
const CHANNEL_T3    = 'signal:T-3s';
const CHANNEL_T0     = 'signal:T-0';
const ALL_CHANNELS   = [CHANNEL_T0PLUS, CHANNEL_T4, CHANNEL_T3, CHANNEL_T0] as const;

function channelFor(ev: SignalBusEvent): string {
  switch (ev.type) {
    case 'T+0':   return CHANNEL_T0PLUS;
    case 'T+4':   return CHANNEL_T4;
    case 'T-3s': return CHANNEL_T3;
    case 'T-0':   return CHANNEL_T0;
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
