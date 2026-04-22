-- Phase 2.B-6 — per-window DCA for Path A + signal_path tracking.
--
-- signal_path: which decision path placed this order. Used to:
--   (1) count consecutive Path A losses for DCA scaling
--   (2) show a path badge on the FE orders table
--
-- DCA logic (Path A only):
--   size = base_size + dca_step × (consecutive Path A losses from most recent)
--   base_size = 5 USDC default; dca_step = 5 → sequence: 5, 10, 15, 20, ...
--   Set dca_step = 0 to disable DCA.
--
-- Path B (panic) stays at fixed base_size — no DCA (its own cheap-entry model
-- already has asymmetric max-loss-equal-entry risk).

ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS signal_path TEXT;
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_signal_path_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_signal_path_check
  CHECK (signal_path IS NULL OR signal_path IN ('boundary', 'panic'));

CREATE INDEX IF NOT EXISTS poly_orders_signal_path_ts_entry
  ON poly_orders(signal_path, ts_entry DESC);

INSERT INTO settings (key, value, updated_at)
VALUES
  ('auto_order_base_size_usdc', '5', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('auto_order_dca_step_usdc',  '5', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
