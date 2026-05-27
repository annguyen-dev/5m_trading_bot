# Backtest — current prod BTC config

_Generated 2026-05-26T09:39:17.809Z_ · source: `/tmp/cfg-dca-a250-i200.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-dca-a250-i200.json (live DB) |
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
| dca_body3_min_armed | 250 |
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

**Total:** 552 trades · WR **60.9%** · pnl $365.45 · maxDD $80.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 245 | 150 | 61.2 | 138.64 | 34.09 |
| armed_dca | 84 | 46 | 54.8 | -3.64 | 74.55 |
| edge_base | 161 | 99 | 61.5 | 95 | 57.27 |
| edge_dca | 58 | 39 | 67.2 | 129.09 | 31.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 244 | 155 | 63.5 | 189.09 | 27.73 |
| 4 | 146 | 83 | 56.8 | 37.73 | 67.27 |
| 5 | 70 | 41 | 58.6 | 52.27 | 55.91 |
| 6 | 48 | 29 | 60.4 | 46.82 | 35.45 |
| 7 | 32 | 23 | 71.9 | 61.82 | 16.82 |
| 8 | 7 | 3 | 42.9 | -9.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1571 trades · WR **57.2%** · pnl $377.73 · maxDD $175.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 671 | 380 | 56.6 | 99.55 | 135.45 |
| armed_dca | 270 | 149 | 55.2 | 9.09 | 122.73 |
| edge_base | 440 | 256 | 58.2 | 127.27 | 72.73 |
| edge_dca | 174 | 102 | 58.6 | 114.55 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 705 | 409 | 58 | 193.18 | 104.09 |
| 4 | 418 | 227 | 54.3 | -30.45 | 132.27 |
| 5 | 200 | 114 | 57 | 72.73 | 85 |
| 6 | 123 | 73 | 59.3 | 72.73 | 45.91 |
| 7 | 76 | 52 | 68.4 | 113.18 | 28.64 |
| 8 | 25 | 13 | 52 | -4.09 | 39.09 |
| 9 | 11 | 3 | 27.3 | -48.64 | 48.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3921 trades · WR **55.7%** · pnl $288.64 · maxDD $531.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 20 | 11 | 55 | 0 | 21.82 |
| idle_dca | 9 | 6 | 66.7 | 19.09 | 20 |
| armed_base | 1802 | 999 | 55.4 | 71.82 | 234.09 |
| armed_dca | 730 | 399 | 54.7 | -45.45 | 292.73 |
| edge_base | 965 | 544 | 56.4 | 120.45 | 76.82 |
| edge_dca | 395 | 224 | 56.7 | 122.73 | 189.09 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1769 | 980 | 55.4 | 64.09 | 271.36 |
| 4 | 1050 | 596 | 56.8 | 247.27 | 186.82 |
| 5 | 461 | 254 | 55.1 | 38.64 | 130.91 |
| 6 | 279 | 155 | 55.6 | -9.09 | 134.09 |
| 7 | 191 | 115 | 60.2 | 94.09 | 69.55 |
| 8 | 82 | 42 | 51.2 | -46.82 | 96.82 |
| 9 | 39 | 21 | 53.8 | -10.45 | 53.64 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
