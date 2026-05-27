# Backtest — current prod BTC config

_Generated 2026-05-26T09:27:36.375Z_ · source: `/tmp/live-cfg-now.json (live DB)` (fetched 2026-05-26)

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

**Total:** 559 trades · WR **61%** · pnl $380.45 · maxDD $81.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 244 | 149 | 61.1 | 134.55 | 34.09 |
| armed_dca | 95 | 53 | 55.8 | 13.64 | 70 |
| edge_base | 159 | 99 | 62.3 | 105 | 53.18 |
| edge_dca | 57 | 38 | 66.7 | 120.91 | 31.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 243 | 154 | 63.4 | 185 | 27.73 |
| 4 | 154 | 87 | 56.5 | 30.45 | 87.27 |
| 5 | 71 | 42 | 59.2 | 60.45 | 47.73 |
| 6 | 49 | 30 | 61.2 | 55 | 31.36 |
| 7 | 30 | 23 | 76.7 | 75.91 | 16.82 |
| 8 | 7 | 3 | 42.9 | -13.64 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1576 trades · WR **57.1%** · pnl $390 · maxDD $186.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 670 | 378 | 56.4 | 86.36 | 144.55 |
| armed_dca | 291 | 163 | 56 | 53.64 | 106.36 |
| edge_base | 428 | 248 | 57.9 | 114.55 | 81.36 |
| edge_dca | 171 | 100 | 58.5 | 108.18 | 80 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 704 | 408 | 58 | 189.09 | 104.09 |
| 4 | 430 | 233 | 54.2 | -41.36 | 135.91 |
| 5 | 202 | 116 | 57.4 | 89.09 | 85 |
| 6 | 127 | 76 | 59.8 | 87.27 | 45.91 |
| 7 | 65 | 45 | 69.2 | 112.73 | 31.36 |
| 8 | 24 | 12 | 50 | -11.36 | 40 |
| 9 | 11 | 3 | 27.3 | -44.55 | 44.55 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3952 trades · WR **55.6%** · pnl $220.45 · maxDD $654.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 20 | 11 | 55 | 0 | 21.82 |
| idle_dca | 9 | 6 | 66.7 | 19.09 | 20 |
| armed_base | 1804 | 999 | 55.4 | 61.82 | 248.18 |
| armed_dca | 801 | 436 | 54.4 | -82.73 | 412.73 |
| edge_base | 935 | 528 | 56.5 | 125 | 81.36 |
| edge_dca | 383 | 216 | 56.4 | 97.27 | 210 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1768 | 979 | 55.4 | 60 | 271.36 |
| 4 | 1098 | 622 | 56.6 | 240 | 176.82 |
| 5 | 466 | 256 | 54.9 | 25 | 150.91 |
| 6 | 287 | 159 | 55.4 | -16.36 | 155.91 |
| 7 | 165 | 101 | 61.2 | 103.18 | 66.36 |
| 8 | 77 | 38 | 49.4 | -70.91 | 103.64 |
| 9 | 40 | 21 | 52.5 | -17.27 | 51.36 |
| 10 | 17 | 11 | 64.7 | 28.64 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
