import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { SignalRepository } from '../services/SignalRepository.js';

export interface Environment {
  id: string;
  type: 'test' | 'production';
  label: string;
  createdAt: string;
  signalCount: number;
  formulaName?: string;
  formulaWeights?: Record<string, number>;
}

const DATA_DIR = './data';

export async function listEnvironments(_req: Request, res: Response): Promise<void> {
  const envs: Environment[] = [];

  // ── 1. DB runs ─────────────────────────────────────────────────────────────
  try {
    const repo = new SignalRepository();
    const runs = await repo.getRuns();
    for (const r of runs) {
      envs.push({
        id: `run/${r.id}`,
        type: 'test',
        label: r.label,
        createdAt: new Date(Number(r.created_at)).toISOString(),
        signalCount: r.total_signals ?? 0,
        formulaName: r.formula_name ?? undefined,
        formulaWeights: r.formula_weights ?? undefined,
      });
    }
  } catch {
    // DB not available — skip
  }

  // ── 2. Production environment ──────────────────────────────────────────────
  const prodFile = path.join(DATA_DIR, 'signals.jsonl');
  if (fs.existsSync(prodFile)) {
    const lines = fs.readFileSync(prodFile, 'utf-8').split('\n').filter(Boolean);
    const stat = fs.statSync(prodFile);
    envs.push({
      id: 'production',
      type: 'production',
      label: 'Production (live)',
      createdAt: stat.mtime.toISOString(),
      signalCount: lines.length,
    });
  }

  // ── 3. JSON file backtest results (legacy) ─────────────────────────────────
  const backtestDir = path.join(DATA_DIR, 'backtest');
  if (fs.existsSync(backtestDir)) {
    const files = fs.readdirSync(backtestDir)
      .filter(f => f.endsWith('.json') && !f.includes('cache'));
    for (const file of files.sort().reverse()) {
      const filePath = path.join(backtestDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          totalSignals?: number;
          dataRange?: { from: string };
          config?: { startDate: string; endDate: string };
        };
        const from = raw.dataRange?.from ?? raw.config?.startDate ?? '';
        const to   = raw.config?.endDate ?? '';
        envs.push({
          id: `test/${file.replace('.json', '')}`,
          type: 'test',
          label: `[file] ${from.split('T')[0]}→${to.split('T')[0]}`,
          createdAt: fs.statSync(filePath).mtime.toISOString(),
          signalCount: raw.totalSignals ?? 0,
        });
      } catch {
        // skip
      }
    }
  }

  res.json({ environments: envs });
}
