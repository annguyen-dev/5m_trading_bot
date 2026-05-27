# Backtest — current prod BTC config

_Generated 2026-05-27T13:43:53.888Z_ · source: `/tmp/cfg-1h-v8.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **800** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-1h-v8.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 99 |
| echo_window_minutes | 360 |
| echo_signal_min_streak | 99 |
| echo_baseline_streak | 99 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 800 |
| idle_body3_min | 1500 |
| armed_body3_min | 1000 |
| dca_body3_min_idle | 1200 |
| dca_body3_min_armed | 800 |
| echo_dca_scale | [] |
| echo_dca_scale_idle | [] |
| echo_defensive_enabled | false |
| echo_chain_enabled | false |
| streak_min | 2 |
| auto_order_min_streak | 7 |
| dca_multiplier | 1.8 |
| dca_streak_whitelist | [4, 5, 9, 10] |
| entry_model_flat | 0.55 |

**Edge cases:**

| label | streakMin | streakMax | body3Min | dcaBody3Min |
|---|---|---|---|---|
| s3 | 3 | 3 | 1000 | 800 |
| s4 | 4 | 4 | 1000 | 800 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (2160 bars)

**Total:** 44 trades · WR **68.2%** · pnl $52.73 · maxDD $15

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 44 | 30 | 68.2 | 52.73 | 15 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 26 | 16 | 61.5 | 15.45 | 15.91 |
| 4 | 18 | 14 | 77.8 | 37.27 | 10.91 |

### 180 days (4320 bars)

**Total:** 112 trades · WR **64.3%** · pnl $94.55 · maxDD $30

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 112 | 72 | 64.3 | 94.55 | 30 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 71 | 46 | 64.8 | 63.18 | 15.91 |
| 4 | 41 | 26 | 63.4 | 31.36 | 22.73 |

### 365 days (8760 bars)

**Total:** 261 trades · WR **59.4%** · pnl $104.09 · maxDD $56.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 261 | 155 | 59.4 | 104.09 | 56.36 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 173 | 101 | 58.4 | 53.18 | 44.55 |
| 4 | 88 | 54 | 61.4 | 50.91 | 24.55 |
