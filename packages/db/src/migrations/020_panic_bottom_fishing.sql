-- Phase 2C — PANIC bottom-fishing path (separate from DCA-add).
--
-- After 019 renamed the old Path B 'panic' label → 'dca' (average-down
-- existing boundary position), we now re-introduce 'panic' with the CORRECT
-- semantic: momentum-based bottom-fishing for CURRENT window when:
--   - streak sits in the gap [signal_min, auto_min) — i.e. a signal exists
--     but boundary won't auto-fire for next window
--   - in the first N seconds of the window
--   - streak-matching token ask has crashed to a very low price (≤5¢ default)
--   - bet the streak direction continues (momentum), not contrarian
--
-- Exit: limit TP at panic_tp_cents (e.g. 20¢), no SL.

-- 1. Allow 'panic' as a signal_path value again -----------------------------
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_signal_path_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_signal_path_check
  CHECK (signal_path IS NULL OR signal_path IN ('boundary', 'dca', 'panic'));

-- 2. Panic settings (defaults only; operator can tweak via /api/settings) ---
INSERT INTO settings (key, value, updated_at) VALUES
  ('panic_entry_cents',     '5',   EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('panic_tp_cents',        '20',  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('panic_first_window_s',  '180', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
