/**
 * src/services/PolySignalService.ts
 *
 * Polymarket P_signal engine — computes probability that the next 5m candle
 * goes UP or DOWN, then calculates EV against the PM share price.
 *
 * Four components (all converted to P(UP)):
 *   1. Daily Quota  (W=0.30) — how much of today's streak-N reversal quota is left
 *   2. Trend        (W=0.35) — 15m + 1h EMA agreement
 *   3. Pattern      (W=0.20) — k-NN similarity from KB snapshots (5m-focused)
 *   4. Liq Bias     (W=0.15) — liquidation zone pressure
 *
 * EV = P_signal - share_price - spread/2
 * Trade only when EV > MIN_EV.
 */

import type pg from 'pg';
import { getPool } from '@trading-bot/db';
import type {
  MacroBias, TrendStrength, PatternMatch, QuotaCheck,
  LiqBias, PolySignalResult,
} from '../types/polymarket.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const W_QUOTA   = 0.30;
const W_TREND   = 0.35;
const W_PATTERN = 0.20;
const W_LIQ     = 0.15;

const MIN_EV       = 0.03;   // minimum edge required to enter
const MOCK_SPREAD  = 0.02;   // Phase 1: fixed spread
const KNN_K        = 30;     // neighbors for pattern match

// ── Service ────────────────────────────────────────────────────────────────────

export class PolySignalService {
  private pool: pg.Pool;

  constructor() {
    this.pool = getPool();
  }

  /**
   * Main entry point.
   * @param timestamp  Unix ms of the 5m candle to analyse
   * @param sharePrice PM share price for UP direction (0–1). Default 0.50 (mock).
   */
  async compute(timestamp: number, sharePrice = 0.50): Promise<PolySignalResult> {
    // Run all components in parallel
    const [candle5m, macro] = await Promise.all([
      this.load5mContext(timestamp),
      this.macroBias(timestamp),
    ]);

    const { streak5m, streak15m, streak1h, change15m, change1h, volRatio, wickRatio, price } = candle5m;

    const [trend, pattern, quota, liq] = await Promise.all([
      this.trendStrength(timestamp),
      this.patternMatch(streak5m, streak15m, streak1h, change15m, change1h, volRatio, wickRatio),
      this.quotaCheck(timestamp, streak5m),
      this.liqBias(timestamp),
    ]);

    // Convert each component to P(UP)
    // quota: pReversal = probability of reversal. If streak UP, reversal = DOWN → p_quota_up = 1 - pReversal
    const p_quota_up   = streak5m >= 0
      ? 1 - quota.pReversal          // streak UP → reversal (DOWN) P → 1-p = continuation P(UP)
      : quota.pReversal;             // streak DOWN → reversal (UP) P

    const p_trend_up   = trend.score;   // TrendStrength.score is already P(UP)

    const p_pattern_up = pattern.total > 0 ? pattern.pUp : 0.5;

    const p_liq_up     = liq.pUp;

    // Weighted composite P(UP)
    const p_signal_up = (
      W_QUOTA   * p_quota_up   +
      W_TREND   * p_trend_up   +
      W_PATTERN * p_pattern_up +
      W_LIQ     * p_liq_up
    );   // weights already sum to 1.0

    const p_signal_down = 1 - p_signal_up;

    // EV (Phase 1: share_price = mock, UP and DOWN are mirror)
    const shareDown = 1 - sharePrice;
    const ev_up   = p_signal_up   - sharePrice  - MOCK_SPREAD / 2;
    const ev_down = p_signal_down - shareDown   - MOCK_SPREAD / 2;

    // Direction decision
    let direction: 'up' | 'down' | 'skip';
    let ev: number;
    let skipReason: string | undefined;

    if (macro.bias === 'bullish' && macro.strength > 0.7 && ev_up <= MIN_EV) {
      direction   = 'skip';
      ev          = Math.max(ev_up, ev_down);
      skipReason  = 'Macro bullish bias — insufficient UP EV, no DOWN trade';
    } else if (macro.bias === 'bearish' && macro.strength > 0.7 && ev_down <= MIN_EV) {
      direction   = 'skip';
      ev          = Math.max(ev_up, ev_down);
      skipReason  = 'Macro bearish bias — insufficient DOWN EV, no UP trade';
    } else if (ev_up > MIN_EV && ev_up >= ev_down) {
      direction = 'up';
      ev        = ev_up;
    } else if (ev_down > MIN_EV) {
      direction = 'down';
      ev        = ev_down;
    } else {
      direction  = 'skip';
      ev         = Math.max(ev_up, ev_down);
      skipReason = `EV insufficient: UP=${ev_up.toFixed(3)} DOWN=${ev_down.toFixed(3)} (min ${MIN_EV})`;
    }

    return {
      timestamp,
      price,
      direction,
      p_signal:    direction === 'down' ? p_signal_down : p_signal_up,
      ev,
      share_price: direction === 'down' ? shareDown : sharePrice,
      spread:      MOCK_SPREAD,
      macroBias:   macro,
      skipReason,
      components: {
        quota:   { p: p_quota_up,   ...quota   },
        trend:   { p: p_trend_up,   ...trend   },
        pattern: { p: p_pattern_up, ...pattern },
        liq:     { p: p_liq_up,     ...liq     },
      },
    };
  }

