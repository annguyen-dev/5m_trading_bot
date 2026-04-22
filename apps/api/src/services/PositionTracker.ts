/**
 * PositionTracker — monitors open positions for TP/SL hits using the live price feed.
 *
 * Works in both paper and live modes:
 *   - Paper: pure in-memory simulation, results written to positions.jsonl
 *   - Live:  same tracking for dashboard/stats; actual orders are on the exchange
 *
 * Each closed position is appended to ./data/positions.jsonl for the dashboard.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { Signal } from '../types/signal.js';
import { log } from '../observability/logger.js';

// Eval window per horizon before we force-close a position (same as backtest)
const EVAL_WINDOW_MS: Record<string, number> = {
  scale: 5   * 60_000,
  short: 30  * 60_000,
  mid:   4_320 * 60_000,   // 3 days
  long:  43_200 * 60_000,  // 30 days
};

// Default TP/SL ratios when signal doesn't carry them
const TP_RATIO: Record<string, number> = { scale: 0.003, short: 0.008, mid: 0.020, long: 0.050 };
const SL_RATIO: Record<string, number> = { scale: 0.0015, short: 0.004, mid: 0.010, long: 0.025 };

export interface OpenPosition {
  signalId:     string;
  signal:       Signal;
  entryPrice:   number;
  tp:           number;
  sl:           number;
  openedAt:     number;   // unix ms
  evalDeadline: number;   // unix ms
}

export interface ClosedPosition {
  signalId:   string;
  signal:     Signal;
  entryPrice: number;
  exitPrice:  number;
  exitReason: 'tp' | 'sl' | 'timeout';
  pnlPct:     number;   // signed: positive = profit
  openedAt:   number;
  closedAt:   number;
}

export interface PositionStats {
  openCount:    number;
  closedCount:  number;
  winRate:      number;   // tp-hit / (tp + sl)
  avgPnlPct:    number;   // average pnl across all closed
  totalPnlPct:  number;   // sum of all pnl (compound proxy)
  byHorizon:    Record<string, { wins: number; losses: number; avgPnl: number }>;
}

export class PositionTracker extends EventEmitter {
  private open   = new Map<string, OpenPosition>();
  private closed: ClosedPosition[] = [];
  private stream: fs.WriteStream | null = null;

  constructor(private readonly dataDir = './data') {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.stream = fs.createWriteStream(
      path.join(dataDir, 'positions.jsonl'), { flags: 'a' },
    );
    this.stream.on('error', err =>
      log('error', 'PositionTracker write error', { error: String(err) }),
    );
  }

  // ── Open ────────────────────────────────────────────────────────────────────

  openPosition(signal: Signal, entryPrice: number): OpenPosition | null {
    if (signal.direction === 'HOLD') return null;

    const isBuy   = signal.direction === 'BUY';
    const horizon = signal.horizon;
    const tpR     = TP_RATIO[horizon] ?? TP_RATIO['mid']!;
    const slR     = SL_RATIO[horizon] ?? SL_RATIO['mid']!;

    const tp = signal.priceTarget
      ?? (isBuy ? entryPrice * (1 + tpR) : entryPrice * (1 - tpR));
    const sl = signal.stopLoss
      ?? (isBuy ? entryPrice * (1 - slR) : entryPrice * (1 + slR));

    const pos: OpenPosition = {
      signalId:     signal.id,
      signal,
      entryPrice,
      tp,
      sl,
      openedAt:     Date.now(),
      evalDeadline: Date.now() + (EVAL_WINDOW_MS[horizon] ?? EVAL_WINDOW_MS['mid']!),
    };

    this.open.set(signal.id, pos);

    log('info', 'Position opened', {
      id:        signal.id,
      direction: signal.direction,
      horizon,
      entry:     entryPrice.toFixed(2),
      tp:        tp.toFixed(2),
      sl:        sl.toFixed(2),
    });

    return pos;
  }

  // ── Price tick ──────────────────────────────────────────────────────────────

  /**
   * Called on every trade / price update.
   * Checks all open positions for TP/SL hit or deadline expiry.
   */
  onPrice(price: number, timestamp = Date.now()): ClosedPosition[] {
    const justClosed: ClosedPosition[] = [];

    for (const [id, pos] of this.open) {
      const isBuy = pos.signal.direction === 'BUY';

      const tpHit = isBuy ? price >= pos.tp : price <= pos.tp;
      const slHit = isBuy ? price <= pos.sl : price >= pos.sl;

      // Conservative: if both hit in same tick, assume SL first (e.g. flash spike)
      let exitReason: 'tp' | 'sl' | 'timeout' | null = null;
      let exitPrice = price;

      if (slHit) {
        exitReason = 'sl';
        exitPrice  = pos.sl;
      } else if (tpHit) {
        exitReason = 'tp';
        exitPrice  = pos.tp;
      } else if (timestamp >= pos.evalDeadline) {
        exitReason = 'timeout';
        exitPrice  = price;
      }

      if (!exitReason) continue;

      const pnlPct = isBuy
        ? (exitPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - exitPrice) / pos.entryPrice;

      const closed: ClosedPosition = {
        signalId: id,
        signal:   pos.signal,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitReason,
        pnlPct,
        openedAt:  pos.openedAt,
        closedAt:  timestamp,
      };

      this.open.delete(id);
      this.closed.push(closed);
      this.stream?.write(JSON.stringify(closed) + '\n');
      this.emit('closed', closed);
      justClosed.push(closed);

      const pnlStr = `${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(3)}%`;
      log('info', 'Position closed', {
        id,
        reason:    exitReason,
        pnl:       pnlStr,
        direction: pos.signal.direction,
        horizon:   pos.signal.horizon,
      });
    }

    return justClosed;
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  stats(): PositionStats {
    const decided = this.closed.filter(p => p.exitReason !== 'timeout');
    const wins    = decided.filter(p => p.exitReason === 'tp');
    const winRate = decided.length === 0 ? 0 : wins.length / decided.length;

    const avgPnlPct = this.closed.length === 0
      ? 0
      : this.closed.reduce((s, p) => s + p.pnlPct, 0) / this.closed.length;
    const totalPnlPct = this.closed.reduce((s, p) => s + p.pnlPct, 0);

    // Per-horizon breakdown
    const byHorizon: Record<string, { wins: number; losses: number; avgPnl: number }> = {};
    for (const p of this.closed) {
      const h = p.signal.horizon;
      if (!byHorizon[h]) byHorizon[h] = { wins: 0, losses: 0, avgPnl: 0 };
      if (p.exitReason === 'tp') byHorizon[h]!.wins++;
      if (p.exitReason === 'sl') byHorizon[h]!.losses++;
    }
    for (const [h, m] of Object.entries(byHorizon)) {
      const group = this.closed.filter(p => p.signal.horizon === h);
      m.avgPnl = group.length === 0
        ? 0 : group.reduce((s, p) => s + p.pnlPct, 0) / group.length;
    }

    return {
      openCount:   this.open.size,
      closedCount: this.closed.length,
      winRate,
      avgPnlPct,
      totalPnlPct,
      byHorizon,
    };
  }

  getOpen():   OpenPosition[]   { return [...this.open.values()]; }
  getClosed(n = 200): ClosedPosition[] { return this.closed.slice(-n); }

  // ── Static reader (for API server) ──────────────────────────────────────────

  static readAll(dataDir: string): ClosedPosition[] {
    const filePath = path.join(dataDir, 'positions.jsonl');
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n').filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line) as ClosedPosition]; } catch { return []; } });
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
