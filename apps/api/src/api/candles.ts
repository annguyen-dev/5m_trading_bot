import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import type { BacktestResult } from '../backtest/types.js';
import type { Candle } from '../types/market.js';
import { SignalRepository } from '../services/SignalRepository.js';

const DATA_DIR = './data';

/**
 * GET /api/run-candles/:runId
 *
 * Returns all 1m OHLCV candles for a DB-backed backtest run, as
 * `{ ts, open, high, low, close, volume }` rows (matches FE CandleRow).
 * Used by the Results page to render per-signal prev/applied candle snippets.
 */
export async function getRunCandles(req: Request, res: Response): Promise<void> {
  const runId = String(req.params['runId'] ?? '');
  try {
    const repo = new SignalRepository();
    const rows = await repo.getCandlesForRun(runId);
    res.json(rows.map(r => ({
      ts: Number(r.ts), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    })));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

/**
 * GET /api/candles/:envId?from=<ts>&to=<ts>&limit=1500
 *
 * For test envs: reads candles from the embedded backtest cache JSON.
 * For production: reads from the most recent cached OHLCV file, or
 *   falls back to fetching live data from the exchange.
 */
export function getCandles(req: Request, res: Response): void {
  const envId = String(req.params['envId'] ?? '');
  const from = req.query['from'] ? Number(req.query['from']) : 0;
  const to = req.query['to'] ? Number(req.query['to']) : Date.now();
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '1500'), 10), 5000);

  try {
    if (envId.startsWith('test/')) {
      const fileName = envId.replace('test/', '') + '.json';
      const resultPath = path.join(DATA_DIR, 'backtest', fileName);
      if (!fs.existsSync(resultPath)) {
        res.status(404).json({ error: 'Backtest result not found' });
        return;
      }

      // Backtest results don't embed candles directly — look for matching cache
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as BacktestResult;
      const { symbol, exchangeId, startDate, endDate } = result.config;
      const from_ = new Date(startDate).toISOString().split('T')[0];
      const to_ = new Date(endDate).toISOString().split('T')[0];
      const cachePattern = `${exchangeId}_${symbol.replace('/', '-')}_${from_}_${to_}`;

      const cacheDir = path.join(DATA_DIR, 'backtest');
      const cacheFiles = fs.existsSync(cacheDir)
        ? fs.readdirSync(cacheDir).filter(f => f.startsWith(cachePattern) && f.endsWith('.json'))
        : [];

      if (cacheFiles.length === 0) {
        res.status(404).json({
          error: 'Candle cache not found. Run the backtest again to populate.',
        });
        return;
      }

      const cacheData = JSON.parse(
        fs.readFileSync(path.join(cacheDir, cacheFiles[0]!), 'utf-8'),
      ) as { candles: Candle[] };

      const candles = filterAndLimit(cacheData.candles, from, to, limit);
      res.json({ candles, total: candles.length });
      return;
    }

    if (envId === 'production') {
      // Look for the most recent candle cache file
      const cacheDir = path.join(DATA_DIR, 'backtest');
      if (!fs.existsSync(cacheDir)) {
        res.json({ candles: [], total: 0, note: 'No cached candles — run a backtest first' });
        return;
      }

      const cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => f.includes('BTC-USDT') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (cacheFiles.length === 0) {
        res.json({ candles: [], total: 0 });
        return;
      }

      const cacheData = JSON.parse(
        fs.readFileSync(path.join(cacheDir, cacheFiles[0]!), 'utf-8'),
      ) as { candles: Candle[] };

      const candles = filterAndLimit(cacheData.candles, from, to, limit);
      res.json({ candles, total: candles.length });
      return;
    }

    res.status(400).json({ error: `Unknown environment: ${envId}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

function filterAndLimit(candles: Candle[], from: number, to: number, limit: number): Candle[] {
  const filtered = candles.filter(c => {
    if (from > 0 && c.timestamp < from) return false;
    if (to > 0 && c.timestamp > to) return false;
    return true;
  });
  // If too many candles, thin them out evenly to fit the limit
  if (filtered.length <= limit) return filtered;
  const step = Math.ceil(filtered.length / limit);
  return filtered.filter((_, i) => i % step === 0);
}
