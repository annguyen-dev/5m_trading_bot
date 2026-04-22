import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { getPool } from '@trading-bot/db';

const DATA_DIR = './data';

/**
 * DELETE /api/backtest/runs/:envId
 * envId is URL-encoded: "run%2F<uuid>" or "test%2F<filename>"
 * - run/<uuid>     → delete from backtest_runs (signals cascade)
 * - test/<file>    → delete JSON file from data/backtest/
 * - production     → not allowed
 */
export async function deleteBacktestRun(req: Request, res: Response): Promise<void> {
  const raw   = req.params['envId'];
  const envId = decodeURIComponent(Array.isArray(raw) ? raw[0]! : (raw ?? ''));

  if (envId === 'production') {
    res.status(400).json({ error: 'Cannot delete production environment' });
    return;
  }

  if (envId.startsWith('run/')) {
    const runId = envId.slice('run/'.length);
    try {
      const pool = getPool();
      const result = await pool.query('DELETE FROM backtest_runs WHERE id = $1', [runId]);
      if (result.rowCount === 0) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }

  if (envId.startsWith('test/')) {
    const filename = envId.slice('test/'.length) + '.json';
    const filePath = path.join(DATA_DIR, 'backtest', filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: `Unknown environment type: ${envId}` });
}
