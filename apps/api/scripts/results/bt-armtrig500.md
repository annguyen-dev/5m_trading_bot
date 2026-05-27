# Backtest — current prod BTC config

_Generated 2026-05-27T04:06:37.127Z_ · source: `/tmp/cfg-armtrig500.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **500** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig500.json (live DB) |
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
| arm_trigger_body3_min | 500 |
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

**Total:** 449 trades · WR **60.6%** · pnl $282.27 · maxDD $100.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 9 | 5 | 55.6 | 0.45 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 14 | 8 | 57.1 | 2.73 | 10.91 |
| armed_dca | 6 | 3 | 50 | -5.45 | 11.82 |
| edge_base | 306 | 187 | 61.1 | 170 | 45.45 |
| edge_dca | 110 | 66 | 60 | 100 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 198 | 129 | 65.2 | 182.73 | 23.18 |
| 4 | 121 | 65 | 53.7 | -7.73 | 72.73 |
| 5 | 64 | 38 | 59.4 | 55 | 40.91 |
| 6 | 26 | 16 | 61.5 | 35.45 | 33.64 |
| 7 | 30 | 20 | 66.7 | 43.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -29.55 | 40 |
| 9 | 1 | 0 | 0 | -5 | 5 |
| 10 | 1 | 1 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1351 trades · WR **56.8%** · pnl $289.09 · maxDD $180.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 31 | 21 | 67.7 | 35.91 | 10 |
| idle_dca | 10 | 5 | 50 | -9.09 | 40 |
| armed_base | 54 | 23 | 42.6 | -60.91 | 71.36 |
| armed_dca | 31 | 18 | 58.1 | 17.27 | 41.82 |
| edge_base | 873 | 501 | 57.4 | 189.55 | 133.18 |
| edge_dca | 352 | 200 | 56.8 | 116.36 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 596 | 345 | 57.9 | 156.36 | 100 |
| 4 | 372 | 196 | 52.7 | -88.18 | 135 |
| 5 | 183 | 107 | 58.5 | 106.36 | 79.09 |
| 6 | 79 | 49 | 62 | 79.09 | 45.45 |
| 7 | 77 | 52 | 67.5 | 91.36 | 27.73 |
| 8 | 25 | 12 | 48 | -24.09 | 53.18 |
| 9 | 7 | 1 | 14.3 | -36.82 | 36.82 |
| 10 | 6 | 4 | 66.7 | 18.64 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3246 trades · WR **55.8%** · pnl $355.91 · maxDD $326.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 66 | 36 | 54.5 | -2.73 | 57.27 |
| idle_dca | 30 | 17 | 56.7 | 9.09 | 49.09 |
| armed_base | 152 | 74 | 48.7 | -87.27 | 152.27 |
| armed_dca | 77 | 45 | 58.4 | 48.18 | 65.45 |
| edge_base | 2067 | 1159 | 56.1 | 201.36 | 153.18 |
| edge_dca | 854 | 480 | 56.2 | 187.27 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1426 | 798 | 56 | 124.55 | 202.27 |
| 4 | 893 | 498 | 55.8 | 119.09 | 193.18 |
| 5 | 417 | 230 | 55.2 | 42.27 | 126.36 |
| 6 | 176 | 102 | 58 | 84.55 | 60.91 |
| 7 | 190 | 114 | 60 | 106.82 | 52.73 |
| 8 | 78 | 38 | 48.7 | -68.64 | 103.64 |
| 9 | 26 | 15 | 57.7 | 6.82 | 41.82 |
| 10 | 13 | 8 | 61.5 | 36.36 | 15 |
| 11 | 7 | 2 | 28.6 | -23.64 | 31.82 |
| 12 | 5 | 0 | 0 | -35 | 35 |
| 13 | 6 | 3 | 50 | -8.64 | 12.73 |
| 14 | 3 | 0 | 0 | -20 | 20 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
