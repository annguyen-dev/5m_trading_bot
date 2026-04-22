/**
 * src/services/SignalRepository.ts
 *
 * Persists backtest runs and signal outcomes to PostgreSQL.
 * Used by BacktestEngine to write, and the /api/simulate/* endpoints to read.
 */

import { getPool } from '@trading-bot/db';
import type { SignalOutcome } from '../backtest/types.js';

export interface RunRow {
  id: string;
  label: string;
  exchange: string;
  symbol: string;
  from_ts: number;
  to_ts: number;
  ai_model: string | null;
  formula_config_id: string | null;
  total_signals: number;
  created_at: number;
  // Joined from formula_configs
  formula_name?: string;
  formula_weights?: Record<string, number>;
}

export interface SignalRow {
  id: string;
  run_id: string | null;
  candle_ts: number;
  exchange: string;
  symbol: string;
  horizon: string;
  direction: string;
  confidence: number | null;
  price_entry: number | null;
  price_target: number | null;
  stop_loss: number | null;
  rationale: string | null;
  mm_trap_flag: number;
  mm_trap_type: string;
  engine: string;
  /** 'auto' = confidence ≥ threshold; 'manual' = user reviews before trading */
  status: string;
  outcome: string;
  exit_reason: string | null;
  exit_price: number | null;
  pnl_pct: number | null;
}

export class SignalRepository {
  async saveRun(run: {
    id: string;
    label: string;
    exchange: string;
    symbol: string;
    fromTs: number;
    toTs: number;
    aiModel?: string;
    formulaConfigId?: string;
    totalSignals?: number;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO backtest_runs (id, label, exchange, symbol, from_ts, to_ts, ai_model, formula_config_id, total_signals, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [run.id, run.label, run.exchange, run.symbol, run.fromTs, run.toTs,
       run.aiModel ?? null, run.formulaConfigId ?? null, run.totalSignals ?? 0, Date.now()],
    );
  }

  /** Bulk-insert all outcomes for a run in one transaction */
  async saveOutcomes(runId: string, outcomes: SignalOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const o of outcomes) {
        const s = o.signal;
        await client.query(
          `INSERT INTO signals (
            id, run_id, candle_ts, exchange, symbol, horizon, direction,
            confidence, price_entry, price_target, stop_loss, rationale,
            mm_trap_flag, mm_trap_type, engine, status, outcome, exit_reason, exit_price, pnl_pct
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (id) DO UPDATE SET
            outcome = EXCLUDED.outcome,
            exit_reason = EXCLUDED.exit_reason,
            exit_price = EXCLUDED.exit_price,
            pnl_pct = EXCLUDED.pnl_pct`,
          [
            s.id,
            runId,
            s.timestamp,             // candle_ts: backtest stamps signal with candle time
            'binance',
            s.asset ?? 'BTC/USDT',
            s.horizon,
            s.direction,
            s.confidence,
            o.entryPrice,
            s.priceTarget ?? null,
            s.stopLoss   ?? null,
            s.rationale,
            s.mmTrapFlag ? 1 : 0,
            s.mmTrapType,
            s.engine,
            s.status ?? 'auto',
            o.outcome,
            o.exitReason ?? null,
            o.evalPrice  ?? null,
            o.pnlPct     ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getRuns(): Promise<RunRow[]> {
    const pool = getPool();
    const { rows } = await pool.query<RunRow>(
      `SELECT r.*, f.name AS formula_name, f.weights AS formula_weights
       FROM backtest_runs r
       LEFT JOIN formula_configs f ON r.formula_config_id = f.id
       ORDER BY r.created_at DESC LIMIT 100`,
    );
    return rows;
  }

  async getSignalsForRun(runId: string): Promise<SignalRow[]> {
    const pool = getPool();
    const { rows } = await pool.query<SignalRow>(
      `SELECT * FROM signals WHERE run_id = $1 ORDER BY candle_ts ASC`,
      [runId],
    );
    return rows;
  }

  /** Fetch 1m candles from ohlcv_1m for the run's time range */
  async getCandlesForRun(runId: string): Promise<{ ts: number; open: number; high: number; low: number; close: number; volume: number }[]> {
    const pool = getPool();
    const { rows: runRows } = await pool.query<RunRow>(
      `SELECT exchange, symbol, from_ts, to_ts FROM backtest_runs WHERE id = $1`,
      [runId],
    );
    const run = runRows[0];
    if (!run) return [];

    const { rows } = await pool.query<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>(
      `SELECT ts, open, high, low, close, volume
       FROM ohlcv_1m
       WHERE exchange = $1 AND symbol = $2 AND ts BETWEEN $3 AND $4
       ORDER BY ts ASC`,
      [run.exchange, run.symbol, run.from_ts, run.to_ts],
    );
    return rows;
  }
}
