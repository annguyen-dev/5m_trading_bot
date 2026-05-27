# Backtest — current prod BTC config

_Generated 2026-05-27T04:05:10.740Z_ · source: `/tmp/cfg-armtrig300.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **300** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig300.json (live DB) |
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
| arm_trigger_body3_min | 300 |
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

### 90 days (25919 bars)

**Total:** 483 trades · WR **61.1%** · pnl $330.91 · maxDD $71.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 6 | 2 | 33.3 | -11.82 | 11.82 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 45 | 28 | 62.2 | 29.55 | 28.64 |
| armed_dca | 17 | 10 | 58.8 | 11.82 | 31.82 |
| edge_base | 303 | 187 | 61.7 | 185 | 40.91 |
| edge_dca | 108 | 65 | 60.2 | 101.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 211 | 137 | 64.9 | 190.45 | 30.45 |
| 4 | 128 | 72 | 56.3 | 32.27 | 60.91 |
| 5 | 66 | 40 | 60.6 | 59.09 | 40.91 |
| 6 | 34 | 20 | 58.8 | 31.82 | 38.64 |
| 7 | 31 | 21 | 67.7 | 45.45 | 15 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51839 bars)

**Total:** 1447 trades · WR **57.2%** · pnl $338.64 · maxDD $196.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 22 | 14 | 63.6 | 17.27 | 16.82 |
| idle_dca | 8 | 4 | 50 | -7.27 | 30 |
| armed_base | 140 | 76 | 54.3 | -9.09 | 77.27 |
| armed_dca | 63 | 36 | 57.1 | 24.55 | 61.82 |
| edge_base | 867 | 501 | 57.8 | 219.55 | 122.73 |
| edge_dca | 347 | 196 | 56.5 | 93.64 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 632 | 366 | 57.9 | 167.27 | 105.91 |
| 4 | 389 | 210 | 54 | -43.18 | 141.36 |
| 5 | 195 | 112 | 57.4 | 79.55 | 75.91 |
| 6 | 103 | 63 | 61.2 | 78.64 | 45 |
| 7 | 79 | 54 | 68.4 | 105.91 | 23.64 |
| 8 | 25 | 12 | 48 | -19.09 | 48.18 |
| 9 | 11 | 3 | 27.3 | -43.64 | 43.64 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105119 bars)

**Total:** 3542 trades · WR **56%** · pnl $460 · maxDD $368.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 40 | 21 | 52.5 | -9.09 | 46.82 |
| idle_dca | 19 | 10 | 52.6 | -8.18 | 40 |
| armed_base | 412 | 224 | 54.4 | -23.64 | 152.73 |
| armed_dca | 186 | 107 | 57.5 | 85.45 | 144.55 |
| edge_base | 2044 | 1151 | 56.3 | 243.64 | 146.36 |
| edge_dca | 841 | 472 | 56.1 | 171.82 | 158.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1552 | 863 | 55.6 | 85.45 | 245 |
| 4 | 963 | 552 | 57.3 | 305.45 | 175 |
| 5 | 440 | 243 | 55.2 | 43.18 | 104.55 |
| 6 | 225 | 129 | 57.3 | 61.36 | 70.91 |
| 7 | 195 | 118 | 60.5 | 111.82 | 48.64 |
| 8 | 79 | 39 | 49.4 | -57.73 | 92.73 |
| 9 | 38 | 21 | 55.3 | -4.55 | 48.64 |
| 10 | 17 | 11 | 64.7 | 41.82 | 25.91 |
| 11 | 9 | 2 | 22.2 | -37.73 | 45.91 |
| 12 | 7 | 1 | 14.3 | -36.82 | 36.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
