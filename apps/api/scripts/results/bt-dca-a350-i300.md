# Backtest — current prod BTC config

_Generated 2026-05-26T09:37:45.202Z_ · source: `/tmp/cfg-dca-a350-i300.json (live DB)` (fetched 2026-05-26)

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

**Total:** 538 trades · WR **60.8%** · pnl $341.82 · maxDD $103.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 114 | 66 | 57.9 | 30 | 36.82 |
| armed_dca | 28 | 14 | 50 | -25.45 | 74.55 |
| edge_base | 292 | 183 | 62.7 | 203.64 | 30.91 |
| edge_dca | 100 | 62 | 62 | 127.27 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 244 | 155 | 63.5 | 189.09 | 27.73 |
| 4 | 137 | 77 | 56.2 | 18.64 | 80.91 |
| 5 | 69 | 40 | 58 | 44.09 | 60.91 |
| 6 | 44 | 27 | 61.4 | 50.45 | 29.55 |
| 7 | 32 | 23 | 71.9 | 61.82 | 16.82 |
| 8 | 7 | 3 | 42.9 | -9.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1541 trades · WR **57.1%** · pnl $350.45 · maxDD $194.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 267 | 148 | 55.4 | 10.45 | 79.55 |
| armed_dca | 78 | 43 | 55.1 | 1.82 | 74.55 |
| edge_base | 844 | 488 | 57.8 | 216.36 | 134.09 |
| edge_dca | 336 | 190 | 56.5 | 94.55 | 108.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 705 | 409 | 58 | 193.18 | 104.09 |
| 4 | 397 | 212 | 53.4 | -93.18 | 169.55 |
| 5 | 199 | 113 | 56.8 | 64.55 | 87.73 |
| 6 | 116 | 71 | 61.2 | 106.36 | 35.91 |
| 7 | 76 | 52 | 68.4 | 113.18 | 28.64 |
| 8 | 25 | 13 | 52 | -4.09 | 39.09 |
| 9 | 10 | 3 | 30 | -38.64 | 38.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3821 trades · WR **55.7%** · pnl $306.82 · maxDD $530.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 19 | 11 | 57.9 | 5 | 16.82 |
| idle_dca | 8 | 5 | 62.5 | 10.91 | 21.82 |
| armed_base | 763 | 414 | 54.3 | -51.36 | 163.64 |
| armed_dca | 200 | 109 | 54.5 | -18.18 | 210.91 |
| edge_base | 2005 | 1129 | 56.3 | 238.64 | 143.18 |
| edge_dca | 826 | 461 | 55.8 | 121.82 | 175.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1769 | 980 | 55.4 | 64.09 | 271.36 |
| 4 | 980 | 553 | 56.4 | 165.45 | 222.27 |
| 5 | 454 | 249 | 54.8 | 17.73 | 146.36 |
| 6 | 263 | 152 | 57.8 | 96.36 | 100.45 |
| 7 | 189 | 114 | 60.3 | 95.91 | 61.36 |
| 8 | 82 | 42 | 51.2 | -46.82 | 96.82 |
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