  // ── Component: 5m candle context ─────────────────────────────────────────────

  private async load5mContext(timestamp: number): Promise<{
    streak5m: number; streak15m: number; streak1h: number;
    change15m: number; change1h: number;
    volRatio: number; wickRatio: number; price: number;
  }> {
    // Load last 120 5m candles (10h) — enough for 20-bar 1h streak
    const res = await this.pool.query<{
      ts5: string; open: string; high: string; low: string; close: string; volume: string;
    }>(
      `SELECT
         floor(ts / 300000.0)::bigint * 300000      AS ts5,
         (array_agg(open   ORDER BY ts))[1]          AS open,
         MAX(high)                                   AS high,
         MIN(low)                                    AS low,
         (array_agg(close  ORDER BY ts DESC))[1]     AS close,
         SUM(volume)                                 AS volume
       FROM ohlcv_1m
       WHERE ts <= $1 AND symbol = 'BTC/USDT' AND exchange = 'binance'
       GROUP BY floor(ts / 300000.0)::bigint * 300000
       ORDER BY ts5 DESC LIMIT 120`,
      [timestamp],
    );

    const candles = res.rows.reverse().map(r => ({
      open: Number(r.open), high: Number(r.high),
      low:  Number(r.low),  close: Number(r.close), volume: Number(r.volume),
    }));

    if (candles.length === 0) {
      return { streak5m: 0, streak15m: 0, streak1h: 0, change15m: 0, change1h: 0, volRatio: 1, wickRatio: 0, price: 0 };
    }

    const last = candles[candles.length - 1]!;
    const isUp = (c: { close: number; open: number }) => c.close >= c.open;

    // 5m streak (each candle here is already a 5m bar)
    const lastDir5m = isUp(last);
    let s5 = 1;
    for (let i = candles.length - 2; i >= 0; i--) { if (isUp(candles[i]!) !== lastDir5m) break; s5++; }
    const streak5m = lastDir5m ? s5 : -s5;

    // 15m streak: group 5m bars into 15m (3 bars each), compute streak
    const bars15m = aggregateBars(candles, 3);
    const streak15m = signedStreak(bars15m);

    // 1h streak: group 5m bars into 1h (12 bars each), compute streak
    const bars1h = aggregateBars(candles, 12);
    const streak1h = signedStreak(bars1h);

    const c15m = candles.length >= 3  ? candles[candles.length - 3]!  : candles[0]!;
    const c1h  = candles.length >= 12 ? candles[candles.length - 12]! : candles[0]!;

    const change15m = (last.close - c15m.close) / c15m.close;
    const change1h  = (last.close - c1h.close)  / c1h.close;

    const recentVols = candles.slice(-21, -1).map(c => c.volume);
    const avgVol     = recentVols.reduce((a, b) => a + b, 0) / Math.max(recentVols.length, 1);
    const volRatio   = avgVol > 0 ? last.volume / avgVol : 1;

    const range     = last.high - last.low;
    const body      = Math.abs(last.close - last.open);
    const wickRatio = range > 0 ? (range - body) / range : 0;

    return { streak5m, streak15m, streak1h, change15m, change1h, volRatio, wickRatio, price: last.close };
  }

  // ── Component: Macro Bias (1h/D1) ────────────────────────────────────────────

  private async macroBias(timestamp: number): Promise<MacroBias> {
    // Aggregate 1m → 1h for last 168 candles (7 days)
    const res = await this.pool.query<{ ts1h: string; open: string; close: string }>(
      `SELECT
         floor(ts / 3600000.0)::bigint * 3600000    AS ts1h,
         (array_agg(open  ORDER BY ts))[1]           AS open,
         (array_agg(close ORDER BY ts DESC))[1]      AS close
       FROM ohlcv_1m
       WHERE ts <= $1 AND ts >= $1 - 604800000
         AND symbol = 'BTC/USDT' AND exchange = 'binance'
       GROUP BY floor(ts / 3600000.0)::bigint * 3600000
       ORDER BY ts1h`,
      [timestamp],
    );

    const closes = res.rows.map(r => Number(r.close));
    if (closes.length < 2) {
      return { bias: 'neutral', strength: 0, change24h: 0, change7d: 0, ema1h: closes[0] ?? 0 };
    }

    // EMA-20 of 1h closes
    const K = 2 / 21;
    let ema = closes[0]!;
    for (let i = 1; i < closes.length; i++) ema = closes[i]! * K + ema * (1 - K);

    const last     = closes[closes.length - 1]!;
    const c24h     = closes.length >= 24 ? closes[closes.length - 24]! : closes[0]!;
    const c7d      = closes[0]!;
    const change24h = (last - c24h) / c24h;
    const change7d  = (last - c7d)  / c7d;

    // Bias from 24h change + EMA deviation
    const deviation = (last - ema) / ema;
    let bias: MacroBias['bias'] = 'neutral';
    let strength = 0;

    if (change24h > 0.015 && deviation > 0.005) {
      bias = 'bullish'; strength = Math.min(1, change24h * 20 + deviation * 50);
    } else if (change24h < -0.015 && deviation < -0.005) {
      bias = 'bearish'; strength = Math.min(1, -change24h * 20 + (-deviation) * 50);
    }

    return { bias, strength, change24h, change7d, ema1h: ema };
  }

