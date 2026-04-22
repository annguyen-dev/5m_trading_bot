/**
 * StatisticalSignalService — k-NN signal engine using kb_snapshots (PostgreSQL).
 *
 * Signal is built from four components:
 *   1. k-NN vote       — P(up|down) from K most similar historical setups
 *   2. Streak stats    — P(reversal | N consecutive same-direction candles) from full KB history
 *   3. Intraday mod    — reduces reversal P when today already exceeded avg daily reversal quota
 *   4. Volume signal   — high volume_ratio + wick = exhaustion → reversal bias
 *
 * Composite probability combines all four with fixed weights.
 * Returns null from reason() when composite confidence is too low → caller falls back to Claude.
 */
import type pg from 'pg';
import { getPool } from '@trading-bot/db';
import type { AIServiceInput } from './AIService.js';
import type { AISignalOutput } from '../types/signal.js';
import { log } from '../observability/logger.js';
import type { FormulaWeights } from '../backtest/types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const K                    = 20;    // neighbors to fetch (reduced from 50 — faster)
// Minimum 1 neighbor needed — any decided neighbor counts toward probability
const CONFIDENCE_THRESHOLD = 0.58;  // composite P must exceed this to make a call
const MIN_KB_ROWS          = 100;   // skip if KB too small

// Composite weights — must sum to 1.0
const W_KNN      = 0.20;
const W_STREAK   = 0.35;
const W_INTRADAY = 0.35;
const W_VOLUME   = 0.10;

// Minimum stop-loss per horizon so kNN avgT5m noise doesn't produce trivially tight stops
const MIN_SL: Record<string, number> = { scale: 0.003, short: 0.006, mid: 0.012, long: 0.025 };


// ── Types ──────────────────────────────────────────────────────────────────────

interface Neighbor {
  direction: string;
  t5m: number | null;
  t1h: number | null;
  t1d: number | null;
}

interface Features {
  streak1m:    number;   // signed: +N = N consecutive up, -N = N consecutive down
  streak5m:    number;   // signed: same for 5m bars
  cvd1h:       number;
  change1h:    number;
  volumeRatio: number;   // current vol / 20-period avg (1.0 = average)
  wickRatio:   number;   // (upper + lower wick) / total range (0–1)
  brokeLiq:    boolean;  // current candle pierced a major liquidity level (4h/24h/round)
}

export interface StreakStats {
  streak:      number;   // absolute streak length
  direction:   'up' | 'down';
  pReversal:   number;   // P(price reverses over next 1h | streak=N, direction=D)
  sampleSize:  number;
}

export interface IntradayContext {
  reversals:         number;   // direction changes in last 24h of 1m candles
  regime:            'ranging' | 'trending';
  currentStreakIsNth: number;  // this is the Nth same-direction streak today
}

export interface IntradayModifier {
  streakLen5m:       number;   // current 5m streak length computed from today's candles
  todayReversals:    number;   // how many times streak-N reversed today so far
  avgDailyReversals: number;   // historical avg per day for streak-N (from materialized view)
  sampleDays:        number;   // how many days of history back this average
  ratio:             number;   // todayReversals / avgDailyReversals
  pIntraday:         number;   // max(0.2, 1.0 - ratio) — room left for streak-N reversals today
}

