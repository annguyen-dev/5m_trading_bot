# Backtest — current prod BTC config

_Generated 2026-05-27T04:07:05.250Z_ · source: `/tmp/cfg-armtrig600.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **600** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig600.json (live DB) |
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
| arm_trigger_body3_min | 600 |
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
| idle_base | 10 | 6 | 60 | 4.55 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 13 | 7 | 53.8 | -1.36 | 11.82 |
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

**Total:** 1339 trades · WR **57.1%** · pnl $293.18 · maxDD $188.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 33 | 23 | 69.7 | 44.09 | 10 |
| idle_dca | 10 | 5 | 50 | -9.09 | 40 |
| armed_base | 45 | 21 | 46.7 | -34.09 | 49.09 |
| armed_dca | 24 | 12 | 50 | -21.82 | 41.82 |
| edge_base | 875 | 503 | 57.5 | 197.73 | 125 |
| edge_dca | 352 | 200 | 56.8 | 116.36 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 590 | 344 | 58.3 | 177.27 | 89.09 |
| 4 | 368 | 193 | 52.4 | -106.82 | 155.45 |
| 5 | 183 | 107 | 58.5 | 106.36 | 79.09 |
| 6 | 78 | 49 | 62.8 | 84.09 | 45.45 |
| 7 | 77 | 52 | 67.5 | 87.27 | 27.73 |
| 8 | 24 | 12 | 50 | -19.09 | 48.18 |
| 9 | 7 | 1 | 14.3 | -40.91 | 40.91 |
| 10 | 6 | 4 | 66.7 | 18.64 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3190 trades · WR **56.1%** · pnl $432.73 · maxDD $304.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 75 | 43 | 57.3 | 15.91 | 57.27 |
| idle_dca | 32 | 19 | 59.4 | 25.45 | 40 |
| armed_base | 106 | 55 | 51.9 | -30 | 103.64 |
| armed_dca | 50 | 29 | 58 | 27.27 | 51.82 |
| edge_base | 2071 | 1162 | 56.1 | 208.64 | 153.18 |
| edge_dca | 856 | 481 | 56.2 | 185.45 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1394 | 787 | 56.5 | 184.55 | 169.09 |
| 4 | 874 | 488 | 55.8 | 119.09 | 217.73 |
| 5 | 415 | 230 | 55.4 | 61.36 | 117.27 |
| 6 | 174 | 101 | 58 | 85.45 | 60.91 |
| 7 | 190 | 114 | 60 | 102.73 | 52.73 |
| 8 | 77 | 38 | 49.4 | -63.64 | 98.64 |
| 9 | 26 | 15 | 57.7 | 2.73 | 45.91 |
| 10 | 13 | 8 | 61.5 | 36.36 | 15 |
| 11 | 7 | 2 | 28.6 | -23.64 | 31.82 |
| 12 | 5 | 0 | 0 | -35 | 35 |
| 13 | 6 | 3 | 50 | -8.64 | 12.73 |
| 14 | 3 | 0 | 0 | -20 | 20 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
