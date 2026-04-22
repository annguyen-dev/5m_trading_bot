/**
 * POST /api/formula/analyze
 *
 * Computes reversal statistics from kb_snapshots (derived from raw ohlcv_1m candles)
 * then asks Claude to suggest optimal formula weights based on the data.
 *
 * Body: { days?: number (default 90), minSamples?: number (default 30) }
 */
import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getPool } from '@trading-bot/db';
import { config } from '../config/index.js';
import type { FormulaWeights } from '../backtest/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreakStat {
  absStreak:    number;
  total:        number;
  reversals:    number;
  reversalRate: number;
  avgVolRatio:  number;
  avgWickRatio: number;
}

export interface VolBucket {
  bucket:       string;
  total:        number;
  reversals:    number;
  reversalRate: number;
}

export interface ComboBucket {
  combo:        string;
  total:        number;
  reversals:    number;
  reversalRate: number;
}

export interface TimingStat {
  absStreak:      number;
  total:          number;
  reversal5mRate: number;
  reversal1hRate: number;
  contRate:       number;
}

export interface CrossTabRow {
  streak5mRange: string;   // '1-2' | '3-4' | '5-6' | '7+'
  volBucket:     string;   // 'low' | 'mid' | 'high'
  alignment:     string;   // 'same_dir' | 'opp_dir' | 'flat_1m'
  total:         number;
  reversals:     number;
  reversalRate:  number;
}

export interface StreakVolRow {
  absStreak5m:  number;
  volBucket:    string;   // 'low' | 'mid' | 'high'
  total:        number;
  reversals:    number;
  reversalRate: number;
}

export interface LiqBreakRow {
  absStreak5m:  number;
  brokeLiq:     boolean;
  total:        number;
  reversals:    number;
  reversalRate: number;
}

export interface AnalysisStats {
  byStreak1m:     StreakStat[];
  byStreak5m:     StreakStat[];
  byVolume:       VolBucket[];
  byCombo:        ComboBucket[];
  byTiming:       TimingStat[];
  crossTab:       CrossTabRow[];
  byStreakVolume: StreakVolRow[];   // s5m × vol bucket
  byLiqBreak:     LiqBreakRow[];    // s5m × liquidity break
  totalSamples:   number;
  daysOfData:     number;
}

