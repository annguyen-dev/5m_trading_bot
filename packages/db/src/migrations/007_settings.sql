-- Runtime settings — single-row key/value store for config that can change
-- without redeploying (e.g. trading_mode toggle: 'simulate' | 'live').
--
-- Bootstrap: trading_mode defaults to 'simulate'. On first server start, if the
-- env TRADING_MODE=live|paper is set, it seeds the row accordingly:
--   paper → simulate (legacy name); live → live.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

INSERT INTO settings (key, value, updated_at)
VALUES ('trading_mode', 'simulate', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
