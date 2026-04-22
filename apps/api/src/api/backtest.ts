import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import type { BacktestResult, SignalOutcome } from '../backtest/types.js';

const BACKTEST_DIR = './data/backtest';

export interface RunSummary {
  id:         string;
  label:      string;
  createdAt:  string;
  config: {
    symbol:         string;
    startDate:      string;
    endDate:        string;
    aiModel:        string;
    evalWindows:    { short: number; mid: number };
    winThresholdPct: { short: number; mid: number };
  };
  dataRange: { from: string; to: string; totalCandles: number };
  totalSignals: number;
  byHorizon:    BacktestResult['byHorizon'];
  mmTrapStats:  BacktestResult['mmTrapStats'];
}

/** GET /api/backtest/compare — all runs summarised for comparison table */
export function getCompare(_req: Request, res: Response): void {
  if (!fs.existsSync(BACKTEST_DIR)) {
    res.json({ runs: [] });
    return;
  }

  const files = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('cache'))
    .sort()
    .reverse();

  const runs: RunSummary[] = [];

  for (const file of files) {
    const filePath = path.join(BACKTEST_DIR, file);
    try {
      const result = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BacktestResult;
      const from = result.dataRange?.from ?? result.config.startDate?.toString() ?? '';
      const to   = result.config.endDate?.toString() ?? '';

      runs.push({
        id:        file.replace('.json', ''),
        label:     `${from.split('T')[0]} → ${to.split('T')[0]}`,
        createdAt: fs.statSync(filePath).mtime.toISOString(),
        config: {
          symbol:          result.config.symbol,
          startDate:       from,
          endDate:         to,
          aiModel:         result.config.aiModel ?? 'default',
          evalWindows:     result.config.evalWindows,
          winThresholdPct: result.config.winThresholdPct,
        },
        dataRange:    result.dataRange,
        totalSignals: result.totalSignals,
        byHorizon:    result.byHorizon,
        mmTrapStats:  result.mmTrapStats,
      });
    } catch {
      // skip malformed
    }
  }

  res.json({ runs });
}

/** GET /api/backtest/equity/:runId — equity curve data points */
export function getEquity(req: Request, res: Response): void {
  const runId   = String(req.params['runId'] ?? '');
  const horizon = String(req.query['horizon'] ?? '');
  const filePath = path.join(BACKTEST_DIR, runId + '.json');

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  try {
    const result = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BacktestResult;

    let outcomes: SignalOutcome[] = result.signalOutcomes ?? [];
    if (horizon) outcomes = outcomes.filter(o => o.signal.horizon === horizon);

    // Sort by signal time
    outcomes.sort((a, b) => a.signal.timestamp - b.signal.timestamp);

    // Build equity curve: starts at 100, each decided outcome adds returnPct
    let equity = 100;
    const points: { ts: number; equity: number }[] = [
      { ts: outcomes[0]?.signal.timestamp ?? Date.now(), equity: 100 },
    ];

    for (const o of outcomes) {
      if (o.outcome === 'win' || o.outcome === 'loss') {
        equity += equity * (o.returnPct ?? 0);
        points.push({ ts: o.signal.timestamp, equity: Math.round(equity * 100) / 100 });
      }
    }

    res.json(points);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
