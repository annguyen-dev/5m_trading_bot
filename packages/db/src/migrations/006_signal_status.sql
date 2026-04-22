-- Add status column to signals table.
-- Signals are now always created when |streak_5m| >= 4 (regardless of composite
-- confidence vs threshold). Threshold decides status:
--   'auto'   → confidence >= threshold (bot trades automatically)
--   'manual' → confidence <  threshold (user reviews before trading)

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS signals_status ON signals(status);
