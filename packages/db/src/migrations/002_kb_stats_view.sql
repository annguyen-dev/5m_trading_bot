-- Pre-computed KB statistics: per-streak-length daily reversal averages.
-- e.g. streak_len=5 → avg 2.3 streak-5 reversals per day historically.
-- DROP is a one-time safety net for DBs that had the view from ensureSchema().
DROP MATERIALIZED VIEW IF EXISTS kb_daily_reversal_stats CASCADE;
CREATE MATERIALIZED VIEW kb_daily_reversal_stats AS
SELECT
  streak_len,
  AVG(daily_count)      AS avg_daily_reversals,
  COUNT(DISTINCT day)   AS sample_days
FROM (
  SELECT
    ABS(streak_5m)                          AS streak_len,
    DATE(TO_TIMESTAMP(ts / 1000.0))         AS day,
    COUNT(*)                                AS daily_count
  FROM kb_snapshots
  WHERE ABS(streak_5m) >= 2
    AND ((streak_5m > 0 AND direction = 'down')
      OR (streak_5m < 0 AND direction = 'up'))
  GROUP BY ABS(streak_5m), DATE(TO_TIMESTAMP(ts / 1000.0))
) t
GROUP BY streak_len;

CREATE UNIQUE INDEX kb_daily_reversal_stats_idx ON kb_daily_reversal_stats (streak_len);
