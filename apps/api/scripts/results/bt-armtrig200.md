# Backtest — current prod BTC config

_Generated 2026-05-27T04:04:13.092Z_ · source: `/tmp/cfg-armtrig200.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **200** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig200.json (live DB) |
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
| arm_trigger_body3_min | 200 |
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

**Total:** 523 trades · WR **60.2%** · pnl $324.55 · maxDD $63.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 79 | 45 | 57 | 14.09 | 34.55 |
| armed_dca | 34 | 20 | 58.8 | 23.64 | 40 |
| edge_base | 299 | 183 | 61.2 | 168.64 | 40.91 |
| edge_dca | 107 | 65 | 60.7 | 111.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 227 | 146 | 64.3 | 192.27 | 30.45 |
| 4 | 139 | 76 | 54.7 | -3.18 | 71.36 |
| 5 | 71 | 43 | 60.6 | 78.64 | 37.73 |
| 6 | 42 | 24 | 57.1 | 27.27 | 48.64 |
| 7 | 31 | 21 | 67.7 | 57.73 | 15 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1516 trades · WR **57.1%** · pnl $382.73 · maxDD $182.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 15 | 9 | 60 | 6.82 | 15 |
| idle_dca | 6 | 3 | 50 | -5.45 | 30 |
| armed_base | 202 | 111 | 55 | -0.91 | 65.45 |
| armed_dca | 90 | 55 | 61.1 | 100 | 61.82 |
| edge_base | 857 | 491 | 57.3 | 178.64 | 139.09 |
| edge_dca | 346 | 196 | 56.6 | 103.64 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 666 | 389 | 58.4 | 206.36 | 98.18 |
| 4 | 403 | 216 | 53.6 | -68.18 | 141.82 |
| 5 | 202 | 115 | 56.9 | 89.09 | 80.91 |
| 6 | 116 | 68 | 58.6 | 66.36 | 48.64 |
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

**Total:** 3763 trades · WR **55.9%** · pnl $475.91 · maxDD $433.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 23 | 12 | 52.2 | -5.91 | 21.82 |
| idle_dca | 11 | 6 | 54.5 | -0.91 | 40 |
| armed_base | 601 | 326 | 54.2 | -41.36 | 129.09 |
| armed_dca | 272 | 159 | 58.5 | 170.91 | 167.27 |
| edge_base | 2019 | 1130 | 56 | 177.73 | 150 |
| edge_dca | 837 | 470 | 56.2 | 175.45 | 158.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1662 | 927 | 55.8 | 117.27 | 231.82 |
| 4 | 1018 | 579 | 56.9 | 287.27 | 155 |
| 5 | 455 | 250 | 54.9 | 50.45 | 124.09 |
| 6 | 258 | 146 | 56.6 | 53.18 | 91.36 |
| 7 | 197 | 119 | 60.4 | 131.82 | 63.64 |
| 8 | 82 | 41 | 50 | -53.64 | 92.73 |
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