  // ── Component: Trend Strength (15m + 1h) ─────────────────────────────────────

  private async trendStrength(timestamp: number): Promise<TrendStrength & { score: number }> {
    // Load last 36 15m candles (9h)
    const res = await this.pool.query<{ ts15: string; close: string }>(
      `SELECT
         floor(ts / 900000.0)::bigint * 900000      AS ts15,
         (array_agg(close ORDER BY ts DESC))[1]      AS close
       FROM ohlcv_1m
       WHERE ts <= $1 AND ts >= $1 - 32400000
         AND symbol = 'BTC/USDT' AND exchange = 'binance'
       GROUP BY floor(ts / 900000.0)::bigint * 900000
       ORDER BY ts15`,
      [timestamp],
    );

    const closes15m = res.rows.map(r => Number(r.close));

    // 15m trend: EMA-9 slope (last 3 EMA values going up/down)
    let trend15m: 'up' | 'down' | 'neutral' = 'neutral';
    if (closes15m.length >= 12) {
      const K9 = 2 / 10;
      let e = closes15m[0]!;
      const emas: number[] = [e];
      for (let i = 1; i < closes15m.length; i++) {
        e = closes15m[i]! * K9 + e * (1 - K9);
        emas.push(e);
      }
      const last3  = emas.slice(-3);
      const slope  = (last3[2]! - last3[0]!) / last3[0]!;
      if (slope > 0.001)       trend15m = 'up';
      else if (slope < -0.001) trend15m = 'down';
    }

    // 1h trend: change from 4h ago vs now
    const c4hAgo = closes15m.length >= 16 ? closes15m[closes15m.length - 16]! : closes15m[0]!;
    const cNow   = closes15m[closes15m.length - 1]!;
    const change4h = cNow ? (cNow - c4hAgo) / c4hAgo : 0;
    let trend1h: 'up' | 'down' | 'neutral' = 'neutral';
    if (change4h > 0.003)       trend1h = 'up';
    else if (change4h < -0.003) trend1h = 'down';

    // Score = P(UP): agreement between 15m and 1h
    let score = 0.50;
    if (trend15m === 'up'   && trend1h === 'up')   score = 0.72;
    else if (trend15m === 'down' && trend1h === 'down') score = 0.28;
    else if (trend15m === 'up'   || trend1h === 'up')   score = 0.60;
    else if (trend15m === 'down' || trend1h === 'down') score = 0.40;

    return { trend15m, trend1h, score };
  }

  // ── Component: Pattern Match (k-NN, 5m focused) ───────────────────────────────

  private async patternMatch(
    streak5m: number, streak15m: number, streak1h: number,
    change15m: number, change1h: number,
    volRatio: number, wickRatio: number,
  ): Promise<PatternMatch> {
    const res = await this.pool.query<{ direction: string }>(
      `SELECT direction
       FROM kb_snapshots
       WHERE direction IN ('up', 'down')
       ORDER BY
           ABS(streak_5m    - $1) / 3.0    -- primary: 5m streak
         + ABS(streak_15m   - $2) / 2.0    -- 15m context
         + ABS(streak_1h    - $3) / 1.5    -- 1h context
         + ABS(change_15m   - $4) / 0.005
         + ABS(change_1h    - $5) / 0.01
         + ABS(volume_ratio - $6) / 0.5
         + ABS(wick_ratio   - $7) / 0.3
       LIMIT $8`,
      [streak5m, streak15m, streak1h, change15m, change1h, volRatio, wickRatio, KNN_K],
    );

    const upVotes   = res.rows.filter(r => r.direction === 'up').length;
    const downVotes = res.rows.filter(r => r.direction === 'down').length;
    const total     = res.rows.length;

    return { upVotes, downVotes, total, pUp: total > 0 ? upVotes / total : 0.5 };
  }

