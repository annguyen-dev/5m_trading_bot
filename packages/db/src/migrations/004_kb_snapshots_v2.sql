-- Multi-timeframe streak + pattern columns for kb_snapshots.
ALTER TABLE kb_snapshots ADD COLUMN IF NOT EXISTS streak_15m       SMALLINT         NOT NULL DEFAULT 0;
ALTER TABLE kb_snapshots ADD COLUMN IF NOT EXISTS streak_1h        SMALLINT         NOT NULL DEFAULT 0;
ALTER TABLE kb_snapshots ADD COLUMN IF NOT EXISTS pattern_hash     TEXT             NOT NULL DEFAULT '';
ALTER TABLE kb_snapshots ADD COLUMN IF NOT EXISTS reliability_score DOUBLE PRECISION NOT NULL DEFAULT 1.0;

CREATE INDEX IF NOT EXISTS kb_snapshots_streak_15m ON kb_snapshots(streak_15m);
CREATE INDEX IF NOT EXISTS kb_snapshots_streak_1h  ON kb_snapshots(streak_1h);
CREATE INDEX IF NOT EXISTS kb_snapshots_pattern    ON kb_snapshots(pattern_hash);
