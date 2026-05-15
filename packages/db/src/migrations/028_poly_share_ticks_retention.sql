-- Retention policy for poly_share_ticks. Bot writes ~7M rows/day (dedupe'd
-- top-of-book changes across ~10 active tokens). Without pruning the table
-- grew to 47GB / 105M rows in ~2 weeks and crashed the host (disk full).
--
-- Fix (rebuild done out-of-band in incident response on 2026-05-15: kept
-- last 24h via CTAS + TRUNCATE + reinsert). This migration adds the prune
-- as an idempotent SQL that callers (a cron or the workers' periodic job)
-- can invoke without worrying about lock spikes.
--
-- DESIGN
--   - Keeps last 48h by default (T-0 outcome reads need only ~30s, but
--     leaving 48h gives the backfill-resolution-outcomes script enough
--     history to fix tiny-move misorders without restart hassle).
--   - DELETE in chunks via WHERE id IN (subquery LIMIT) so each statement
--     finishes in seconds — important because workers actively write to
--     this table; long-running locks would stall WS handling.
--   - autovacuum keeps file bloat in check; long-term file shrink happens
--     on next manual VACUUM FULL during maintenance.
--
-- Caller (cron) example:
--   0 * * * * docker exec trading-bot-postgres psql -U trading -d trading \
--     -c "CALL prune_poly_share_ticks(48);"

CREATE OR REPLACE PROCEDURE prune_poly_share_ticks(retention_hours INT DEFAULT 48)
LANGUAGE plpgsql AS $$
DECLARE
  cutoff_ms BIGINT;
  deleted_chunk INT;
  total_deleted INT := 0;
BEGIN
  cutoff_ms := (EXTRACT(EPOCH FROM (now() - (retention_hours || ' hours')::interval)) * 1000)::BIGINT;

  LOOP
    DELETE FROM poly_share_ticks
     WHERE id IN (
       SELECT id FROM poly_share_ticks
        WHERE ts < cutoff_ms
        LIMIT 50000
     );
    GET DIAGNOSTICS deleted_chunk = ROW_COUNT;
    total_deleted := total_deleted + deleted_chunk;
    EXIT WHEN deleted_chunk = 0;
    COMMIT;   -- release locks each chunk
  END LOOP;

  RAISE NOTICE 'prune_poly_share_ticks: deleted % rows older than %h', total_deleted, retention_hours;
END $$;
