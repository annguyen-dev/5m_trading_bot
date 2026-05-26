# Backtest — current prod BTC config

_Generated 2026-05-25T14:01:24.194Z_ · source: `/tmp/cfg-armed250.json (live DB)` (fetched 2026-05-25)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-25 |
| source | /tmp/cfg-armed250.json (live DB) |
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
| armed_body3_min | 250 |
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
| 7 | 7 | 7 | 120 | 100 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 665 trades · WR **58.8%** · pnl $312.73 · maxDD $73.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 3 | 1 | 33.3 | -5.91 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 269 | 156 | 58 | 73.18 | 75 |
| armed_dca | 105 | 59 | 56.2 | 22.73 | 111.82 |
| edge_base | 206 | 122 | 59.2 | 79.09 | 53.18 |
| edge_dca | 80 | 51 | 63.7 | 127.27 | 51.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 295 | 183 | 62 | 188.64 | 41.82 |
| 4 | 175 | 93 | 53.1 | -23.18 | 98.64 |
| 5 | 43 | 26 | 60.5 | 43.18 | 30.91 |
| 6 | 75 | 41 | 54.7 | 18.18 | 50 |
| 7 | 47 | 32 | 68.1 | 86.82 | 20.91 |
| 8 | 13 | 6 | 46.2 | -7.27 | 30 |
| 9 | 8 | 5 | 62.5 | 2.73 | 11.82 |
| 10 | 5 | 3 | 60 | 2.27 | 5 |
| 11 | 3 | 2 | 66.7 | 11.36 | 5 |
| 12 | 1 | 0 | 0 | -10 | 10 |

### 180 days (51840 bars)

**Total:** 1738 trades · WR **56%** · pnl $175.45 · maxDD $279.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 11 | 68.8 | 20 | 10 |
| idle_dca | 5 | 3 | 60 | 4.55 | 20 |
| armed_base | 641 | 354 | 55.2 | 13.18 | 117.27 |
| armed_dca | 278 | 149 | 53.6 | -70.91 | 147.27 |
| edge_base | 565 | 322 | 57 | 102.27 | 86.82 |
| edge_dca | 233 | 134 | 57.5 | 106.36 | 143.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 777 | 451 | 58 | 215 | 98.18 |
| 4 | 470 | 249 | 53 | -120 | 153.18 |
| 5 | 115 | 65 | 56.5 | 28.64 | 90.45 |
| 6 | 182 | 95 | 52.2 | -50.45 | 89.55 |
| 7 | 113 | 71 | 62.8 | 127.73 | 47.27 |
| 8 | 39 | 20 | 51.3 | -0.45 | 46.36 |
| 9 | 20 | 11 | 55 | -11.36 | 25 |
| 10 | 12 | 7 | 58.3 | -1.36 | 15.91 |
| 11 | 5 | 3 | 60 | 9.55 | 10 |
| 12 | 2 | 0 | 0 | -15 | 15 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 4327 trades · WR **54.6%** · pnl $-187.73 · maxDD $743.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 16 | 61.5 | 15.45 | 15.91 |
| idle_dca | 10 | 6 | 60 | 9.09 | 23.64 |
| armed_base | 1722 | 923 | 53.6 | -219.09 | 360.91 |
| armed_dca | 773 | 413 | 53.4 | -220.91 | 321.82 |
| edge_base | 1263 | 704 | 55.7 | 85 | 119.55 |
| edge_dca | 533 | 301 | 56.5 | 142.73 | 289.09 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1935 | 1062 | 54.9 | -20.45 | 329.09 |
| 4 | 1171 | 653 | 55.8 | 85.45 | 200.91 |
| 5 | 254 | 139 | 54.7 | -29.09 | 146.36 |
| 6 | 441 | 224 | 50.8 | -200.45 | 258.18 |
| 7 | 279 | 162 | 58.1 | 142.73 | 104.55 |
| 8 | 114 | 61 | 53.5 | -5.45 | 65.45 |
| 9 | 60 | 32 | 53.3 | -21.36 | 67.73 |
| 10 | 31 | 17 | 54.8 | -5 | 24.55 |
| 11 | 13 | 5 | 38.5 | -28.18 | 47.73 |
| 12 | 9 | 1 | 11.1 | -50.91 | 50.91 |
| 13 | 8 | 3 | 37.5 | -10.45 | 13.64 |
| 14 | 5 | 0 | 0 | -40 | 40 |
| 15 | 4 | 3 | 75 | 6.36 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
