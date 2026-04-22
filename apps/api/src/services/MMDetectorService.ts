import { Trade, OrderBookSnapshot, CVDState } from '../types/market.js';
import { MMTrapResult } from '../types/mm.js';
import { getTrapCounter } from '../observability/metrics.js';
import { log } from '../observability/logger.js';
import { getTracer } from '../observability/tracing.js';

// ── Thresholds ────────────────────────────────────────────────────────────
const CVD_WINDOW_SIZE = 20;      // CVDState snapshots for divergence analysis
const CVD_DIVERGENCE_THRESHOLD = 0.30; // 30% divergence → trap

const FREQ_WINDOW_SIZE = 50;     // trades for mechanical pattern detection
const CV_THRESHOLD = 0.05;       // coefficient of variation < 5% = suspicious

const SPOOF_SIZE_BTC = 5;        // minimum order size to track (BTC)
const SPOOF_WINDOW_MS = 500;     // order must disappear within this window

interface WickSample {
  timestamp: number;
  amount: number;
  intervalMs: number;
}

interface PendingOrder {
  price: number;
  size: number;
  side: 'bid' | 'ask';
  firstSeen: number;
}

export class MMDetectorService {
  private trapCounter = getTrapCounter();
  private tracer = getTracer('MMDetectorService');

  // CVD divergence state
  private cvdHistory: CVDState[] = [];

  // Frequency analysis state
  private wickSamples: WickSample[] = [];
  private lastTradeTs = 0;

  // Spoofing state
  private lastObSnapshot: OrderBookSnapshot | null = null;
  private pendingLargeOrders = new Map<string, PendingOrder>();

  // ── 1. CVD Divergence ──────────────────────────────────────────────────

  analyzeCVD(state: CVDState): MMTrapResult {
    this.cvdHistory.push(state);
    if (this.cvdHistory.length > CVD_WINDOW_SIZE) this.cvdHistory.shift();
    if (this.cvdHistory.length < CVD_WINDOW_SIZE) {
      return { detected: false, type: 'NONE', detail: '' };
    }

    const first = this.cvdHistory[0];
    const last = this.cvdHistory[this.cvdHistory.length - 1];

    const priceChange = last.price - first.price;
    const cvdChange = last.cvd - first.cvd;

    // Divergence: price going up but CVD going down (or vice versa)
    const diverging = (priceChange > 0 && cvdChange < 0) || (priceChange < 0 && cvdChange > 0);
    if (!diverging) return { detected: false, type: 'NONE', detail: '' };

    const priceChangePct = Math.abs(priceChange / first.price);
    const cvdChangePct =
      first.cvd !== 0 ? Math.abs(cvdChange / Math.abs(first.cvd)) : 1;

    // Only flag if both price and CVD moved meaningfully
    const divergenceRate = Math.min(priceChangePct, cvdChangePct);
    if (divergenceRate < CVD_DIVERGENCE_THRESHOLD) {
      return { detected: false, type: 'NONE', detail: '' };
    }

    const type = priceChange > 0 ? 'BULL_TRAP' : 'BEAR_TRAP';
    this.trapCounter.add(1, { type });
    log('warn', 'CVD trap detected', { type, divergenceRate: divergenceRate.toFixed(3) });

    return {
      detected: true,
      type,
      detail: `CVD divergence ${(divergenceRate * 100).toFixed(1)}% over last ${CVD_WINDOW_SIZE} snapshots`,
    };
  }

  // ── 2. Mechanical Pattern / Frequency Filter ──────────────────────────

