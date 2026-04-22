import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { SignalStore } from '../services/SignalStore.js';
import type { BacktestResult, SignalOutcome } from '../backtest/types.js';
import { SignalRepository } from '../services/SignalRepository.js';
import { getPool } from '@trading-bot/db';

const DATA_DIR = './data';

/** GET /api/signals/:envId?page=0&pageSize=100 */
export async function getSignals(req: Request, res: Response): Promise<void> {
  const envId    = String(req.params['envId'] ?? '');
  const page     = parseInt(String(req.query['page'] ?? '0'), 10);
  // Allow up to 5000 so the FE can load a full run in one shot and filter/paginate client-side.
  const pageSize = Math.min(parseInt(String(req.query['pageSize'] ?? '100'), 10), 5000);

  try {
    // DB-backed run
    if (envId.startsWith('run/')) {
      const runId = envId.replace('run/', '');
      const repo  = new SignalRepository();
      const all   = await repo.getSignalsForRun(runId);
      all.sort((a, b) => b.candle_ts - a.candle_ts);
      const total     = all.length;
      const paginated = all.slice(page * pageSize, (page + 1) * pageSize);
      const signals   = paginated.map(s => ({
        id:           s.id,
        ts:           Number(s.candle_ts),
        direction:    s.direction,
        horizon:      s.horizon,
        confidence:   s.confidence,
        engine:       s.engine,
        status:       s.status,
        price_entry:  s.price_entry,
        price_target: s.price_target,
        stop_loss:    s.stop_loss,
        exit_price:   s.exit_price,
        exit_reason:  s.exit_reason,
        outcome:      s.outcome,
        return_pct:   s.pnl_pct,
        pnl_pct:      s.pnl_pct,
        rationale:    s.rationale,
      }));
      res.json({ signals, total });
      return;
    }

    if (envId === 'production') {
      const filePath = path.join(DATA_DIR, 'signals.jsonl');
      const { records, total } = SignalStore.readPage(filePath, page, pageSize);
      const signals = records.map(r => ({
        id:           r.signal.id,
        ts:           r.signal.timestamp,
        direction:    r.signal.direction,
        horizon:      r.signal.horizon,
        confidence:   r.signal.confidence ?? null,
        engine:       r.signal.engine,
        price_entry:  null as number | null,
        price_target: r.signal.priceTarget ?? null,
        stop_loss:    r.signal.stopLoss ?? null,
        outcome:      'pending',
        return_pct:   null as number | null,
        pnl_pct:      null as number | null,
      }));
      res.json({ signals, total });
      return;
    }

    if (envId.startsWith('test/')) {
      const fileName = envId.replace('test/', '') + '.json';
      const filePath = path.join(DATA_DIR, 'backtest', fileName);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Backtest file not found' });
        return;
      }
      const result  = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BacktestResult;
      const all     = (result.signalOutcomes ?? [])
        .sort((a, b) => b.signal.timestamp - a.signal.timestamp);
      const total     = all.length;
      const paginated = all.slice(page * pageSize, (page + 1) * pageSize);

      const signals = paginated.map((o: SignalOutcome) => ({
        id:           o.signal.id,
        ts:           o.signal.timestamp,
        direction:    o.signal.direction,
        horizon:      o.signal.horizon,
        confidence:   o.signal.confidence ?? null,
        engine:       o.signal.engine,
        price_entry:  o.entryPrice ?? null,
        price_target: o.signal.priceTarget ?? null,
        stop_loss:    o.signal.stopLoss ?? null,
        outcome:      o.outcome,
        return_pct:   o.returnPct,
        pnl_pct:      o.pnlPct,
      }));
      res.json({ signals, total });
      return;
    }

    res.status(400).json({ error: `Unknown environment: ${envId}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

/** GET /api/summary/:envId */
export async function getSummary(req: Request, res: Response): Promise<void> {
  const envId = String(req.params['envId'] ?? '');

  try {
    if (envId.startsWith('run/')) {
      const runId = envId.replace('run/', '');
      const repo  = new SignalRepository();
      const [all, { rows: runRows }] = await Promise.all([
        repo.getSignalsForRun(runId),
        getPool().query<{ metrics_json: Record<string, unknown> | null }>(
          `SELECT metrics_json FROM backtest_runs WHERE id = $1`, [runId],
        ),
      ]);
      const wins    = all.filter(s => s.outcome === 'win').length;
      const losses  = all.filter(s => s.outcome === 'loss').length;
      const neutral = all.filter(s => s.outcome === 'neutral').length;
      const pending = all.filter(s => s.outcome === 'pending').length;
      const decided = wins + losses;
      const pnls    = all.map(s => s.pnl_pct).filter((v): v is number => v != null);
      const metrics = runRows[0]?.metrics_json ?? null;
      res.json({
        total: all.length, wins, losses, neutral, pending,
        win_rate: decided > 0 ? wins / decided : 0,
        avg_return_pct: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
        total_pnl: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) : null,
        by_horizon:    metrics?.byHorizon    ?? {},
        mm_trap_stats: metrics?.mmTrapStats  ?? null,
        data_range:    metrics?.dataRange    ?? null,
      });
      return;
    }

    if (envId.startsWith('test/')) {
      const fileName = envId.replace('test/', '') + '.json';
      const filePath = path.join(DATA_DIR, 'backtest', fileName);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Backtest file not found' });
        return;
      }
      const result   = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BacktestResult;
      const outcomes = result.signalOutcomes ?? [];
      const wins     = outcomes.filter(o => o.outcome === 'win').length;
      const losses   = outcomes.filter(o => o.outcome === 'loss').length;
      const neutral  = outcomes.filter(o => o.outcome === 'neutral').length;
      const pending  = outcomes.filter(o => o.outcome === 'pending').length;
      const decided  = wins + losses;
      const returns  = outcomes.map(o => o.returnPct).filter((v): v is number => v != null);
      const pnls     = outcomes.map(o => o.pnlPct).filter((v): v is number => v != null);

      res.json({
        total:           result.totalSignals,
        wins,
        losses,
        neutral,
        pending,
        win_rate:        decided > 0 ? wins / decided : 0,
        avg_return_pct:  returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
        total_pnl:       pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) : null,
        by_horizon:      result.byHorizon,
        mm_trap_stats:   result.mmTrapStats,
        data_range:      result.dataRange,
      });
      return;
    }

    if (envId === 'production') {
      const filePath = path.join(DATA_DIR, 'signals.jsonl');
      const records  = SignalStore.readAll(filePath);
      res.json({
        total: records.length, wins: 0, losses: 0, neutral: 0, pending: records.length,
        win_rate: 0, avg_return_pct: null, total_pnl: null,
        by_horizon: {}, mm_trap_stats: null, data_range: null,
      });
      return;
    }

    res.status(400).json({ error: `Unknown environment: ${envId}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
