# Backtest — current prod BTC config

_Generated 2026-05-26T09:40:05.552Z_ · source: `/tmp/cfg-dca-a450-i400.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-dca-a450-i400.json (live DB) |
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
| dca_body3_min_idle | 400 |
| dca_body3_min_armed | 450 |
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

**Total:** 537 trades · WR **60.7%** · pnl $338.64 · maxDD $76.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 265 | 161 | 60.8 | 138.64 | 48.64 |
| armed_dca | 47 | 25 | 53.2 | -15.45 | 50 |
| edge_base | 162 | 99 | 61.1 | 90 | 58.18 |
| edge_dca | 59 | 39 | 66.1 | 119.09 | 39.09 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 245 | 155 | 63.3 | 184.09 | 27.73 |
| 4 | 136 | 76 | 55.9 | 20 | 68.18 |
| 5 | 68 | 40 | 58.8 | 54.09 | 46.82 |
| 6 | 44 | 27 | 61.4 | 42.27 | 29.55 |
| 7 | 32 | 23 | 71.9 | 59.55 | 16.82 |
| 8 | 7 | 3 | 42.9 | -9.55 | 30 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51839 bars)

**Total:** 1532 trades · WR **57.1%** · pnl $334.55 · maxDD $186.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 724 | 411 | 56.8 | 116.36 | 140.91 |
| armed_dca | 172 | 92 | 53.5 | -47.27 | 166.36 |
| edge_base | 444 | 258 | 58.1 | 125.45 | 72.73 |
| edge_dca | 176 | 103 | 58.5 | 112.73 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 706 | 409 | 57.9 | 188.18 | 104.09 |
| 4 | 390 | 209 | 53.6 | -74.55 | 145.91 |
| 5 | 197 | 112 | 56.9 | 61.36 | 102.27 |
| 6 | 116 | 71 | 61.2 | 100.91 | 35.91 |
| 7 | 76 | 52 | 68.4 | 98.64 | 32.73 |
| 8 | 24 | 12 | 50 | -11.36 | 47.73 |
| 9 | 10 | 3 | 30 | -33.64 | 33.64 |
| 10 | 7 | 5 | 71.4 | 18.64 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105119 bars)

**Total:** 3783 trades · WR **55.6%** · pnl $255.91 · maxDD $514.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 18 | 11 | 61.1 | 10 | 15 |
| idle_dca | 7 | 4 | 57.1 | 2.73 | 21.82 |
| armed_base | 1949 | 1077 | 55.3 | 45.91 | 274.09 |
| armed_dca | 441 | 238 | 54 | -82.73 | 244.55 |
| edge_base | 972 | 549 | 56.5 | 130.91 | 72.73 |
| edge_dca | 396 | 226 | 57.1 | 149.09 | 170.91 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1770 | 980 | 55.4 | 59.09 | 271.36 |
| 4 | 950 | 535 | 56.3 | 127.73 | 197.73 |
| 5 | 449 | 246 | 54.8 | 8.18 | 167.27 |
| 6 | 263 | 152 | 57.8 | 100.45 | 88.64 |
| 7 | 189 | 114 | 60.3 | 89.09 | 67.73 |
| 8 | 78 | 39 | 50 | -40.45 | 85.45 |
| 9 | 37 | 20 | 54.1 | -8.64 | 39.55 |
| 10 | 17 | 11 | 64.7 | 20.45 | 30.91 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 6 | 0 | 0 | -40 | 40 |
| 13 | 7 | 3 | 42.9 | -8.64 | 12.73 |
| 14 | 3 | 0 | 0 | -25 | 25 |
| 15 | 3 | 2 | 66.7 | 7.27 | 5 |
| 16 | 1 | 0 | 0 | -10 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