  // ── Component: Daily Quota (streak-N reversal quota) ─────────────────────────

  private async quotaCheck(timestamp: number, streak5m: number): Promise<QuotaCheck> {
    const absStreak = Math.abs(streak5m);
    const dayStart  = timestamp - (timestamp % 86_400_000);

    // Today's 5m candles
    const res = await this.pool.query<{ ts5: string; open: string; close: string }>(
      `SELECT
         floor(ts / 300000.0)::bigint * 300000     AS ts5,
         (array_agg(open  ORDER BY ts))[1]          AS open,
         (array_agg(close ORDER BY ts DESC))[1]     AS close
       FROM ohlcv_1m
       WHERE ts >= $1 AND ts <= $2
         AND symbol = 'BTC/USDT' AND exchange = 'binance'
       GROUP BY floor(ts / 300000.0)::bigint * 300000
       ORDER BY ts5`,
      [dayStart, timestamp],
    );

    const dirs = res.rows.map(r => Number(r.close) >= Number(r.open) ? 1 : -1);

    // Count reversals where prior run length = absStreak
    const reversalsByLen: Record<number, number> = {};
    let runLen = 1;
    for (let i = 1; i < dirs.length; i++) {
      if (dirs[i] !== dirs[i - 1]) {
        reversalsByLen[runLen] = (reversalsByLen[runLen] ?? 0) + 1;
        runLen = 1;
      } else {
        runLen++;
      }
    }

    const todayCount = reversalsByLen[absStreak] ?? 0;

    // Historical average from materialized view
    let avgCount   = 0;
    let sampleDays = 0;
    try {
      const avgRes = await this.pool.query<{ avg_daily_reversals: string; sample_days: string }>(
        `SELECT avg_daily_reversals, sample_days
         FROM kb_daily_reversal_stats WHERE streak_len = $1`,
        [absStreak],
      );
      avgCount   = Number(avgRes.rows[0]?.avg_daily_reversals ?? 0);
      sampleDays = Number(avgRes.rows[0]?.sample_days         ?? 0);
    } catch { /* view not yet populated */ }

    const ratio     = avgCount > 0 ? todayCount / avgCount : 0;
    const pReversal = Math.max(0.2, 1.0 - ratio);

    return { streak5m, todayCount, avgCount, sampleDays, ratio, pReversal };
  }

  // ── Component: Liquidity Bias ─────────────────────────────────────────────────

  private async liqBias(timestamp: number): Promise<LiqBias> {
    // Read liq data from 5 most recent KB snapshots near current timestamp
    const res = await this.pool.query<{
      liq_long_usd: string; liq_short_usd: string; liq_cascade: string;
    }>(
      `SELECT liq_long_usd, liq_short_usd, liq_cascade
       FROM kb_snapshots
       WHERE ts <= $1 AND symbol = 'BTC/USDT' AND exchange = 'binance'
       ORDER BY ts DESC LIMIT 5`,
      [timestamp],
    );

    if (res.rows.length === 0) {
      return { liqLong: 0, liqShort: 0, cascade: 0, pUp: 0.5 };
    }

    const liqLong  = avg(res.rows.map(r => Number(r.liq_long_usd)));
    const liqShort = avg(res.rows.map(r => Number(r.liq_short_usd)));
    const cascade  = avg(res.rows.map(r => Number(r.liq_cascade)));

    const total = liqLong + liqShort + 0.001;

    // High short liq → price likely hunts up → UP bias
    // High long liq  → price likely hunts down → DOWN bias
    let pUp = 0.5 + ((liqShort - liqLong) / total) * 0.25;
    pUp = Math.min(0.75, Math.max(0.25, pUp));

    // Cascade override: active cascade has momentum — follow current price direction
    if (cascade >= 2) pUp = liqShort > liqLong ? 0.68 : 0.32;

    return { liqLong, liqShort, cascade, pUp };
  }
}

// ── Util ──────────────────────────────────────────────────────────────────────

function avg(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Aggregate an array of {open,close,...} bars into N-bar composite bars. */
function aggregateBars(
  bars: { open: number; close: number }[],
  n: number,
): { open: number; close: number }[] {
  const result: { open: number; close: number }[] = [];
  for (let i = 0; i + n - 1 < bars.length; i += n) {
    result.push({ open: bars[i]!.open, close: bars[i + n - 1]!.close });
  }
  return result;
}

/** Signed streak of an array of {open,close} bars (last N consecutive same direction). */
function signedStreak(bars: { open: number; close: number }[]): number {
  if (bars.length === 0) return 0;
  const last = bars[bars.length - 1]!;
  const dir  = last.close >= last.open;
  let count  = 1;
  for (let i = bars.length - 2; i >= 0; i--) {
    if ((bars[i]!.close >= bars[i]!.open) !== dir) break;
    count++;
  }
  return dir ? count : -count;
}
