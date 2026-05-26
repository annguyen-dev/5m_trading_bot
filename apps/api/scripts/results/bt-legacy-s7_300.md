# Backtest — current prod BTC config

_Generated 2026-05-26T07:57:12.379Z_ · source: `/tmp/cfg-B-s5_400-s7_300.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-B-s5_400-s7_300.json (live DB) |
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
| streak5 | 5 | 5 | 400 | 350 |
| 7 | 7 | 7 | 300 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 493 trades · WR **62.1%** · pnl $411.36 · maxDD $61.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 122 | 83 | 68 | 144.55 | 17.73 |
| armed_dca | 39 | 23 | 59 | 28.18 | 40 |
| edge_base | 235 | 139 | 59.1 | 88.64 | 77.27 |
| edge_dca | 90 | 57 | 63.3 | 136.36 | 63.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 130 | 75 | 57.7 | 57.73 | 72.73 |
| 5 | 64 | 38 | 59.4 | 46.82 | 45.91 |
| 6 | 45 | 28 | 62.2 | 58.64 | 30 |
| 7 | 30 | 23 | 76.7 | 85 | 11.82 |
| 8 | 7 | 3 | 42.9 | -18.64 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1417 trades · WR **57.4%** · pnl $426.82 · maxDD $188.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 330 | 190 | 57.6 | 77.27 | 158.64 |
| armed_dca | 140 | 79 | 56.4 | 36.36 | 81.82 |
| edge_base | 657 | 374 | 56.9 | 115 | 103.64 |
| edge_dca | 268 | 157 | 58.6 | 174.55 | 88.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 385 | 208 | 54 | -42.73 | 160 |
| 5 | 185 | 108 | 58.4 | 97.27 | 75.91 |
| 6 | 119 | 72 | 60.5 | 96.36 | 35.91 |
| 7 | 65 | 45 | 69.2 | 130 | 31.36 |
| 8 | 24 | 12 | 50 | -16.36 | 45 |
| 9 | 11 | 3 | 27.3 | -39.55 | 39.55 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3474 trades · WR **56%** · pnl $389.09 · maxDD $444.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 917 | 522 | 56.9 | 160.45 | 158.64 |
| armed_dca | 395 | 214 | 54.2 | -59.09 | 253.64 |
| edge_base | 1501 | 837 | 55.8 | 104.09 | 124.55 |
| edge_dca | 624 | 352 | 56.4 | 160 | 237.27 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1501 | 844 | 56.2 | 167.73 | 165.45 |
| 4 | 946 | 533 | 56.3 | 160.91 | 213.64 |
| 5 | 428 | 238 | 55.6 | 45.91 | 115.91 |
| 6 | 266 | 151 | 56.8 | 59.09 | 105.91 |
| 7 | 165 | 102 | 61.8 | 142.73 | 60.91 |
| 8 | 77 | 38 | 49.4 | -75.91 | 108.64 |
| 9 | 40 | 21 | 52.5 | -12.27 | 46.36 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
