-- Phase 2.B-5 — per-order TP/SL + Path B (panic buy) settings.
--
-- Per-order tp_cents/sl_cents let different entry strategies have different
-- exit rules:
--   Path A (pre-position for next window, entry ~50¢): tp=75 / sl=25 (global)
--   Path B (panic buy on current window, entry 5-10¢): tp=30 / sl=NULL
--
-- NULL in either column → resolver falls back to global setting.

ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS tp_cents INT;
ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS sl_cents INT;

-- Panic path settings.
--   panic_tp_cents        take-profit for Path B orders (e.g. 30 = sell at 30¢)
--   panic_max_entry_cents max share price to trigger a panic buy (e.g. 10)
INSERT INTO settings (key, value, updated_at)
VALUES
  ('panic_tp_cents',        '30', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('panic_max_entry_cents', '10', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
