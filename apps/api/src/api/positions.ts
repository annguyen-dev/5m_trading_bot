/**
 * /api/positions — returns closed position history + aggregate stats.
 * Reads from ./data/positions.jsonl (written by PositionTracker).
 */
import type { Request, Response } from 'express';
import path from 'path';
import { PositionTracker, type ClosedPosition } from '../services/PositionTracker.js';

const DATA_DIR = './data';

export function getPositions(req: Request, res: Response): void {
  const page     = parseInt(String(req.query['page']     ?? '0'), 10);
  const pageSize = parseInt(String(req.query['pageSize'] ?? '50'), 10);

  const all = PositionTracker.readAll(DATA_DIR)
    .sort((a, b) => b.closedAt - a.closedAt);

  const total   = all.length;
  const records = all.slice(page * pageSize, (page + 1) * pageSize);

  // Aggregate stats
  const decided = all.filter(p => p.exitReason !== 'timeout');
  const wins    = decided.filter(p => p.exitReason === 'tp');
  const losses  = decided.filter(p => p.exitReason === 'sl');
  const winRate = decided.length === 0 ? 0 : wins.length / decided.length;
  const avgPnl  = all.length === 0
    ? 0 : all.reduce((s, p) => s + p.pnlPct, 0) / all.length;
  const totalPnl = all.reduce((s, p) => s + p.pnlPct, 0);

  // Per-horizon breakdown
  const horizons = ['scale', 'short', 'mid', 'long'];
  const byHorizon: Record<string, {
    total: number; wins: number; losses: number; timeouts: number;
    winRate: number; avgPnl: number;
  }> = {};

  for (const h of horizons) {
    const group   = all.filter(p => p.signal.horizon === h);
    const gWins   = group.filter(p => p.exitReason === 'tp').length;
    const gLosses = group.filter(p => p.exitReason === 'sl').length;
    const gDecided = gWins + gLosses;
    byHorizon[h] = {
      total:    group.length,
      wins:     gWins,
      losses:   gLosses,
      timeouts: group.filter(p => p.exitReason === 'timeout').length,
      winRate:  gDecided === 0 ? 0 : gWins / gDecided,
      avgPnl:   group.length === 0
        ? 0 : group.reduce((s, p) => s + p.pnlPct, 0) / group.length,
    };
  }

  res.json({
    total,
    page,
    pageSize,
    records,
    stats: { winRate, avgPnlPct: avgPnl, totalPnlPct: totalPnl, byHorizon },
  });
}
