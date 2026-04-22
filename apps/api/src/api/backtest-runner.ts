/**
 * Backtest runner API
 *
 * POST /api/backtest/run      — start a backtest job, returns { runId }
 * GET  /api/backtest/progress/:runId — SSE stream: { type, pct, msg } | { type: 'done', runId } | { type: 'error', msg }
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '@trading-bot/db';
import { DataFetcher } from '../backtest/DataFetcher.js';
import { BacktestEngine } from '../backtest/BacktestEngine.js';
import { PerformanceAnalyzer } from '../backtest/PerformanceAnalyzer.js';
import { DEFAULT_CONFIG } from '../backtest/types.js';
import type { FormulaWeights } from '../backtest/types.js';
import type { FormulaConfigRow } from './formula.js';

// ── Job registry ──────────────────────────────────────────────────────────────

interface Job {
  runId: string | null;   // null until persisted
  status: 'running' | 'done' | 'error';
  pct: number;
  msg: string;
  error: string | null;
  sseClients: Set<Response>;
}

const jobs = new Map<string, Job>();

function pushSSE(job: Job, data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of job.sseClients) {
    res.write(payload);
  }
}

// ── POST /api/backtest/run ────────────────────────────────────────────────────

export async function startBacktest(req: Request, res: Response): Promise<void> {
  const { from, to, formulaConfigId, noCache } = req.body as {
    from: string;
    to: string;
    formulaConfigId?: string;
    noCache?: boolean;
  };

  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required (ISO date strings)' });
    return;
  }

  const startDate = new Date(from);
  const endDate   = new Date(to);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({ error: 'Invalid date format' });
    return;
  }
  if (endDate <= startDate) {
    res.status(400).json({ error: 'to must be after from' });
    return;
  }

  // Resolve formula config
  let formulaWeights: FormulaWeights | undefined;
  let resolvedConfigId = formulaConfigId ?? null;
  try {
    if (formulaConfigId) {
      const { rows } = await getPool().query<FormulaConfigRow>(
        `SELECT * FROM formula_configs WHERE id = $1`, [formulaConfigId],
      );
      if (rows[0]) formulaWeights = rows[0].weights;
    } else {
      const { rows } = await getPool().query<FormulaConfigRow>(
        `SELECT * FROM formula_configs WHERE is_active = TRUE LIMIT 1`,
      );
      if (rows[0]) {
        formulaWeights = rows[0].weights;
        resolvedConfigId = rows[0].id;
      }
    }
  } catch {
    // proceed without formula override
  }

  const jobId = uuidv4();
  const job: Job = {
    runId: null,
    status: 'running',
    pct: 0,
    msg: 'Starting…',
    error: null,
    sseClients: new Set(),
  };
  jobs.set(jobId, job);

  // Return jobId immediately
  res.json({ jobId });

  // Run backtest asynchronously
  setImmediate(async () => {
    try {
      const label = `${from.split('T')[0]} → ${to.split('T')[0]}`;

      // Delete ALL existing runs with same week + same formula before creating fresh one
      await getPool().query(
        `DELETE FROM backtest_runs
         WHERE label = $1 AND formula_config_id IS NOT DISTINCT FROM $2`,
        [label, resolvedConfigId ?? null],
      );
      // signals cascade-delete via FK ON DELETE CASCADE

      const config = {
        ...DEFAULT_CONFIG,
        startDate,
        endDate,
        simulateTrades: true,
        cacheDir: './data/backtest',
        knnOnly: true,
        persistToDb: true,
        runLabel: label,
        formulaWeights,
        formulaConfigId: resolvedConfigId ?? undefined,
        noCache: noCache === true,
        onProgress: (pct: number, msg: string) => {
          job.pct = pct;
          job.msg = msg;
          pushSSE(job, { type: 'progress', pct, msg });
        },
      };

      const fetcher = new DataFetcher(config);
      const dataset = await fetcher.fetch();
      await fetcher.close();

      pushSSE(job, { type: 'progress', pct: 50, msg: 'Data loaded, running engine…' });

      const engine   = new BacktestEngine(config);
      const outcomes = await engine.run(dataset);

      pushSSE(job, { type: 'progress', pct: 90, msg: 'Analyzing results…' });

      const analyzer = new PerformanceAnalyzer(config);
      const result   = analyzer.analyze(outcomes, dataset.candles);
      result.dataRange.totalTrades = dataset.trades.length;

      // Get the runId from DB (BacktestEngine saves it with persistToDb)
      // We wait a moment then fetch the latest run
      await new Promise(r => setTimeout(r, 500));
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id FROM backtest_runs WHERE label = $1 ORDER BY created_at DESC LIMIT 1`,
        [label],
      );
      job.runId = rows[0]?.id ?? null;

      // Persist full metrics (byHorizon, dataRange, mmTrapStats) for the Results tab
      if (job.runId) {
        await getPool().query(
          `UPDATE backtest_runs SET metrics_json = $1 WHERE id = $2`,
          [JSON.stringify({ byHorizon: result.byHorizon, mmTrapStats: result.mmTrapStats, dataRange: result.dataRange }), job.runId],
        );
      }

      job.status = 'done';
      job.pct    = 100;
      job.msg    = `Done — ${result.totalSignals} signals`;
      pushSSE(job, { type: 'done', runId: job.runId, totalSignals: result.totalSignals });
    } catch (err) {
      job.status = 'error';
      job.error  = String(err);
      pushSSE(job, { type: 'error', msg: String(err) });
      console.error('[backtest-runner] Error:', err);
    } finally {
      // Close all SSE connections after a delay
      setTimeout(() => {
        for (const res of job.sseClients) {
          res.end();
        }
        job.sseClients.clear();
        jobs.delete(jobId);
      }, 5000);
    }
  });
}

// ── GET /api/backtest/progress/:jobId ─────────────────────────────────────────

export function backtestProgress(req: Request, res: Response): void {
  const jobId = String(req.params['jobId'] ?? '');
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  if (job.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'done', runId: job.runId })}\n\n`);
    res.end();
    return;
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', msg: job.error })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ type: 'progress', pct: job.pct, msg: job.msg })}\n\n`);
  job.sseClients.add(res);

  req.on('close', () => {
    job.sseClients.delete(res);
  });
}
