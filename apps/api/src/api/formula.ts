/**
 * Formula config API
 * GET    /api/formula/configs          — list all configs
 * GET    /api/formula/configs/active   — get active config
 * POST   /api/formula/configs          — create new config
 * PUT    /api/formula/configs/:id/activate — set as active
 * DELETE /api/formula/configs/:id      — delete (not if active)
 */
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '@trading-bot/db';
import type { FormulaWeights } from '../backtest/types.js';

export interface FormulaConfigRow {
  id: string;
  name: string;
  description: string | null;
  weights: FormulaWeights;
  is_active: boolean;
  created_at: number;
}

export async function listFormulaConfigs(_req: Request, res: Response): Promise<void> {
  try {
    const { rows } = await getPool().query<FormulaConfigRow>(
      `SELECT * FROM formula_configs ORDER BY created_at DESC`,
    );
    res.json({ configs: rows });
  } catch (err) {
    console.error('[formula] listFormulaConfigs error:', err);
    res.status(500).json({ error: String(err) });
  }
}

export async function getActiveFormulaConfig(_req: Request, res: Response): Promise<void> {
  try {
    const { rows } = await getPool().query<FormulaConfigRow>(
      `SELECT * FROM formula_configs WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
    );
    const config = rows[0] ?? null;
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function createFormulaConfig(req: Request, res: Response): Promise<void> {
  const { name, description, weights } = req.body as {
    name: string;
    description?: string;
    weights: FormulaWeights;
  };

  if (!name || !weights) {
    res.status(400).json({ error: 'name and weights are required' });
    return;
  }

  // Validate weights sum ~= 1.0
  const sum = (weights.wKnn ?? 0) + (weights.wStreak ?? 0) + (weights.wIntraday ?? 0) + (weights.wVolume ?? 0);
  if (Math.abs(sum - 1.0) > 0.05) {
    res.status(400).json({ error: `Weights must sum to 1.0 (got ${sum.toFixed(3)})` });
    return;
  }

  try {
    const id = uuidv4();
    await getPool().query(
      `INSERT INTO formula_configs (id, name, description, weights, is_active, created_at)
       VALUES ($1, $2, $3, $4, FALSE, $5)`,
      [id, name, description ?? null, JSON.stringify(weights), Date.now()],
    );
    res.json({ id, name, weights });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function updateFormulaConfig(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id'] ?? '');
  const { name, description, weights } = req.body as {
    name?: string;
    description?: string;
    weights?: FormulaWeights;
  };

  if (weights) {
    const sum = (weights.wKnn ?? 0) + (weights.wStreak ?? 0) + (weights.wIntraday ?? 0) + (weights.wVolume ?? 0);
    if (Math.abs(sum - 1.0) > 0.05) {
      res.status(400).json({ error: `Weights must sum to 1.0 (got ${sum.toFixed(3)})` });
      return;
    }
  }

  try {
    await getPool().query(
      `UPDATE formula_configs
       SET name        = COALESCE($2, name),
           description = COALESCE($3, description),
           weights     = COALESCE($4, weights)
       WHERE id = $1`,
      [id, name ?? null, description ?? null, weights ? JSON.stringify(weights) : null],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function activateFormulaConfig(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id'] ?? '');
  try {
    const pool = getPool();
    await pool.query(`UPDATE formula_configs SET is_active = FALSE`);
    await pool.query(`UPDATE formula_configs SET is_active = TRUE WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function deleteFormulaConfig(req: Request, res: Response): Promise<void> {
  const id = String(req.params['id'] ?? '');
  if (id === 'default') {
    res.status(400).json({ error: 'Cannot delete default config' });
    return;
  }
  try {
    const { rows } = await getPool().query<{ is_active: boolean }>(
      `SELECT is_active FROM formula_configs WHERE id = $1`, [id],
    );
    if (rows[0]?.is_active) {
      res.status(400).json({ error: 'Cannot delete active config' });
      return;
    }
    await getPool().query(`DELETE FROM formula_configs WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
