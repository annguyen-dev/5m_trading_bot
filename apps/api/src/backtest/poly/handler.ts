/**
 * Express handlers for poly-backtest:
 *   POST /api/backtest/poly/run        — start a job, return {jobId}
 *   GET  /api/backtest/poly/progress/:jobId  — SSE: progress + final result
 *
 * Job state is in-memory (single-process). Acceptable since backtests are
 * short-lived (seconds, not hours) and we don't need cross-instance shared
 * state. Restart loses any in-flight job — caller can just re-run.
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { runPolyBacktest } from './PolyBacktestEngine.js';
import type {
  PolyBacktestRequest, PolyBacktestResult, PolyBacktestStreamEvent,
} from './types.js';

interface JobState {
  /** Latest progress { pct, msg } sent so reconnects after a brief gap can
   *  resume from a known point. */
  progress: { pct: number; msg: string };
  /** Set once the job finishes (success or error). */
  done?:    { ok: true; result: PolyBacktestResult } | { ok: false; msg: string };
  /** Active SSE writer if any (for live streaming). */
  res?:     Response;
}

const jobs = new Map<string, JobState>();

// Reap finished jobs after 5 min so memory doesn't grow unbounded.
const REAP_AFTER_MS = 5 * 60 * 1000;

export async function startPolyBacktest(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Partial<PolyBacktestRequest>;
    if (!body.fromMs || !body.toMs || !body.config) {
      res.status(400).json({ error: 'fromMs, toMs, config required' });
      return;
    }
    if (body.config.symbol !== 'BTC') {
      res.status(400).json({ error: 'v1 only supports BTC' });
      return;
    }
    if (body.toMs - body.fromMs > 35 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'date range must be ≤ 35 days' });
      return;
    }

    const jobId = randomUUID();
    jobs.set(jobId, { progress: { pct: 0, msg: 'queued' } });
    res.json({ jobId });

    // Run async — don't await in handler.
    void runJob(jobId, body as PolyBacktestRequest);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function runJob(jobId: string, req: PolyBacktestRequest): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    const result = await runPolyBacktest(req, (pct, msg) => {
      const state = jobs.get(jobId);
      if (!state) return;
      state.progress = { pct, msg };
      sendSse(state, { type: 'progress', pct, msg });
    });
    job.done = { ok: true, result };
    sendSse(job, { type: 'done', result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.done = { ok: false, msg };
    sendSse(job, { type: 'error', msg });
  } finally {
    closeSse(jobs.get(jobId));
    setTimeout(() => jobs.delete(jobId), REAP_AFTER_MS).unref();
  }
}

export function streamPolyBacktest(req: Request, res: Response): void {
  const jobIdRaw = req.params['jobId'];
  const jobId = Array.isArray(jobIdRaw) ? jobIdRaw[0] : jobIdRaw;
  if (!jobId) { res.status(400).json({ error: 'jobId required' }); return; }

  const job = jobs.get(jobId);
  if (!job) { res.status(404).json({ error: 'unknown job' }); return; }

  res.statusCode = 200;
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Replay last known progress so the client sees something immediately.
  sendSse({ res } as JobState, { type: 'progress', ...job.progress });

  // If already done, send terminal event + close.
  if (job.done) {
    if (job.done.ok) sendSse({ res } as JobState, { type: 'done',  result: job.done.result });
    else             sendSse({ res } as JobState, { type: 'error', msg:    job.done.msg });
    res.end();
    return;
  }

  // Otherwise attach for live updates.
  job.res = res;
  req.on('close', () => { delete job.res; });
}

// ── SSE helpers ──────────────────────────────────────────────────────────

function sendSse(job: JobState | undefined, ev: PolyBacktestStreamEvent): void {
  if (!job?.res) return;
  try {
    job.res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch { /* ignore — broken pipe means client gone */ }
}

function closeSse(job: JobState | undefined): void {
  try { job?.res?.end(); } catch { /* ignore */ }
}
