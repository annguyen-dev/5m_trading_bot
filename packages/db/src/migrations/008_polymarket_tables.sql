-- Phase 2.A — Polymarket CLOB market metadata + WS tick feed + Binance 5s scanner.
-- New tables, decoupled from the Phase-1 poly_markets (003) which is used by
-- the sim-only PolySignalService.

-- Real PM 5m BTC up/down markets, discovered via Gamma API.
-- Keyed by conditionId; we keep both CLOB token IDs so we can subscribe the
-- WS channel for either outcome.
CREATE TABLE IF NOT EXISTS poly_clob_markets (
  condition_id    TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  question        TEXT,
  symbol          TEXT NOT NULL DEFAULT 'BTC',
  window_start    BIGINT NOT NULL,        -- unix ms, 5m-aligned window open
  window_end      BIGINT NOT NULL,        -- unix ms, window close / resolution
  token_up        TEXT NOT NULL,
  token_down      TEXT NOT NULL,
  resolution_src  TEXT,
  fetched_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS poly_clob_markets_slug   ON poly_clob_markets(slug);
CREATE INDEX IF NOT EXISTS poly_clob_markets_window ON poly_clob_markets(window_start, window_end);

-- Tick-by-tick share-price WS feed. Dedup'd: we only INSERT when top-of-book
-- (best_bid/best_ask) changes, plus every book snapshot and last_trade event.
CREATE TABLE IF NOT EXISTS poly_share_ticks (
  id              BIGSERIAL PRIMARY KEY,
  condition_id    TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  ts              BIGINT NOT NULL,        -- unix ms
  best_bid        DOUBLE PRECISION,
  best_ask        DOUBLE PRECISION,
  last_price      DOUBLE PRECISION,
  event_type      TEXT NOT NULL           -- 'book' | 'price_change' | 'last_trade_price'
);
CREATE INDEX IF NOT EXISTS poly_share_ticks_cond_ts  ON poly_share_ticks(condition_id, ts);
CREATE INDEX IF NOT EXISTS poly_share_ticks_token_ts ON poly_share_ticks(token_id, ts);

-- Binance Futures 5s scanner output — one row per 5s bucket.
-- Used as input features for volatility / volume-spike / OB-imbalance signals.
CREATE TABLE IF NOT EXISTS future_ticks_5s (
  ts              BIGINT PRIMARY KEY,     -- unix ms, 5s-aligned
  price           DOUBLE PRECISION NOT NULL,
  volume_5s       DOUBLE PRECISION NOT NULL,   -- base volume over last 5s
  price_change_5s DOUBLE PRECISION NOT NULL,   -- (price_now - price_5s_ago) / price_5s_ago
  bid_depth_usd   DOUBLE PRECISION NOT NULL,   -- sum(size × price) top 20 bids
  ask_depth_usd   DOUBLE PRECISION NOT NULL,   -- sum(size × price) top 20 asks
  ob_imbalance    DOUBLE PRECISION NOT NULL,   -- (bid - ask) / (bid + ask), ∈ [-1, 1]
  vol_spike_z     DOUBLE PRECISION NOT NULL    -- z-score of volume_5s vs rolling 5min
);
