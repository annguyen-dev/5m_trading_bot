# Backtest — current prod BTC config

_Generated 2026-05-27T07:43:13.433Z_ · source: `/tmp/cfg-armtrig150.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **150** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig150.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 5 |
| echo_window_minutes | 150 |
| echo_signal_min_streak | 3 |
| echo_baseline_streak | 6 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 150 |
| idle_body3_min | 500 |
| armed_body3_min | 350 |
| dca_body3_min_idle | 200 |
| dca_body3_min_armed | 150 |
| echo_dca_scale | [2] |
| echo_dca_scale_idle | [2] |
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
| streak3 | 3 | 3 | 440 | 250 |
| streak4 | 4 | 4 | 420 | 300 |
| streak5 | 5 | 5 | 400 | 350 |
| 7 | 7 | 7 | 300 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 515 trades · WR **60.8%** · pnl $370.45 · maxDD $60.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 3 | 1 | 33.3 | -5.91 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 73 | 43 | 58.9 | 25.91 | 25 |
| armed_dca | 30 | 20 | 66.7 | 63.64 | 30 |
| edge_base | 299 | 181 | 60.5 | 150.45 | 40.91 |
| edge_dca | 108 | 66 | 61.1 | 120 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 225 | 145 | 64.4 | 193.18 | 29.55 |
| 4 | 140 | 78 | 55.7 | 33.18 | 67.27 |
| 5 | 69 | 43 | 62.3 | 96.82 | 25 |
| 6 | 38 | 22 | 57.9 | 20.91 | 43.64 |
| 7 | 30 | 20 | 66.7 | 54.55 | 11.82 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1484 trades · WR **57.3%** · pnl $411.82 · maxDD $203.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 19 | 12 | 63.2 | 14.09 | 10 |
| idle_dca | 7 | 3 | 42.9 | -15.45 | 40 |
| armed_base | 177 | 102 | 57.6 | 42.27 | 46.82 |
| armed_dca | 74 | 46 | 62.2 | 96.36 | 63.64 |
| edge_base | 858 | 488 | 56.9 | 146.36 | 149.55 |
| edge_dca | 349 | 199 | 57 | 128.18 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 654 | 386 | 59 | 239.09 | 83.18 |
| 4 | 397 | 211 | 53.1 | -75 | 201.36 |
| 5 | 196 | 114 | 58.2 | 126.36 | 80.91 |
| 6 | 110 | 64 | 58.2 | 39.55 | 45 |
| 7 | 78 | 53 | 67.9 | 131.36 | 23.64 |
| 8 | 26 | 13 | 50 | -15 | 44.09 |
| 9 | 10 | 2 | 20 | -47.73 | 47.73 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3663 trades · WR **56.1%** · pnl $506.36 · maxDD $506.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 40 | 21 | 52.5 | -9.09 | 33.18 |
| idle_dca | 19 | 12 | 63.2 | 28.18 | 40 |
| armed_base | 511 | 289 | 56.6 | 72.27 | 111.36 |
| armed_dca | 219 | 126 | 57.5 | 100.91 | 196.36 |
| edge_base | 2029 | 1134 | 55.9 | 164.09 | 149.55 |
| edge_dca | 845 | 473 | 56 | 150 | 188.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1610 | 908 | 56.4 | 204.55 | 168.64 |
| 4 | 994 | 562 | 56.5 | 235.91 | 229.55 |
| 5 | 446 | 245 | 54.9 | 60.45 | 142.27 |
| 6 | 248 | 143 | 57.7 | 50.45 | 75.45 |
| 7 | 194 | 117 | 60.3 | 141.36 | 49.09 |
| 8 | 83 | 42 | 50.6 | -64.55 | 99.55 |
| 9 | 37 | 18 | 48.6 | -30.91 | 52.73 |
| 10 | 17 | 11 | 64.7 | 40.91 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
