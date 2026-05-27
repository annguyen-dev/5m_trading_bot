# Backtest — current prod BTC config

_Generated 2026-05-26T09:38:13.759Z_ · source: `/tmp/cfg-dca-a450-i400.json (live DB)` (fetched 2026-05-26)

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

### 90 days (25920 bars)

**Total:** 539 trades · WR **60.7%** · pnl $329.09 · maxDD $100

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 123 | 71 | 57.7 | 30.45 | 42.73 |
| armed_dca | 13 | 6 | 46.2 | -20.91 | 50 |
| edge_base | 297 | 186 | 62.6 | 205.91 | 31.36 |
| edge_dca | 102 | 62 | 60.8 | 107.27 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 245 | 155 | 63.3 | 184.09 | 27.73 |
| 4 | 137 | 77 | 56.2 | 30.45 | 68.64 |
| 5 | 69 | 40 | 58 | 35 | 60.91 |
| 6 | 44 | 27 | 61.4 | 46.36 | 29.55 |
| 7 | 32 | 23 | 71.9 | 59.55 | 16.82 |
| 8 | 7 | 3 | 42.9 | -14.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1542 trades · WR **57.1%** · pnl $319.55 · maxDD $202.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 8 | 66.7 | 12.73 | 15 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 290 | 161 | 55.5 | 13.64 | 83.18 |
| armed_dca | 42 | 21 | 50 | -38.18 | 64.55 |
| edge_base | 855 | 496 | 58 | 234.09 | 127.27 |
| edge_dca | 339 | 191 | 56.3 | 82.73 | 116.36 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 706 | 409 | 57.9 | 188.18 | 104.09 |
| 4 | 397 | 212 | 53.4 | -84.09 | 173.18 |
| 5 | 199 | 113 | 56.8 | 50.45 | 94.09 |
| 6 | 116 | 71 | 61.2 | 104.09 | 35.91 |
| 7 | 76 | 52 | 68.4 | 98.64 | 32.73 |
| 8 | 25 | 13 | 52 | -9.09 | 44.09 |
| 9 | 10 | 3 | 30 | -33.64 | 33.64 |
| 10 | 7 | 5 | 71.4 | 18.64 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3821 trades · WR **55.7%** · pnl $325 · maxDD $480.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 18 | 11 | 61.1 | 10 | 15 |
| idle_dca | 7 | 4 | 57.1 | 2.73 | 21.82 |
| armed_base | 823 | 441 | 53.6 | -105.91 | 200 |
| armed_dca | 115 | 63 | 54.8 | -4.55 | 110.91 |
| edge_base | 2026 | 1142 | 56.4 | 251.82 | 137.27 |
| edge_dca | 832 | 467 | 56.1 | 170.91 | 170.91 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1770 | 980 | 55.4 | 59.09 | 271.36 |
| 4 | 979 | 552 | 56.4 | 181.82 | 218.18 |
| 5 | 454 | 249 | 54.8 | 2.73 | 153.64 |
| 6 | 263 | 152 | 57.8 | 123.18 | 88.64 |
| 7 | 189 | 114 | 60.3 | 89.09 | 67.73 |
| 8 | 82 | 42 | 51.2 | -39.55 | 88.64 |
| 9 | 37 | 20 | 54.1 | -11.82 | 47.73 |
| 10 | 17 | 11 | 64.7 | 20.45 | 30.91 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 6 | 0 | 0 | -40 | 40 |
| 13 | 7 | 3 | 42.9 | -8.64 | 12.73 |
| 14 | 3 | 0 | 0 | -25 | 25 |
| 15 | 3 | 2 | 66.7 | 7.27 | 5 |
| 16 | 1 | 0 | 0 | -10 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
