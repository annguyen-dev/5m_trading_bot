# Backtest — current prod BTC config

_Generated 2026-05-26T09:39:40.840Z_ · source: `/tmp/cfg-dca-a350-i300.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-dca-a350-i300.json (live DB) |
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
| dca_body3_min_idle | 300 |
| dca_body3_min_armed | 350 |
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

**Total:** 536 trades · WR **60.8%** · pnl $343.64 · maxDD $95.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 245 | 150 | 61.2 | 138.64 | 34.09 |
| armed_dca | 68 | 36 | 52.9 | -25.45 | 73.64 |
| edge_base | 161 | 99 | 61.5 | 95 | 57.27 |
| edge_dca | 58 | 39 | 67.2 | 129.09 | 31.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 244 | 155 | 63.5 | 189.09 | 27.73 |
| 4 | 136 | 76 | 55.9 | 10.45 | 80.91 |
| 5 | 68 | 40 | 58.8 | 54.09 | 50.91 |
| 6 | 44 | 27 | 61.4 | 50.45 | 29.55 |
| 7 | 32 | 23 | 71.9 | 61.82 | 16.82 |
| 8 | 7 | 3 | 42.9 | -9.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1531 trades · WR **57.2%** · pnl $359.55 · maxDD $180.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 671 | 380 | 56.6 | 99.55 | 135.45 |
| armed_dca | 230 | 126 | 54.8 | -9.09 | 89.09 |
| edge_base | 440 | 256 | 58.2 | 127.27 | 72.73 |
| edge_dca | 174 | 102 | 58.6 | 114.55 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 705 | 409 | 58 | 193.18 | 104.09 |
| 4 | 390 | 209 | 53.6 | -77.73 | 145.91 |
| 5 | 197 | 112 | 56.9 | 66.36 | 93.18 |
| 6 | 116 | 71 | 61.2 | 106.36 | 35.91 |
| 7 | 76 | 52 | 68.4 | 113.18 | 28.64 |
| 8 | 24 | 12 | 50 | -12.27 | 47.27 |
| 9 | 10 | 3 | 30 | -38.64 | 38.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3784 trades · WR **55.7%** · pnl $276.82 · maxDD $542.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 19 | 11 | 57.9 | 5 | 16.82 |
| idle_dca | 8 | 5 | 62.5 | 10.91 | 21.82 |
| armed_base | 1804 | 1000 | 55.4 | 70.91 | 235 |
| armed_dca | 594 | 324 | 54.5 | -49.09 | 327.27 |
| edge_base | 964 | 543 | 56.3 | 116.36 | 76.82 |
| edge_dca | 395 | 224 | 56.7 | 122.73 | 189.09 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1769 | 980 | 55.4 | 64.09 | 271.36 |
| 4 | 952 | 537 | 56.4 | 154.55 | 217.73 |
| 5 | 449 | 246 | 54.8 | 13.18 | 158.18 |
| 6 | 263 | 152 | 57.8 | 96.36 | 100.45 |
| 7 | 189 | 114 | 60.3 | 95.91 | 61.36 |
| 8 | 78 | 39 | 50 | -61.36 | 102.27 |
| 9 | 37 | 20 | 54.1 | -8.64 | 48.64 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 6 | 0 | 0 | -45 | 45 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 3 | 0 | 0 | -20 | 20 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
