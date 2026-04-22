-- Polymarket markets (one row per 5m PM market)
CREATE TABLE IF NOT EXISTS poly_markets (
  id               TEXT PRIMARY KEY,
  ts_open          BIGINT NOT NULL,
  ts_close         BIGINT NOT NULL,
  symbol           TEXT NOT NULL DEFAULT 'BTC/USDT',
  share_price_up   DOUBLE PRECISION,
  share_price_down DOUBLE PRECISION,
  spread           DOUBLE PRECISION NOT NULL DEFAULT 0.02,
  resolved         SMALLINT NOT NULL DEFAULT 0,
  resolution       TEXT
);
CREATE INDEX IF NOT EXISTS poly_markets_ts ON poly_markets(ts_open);

-- Polymarket orders (sim + live)
CREATE TABLE IF NOT EXISTS poly_orders (
  id              TEXT PRIMARY KEY,
  market_id       TEXT REFERENCES poly_markets(id),
  ts_entry        BIGINT NOT NULL,
  direction       TEXT NOT NULL,
  share_price     DOUBLE PRECISION NOT NULL,
  size_usdc       DOUBLE PRECISION NOT NULL,
  p_signal        DOUBLE PRECISION NOT NULL,
  ev              DOUBLE PRECISION NOT NULL,
  streak_5m       SMALLINT NOT NULL DEFAULT 0,
  trend_15m       TEXT,
  trend_1h        TEXT,
  p_quota         DOUBLE PRECISION,
  p_trend         DOUBLE PRECISION,
  p_pattern       DOUBLE PRECISION,
  p_liq           DOUBLE PRECISION,
  dca_round       SMALLINT NOT NULL DEFAULT 0,
  parent_order_id TEXT,
  mode            TEXT NOT NULL DEFAULT 'sim',
  status          TEXT NOT NULL DEFAULT 'pending',
  pnl_usdc        DOUBLE PRECISION,
  resolved_at     BIGINT
);
CREATE INDEX IF NOT EXISTS poly_orders_market ON poly_orders(market_id);
CREATE INDEX IF NOT EXISTS poly_orders_ts     ON poly_orders(ts_entry);
CREATE INDEX IF NOT EXISTS poly_orders_status ON poly_orders(status);
