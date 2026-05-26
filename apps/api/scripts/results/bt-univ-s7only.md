# Backtest — current prod BTC config

_Generated 2026-05-26T08:02:54.206Z_ · source: `/tmp/cfg-B-s7_300-only.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-B-s7_300-only.json (live DB) |
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
| 7 | 7 | 7 | 300 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 463 trades · WR **62.2%** · pnl $375 · maxDD $45.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 84 | 54 | 64.3 | 70.91 | 20.45 |
| armed_dca | 30 | 18 | 60 | 27.27 | 40 |
| edge_base | 253 | 158 | 62.5 | 171.36 | 28.18 |
| edge_dca | 89 | 54 | 60.7 | 91.82 | 73.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 129 | 74 | 57.4 | 49.55 | 72.73 |
| 5 | 32 | 20 | 62.5 | 43.18 | 25 |
| 6 | 45 | 28 | 62.2 | 45.91 | 20.91 |
| 7 | 33 | 24 | 72.7 | 77.27 | 17.73 |
| 8 | 7 | 3 | 42.9 | -4.55 | 25 |
| 9 | 3 | 0 | 0 | -30 | 30 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1333 trades · WR **57.5%** · pnl $342.27 · maxDD $231.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 210 | 127 | 60.5 | 104.55 | 48.18 |
| armed_dca | 83 | 45 | 54.2 | -11.82 | 60.91 |
| edge_base | 723 | 415 | 57.4 | 157.73 | 122.73 |
| edge_dca | 295 | 166 | 56.3 | 68.18 | 141.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 383 | 206 | 53.8 | -59.09 | 168.18 |
| 5 | 90 | 54 | 60 | 81.36 | 67.27 |
| 6 | 119 | 72 | 60.5 | 58.18 | 30.91 |
| 7 | 78 | 54 | 69.2 | 141.36 | 20.91 |
| 8 | 24 | 12 | 50 | -1.36 | 37.73 |
| 9 | 11 | 3 | 27.3 | -63.64 | 63.64 |
| 10 | 7 | 5 | 71.4 | 10.45 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3269 trades · WR **56%** · pnl $310 · maxDD $403.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 572 | 320 | 55.9 | 49.09 | 149.09 |
| armed_dca | 251 | 131 | 52.2 | -128.18 | 189.09 |
| edge_base | 1702 | 962 | 56.5 | 235.45 | 147.73 |
| edge_dca | 707 | 396 | 56 | 130 | 197.27 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1502 | 844 | 56.2 | 162.73 | 170.45 |
| 4 | 941 | 530 | 56.3 | 156.36 | 212.27 |
| 5 | 191 | 106 | 55.5 | 30.91 | 113.18 |
| 6 | 266 | 151 | 56.8 | 23.18 | 77.73 |
| 7 | 196 | 119 | 60.7 | 130 | 87.73 |
| 8 | 80 | 40 | 50 | -33.64 | 75 |
| 9 | 42 | 21 | 50 | -44.09 | 86.36 |
| 10 | 17 | 11 | 64.7 | 16.36 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