export interface KNNAnalysis {
  kbRows:           number;
  neighborsFound:   number;
  upVotes:          number;
  downVotes:        number;
  pUp:              number;
  pDown:            number;
  pComposite:       number;   // weighted composite probability for dominant direction
  dominantDir:      'up' | 'down' | 'none';
  fallbackReason:   string;   // empty string if k-NN made the call
  signal:           AISignalOutput | null;
  streakStats:      StreakStats | null;
  intradayContext:  IntradayContext | null;
  intradayModifier: IntradayModifier | null;
  components: {
    knn:      number;   // k-NN contribution (0–1, in dominant direction)
    streak:   number;   // streak contribution
    intraday: number;   // intraday modifier contribution
    volume:   number;   // volume contribution
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

export class StatisticalSignalService {
  private pool: pg.Pool;
  private kbRowCount = -1;

  constructor(private readonly w?: Partial<FormulaWeights>) {
    this.pool = getPool();
  }

  /**
   * Returns a signal based on the composite probability model.
   * Returns null only when KB is too small or no decided neighbors exist.
   */
  async reason(input: AIServiceInput, timestamp?: number): Promise<AISignalOutput | null> {
    if (!(await this.hasEnoughData())) return null;

    const features  = extractFeatures(input);
    const neighbors = await this.knnQuery(features);
    const decided   = neighbors.filter(n => n.direction === 'up' || n.direction === 'down');

    const upVotes   = decided.filter(n => n.direction === 'up').length;
    const downVotes = decided.length - upVotes;
    const hasKnn    = decided.length > 0;
    const pUp       = hasKnn ? upVotes   / decided.length : 0;
    const pDown     = hasKnn ? downVotes / decided.length : 0;

    const effectiveStreak = features.streak5m !== 0 ? features.streak5m : features.streak1m;
    const streakStats = await this.streakReversalStats(effectiveStreak);
    const intradayMod = timestamp != null ? await this.computeIntradayModifier(timestamp) : null;
    const { pComposite, dominantDir } = compositeProb(
      pUp, pDown, features, streakStats, intradayMod, this.w, hasKnn,
    );

    // 'none' now means truly indeterminate (no streak AND no kNN) — skip.
    // Below-threshold signals are NOT rejected; caller marks them 'manual'.
    if (dominantDir === 'none') return null;

    const absStreak = Math.abs(effectiveStreak);
    const threshold = this.w?.thresholdByStreak?.[absStreak]
      ?? this.w?.confidenceThreshold
      ?? CONFIDENCE_THRESHOLD;

    return buildSignal(
      dominantDir === 'up' ? 'BUY' : 'SELL',
      pComposite,
      decided,
      input.price,
      features,
      input.horizon,
      pComposite >= threshold ? 'auto' : 'manual',
    );
  }

  /**
   * Always returns full diagnostics — never returns null.
   * Callers use this for the Simulate tab.
   */
  async analyze(input: AIServiceInput, timestamp?: number): Promise<KNNAnalysis> {
    const kbRows = await this.getKBRowCount();

    if (kbRows < MIN_KB_ROWS) {
      return emptyAnalysis(kbRows, `KB has ${kbRows} labeled rows — need ${MIN_KB_ROWS} to activate k-NN`);
    }

    const features  = extractFeatures(input);
    const neighbors = await this.knnQuery(features);
    const decided   = neighbors.filter(n => n.direction === 'up' || n.direction === 'down');
    const upVotes   = decided.filter(n => n.direction === 'up').length;
    const downVotes = decided.length - upVotes;
    const total     = decided.length;
    const pUp       = total > 0 ? upVotes   / total : 0;
    const pDown     = total > 0 ? downVotes / total : 0;

    // Streak + intraday context + intraday modifier (parallel for speed)
    const effectiveStreak = features.streak5m !== 0 ? features.streak5m : features.streak1m;
    const [streakStats, intradayContext, intradayMod] = await Promise.all([
      this.streakReversalStats(effectiveStreak),
      timestamp != null ? this.intradayReversalContext(timestamp, effectiveStreak) : Promise.resolve(null),
      timestamp != null ? this.computeIntradayModifier(timestamp) : Promise.resolve(null),
    ]);

    const { pComposite, dominantDir, components } = compositeProb(
      pUp, pDown, features, streakStats, intradayMod, this.w, total > 0,
    );

    if (total === 0) {
      return {
        kbRows, neighborsFound: 0, upVotes: 0, downVotes: 0, pUp: 0, pDown: 0,
        pComposite: 0, dominantDir: 'none', components, streakStats, intradayContext,
        intradayModifier: intradayMod,
        fallbackReason: 'No decided neighbors found (all flat)',
        signal: null,
      };
    }

    // analyze() always returns a signal for diagnostics (Simulate tab).
    // The real gate is in reason() — this is display-only.
    const absStreak    = Math.abs(effectiveStreak);
    const reversalDir  = absStreak > 0 ? (effectiveStreak > 0 ? 'down' : 'up') : (pUp >= pDown ? 'up' : 'down');
    const effectiveDir = dominantDir !== 'none' ? dominantDir : reversalDir as 'up' | 'down';
    const direction    = effectiveDir === 'up' ? 'BUY' : 'SELL';
    const signal       = buildSignal(direction, pComposite, decided, input.price, features, input.horizon);
    const lowConf      = pComposite < CONFIDENCE_THRESHOLD
      ? `Low confidence: ${Math.round(pComposite * 100)}% < ${Math.round(CONFIDENCE_THRESHOLD * 100)}% threshold`
      : '';
    return {
      kbRows, neighborsFound: total, upVotes, downVotes, pUp, pDown,
      pComposite, dominantDir: effectiveDir, components, streakStats, intradayContext,
      intradayModifier: intradayMod,
      fallbackReason: lowConf,
      signal,
    };
  }

  // ── Streak reversal probability ─────────────────────────────────────────────

  /**
   * Given a signed streak (e.g. +3 = 3 up candles, -4 = 4 down candles),
   * compute P(reversal over next 1h) from the full KB history.
   */
  async streakReversalStats(signedStreak: number): Promise<StreakStats | null> {
    if (signedStreak === 0) return null;

    const absStreak   = Math.abs(signedStreak);
    const streakDir   = signedStreak > 0 ? 'up' : 'down';
    const reversalDir = streakDir === 'up' ? 'down' : 'up';

    const res = await this.pool.query<{ total: string; reversals: string }>(
      `SELECT
         COUNT(*)                                               AS total,
         COUNT(*) FILTER (WHERE direction = $1)                AS reversals
       FROM kb_snapshots
       WHERE ABS(streak_5m) = $2
         AND direction IN ('up', 'down')`,
      [reversalDir, absStreak],
    );

    const total     = Number(res.rows[0]?.total    ?? 0);
    const reversals = Number(res.rows[0]?.reversals ?? 0);
    if (total === 0) return null;

    return {
      streak:     absStreak,
      direction:  streakDir,
      pReversal:  reversals / total,  // kept for diagnostics only
      sampleSize: total,
    };
  }

  // ── Intraday reversal context ───────────────────────────────────────────────

  /**
   * Counts how many direction changes occurred in the last 24h of 1m candles,
   * and whether the market is in a ranging or trending regime.
   * Also counts how many same-direction streaks happened today (to say "this is the Nth streak").
   */
  async intradayReversalContext(
    timestamp: number,
    signedStreak: number,
  ): Promise<IntradayContext> {
    const since = timestamp - 24 * 3_600_000;

    const rows = await this.pool.query<{ ts: string; close: string }>(
      `SELECT ts, close FROM ohlcv_1m
       WHERE ts >= $1 AND ts <= $2
         AND symbol = 'BTC/USDT' AND exchange = 'binance'
       ORDER BY ts`,
      [since, timestamp],
    );

    const closes = rows.rows.map(r => Number(r.close));
    if (closes.length < 2) {
      return { reversals: 0, regime: 'trending', currentStreakIsNth: 1 };
    }

    // Count direction changes (reversal = prev direction ≠ current direction)
    let reversals = 0;
    let sameStreakCount = 0;
    const currentDir = signedStreak > 0 ? 'up' : 'down';
    let inCurrentDir = false;

    for (let i = 1; i < closes.length; i++) {
      const prevDir = closes[i]! >= closes[i - 1]! ? 'up' : 'down';
      const curDir  = i + 1 < closes.length
        ? (closes[i + 1]! >= closes[i]! ? 'up' : 'down')
        : currentDir;

      if (i > 1) {
        const ppDir = closes[i - 1]! >= closes[i - 2]! ? 'up' : 'down';
        if (prevDir !== ppDir) reversals++;
      }

      // Count how many streaks were in the same direction as current
      if (prevDir === currentDir && !inCurrentDir) {
        sameStreakCount++;
        inCurrentDir = true;
      } else if (prevDir !== currentDir) {
        inCurrentDir = false;
      }
    }

    // Regime: >1 reversal per hour average → ranging
    const hours  = closes.length / 60;
    const regime: 'ranging' | 'trending' = hours > 0 && reversals / hours > 1
      ? 'ranging'
      : 'trending';

    return {
      reversals,
      regime,
      currentStreakIsNth: Math.max(1, sameStreakCount),
    };
  }

  // ── Intraday modifier ───────────────────────────────────────────────────────

  /**
   * Computes pIntraday based on how many streak-N reversals have already happened today
   * vs the historical daily average for streak-N from the materialized view.
   *
   * Logic: if today's streak-N reversal count exceeds the historical average,
   * the market has used up its reversal quota at this streak length → reduce P.
   *
   * pIntraday = max(0.2, 1.0 - ratio)
   *   ratio=0  → pIntraday=1.0 (no streak-N reversals yet today → full reversal P)
   *   ratio=1  → pIntraday=0.2 (already at average → dampened)
   *   ratio=2+ → pIntraday=0.2 (exceeded quota → floor)
   */
  async computeIntradayModifier(timestamp: number): Promise<IntradayModifier> {
    // Day boundary: midnight UTC
    const dayStart = timestamp - (timestamp % 86_400_000);

    // Aggregate 1m → 5m candles for today
    const res = await this.pool.query<{ ts5: string; open: string; close: string }>(
      `SELECT
         floor(ts / 300000.0)::bigint * 300000  AS ts5,
         (array_agg(open  ORDER BY ts))[1]       AS open,
         (array_agg(close ORDER BY ts DESC))[1]  AS close
       FROM ohlcv_1m
       WHERE ts >= $1 AND ts <= $2
         AND symbol = 'BTC/USDT' AND exchange = 'binance'
       GROUP BY floor(ts / 300000.0)::bigint * 300000
       ORDER BY ts5`,
      [dayStart, timestamp],
    );

    const candles = res.rows.map(r => ({
      dir: Number(r.close) >= Number(r.open) ? 1 : -1,
    }));

    // Compute 5m streak lengths and count per-streak-length reversals today.
    // At the end of the loop, currentStreak5m is the live streak length.
    const reversalsByLen: Record<number, number> = {};
    let runLen = 1;
    for (let i = 1; i < candles.length; i++) {
      const reversed = candles[i]!.dir !== candles[i - 1]!.dir;
      if (reversed) {
        if (runLen >= 2) {
          reversalsByLen[runLen] = (reversalsByLen[runLen] ?? 0) + 1;
        }
        runLen = 1;
      } else {
        runLen++;
      }
    }
    const streakLen5m = runLen; // current live 5m streak length

    // Look up the historical average for this streak length from materialized view
    let avgDailyReversals = 0;
    let sampleDays = 0;
    try {
      const avgRes = await this.pool.query<{
        avg_daily_reversals: string;
        sample_days: string;
      }>(
        `SELECT avg_daily_reversals, sample_days
         FROM kb_daily_reversal_stats
         WHERE streak_len = $1`,
        [streakLen5m],
      );
      avgDailyReversals = Number(avgRes.rows[0]?.avg_daily_reversals ?? 0);
      sampleDays        = Number(avgRes.rows[0]?.sample_days        ?? 0);
    } catch {
      // View not yet populated — use neutral values
    }

    const todayReversals = reversalsByLen[streakLen5m] ?? 0;
    const ratio     = avgDailyReversals > 0 ? todayReversals / avgDailyReversals : 0;
    const pIntraday = Math.max(0.2, 1.0 - ratio);

    return { streakLen5m, todayReversals, avgDailyReversals, sampleDays, ratio, pIntraday };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async getKBRowCount(): Promise<number> {
    if (this.kbRowCount >= 0) return this.kbRowCount;
    const res = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM kb_snapshots WHERE direction IN ('up', 'down')`,
    );
    this.kbRowCount = Number(res.rows[0]?.cnt ?? 0);
    if (this.kbRowCount < MIN_KB_ROWS) {
      log('warn', `StatisticalSignal: KB has ${this.kbRowCount} rows — need ${MIN_KB_ROWS} to activate`);
    }
    return this.kbRowCount;
  }

  private async hasEnoughData(): Promise<boolean> {
    return (await this.getKBRowCount()) >= MIN_KB_ROWS;
  }

  private async knnQuery(f: Features): Promise<Neighbor[]> {
    // Normalised L1 distance across 5 features.
    // streak_5m is the macro reversal context (has real edge); streak_1m is only entry timing.
    // Scale factors chosen so each feature contributes roughly equally
    // at typical market ranges:
    //   streak_5m    ÷ 5      (range ±12)
    //   cvd_1h       ÷ 500    (range ±5000)
    //   change_1h    ÷ 0.01   (range ±5%)
    //   volume_ratio ÷ 0.5    (range 0–3; 2× spike = distance 2.0)
    //   wick_ratio   ÷ 0.3    (range 0–1; high wick = distance 1.0+)
    const res = await this.pool.query<{
      direction: string;
      t5m: string | null;
      t1h: string | null;
      t1d: string | null;
    }>(
      `SELECT direction, t5m, t1h, t1d
       FROM kb_snapshots
       WHERE direction IN ('up', 'down')
       ORDER BY
           ABS(streak_5m    - $1) / 5.0
         + ABS(cvd_1h       - $2) / 500.0
         + ABS(change_1h    - $3) / 0.01
         + ABS(volume_ratio - $4) / 0.5
         + ABS(wick_ratio   - $5) / 0.3
       LIMIT $6`,
      [f.streak5m, f.cvd1h, f.change1h, f.volumeRatio, f.wickRatio, K],
    );

    return res.rows.map(r => ({
      direction: r.direction,
      t5m: r.t5m !== null ? Number(r.t5m) : null,
      t1h: r.t1h !== null ? Number(r.t1h) : null,
      t1d: r.t1d !== null ? Number(r.t1d) : null,
    }));
  }
}

// ── Composite probability ──────────────────────────────────────────────────────
//
// All components are expressed as P(reversal from current streak direction).
// Signal direction is always the reversal direction when pComposite >= threshold.
//
// - P_streak   = min(cap, |streak| * scale)         [user-configurable formula]
// - P_knn_rev  = P(knn voted for reversal direction) [kNN remapped to reversal frame]
// - P_intraday = reversal quota availability          [1.0=full, 0.2=exhausted]
// - P_vol      = 0.70 exhaustion | 0.30 breakout | 0.50 neutral
//
// When no streak (streak=0): fall back to kNN direction frame.

function compositeProb(
  pUp: number,
  pDown: number,
  features: Features,
  _streakStats: StreakStats | null,   // diagnostics only — P_streak now from formula
  intradayMod: IntradayModifier | null,
  w?: Partial<FormulaWeights>,
  hasKnn: boolean = true,
): { pComposite: number; dominantDir: 'up' | 'down' | 'none'; components: KNNAnalysis['components'] } {
  const knnDir = pUp >= pDown ? 'up' : 'down';
  const pKnn   = knnDir === 'up' ? pUp : pDown;
  // Use streak_5m for reversal signal (has real edge); fall back to streak_1m when unavailable
  const effectiveStreak = features.streak5m !== 0 ? features.streak5m : features.streak1m;
  const absStreak = Math.abs(effectiveStreak);

  // ── No streak: kNN direction frame ───────────────────────────────────────────
  if (absStreak === 0) {
    const isBreakout = features.volumeRatio > 1.5 && features.wickRatio < 0.2;
    const pVol = isBreakout
      ? 0.65
      : Math.min(0.65, Math.max(0.35, 0.5 + (features.volumeRatio - 1) * 0.05));
    const w1 = hasKnn ? (w?.wKnn ?? W_KNN) : 0;
    const w4 = w?.wVolume ?? W_VOLUME;
    const wT = w1 + w4;
    const p  = wT > 0 ? (w1 * pKnn + w4 * pVol) / wT : 0.5;
    return {
      // No streak + no kNN = truly indeterminate direction; caller skips.
      pComposite:  p,
      dominantDir: hasKnn ? knnDir : 'none',
      components:  { knn: pKnn, streak: 0.5, intraday: 0.5, volume: pVol },
    };
  }

  // ── Streak exists: reversal reference frame ───────────────────────────────────
  const reversalDir: 'up' | 'down' = effectiveStreak > 0 ? 'down' : 'up';

  // P_streak: configurable formula + volume exhaustion boost.
  // Exhaustion (high volume + long wick) at moderate streak lengths has empirically
  // high reversal probability — boost pStreak when detected.
  const scale   = w?.streakScale ?? 0.10;
  const cap     = w?.streakCap   ?? 0.85;
  const volBoostMinR = w?.volBoostMinRatio ?? 1.5;
  const volBoostMinW = w?.volBoostMinWick  ?? 0.4;
  const volBoostGain = w?.volBoostGain     ?? 0.10;
  const volBoostMax  = w?.volBoostMax      ?? 0.15;
  const volBoost = (features.volumeRatio > volBoostMinR && features.wickRatio > volBoostMinW)
    ? Math.min(volBoostMax, (features.volumeRatio - volBoostMinR) * volBoostGain)
    : 0;
  // Liquidity break boost: wick pierced prior 4h/24h high/low or round number → sweep reversal
  const liqBoost = features.brokeLiq ? (w?.liqBoost ?? 0.10) : 0;
  const pStreak = Math.min(cap, absStreak * scale + volBoost + liqBoost);

  // P_knn in reversal frame: does kNN vote for the reversal direction?
  const pKnnRev = knnDir === reversalDir ? pKnn : (1 - pKnn);

  // P_intraday: reversal quota availability (1.0=quota full → reversal likely)
  const pIntraday = intradayMod?.pIntraday ?? 1.0;

  // P_vol in reversal frame: exhaustion → reversal, breakout → continuation
  const isExhaustion = features.volumeRatio > 1.5 && features.wickRatio > 0.4;
  const isBreakout   = features.volumeRatio > 1.5 && features.wickRatio < 0.2;
  const pVol = isExhaustion ? 0.70 : isBreakout ? 0.30 : 0.50;

  const hasIntraday = intradayMod !== null;
  const w1 = hasKnn ? (w?.wKnn ?? W_KNN) : 0;
  const w2 = w?.wStreak   ?? W_STREAK;
  const w3 = hasIntraday ? (w?.wIntraday ?? W_INTRADAY) : 0;
  const w4 = w?.wVolume   ?? W_VOLUME;
  const wTotal = w1 + w2 + w3 + w4;

  const pComposite = (w1 * pKnnRev + w2 * pStreak + w3 * pIntraday + w4 * pVol) / wTotal;

  // When a streak exists, direction is always the reversal direction — regardless
  // of threshold. The caller decides auto vs manual status from confidence.
  return {
    pComposite,
    dominantDir: reversalDir,
    components:  { knn: pKnnRev, streak: pStreak, intraday: pIntraday, volume: pVol },
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function extractFeatures(input: AIServiceInput): Features {
  // Use direct value if provided; fall back to parsing event string (backward compat)
  let streak1m: number;
  if (input.streak1m !== undefined) {
    streak1m = input.streak1m;
  } else {
    const m = input.event.match(/(\d+) consecutive (UP|DOWN)/i);
    streak1m = m ? parseInt(m[1]!) * (m[2]!.toUpperCase() === 'UP' ? 1 : -1) : 0;
  }

  const change1h = input.trendContext
    ? input.trendContext.change24h / 24
    : 0;

  return {
    streak1m,
    streak5m:    input.streak5m   ?? 0,
    cvd1h:       input.cvd,
    change1h,
    volumeRatio: input.volumeRatio ?? 1.0,
    wickRatio:   input.wickRatio   ?? 0.0,
    brokeLiq:    input.brokeLiq    ?? false,
  };
}

function buildSignal(
  direction: 'BUY' | 'SELL',
  confidence: number,
  decided: Neighbor[],
  price: number,
  features: Features,
  horizon: string,
  status: 'auto' | 'manual' = 'auto',
): AISignalOutput {
  const group  = decided.filter(n => n.direction === (direction === 'BUY' ? 'up' : 'down'));
  const avgT1h = mean(group.map(n => n.t1h).filter((v): v is number => v !== null));
  const avgT5m = mean(group.map(n => n.t5m).filter((v): v is number => v !== null));

  const tpMove = Math.abs(avgT1h ?? 0.015);
  // Enforce minimum SL so kNN avgT5m noise (~0.02%) doesn't produce trivially tight stops
  const slMove = Math.max(Math.abs(avgT5m ?? 0.005), MIN_SL[horizon] ?? 0.003);

  const priceTarget = direction === 'BUY' ? price * (1 + tpMove) : price * (1 - tpMove);
  const stopLoss    = direction === 'BUY' ? price * (1 - slMove) : price * (1 + slMove);

  const dominant = direction === 'BUY'
    ? decided.filter(n => n.direction === 'up').length
    : decided.filter(n => n.direction === 'down').length;

  return {
    direction,
    confidence,
    status,
    priceTarget: parseFloat(priceTarget.toFixed(2)),
    stopLoss:    parseFloat(stopLoss.toFixed(2)),
    rationale:
      `k-NN composite: ${(confidence * 100).toFixed(0)}% | ` +
      `vote ${dominant}/${decided.length} | ` +
      `streak=${features.streak1m} s5m=${features.streak5m} vol=${features.volumeRatio.toFixed(1)}x wick=${(features.wickRatio * 100).toFixed(0)}%`,
  };
}

function emptyAnalysis(kbRows: number, fallbackReason: string): KNNAnalysis {
  return {
    kbRows, neighborsFound: 0, upVotes: 0, downVotes: 0,
    pUp: 0, pDown: 0, pComposite: 0, dominantDir: 'none',
    fallbackReason, signal: null,
    streakStats: null, intradayContext: null, intradayModifier: null,
    components: { knn: 0, streak: 0, intraday: 0, volume: 0 },
  };
}

function mean(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
