/**
 * src/client/api/simulate.ts
 *
 * Simulate tab API:
 *   GET  /api/simulate/candles?from=ISO&to=ISO  — OHLCV candles for chart
 *   POST /api/simulate/run                       — run signal pipeline at a timestamp
 */

import type { Request, Response } from 'express';
import { getPool } from '@trading-bot/db';
import { migrate } from '@trading-bot/db/migrate';
import { AIService } from '../services/AIService.js';
import { StatisticalSignalService } from '../services/StatisticalSignalService.js';
import type { AIServiceInput } from '../services/AIService.js';

let schemaReady = false;
async function ensureReady(): Promise<void> {
  if (!schemaReady) { await migrate(); schemaReady = true; }
}

// ── GET /api/simulate/candles ─────────────────────────────────────────────────

export async function getSimulateCandles(req: Request, res: Response): Promise<void> {
  await ensureReady();
  const pool = getPool();

  const from = new Date(String(req.query['from'] ?? '')).getTime();
  const to   = new Date(String(req.query['to']   ?? '')).getTime();

  if (isNaN(from) || isNaN(to)) {
    res.status(400).json({ error: 'from and to must be valid ISO dates' });
    return;
  }

  try {
    const result = await pool.query<{
      ts: string; open: string; high: string; low: string; close: string; volume: string;
    }>(
      `SELECT ts, open, high, low, close, volume
       FROM ohlcv_1m
       WHERE ts >= $1 AND ts < $2
         AND symbol   = 'BTC/USDT'
         AND exchange = 'binance'
       ORDER BY ts
       LIMIT 2000`,
      [from, to],
    );

    const candles = result.rows.map(r => ({
      time:   Math.floor(Number(r.ts) / 1000), // LightweightCharts expects seconds
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
    }));
    res.json({ candles });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── POST /api/simulate/run ────────────────────────────────────────────────────

const ai    = new AIService('claude-haiku-4-5-20251001'); // cheap model for simulate
const statAI = new StatisticalSignalService();

export async function runSimulate(req: Request, res: Response): Promise<void> {
  await ensureReady();
  const pool = getPool();

  const { timestamp } = req.body as { timestamp?: number };
  if (!timestamp || typeof timestamp !== 'number') {
    res.status(400).json({ error: 'timestamp (ms) required' });
    return;
  }

  try {
    // 1. Load last 201 candles ending at timestamp
    const candleRows = await pool.query<{
      ts: string; open: string; high: string; low: string; close: string; volume: string;
    }>(
      `SELECT ts, open, high, low, close, volume
       FROM ohlcv_1m
       WHERE ts <= $1 AND symbol = 'BTC/USDT' AND exchange = 'binance'
       ORDER BY ts DESC LIMIT 201`,
      [timestamp],
    );

    const candles = candleRows.rows
      .map(r => ({
        ts:    Number(r.ts),
        open:  Number(r.open),
        high:  Number(r.high),
        low:   Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }))
      .reverse(); // oldest first

    if (candles.length < 21) {
      res.status(400).json({ error: 'Not enough candle history at this timestamp (need 21+)' });
      return;
    }

    // 2. Compute EMA-20
    const EMA_K = 2 / 21;
    let ema = candles[0]!.close;
    for (let i = 1; i < candles.length; i++) {
      ema = candles[i]!.close * EMA_K + ema * (1 - EMA_K);
    }

    // Compute signed streak at last candle: +N = N consecutive up, -N = N consecutive down
    const last = candles[candles.length - 1]!;
    const lastIsUp = last.close >= candles[candles.length - 2]!.close;
    let streakLen = 1;
    for (let j = candles.length - 2; j > 0; j--) {
      const isUp = candles[j]!.close >= candles[j - 1]!.close;
      if (isUp === lastIsUp) streakLen++;
      else break;
    }
    const streak = lastIsUp ? streakLen : -streakLen;

    const target = candles[candles.length - 1]!;
    const deviation = (target.close - ema) / ema;
    const trendLabel = deviation >= 0 ? 'above' : 'below';
    // Include streak in event description so extractFeatures() can parse it
    const streakAbs = Math.abs(streak);
    const streakDir = streak > 0 ? 'UP' : 'DOWN';
    const eventDesc = streakAbs >= 2
      ? `${streakAbs} consecutive ${streakDir} candles — price ${trendLabel} 20-EMA by ${Math.abs(deviation * 100).toFixed(2)}%`
      : `Price ${trendLabel} 20-EMA by ${Math.abs(deviation * 100).toFixed(2)}% at $${target.close.toLocaleString()}`;

    // 3. Build TrendContext
    const c24h = candles.length >= 1440 ? candles[candles.length - 1440]! : candles[0]!;
    const c7d  = candles.length >= 10080 ? candles[candles.length - 10080]! : candles[0]!;
    const change24h = (target.close - c24h.close) / c24h.close;
    const change7d  = (target.close - c7d.close)  / c7d.close;
    const trend: 'uptrend' | 'downtrend' | 'sideways' = change24h > 0.01 ? 'uptrend' : change24h < -0.01 ? 'downtrend' : 'sideways';
    const trendContext = { trend, change24h, change7d, ema20: ema, deviationFromEma: deviation };

    // 4. Load active macro events (last 72h from DB)
    const macroRows = await pool.query<{ category: string; title: string; ts: string }>(
      `SELECT category, title, ts FROM macro_events
       WHERE ts >= $1 AND ts <= $2 ORDER BY ts DESC LIMIT 10`,
      [timestamp - 72 * 3_600_000, timestamp],
    );
    const macroContext = macroRows.rows.length > 0
      ? '## Active Macro Events\n' +
        macroRows.rows.map(r => {
          const hoursAgo = ((timestamp - Number(r.ts)) / 3_600_000).toFixed(1);
          return `• [${r.category}] ${r.title} (${hoursAgo}h ago)`;
        }).join('\n')
      : '## Active Macro Events\nNone in last 72h.';

    // 5. Compute candle shape features for richer k-NN
    const range       = target.high - target.low;
    const body        = Math.abs(target.close - target.open);
    const upperWick   = target.high - Math.max(target.close, target.open);
    const lowerWick   = Math.min(target.close, target.open) - target.low;
    const wickRatio   = range > 0 ? (upperWick + lowerWick) / range : 0;

    // volume ratio: target volume vs 20-candle avg
    const recentVols  = candles.slice(-21, -1).map(c => c.volume);
    const avgVol      = recentVols.reduce((a, b) => a + b, 0) / Math.max(recentVols.length, 1);
    const volumeRatio = avgVol > 0 ? target.volume / avgVol : 1;

    // 6. Build AIServiceInput
    const input: AIServiceInput = {
      asset:             'BTC/USDT',
      horizon:           'mid',
      price:             target.close,
      cvd:               0,
      divergence:        0,
      event:             eventDesc,
      historicalContext: macroContext,
      mmTrapStatus:      'No MM trap analysis (simulate mode)',
      trendContext,
      volumeRatio,
      wickRatio,
    };

    // 7. Try k-NN first, fall back to Claude
    const analysis = await statAI.analyze(input, timestamp);
    let engine: 'knn' | 'claude';
    let finalResult;

    if (analysis.signal !== null) {
      finalResult = analysis.signal;
      engine = 'knn';
    } else {
      finalResult = await ai.reason(input);
      engine = 'claude';
    }

    // Strip `signal` from knnAnalysis to avoid duplication
    const { signal: _signal, ...knnAnalysis } = analysis;
    void _signal;

    // 7. Outcome look-ahead: check up to 120 candles AFTER timestamp
    let outcome: { result: 'win' | 'loss' | 'open'; pnlPct: number | null; minutesToOutcome: number | null };

    if (finalResult.direction === 'HOLD') {
      outcome = { result: 'open', pnlPct: null, minutesToOutcome: null };
    } else {
      const futureRows = await pool.query<{
        ts: string; high: string; low: string; close: string;
      }>(
        `SELECT ts, high, low, close
         FROM ohlcv_1m
         WHERE ts > $1 AND symbol = 'BTC/USDT' AND exchange = 'binance'
         ORDER BY ts
         LIMIT 120`,
        [timestamp],
      );

      const entry = target.close;
      const tp = finalResult.priceTarget;
      const sl = finalResult.stopLoss;
      outcome = { result: 'open', pnlPct: null, minutesToOutcome: null };

      for (const row of futureRows.rows) {
        const h = Number(row.high);
        const l = Number(row.low);
        const minutesElapsed = Math.round((Number(row.ts) - timestamp) / 60_000);

        if (finalResult.direction === 'BUY') {
          const tpHit = tp != null && h >= tp;
          const slHit = sl != null && l <= sl;
          if (tpHit && slHit) {
            // Both hit same candle — assume TP hit first (conservative optimism)
            outcome = { result: 'win', pnlPct: (tp! - entry) / entry, minutesToOutcome: minutesElapsed };
            break;
          } else if (tpHit) {
            outcome = { result: 'win', pnlPct: (tp! - entry) / entry, minutesToOutcome: minutesElapsed };
            break;
          } else if (slHit) {
            outcome = { result: 'loss', pnlPct: (sl! - entry) / entry, minutesToOutcome: minutesElapsed };
            break;
          }
        } else { // SELL
          const tpHit = tp != null && l <= tp;
          const slHit = sl != null && h >= sl;
          if (tpHit && slHit) {
            outcome = { result: 'win', pnlPct: (entry - tp!) / entry, minutesToOutcome: minutesElapsed };
            break;
          } else if (tpHit) {
            outcome = { result: 'win', pnlPct: (entry - tp!) / entry, minutesToOutcome: minutesElapsed };
            break;
          } else if (slHit) {
            outcome = { result: 'loss', pnlPct: (entry - sl!) / entry, minutesToOutcome: minutesElapsed };
            break;
          }
        }
      }
    }

    res.json({
      timestamp,
      price:      target.close,
      ema,
      deviation,
      trendContext,
      candle: {
        open:   target.open,
        high:   target.high,
        low:    target.low,
        close:  target.close,
        volume: target.volume,
      },
      signal: {
        direction:   finalResult.direction,
        confidence:  finalResult.confidence,
        rationale:   finalResult.rationale,
        priceTarget: finalResult.priceTarget,
        stopLoss:    finalResult.stopLoss,
        engine,
      },
      knnAnalysis,
      outcome,
      macroEvents: macroRows.rows.map(r => ({
        category: r.category,
        title:    r.title,
        hoursAgo: ((timestamp - Number(r.ts)) / 3_600_000).toFixed(1),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
