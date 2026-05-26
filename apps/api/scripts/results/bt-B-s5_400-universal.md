# Backtest — current prod BTC config

_Generated 2026-05-26T07:54:23.994Z_ · source: `/tmp/cfg-B-s5_400.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-B-s5_400.json (live DB) |
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
| 7 | 7 | 7 | 120 | 100 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 587 trades · WR **60.1%** · pnl $355 · maxDD $98.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 63 | 38 | 60.3 | 30.45 | 23.64 |
| armed_dca | 25 | 17 | 68 | 59.09 | 30 |
| edge_base | 358 | 216 | 60.3 | 173.64 | 44.55 |
| edge_dca | 134 | 78 | 58.2 | 78.18 | 123.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 128 | 73 | 57 | 45.45 | 72.73 |
| 5 | 63 | 37 | 58.7 | 42.73 | 50 |
| 6 | 45 | 28 | 62.2 | 58.64 | 30 |
| 7 | 97 | 58 | 59.8 | 68.18 | 35.91 |
| 8 | 37 | 18 | 48.6 | -41.82 | 71.82 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1607 trades · WR **56.7%** · pnl $328.18 · maxDD $214.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 144 | 82 | 56.9 | 25.45 | 68.64 |
| armed_dca | 62 | 39 | 62.9 | 89.09 | 55.45 |
| edge_base | 976 | 551 | 56.5 | 129.09 | 186.36 |
| edge_dca | 403 | 225 | 55.8 | 60.91 | 123.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 382 | 205 | 53.7 | -63.18 | 168.18 |
| 5 | 184 | 107 | 58.2 | 93.18 | 75.91 |
| 6 | 118 | 72 | 61 | 106.36 | 35.91 |
| 7 | 203 | 117 | 57.6 | 94.55 | 45.45 |
| 8 | 81 | 41 | 50.6 | -56.82 | 123.64 |
| 9 | 11 | 3 | 27.3 | -47.73 | 47.73 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3890 trades · WR **55.8%** · pnl $349.55 · maxDD $435.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 402 | 225 | 56 | 35.45 | 70.91 |
| armed_dca | 177 | 98 | 55.4 | 11.82 | 168.18 |
| edge_base | 2311 | 1291 | 55.9 | 181.36 | 186.36 |
| edge_dca | 963 | 535 | 55.6 | 97.27 | 191.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1501 | 844 | 56.2 | 167.73 | 165.45 |
| 4 | 940 | 529 | 56.3 | 152.27 | 212.27 |
| 5 | 427 | 237 | 55.5 | 41.82 | 115.91 |
| 6 | 262 | 151 | 57.6 | 99.09 | 95.91 |
| 7 | 475 | 267 | 56.2 | 92.73 | 97.27 |
| 8 | 196 | 103 | 52.6 | -83.18 | 138.18 |
| 9 | 39 | 20 | 51.3 | -30.91 | 56.82 |
| 10 | 17 | 11 | 64.7 | 31.82 | 31.82 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
