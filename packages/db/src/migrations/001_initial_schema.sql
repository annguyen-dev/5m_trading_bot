-- Raw 1m OHLCV candles
CREATE TABLE IF NOT EXISTS ohlcv_1m (
  exchange TEXT             NOT NULL,
  symbol   TEXT             NOT NULL,
  ts       BIGINT           NOT NULL,
  open     DOUBLE PRECISION NOT NULL,
  high     DOUBLE PRECISION NOT NULL,
  low      DOUBLE PRECISION NOT NULL,
  close    DOUBLE PRECISION NOT NULL,
  volume   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (exchange, symbol, ts)
);

-- Funding rates (typically 8h intervals)
CREATE TABLE IF NOT EXISTS funding_rates (
  exchange TEXT             NOT NULL,
  symbol   TEXT             NOT NULL,
  ts       BIGINT           NOT NULL,
  rate     DOUBLE PRECISION NOT NULL,
  oi_usd   DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (exchange, symbol, ts)
);

-- Macro events from GDELT / FRED
CREATE TABLE IF NOT EXISTS macro_events (
  id        TEXT             PRIMARY KEY,
  ts        BIGINT           NOT NULL,
  category  TEXT             NOT NULL,
  title     TEXT             NOT NULL,
  tone      DOUBLE PRECISION NOT NULL,
  lag_hours INTEGER          NOT NULL,
  source    TEXT             NOT NULL
);
CREATE INDEX IF NOT EXISTS macro_events_ts ON macro_events(ts);

-- KB snapshots: one row per 1m candle
CREATE TABLE IF NOT EXISTS kb_snapshots (
  id           TEXT    PRIMARY KEY,
  exchange     TEXT    NOT NULL,
  symbol       TEXT    NOT NULL,
  ts           BIGINT  NOT NULL,

  streak_1m    SMALLINT         NOT NULL,
  streak_5m    SMALLINT         NOT NULL,

  change_1m    DOUBLE PRECISION NOT NULL,
  change_5m    DOUBLE PRECISION NOT NULL,
  change_15m   DOUBLE PRECISION NOT NULL,
  change_1h    DOUBLE PRECISION NOT NULL,

  volume_ratio DOUBLE PRECISION NOT NULL DEFAULT 1,
  wick_ratio   DOUBLE PRECISION NOT NULL DEFAULT 0,
  cvd_1h       DOUBLE PRECISION NOT NULL DEFAULT 0,

  liq_long_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  liq_short_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  liq_cascade   SMALLINT         NOT NULL DEFAULT 0,

  funding_rate  DOUBLE PRECISION NOT NULL DEFAULT 0,
  oi_change_1h  DOUBLE PRECISION NOT NULL DEFAULT 0,

  macro_tone    DOUBLE PRECISION NOT NULL DEFAULT 0,
  macro_events  TEXT             NOT NULL DEFAULT '[]',

  entry_price   DOUBLE PRECISION,
  t1m           DOUBLE PRECISION,
  t2m           DOUBLE PRECISION,
  t3m           DOUBLE PRECISION,
  t5m           DOUBLE PRECISION,
  t10m          DOUBLE PRECISION,
  t15m          DOUBLE PRECISION,
  t1h           DOUBLE PRECISION,
  t4h           DOUBLE PRECISION,
  t1d           DOUBLE PRECISION,
  max_down_1h   DOUBLE PRECISION,
  max_up_1h     DOUBLE PRECISION,
  direction     TEXT,

  embedding_text TEXT    NOT NULL DEFAULT '',
  embedded       SMALLINT NOT NULL DEFAULT 0,
  embedded_at    BIGINT
);
CREATE INDEX IF NOT EXISTS kb_snapshots_ts       ON kb_snapshots(ts);
CREATE INDEX IF NOT EXISTS kb_snapshots_embedded ON kb_snapshots(embedded) WHERE embedded = 0;
CREATE INDEX IF NOT EXISTS kb_snapshots_streak_1m ON kb_snapshots(streak_1m);
CREATE INDEX IF NOT EXISTS kb_snapshots_streak_5m ON kb_snapshots(streak_5m);
CREATE INDEX IF NOT EXISTS kb_snapshots_symbol   ON kb_snapshots(exchange, symbol);

-- Backtest runs
CREATE TABLE IF NOT EXISTS backtest_runs (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  from_ts     BIGINT NOT NULL,
  to_ts       BIGINT NOT NULL,
  ai_model    TEXT,
  created_at  BIGINT NOT NULL
);

-- Signals
CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT REFERENCES backtest_runs(id) ON DELETE CASCADE,
  candle_ts     BIGINT  NOT NULL,
  exchange      TEXT    NOT NULL DEFAULT 'binance',
  symbol        TEXT    NOT NULL DEFAULT 'BTC/USDT',
  horizon       TEXT    NOT NULL,
  direction     TEXT    NOT NULL,
  confidence    REAL,
  price_entry   REAL,
  price_target  REAL,
  stop_loss     REAL,
  rationale     TEXT,
  mm_trap_flag  INTEGER NOT NULL DEFAULT 0,
  mm_trap_type  TEXT    NOT NULL DEFAULT 'NONE',
  engine        TEXT    NOT NULL DEFAULT 'claude',
  outcome       TEXT    NOT NULL DEFAULT 'pending',
  exit_reason   TEXT,
  exit_price    REAL,
  pnl_pct       REAL
);
CREATE INDEX IF NOT EXISTS signals_run_candle ON signals(run_id, candle_ts);
CREATE INDEX IF NOT EXISTS signals_candle_ts  ON signals(candle_ts);