export interface AnalyzeResult {
  stats:            AnalysisStats;
  suggestedWeights: FormulaWeights;
  reasoning:        Record<string, string>;
  insights:         string[];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function analyzeFormula(req: Request, res: Response): Promise<void> {
  const days       = Math.min(365, Math.max(7,  parseInt(String(req.body.days       ?? 90))));
  const minSamples = Math.max(10,               parseInt(String(req.body.minSamples ?? 30)));

  const pool = getPool();

  try {
    // Anchor "recent N days" to the latest available KB timestamp, not wall-clock time.
    const maxTsRes = await pool.query<{ max_ts: string }>(
      `SELECT MAX(ts) AS max_ts FROM kb_snapshots WHERE direction IN ('up', 'down')`,
    );
    const maxTs   = Number(maxTsRes.rows[0]?.max_ts ?? Date.now());
    const sinceTs = maxTs - days * 86_400_000;

    // Run all stat queries in parallel
    const [
      streakRes1m, streakRes5m, volRes, comboRes, timingRes, crossTabRes,
      streakVolRes, liqBreakRes,
    ] = await Promise.all([

      // A. Reversal rate by abs(streak_1m)
      pool.query<{ abs_streak: string; total: string; reversals: string; avg_vol: string; avg_wick: string }>(
        `SELECT
           ABS(streak_1m)                                                AS abs_streak,
           COUNT(*)                                                      AS total,
           COUNT(*) FILTER (
             WHERE (streak_1m > 0 AND direction = 'down')
                OR (streak_1m < 0 AND direction = 'up')
           )                                                             AS reversals,
           ROUND(AVG(volume_ratio)::numeric, 3)                         AS avg_vol,
           ROUND(AVG(wick_ratio)::numeric,   3)                         AS avg_wick
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND streak_1m != 0 AND ts >= $1
         GROUP BY ABS(streak_1m)
         HAVING COUNT(*) >= $2
         ORDER BY ABS(streak_1m)`,
        [sinceTs, minSamples],
      ),

      // B. Reversal rate by abs(streak_5m)
      pool.query<{ abs_streak: string; total: string; reversals: string; avg_vol: string; avg_wick: string }>(
        `SELECT
           ABS(streak_5m)                                                AS abs_streak,
           COUNT(*)                                                      AS total,
           COUNT(*) FILTER (
             WHERE (streak_5m > 0 AND direction = 'down')
                OR (streak_5m < 0 AND direction = 'up')
           )                                                             AS reversals,
           ROUND(AVG(volume_ratio)::numeric, 3)                         AS avg_vol,
           ROUND(AVG(wick_ratio)::numeric,   3)                         AS avg_wick
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND streak_5m != 0 AND ts >= $1
         GROUP BY ABS(streak_5m)
         HAVING COUNT(*) >= $2
         ORDER BY ABS(streak_5m)`,
        [sinceTs, minSamples],
      ),

      // C. Volume effect (streak_1m >= 3)
      pool.query<{ bucket: string; total: string; reversals: string }>(
        `SELECT
           CASE WHEN volume_ratio < 0.7 THEN 'low'
                WHEN volume_ratio < 1.3 THEN 'mid'
                ELSE                         'high' END  AS bucket,
           COUNT(*)                                      AS total,
           COUNT(*) FILTER (
             WHERE (streak_1m > 0 AND direction = 'down')
                OR (streak_1m < 0 AND direction = 'up')
           )                                             AS reversals
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND ABS(streak_1m) >= 3 AND ts >= $1
         GROUP BY 1 ORDER BY 1`,
        [sinceTs],
      ),

      // D. Streak combo: streak_1m vs streak_5m direction
      pool.query<{ combo: string; total: string; reversals: string }>(
        `SELECT
           CASE
             WHEN streak_5m = 0 THEN 'flat_5m'
             WHEN (streak_1m > 0 AND streak_5m > 0)
               OR (streak_1m < 0 AND streak_5m < 0) THEN 'same_dir'
             ELSE 'opposite_dir'
           END                   AS combo,
           COUNT(*)              AS total,
           COUNT(*) FILTER (
             WHERE (streak_1m > 0 AND direction = 'down')
                OR (streak_1m < 0 AND direction = 'up')
           )                     AS reversals
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND ABS(streak_1m) >= 3 AND ts >= $1
         GROUP BY 1 ORDER BY 1`,
        [sinceTs],
      ),

      // E. Reversal timing: fast (5m) vs slow (1h) + continuation rate
      pool.query<{
        abs_streak: string; total: string;
        rev_5m: string; rev_1h: string; cont_1m: string;
      }>(
        `SELECT
           ABS(streak_1m)                                                AS abs_streak,
           COUNT(*)                                                      AS total,
           COUNT(*) FILTER (
             WHERE t5m IS NOT NULL
               AND ((streak_1m > 0 AND t5m < 0) OR (streak_1m < 0 AND t5m > 0))
           )                                                             AS rev_5m,
           COUNT(*) FILTER (
             WHERE (streak_1m > 0 AND direction = 'down')
                OR (streak_1m < 0 AND direction = 'up')
           )                                                             AS rev_1h,
           COUNT(*) FILTER (
             WHERE t1m IS NOT NULL
               AND ((streak_1m > 0 AND t1m > 0) OR (streak_1m < 0 AND t1m < 0))
           )                                                             AS cont_1m
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND ABS(streak_1m) >= 2 AND ts >= $1
         GROUP BY ABS(streak_1m)
         HAVING COUNT(*) >= $2
         ORDER BY ABS(streak_1m)`,
        [sinceTs, minSamples],
      ),

      // F. Cross-tabulation: streak_5m × volume × 1m-5m alignment
      pool.query<{ streak5m_range: string; vol: string; align: string; total: string; reversals: string }>(
        `SELECT
           CASE
             WHEN ABS(streak_5m) BETWEEN 1 AND 2 THEN '1-2'
             WHEN ABS(streak_5m) BETWEEN 3 AND 4 THEN '3-4'
             WHEN ABS(streak_5m) BETWEEN 5 AND 6 THEN '5-6'
             ELSE '7+'
           END                                                           AS streak5m_range,
           CASE
             WHEN volume_ratio < 0.7 THEN 'low'
             WHEN volume_ratio < 1.3 THEN 'mid'
             ELSE                         'high'
           END                                                           AS vol,
           CASE
             WHEN streak_1m = 0 THEN 'flat_1m'
             WHEN (streak_1m > 0 AND streak_5m > 0)
               OR (streak_1m < 0 AND streak_5m < 0) THEN 'same_dir'
             ELSE 'opp_dir'
           END                                                           AS align,
           COUNT(*)                                                      AS total,
           COUNT(*) FILTER (
             WHERE (streak_5m > 0 AND direction = 'down')
                OR (streak_5m < 0 AND direction = 'up')
           )                                                             AS reversals
         FROM kb_snapshots
         WHERE direction IN ('up', 'down') AND streak_5m != 0 AND ts >= $1
         GROUP BY 1, 2, 3
         HAVING COUNT(*) >= $2
         ORDER BY (COUNT(*) FILTER (
           WHERE (streak_5m > 0 AND direction = 'down')
              OR (streak_5m < 0 AND direction = 'up')
         ))::float / COUNT(*) DESC`,
        [sinceTs, minSamples],
      ),

      // G. s5m × volume bucket — clean 2D for calibrating volBoost
      pool.query<{ abs_streak: string; vol: string; total: string; reversals: string }>(
        `SELECT
           ABS(streak_5m)  AS abs_streak,
           CASE
             WHEN volume_ratio < 1.0 THEN 'low'
             WHEN volume_ratio < 1.5 THEN 'mid'
             WHEN volume_ratio < 2.5 THEN 'high'
             ELSE                         'extreme'
           END              AS vol,
           COUNT(*)         AS total,
           COUNT(*) FILTER (
             WHERE (streak_5m > 0 AND direction = 'down')
                OR (streak_5m < 0 AND direction = 'up')
           )                AS reversals
         FROM kb_snapshots
         WHERE direction IN ('up', 'down')
           AND ABS(streak_5m) >= 4
           AND ts >= $1
         GROUP BY 1, 2
         HAVING COUNT(*) >= $2
         ORDER BY 1, 2`,
        [sinceTs, minSamples],
      ),

      // H. s5m × broke_liq — computed on-the-fly from ohlcv_1m windows
      //    broke_liq = candle wick pierced prior 4h high/low (proxy for liquidity sweep)
      pool.query<{ abs_streak: string; broke_liq: boolean; total: string; reversals: string }>(
        `WITH candle_liq AS (
           SELECT
             o.ts,
             (o.high > MAX(o.high) OVER (
                ORDER BY o.ts ROWS BETWEEN 240 PRECEDING AND 1 PRECEDING))
           OR (o.low  < MIN(o.low)  OVER (
                ORDER BY o.ts ROWS BETWEEN 240 PRECEDING AND 1 PRECEDING)) AS broke_liq
           FROM ohlcv_1m o
           WHERE o.symbol = 'BTC/USDT' AND o.exchange = 'binance' AND o.ts >= $1
         )
         SELECT
           ABS(k.streak_5m) AS abs_streak,
           COALESCE(c.broke_liq, false) AS broke_liq,
           COUNT(*)         AS total,
           COUNT(*) FILTER (
             WHERE (k.streak_5m > 0 AND k.direction = 'down')
                OR (k.streak_5m < 0 AND k.direction = 'up')
           )                AS reversals
         FROM kb_snapshots k
         LEFT JOIN candle_liq c ON c.ts = k.ts
         WHERE k.direction IN ('up', 'down')
           AND ABS(k.streak_5m) >= 4
           AND k.ts >= $1
         GROUP BY 1, 2
         HAVING COUNT(*) >= $2
         ORDER BY 1, 2`,
        [sinceTs, minSamples],
      ),
    ]);

    const toStreakStats = (rows: typeof streakRes1m.rows): StreakStat[] =>
      rows.map(r => ({
        absStreak:    Number(r.abs_streak),
        total:        Number(r.total),
        reversals:    Number(r.reversals),
        reversalRate: Number(r.reversals) / Number(r.total),
        avgVolRatio:  Number(r.avg_vol),
        avgWickRatio: Number(r.avg_wick),
      }));

    const byStreak1m = toStreakStats(streakRes1m.rows);
    const byStreak5m = toStreakStats(streakRes5m.rows);

    const byVolume: VolBucket[] = volRes.rows.map(r => ({
      bucket:       r.bucket,
      total:        Number(r.total),
      reversals:    Number(r.reversals),
      reversalRate: Number(r.reversals) / Number(r.total),
    }));

    const byCombo: ComboBucket[] = comboRes.rows.map(r => ({
      combo:        r.combo,
      total:        Number(r.total),
      reversals:    Number(r.reversals),
      reversalRate: Number(r.reversals) / Number(r.total),
    }));

    const byTiming: TimingStat[] = timingRes.rows.map(r => {
      const total = Number(r.total);
      return {
        absStreak:      Number(r.abs_streak),
        total,
        reversal5mRate: Number(r.rev_5m)  / total,
        reversal1hRate: Number(r.rev_1h)  / total,
        contRate:       Number(r.cont_1m) / total,
      };
    });

    const crossTab: CrossTabRow[] = crossTabRes.rows.map(r => ({
      streak5mRange: r.streak5m_range,
      volBucket:     r.vol,
      alignment:     r.align,
      total:         Number(r.total),
      reversals:     Number(r.reversals),
      reversalRate:  Number(r.reversals) / Number(r.total),
    }));

    const byStreakVolume: StreakVolRow[] = streakVolRes.rows.map(r => ({
      absStreak5m:  Number(r.abs_streak),
      volBucket:    r.vol,
      total:        Number(r.total),
      reversals:    Number(r.reversals),
      reversalRate: Number(r.reversals) / Number(r.total),
    }));

    const byLiqBreak: LiqBreakRow[] = liqBreakRes.rows.map(r => ({
      absStreak5m:  Number(r.abs_streak),
      brokeLiq:     Boolean(r.broke_liq),
      total:        Number(r.total),
      reversals:    Number(r.reversals),
      reversalRate: Number(r.reversals) / Number(r.total),
    }));

    const totalSamples = byStreak1m.reduce((s, r) => s + r.total, 0);
    const stats: AnalysisStats = {
      byStreak1m, byStreak5m, byVolume, byCombo, byTiming, crossTab,
      byStreakVolume, byLiqBreak,
      totalSamples, daysOfData: days,
    };

    if (totalSamples === 0) {
      res.status(422).json({ error: 'Not enough KB data (direction=null for all rows). Run SnapshotBuilder to label outcomes.' });
      return;
    }

    // ── Call Claude via tool_use (enforces schema) ────────────────────────────
    const client  = new Anthropic({ apiKey: config.anthropicApiKey });
    const message = await client.messages.create({
      model:       'claude-sonnet-4-6',
      max_tokens:  1024,
      tool_choice: { type: 'tool', name: 'suggest_weights' },
      tools: [{
        name:        'suggest_weights',
        description: 'Output suggested formula weights and analysis based on the provided statistics.',
        input_schema: {
          type: 'object',
          properties: {
            weights: {
              type: 'object',
              properties: {
                wKnn:                { type: 'number' },
                wStreak:             { type: 'number' },
                wIntraday:           { type: 'number' },
                wVolume:             { type: 'number' },
                confidenceThreshold: { type: 'number' },
                streakScale:         { type: 'number' },
                streakCap:           { type: 'number' },
                volBoostMinRatio:    { type: 'number' },
                volBoostMinWick:     { type: 'number' },
                volBoostGain:        { type: 'number' },
                volBoostMax:         { type: 'number' },
                liqBoost:            { type: 'number' },
                thresholdByStreak:   {
                  type: 'object',
                  description: 'Per |streak_5m| threshold override. Keys are "4","5","6","7","8","9","10"; values 0.45–0.90.',
                  additionalProperties: { type: 'number' },
                },
              },
              required: [
                'wKnn', 'wStreak', 'wIntraday', 'wVolume',
                'confidenceThreshold', 'streakScale', 'streakCap',
                'volBoostMinRatio', 'volBoostMinWick', 'volBoostGain', 'volBoostMax',
                'liqBoost', 'thresholdByStreak',
              ],
            },
            reasoning: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            insights: { type: 'array', items: { type: 'string' } },
          },
          required: ['weights', 'reasoning', 'insights'],
        },
      }],
      messages: [{ role: 'user', content: buildPrompt(stats) }],
    });

    const toolBlock = message.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    if (!toolBlock) throw new Error('Claude did not call suggest_weights tool');

    const parsed = toolBlock.input as { weights: FormulaWeights; reasoning: Record<string, string>; insights: string[] };
    res.json({ stats, suggestedWeights: parsed.weights, reasoning: parsed.reasoning, insights: parsed.insights } satisfies AnalyzeResult);
  } catch (err) {
    console.error('[formula-analyze] error:', err);
    res.status(500).json({ error: String(err) });
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(stats: AnalysisStats): string {
  const fmt = (rows: StreakStat[]) => rows.length > 0
    ? rows.map(r =>
        `  streak=${r.absStreak}: n=${r.total}, reversal_1h=${(r.reversalRate * 100).toFixed(1)}%, ` +
        `avg_vol=${r.avgVolRatio.toFixed(2)}, avg_wick=${r.avgWickRatio.toFixed(2)}`,
      ).join('\n')
    : '  (no data)';

  const tableVol = stats.byVolume.length > 0
    ? stats.byVolume.map(r => `  vol_${r.bucket}: n=${r.total}, reversal=${(r.reversalRate * 100).toFixed(1)}%`).join('\n')
    : '  (no data)';

  const tableCombo = stats.byCombo.length > 0
    ? stats.byCombo.map(r => `  ${r.combo}: n=${r.total}, reversal=${(r.reversalRate * 100).toFixed(1)}%`).join('\n')
    : '  (no data)';

  const tableTiming = stats.byTiming.length > 0
    ? stats.byTiming.map(r =>
        `  streak=${r.absStreak}: n=${r.total}, ` +
        `rev_5m=${(r.reversal5mRate * 100).toFixed(1)}%, rev_1h=${(r.reversal1hRate * 100).toFixed(1)}%, ` +
        `continuation_1m=${(r.contRate * 100).toFixed(1)}%`,
      ).join('\n')
    : '  (no data)';

  const tableCrossTab = stats.crossTab.length > 0
    ? stats.crossTab.map(r =>
        `  streak5m=${r.streak5mRange} + vol=${r.volBucket} + align=${r.alignment}: ` +
        `n=${r.total}, reversal=${(r.reversalRate * 100).toFixed(1)}%`,
      ).join('\n')
    : '  (no data)';

  const tableStreakVol = stats.byStreakVolume.length > 0
    ? stats.byStreakVolume.map(r =>
        `  s5m=${r.absStreak5m} + vol=${r.volBucket}: n=${r.total}, reversal=${(r.reversalRate * 100).toFixed(1)}%`,
      ).join('\n')
    : '  (no data)';

  const tableLiqBreak = stats.byLiqBreak.length > 0
    ? stats.byLiqBreak.map(r =>
        `  s5m=${r.absStreak5m} + brokeLiq=${r.brokeLiq}: n=${r.total}, reversal=${(r.reversalRate * 100).toFixed(1)}%`,
      ).join('\n')
    : '  (no data)';

  return `You are a quantitative analyst. Analyze BTC/USDT market statistics derived from ${stats.totalSamples.toLocaleString()} raw candles (last ${stats.daysOfData} days) and suggest optimal formula weights.

All statistics are computed from actual price behavior — NOT from trading bot performance.

## A. Reversal rate by streak_1m (consecutive 1m candles same direction)
(reversal_1h = price reversed direction within 1h; avg_vol = volume ratio vs 20m avg)
${fmt(stats.byStreak1m)}

## B. Reversal rate by streak_5m (consecutive 5m candles same direction)
(stronger momentum signal — does longer timeframe streak predict reversal better?)
${fmt(stats.byStreak5m)}

## C. Volume effect on reversal (streak_1m >= 3)
(does volume level at time of streak affect reversal probability?)
${tableVol}

## D. Streak combo: streak_1m direction vs streak_5m direction
(same_dir = 5m confirms 1m trend; opposite_dir = 5m already reversing)
${tableCombo}

## E. Reversal timing + continuation (by streak_1m length)
(rev_5m = reversed within 5m candles; rev_1h = reversed within 1h; continuation_1m = streak continued 1+ more candle)
${tableTiming}

## Formula structure
pComposite = (wKnn×P_knn + wStreak×P_streak + wIntraday×P_intraday + wVolume×P_vol) / sum(weights)
P_streak = min(streakCap, |streak_5m| × streakScale + volBoost + liqBoost)
  volBoost = clamp(0, volBoostMax, (volRatio - volBoostMinRatio) × volBoostGain)
             when volRatio > volBoostMinRatio AND wick > volBoostMinWick, else 0
  liqBoost = liqBoost when brokeLiq=true else 0
Signal fires if pComposite >= threshold, where threshold = thresholdByStreak[|s5m|] ?? confidenceThreshold

Components:
- P_knn:      k-NN historical similarity (0–1, dropped when no neighbors)
- P_streak:   reversal probability from streak length + volume/liquidity boosts
- P_intraday: today's reversal quota availability (1.0=none used, 0.2=quota exhausted)
- P_vol:      volume pattern (0.70=exhaustion→reversal, 0.30=breakout→continuation, 0.50=neutral)

Constraints:
- wKnn + wStreak + wIntraday + wVolume = 1.0
- streakScale: 0.05–0.20, streakCap: 0.60–0.95
- confidenceThreshold: 0.45–0.75
- volBoostMinRatio: 1.0–3.0, volBoostMinWick: 0.1–0.9, volBoostGain: 0–0.30, volBoostMax: 0–0.30
- liqBoost: 0–0.30
- thresholdByStreak: object MUST contain entries for every |s5m| in {4,5,6,7,8,9,10} with values 0.45–0.90.
  Higher streaks should generally have HIGHER thresholds (rarer → higher conviction needed). Calibrate each
  entry from the observed reversal rate at that streak in table B / G / H — e.g. if |s5m|=5 has reversal ~62%,
  set threshold ≈ 0.62. Never leave keys out; if data is thin, interpolate from neighbouring streaks.

## F. Cross-tabulation: streak_5m × volume × 1m-5m alignment (sorted by reversal rate desc)
${tableCrossTab}

## G. streak_5m × volume bucket (|s5m|≥4) — calibrate volBoost thresholds
(If reversal rate jumps sharply at high/extreme volume buckets, increase volBoostGain/volBoostMax)
${tableStreakVol}

## H. streak_5m × broke_liq (|s5m|≥4) — calibrate liqBoost
(brokeLiq=true means candle wick pierced prior 4h high/low. Compare reversal rate true vs false at each streak)
${tableLiqBreak}

Base suggestions on the actual data patterns above.
- Use G to calibrate volBoostGain (gap between low and high vol buckets) and volBoostMinRatio.
- Use H to calibrate liqBoost — suggested = (reversalRate[brokeLiq=true] - reversalRate[brokeLiq=false]) averaged across streak levels, capped at 0.20.
- Use B combined with G/H to set thresholdByStreak — higher |s5m| should need higher threshold.
Call the suggest_weights tool.`;
}