  analyzeTrade(trade: Trade): MMTrapResult {
    const intervalMs = this.lastTradeTs > 0 ? trade.timestamp - this.lastTradeTs : 0;
    this.lastTradeTs = trade.timestamp;

    this.wickSamples.push({ timestamp: trade.timestamp, amount: trade.amount, intervalMs });
    if (this.wickSamples.length > FREQ_WINDOW_SIZE) this.wickSamples.shift();
    if (this.wickSamples.length < FREQ_WINDOW_SIZE) {
      return { detected: false, type: 'NONE', detail: '' };
    }

    const amounts = this.wickSamples.map(s => s.amount);
    const intervals = this.wickSamples.map(s => s.intervalMs).filter(i => i > 0);

    const amountCV = coefficientOfVariation(amounts);
    const intervalCV = coefficientOfVariation(intervals);

    if (amountCV < CV_THRESHOLD && intervalCV < CV_THRESHOLD) {
      this.trapCounter.add(1, { type: 'MM_BOT' });
      log('warn', 'MM bot activity detected', {
        amountCV: amountCV.toFixed(4),
        intervalCV: intervalCV.toFixed(4),
      });
      return {
        detected: true,
        type: 'MM_BOT',
        detail: `Mechanical pattern — amount CV=${amountCV.toFixed(4)}, interval CV=${intervalCV.toFixed(4)}`,
      };
    }
    return { detected: false, type: 'NONE', detail: '' };
  }

  // ── 3. Spoofing Detection ─────────────────────────────────────────────

  analyzeOrderBook(snap: OrderBookSnapshot, recentTrades: Trade[]): MMTrapResult {
    const prev = this.lastObSnapshot;
    this.lastObSnapshot = snap;
    if (!prev) return { detected: false, type: 'NONE', detail: '' };

    const now = snap.timestamp;

    // Check large bid orders that vanished
    for (const [price, size] of prev.bids) {
      if (size < SPOOF_SIZE_BTC) continue;
      const key = `bid:${price}`;
      const stillPresent = snap.bids.some(([p]) => Math.abs(p - price) < 0.01);
      if (stillPresent) continue;

      const consumed = recentTrades.some(
        t => t.side === 'sell' && Math.abs(t.price - price) < 1 && t.amount >= size * 0.5,
      );
      if (consumed) continue;

      const pending = this.pendingLargeOrders.get(key);
      if (!pending) {
        this.pendingLargeOrders.set(key, { price, size, side: 'bid', firstSeen: now });
      } else if (now - pending.firstSeen < SPOOF_WINDOW_MS) {
        this.pendingLargeOrders.delete(key);
        this.trapCounter.add(1, { type: 'SPOOF' });
        const detail = `Large bid ${size} BTC @ ${price} vanished in ${now - pending.firstSeen}ms unfilled`;
        log('warn', 'Spoofing detected', { detail });
        return { detected: true, type: 'SPOOF', detail };
      }
    }

    // Check large ask orders that vanished
    for (const [price, size] of prev.asks) {
      if (size < SPOOF_SIZE_BTC) continue;
      const key = `ask:${price}`;
      const stillPresent = snap.asks.some(([p]) => Math.abs(p - price) < 0.01);
      if (stillPresent) continue;

      const consumed = recentTrades.some(
        t => t.side === 'buy' && Math.abs(t.price - price) < 1 && t.amount >= size * 0.5,
      );
      if (consumed) continue;

      const pending = this.pendingLargeOrders.get(key);
      if (!pending) {
        this.pendingLargeOrders.set(key, { price, size, side: 'ask', firstSeen: now });
      } else if (now - pending.firstSeen < SPOOF_WINDOW_MS) {
        this.pendingLargeOrders.delete(key);
        this.trapCounter.add(1, { type: 'SPOOF' });
        const detail = `Large ask ${size} BTC @ ${price} vanished in ${now - pending.firstSeen}ms unfilled`;
        log('warn', 'Spoofing detected', { detail });
        return { detected: true, type: 'SPOOF', detail };
      }
    }

    // Prune stale pending entries
    for (const [key, order] of this.pendingLargeOrders) {
      if (now - order.firstSeen > SPOOF_WINDOW_MS * 6) {
        this.pendingLargeOrders.delete(key);
      }
    }

    return { detected: false, type: 'NONE', detail: '' };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}
