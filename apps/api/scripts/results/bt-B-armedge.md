# Backtest — current prod BTC config

_Generated 2026-05-26T14:14:25.559Z_ · source: `/tmp/live-cfg-now.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/live-cfg-now.json (live DB) |
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
| arm_trigger_body3_min | 100 |
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

**Total:** 611 trades · WR **59.9%** · pnl $350.45 · maxDD $101.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 153 | 85 | 55.6 | 7.73 | 47.73 |
| armed_dca | 67 | 40 | 59.7 | 57.27 | 61.82 |
| edge_base | 289 | 180 | 62.3 | 191.36 | 35 |
| edge_dca | 100 | 60 | 60 | 90.91 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 276 | 174 | 63 | 201.82 | 33.64 |
| 4 | 164 | 93 | 56.7 | 57.73 | 79.09 |
| 5 | 77 | 42 | 54.5 | 11.36 | 72.73 |
| 6 | 48 | 29 | 60.4 | 50.91 | 31.36 |
| 7 | 33 | 23 | 69.7 | 60.91 | 16.82 |
| 8 | 8 | 3 | 37.5 | -19.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1736 trades · WR **56.7%** · pnl $397.27 · maxDD $205

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 393 | 213 | 54.2 | -28.64 | 115 |
| armed_dca | 176 | 106 | 60.2 | 167.27 | 83.64 |
| edge_base | 832 | 478 | 57.5 | 185.45 | 156.36 |
| edge_dca | 333 | 187 | 56.2 | 70 | 106.36 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 797 | 463 | 58.1 | 224.09 | 99.55 |
| 4 | 463 | 249 | 53.8 | -34.09 | 139.55 |
| 5 | 219 | 120 | 54.8 | 37.73 | 102.73 |
| 6 | 128 | 76 | 59.4 | 94.55 | 45.91 |
| 7 | 79 | 54 | 68.4 | 128.64 | 28.64 |
| 8 | 26 | 13 | 50 | -14.09 | 39.09 |
| 9 | 11 | 3 | 27.3 | -48.64 | 48.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 4306 trades · WR **55.4%** · pnl $235 · maxDD $635.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 1031 | 554 | 53.7 | -118.64 | 198.18 |
| armed_dca | 468 | 260 | 55.6 | 47.27 | 318.18 |
| edge_base | 1987 | 1118 | 56.3 | 228.64 | 168.64 |
| edge_dca | 818 | 454 | 55.5 | 74.55 | 204.55 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1959 | 1089 | 55.6 | 105 | 252.73 |
| 4 | 1176 | 658 | 56 | 183.64 | 180 |
| 5 | 511 | 277 | 54.2 | 2.73 | 126.36 |
| 6 | 287 | 161 | 56.1 | 14.09 | 132.73 |
| 7 | 198 | 119 | 60.1 | 111.82 | 68.18 |
| 8 | 84 | 42 | 50 | -62.73 | 97.73 |
| 9 | 40 | 21 | 52.5 | -20.45 | 53.64 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
