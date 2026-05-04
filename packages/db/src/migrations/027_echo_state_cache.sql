-- 027_echo_state_cache.sql
--
-- Persist the latest published `echo_state` event per coin. API server (which
-- holds the in-memory `engine.echoStates` Map for SSE snapshots) UPSERTs here
-- on every event, and loads all rows on startup → API restart no longer
-- empties the Live page panel waiting for the next state transition (which
-- can be hours away).
--
-- One row per coin. `state` mirrors SignalEchoStateEvent JSON exactly so the
-- snapshot can serve it without transformation.

CREATE TABLE IF NOT EXISTS echo_state_cache (
  coin        TEXT   PRIMARY KEY,
  state       JSONB  NOT NULL,
  updated_at  BIGINT NOT NULL
);
