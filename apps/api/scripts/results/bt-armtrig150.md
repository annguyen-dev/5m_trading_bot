# Backtest — current prod BTC config

_Generated 2026-05-27T04:03:44.506Z_ · source: `/tmp/cfg-armtrig150.json (live DB)` (fetched 2026-05-27)

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

**Total:** 537 trades · WR **60.7%** · pnl $366.82 · maxDD $60.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 91 | 54 | 59.3 | 35.91 | 29.09 |
| armed_dca | 37 | 23 | 62.2 | 48.18 | 40 |
| edge_base | 298 | 182 | 61.1 | 164.55 | 40.91 |
| edge_dca | 107 | 65 | 60.7 | 111.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 234 | 151 | 64.5 | 202.73 | 27.73 |
| 4 | 144 | 80 | 55.6 | 16.36 | 67.27 |
| 5 | 71 | 43 | 60.6 | 82.73 | 37.73 |
| 6 | 44 | 26 | 59.1 | 35.45 | 48.64 |
| 7 | 31 | 21 | 67.7 | 57.73 | 15 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1552 trades · WR **57.3%** · pnl $435.45 · maxDD $184.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 14 | 8 | 57.1 | 2.73 | 15 |
| idle_dca | 6 | 3 | 50 | -5.45 | 30 |
| armed_base | 233 | 133 | 57.1 | 44.09 | 69.09 |
| armed_dca | 99 | 61 | 61.6 | 119.09 | 63.64 |
| edge_base | 855 | 490 | 57.3 | 179.55 | 134.09 |
| edge_dca | 345 | 195 | 56.5 | 95.45 | 100 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 687 | 402 | 58.5 | 219.55 | 99.09 |
| 4 | 413 | 223 | 54 | -49.09 | 143.64 |
| 5 | 202 | 115 | 56.9 | 89.09 | 85 |
| 6 | 121 | 73 | 60.3 | 86.82 | 48.64 |
| 7 | 79 | 54 | 68.4 | 134.55 | 23.64 |
| 8 | 26 | 13 | 50 | -15 | 44.09 |
| 9 | 11 | 3 | 27.3 | -43.64 | 43.64 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3860 trades · WR **56%** · pnl $502.27 · maxDD $477.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 22 | 11 | 50 | -10 | 22.73 |
| idle_dca | 11 | 6 | 54.5 | -0.91 | 40 |
| armed_base | 679 | 376 | 55.4 | 23.18 | 122.27 |
| armed_dca | 299 | 172 | 57.5 | 137.27 | 198.18 |
| edge_base | 2014 | 1129 | 56.1 | 193.64 | 144.09 |
| edge_dca | 835 | 468 | 56 | 159.09 | 162.73 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1711 | 956 | 55.9 | 135.91 | 243.64 |
| 4 | 1047 | 596 | 56.9 | 292.73 | 173.64 |
| 5 | 462 | 253 | 54.8 | 40.91 | 132.73 |
| 6 | 269 | 155 | 57.6 | 74.09 | 96.36 |
| 7 | 197 | 119 | 60.4 | 122.73 | 63.64 |
| 8 | 83 | 42 | 50.6 | -53.64 | 92.73 |
| 9 | 40 | 21 | 52.5 | -15.45 | 48.64 |
| 10 | 17 | 11 | 64.7 | 36.82 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
