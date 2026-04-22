-- Phase 2.B — streak-based signal + order config.
--
-- Two thresholds that govern the (future) decision engine:
--   signal_min_streak     — emit a signal when |5m streak| ≥ this value
--   auto_order_min_streak — auto-place a sim/live order when |5m streak| ≥ this;
--                           between signal_min and auto_order_min the signal
--                           appears on the Live page as a "manual" action that
--                           the user confirms by clicking.
--
-- Invariant (enforced in the settings API): auto_order_min_streak ≥ signal_min_streak.

INSERT INTO settings (key, value, updated_at)
VALUES
  ('signal_min_streak',     '3', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('auto_order_min_streak', '4', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
