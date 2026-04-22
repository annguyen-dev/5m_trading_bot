/**
 * src/client/api/poly-simulate.ts
 *
 * POST /api/poly-simulate/run  { timestamp: number, sharePrice?: number }
 *
 * Runs the PolySignalService at a historical timestamp and looks ahead
 * one 5m candle to determine Win/Loss outcome.
 */

import type { Request, Response } from 'express';
import { getPool } from '@trading-bot/db';
import { migrate } from '@trading-bot/db/migrate';
import { PolySignalService } from '../services/PolySignalService.js';

let schemaReady = false;
async function ensureReady(): Promise<void> {
  if (!schemaReady) { await migrate(); schemaReady = true; }
}

const polySignal = new PolySignalService();

export async function runPolySimulate(req: Request, res: Response): Promise<void> {
  await ensureReady();
  const pool = getPool();

  const { timestamp, sharePrice } = req.body as { timestamp?: number; sharePrice?: number };
  if (!timestamp || typeof timestamp !== 'number') {
    res.status(400).json({ error: 'timestamp (ms) required' });
    return;
  }

  try {
    // 1. Compute P_signal
    const result = await polySignal.compute(timestamp, sharePrice ?? 0.50);

    // 2. Outcome look-ahead: next 5m candle result
    if (result.direction !== 'skip') {
      const nextCandle = await pool.query<{
        open: string; close: string;
      }>(
        `SELECT
           (array_agg(open  ORDER BY ts))[1]      AS open,
           (array_agg(close ORDER BY ts DESC))[1]  AS close
         FROM ohlcv_1m
         WHERE ts > $1 AND ts <= $1 + 300000
           AND symbol = 'BTC/USDT' AND exchange = 'binance'`,
        [timestamp],
      );

      if (nextCandle.rows[0]) {
        const open      = Number(nextCandle.rows[0].open);
        const close     = Number(nextCandle.rows[0].close);
        const actual: 'up' | 'down' = close >= open ? 'up' : 'down';
        const correct   = actual === result.direction;
        const changePct = (close - open) / open;
        // PnL = actual candle % move in predicted direction (+ve = win, -ve = loss)
        const pnlPct    = result.direction === 'up' ? changePct : -changePct;

        result.outcome = {
          actual,
          correct,
          pnlPct,
          entryPrice: open,
          exitPrice:  close,
          changePct,
          changeUsd:  close - open,
        };
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
