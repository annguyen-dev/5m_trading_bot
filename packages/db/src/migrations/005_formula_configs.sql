-- Formula weight configurations for the reversal probability model
CREATE TABLE IF NOT EXISTS formula_configs (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT,
  weights     JSONB   NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  BIGINT  NOT NULL
);

-- Seed default config
INSERT INTO formula_configs (id, name, description, weights, is_active, created_at)
VALUES (
  'default',
  'Default',
  'Default weights: knn=0.20, streak=0.35, intraday=0.35, volume=0.10, threshold=0.58',
  '{"wKnn":0.20,"wStreak":0.35,"wIntraday":0.35,"wVolume":0.10,"confidenceThreshold":0.58}',
  TRUE,
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
) ON CONFLICT DO NOTHING;

-- Extend backtest_runs with formula reference and summary metrics
ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS formula_config_id TEXT REFERENCES formula_configs(id),
  ADD COLUMN IF NOT EXISTS total_signals     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metrics_json      JSONB;
