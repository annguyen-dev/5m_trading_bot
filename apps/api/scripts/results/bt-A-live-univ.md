# Backtest — current prod BTC config

_Generated 2026-05-26T14:13:57.771Z_ · source: `/tmp/live-cfg-now.json (live DB)` (fetched 2026-05-26)

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

**Total:** 560 trades · WR **60.4%** · pnl $340 · maxDD $78.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 112 | 64 | 57.1 | 21.82 | 36.82 |
| armed_dca | 48 | 27 | 56.3 | 10.91 | 55.45 |
| edge_base | 294 | 183 | 62.2 | 193.64 | 30.91 |
| edge_dca | 102 | 62 | 60.8 | 107.27 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 242 | 153 | 63.2 | 180.91 | 27.73 |
| 4 | 152 | 86 | 56.6 | 28.18 | 77.27 |
| 5 | 72 | 42 | 58.3 | 55.45 | 47.73 |
| 6 | 48 | 29 | 60.4 | 46.82 | 31.36 |
| 7 | 33 | 23 | 69.7 | 60.91 | 16.82 |
| 8 | 8 | 3 | 37.5 | -19.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1585 trades · WR **57.2%** · pnl $393.18 · maxDD $169.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 266 | 147 | 55.3 | 6.36 | 79.55 |
| armed_dca | 118 | 69 | 58.5 | 74.55 | 73.64 |
| edge_base | 847 | 489 | 57.7 | 210.45 | 134.09 |
| edge_dca | 338 | 190 | 56.2 | 74.55 | 108.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 704 | 408 | 58 | 189.09 | 104.09 |
| 4 | 426 | 231 | 54.2 | -41.82 | 134.09 |
| 5 | 203 | 116 | 57.1 | 84.09 | 85 |
| 6 | 123 | 74 | 60.2 | 90.91 | 45.91 |
| 7 | 79 | 54 | 68.4 | 124.55 | 28.64 |
| 8 | 26 | 13 | 50 | -14.09 | 39.09 |
| 9 | 11 | 3 | 27.3 | -48.64 | 48.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3970 trades · WR **55.7%** · pnl $335.91 · maxDD $615.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 20 | 11 | 55 | 0 | 21.82 |
| idle_dca | 9 | 6 | 66.7 | 19.09 | 20 |
| armed_base | 761 | 413 | 54.3 | -50.45 | 158.64 |
| armed_dca | 344 | 191 | 55.5 | 32.73 | 290.91 |
| edge_base | 2008 | 1130 | 56.3 | 232.73 | 143.18 |
| edge_dca | 828 | 461 | 55.7 | 101.82 | 175.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1768 | 979 | 55.4 | 60 | 271.36 |
| 4 | 1088 | 618 | 56.8 | 263.18 | 164.09 |
| 5 | 467 | 256 | 54.8 | 20 | 150.91 |
| 6 | 275 | 157 | 57.1 | 67.27 | 106.36 |
| 7 | 198 | 119 | 60.1 | 101.82 | 73.18 |
| 8 | 83 | 42 | 50.6 | -56.82 | 96.82 |
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
