# Backtest — current prod BTC config

_Generated 2026-05-26T08:03:22.858Z_ · source: `/tmp/cfg-B-s7_300-only.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-B-s7_300-only.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 5 |
| echo_window_minutes | 60 |
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
| 7 | 7 | 7 | 300 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 461 trades · WR **62.5%** · pnl $385 · maxDD $45.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 132 | 91 | 68.9 | 167.27 | 23.18 |
| armed_dca | 41 | 23 | 56.1 | 8.18 | 44.55 |
| edge_base | 203 | 121 | 59.6 | 85 | 58.18 |
| edge_dca | 78 | 49 | 62.8 | 110.91 | 61.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 130 | 75 | 57.7 | 57.73 | 72.73 |
| 5 | 32 | 20 | 62.5 | 43.18 | 25 |
| 6 | 45 | 28 | 62.2 | 45.91 | 20.91 |
| 7 | 30 | 23 | 76.7 | 83.18 | 17.73 |
| 8 | 7 | 3 | 42.9 | -8.64 | 25 |
| 9 | 3 | 0 | 0 | -30 | 30 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1321 trades · WR **57.5%** · pnl $338.64 · maxDD $240.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 362 | 216 | 59.7 | 153.64 | 109.09 |
| armed_dca | 146 | 79 | 54.1 | -23.64 | 80 |
| edge_base | 559 | 317 | 56.7 | 86.82 | 86.82 |
| edge_dca | 232 | 133 | 57.3 | 98.18 | 131.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 385 | 208 | 54 | -42.73 | 160 |
| 5 | 90 | 54 | 60 | 81.36 | 67.27 |
| 6 | 119 | 72 | 60.5 | 58.18 | 30.91 |
| 7 | 65 | 45 | 69.2 | 124.55 | 28.18 |
| 8 | 23 | 11 | 47.8 | -8.64 | 37.27 |
| 9 | 11 | 3 | 27.3 | -59.55 | 59.55 |
| 10 | 7 | 5 | 71.4 | 10.45 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3238 trades · WR **56%** · pnl $290 · maxDD $397.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 990 | 567 | 57.3 | 204.55 | 110.45 |
| armed_dca | 422 | 225 | 53.3 | -129.09 | 253.64 |
| edge_base | 1258 | 701 | 55.7 | 82.73 | 122.73 |
| edge_dca | 531 | 298 | 56.1 | 108.18 | 287.27 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1502 | 844 | 56.2 | 162.73 | 170.45 |
| 4 | 946 | 533 | 56.3 | 160.91 | 213.64 |
| 5 | 191 | 106 | 55.5 | 30.91 | 113.18 |
| 6 | 266 | 151 | 56.8 | 23.18 | 77.73 |
| 7 | 165 | 102 | 61.8 | 130.45 | 80.91 |
| 8 | 75 | 36 | 48 | -57.73 | 86.36 |
| 9 | 42 | 21 | 50 | -40.91 | 87.27 |
| 10 | 17 | 11 | 64.7 | 12.27 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
