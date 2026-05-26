# Backtest — current prod BTC config

_Generated 2026-05-25T13:50:39.124Z_ · source: `/tmp/cfg-retune.json (live DB)` (fetched 2026-05-25)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-25 |
| source | /tmp/cfg-retune.json (live DB) |
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
| echo_baseline_streak | 8 |
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
| s3 | 3 | 3 | 350 | 300 |
| s4 | 4 | 4 | 180 | 250 |
| s5 | 5 | 5 | 380 | 400 |
| s6 | 6 | 6 | 400 | 400 |
| s7 | 7 | 7 | 250 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 1018 trades · WR **58.7%** · pnl $376.36 · maxDD $169.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 110 | 82 | 74.5 | 195.45 | 10.91 |
| armed_dca | 28 | 16 | 57.1 | 10.91 | 42.73 |
| edge_base | 694 | 395 | 56.9 | 120.91 | 161.36 |
| edge_dca | 186 | 105 | 56.5 | 49.09 | 106.36 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 324 | 199 | 61.4 | 189.09 | 37.73 |
| 4 | 491 | 276 | 56.2 | 56.36 | 104.55 |
| 5 | 119 | 68 | 57.1 | 31.36 | 119.55 |
| 6 | 42 | 27 | 64.3 | 59.09 | 15 |
| 7 | 30 | 23 | 76.7 | 70.91 | 23.64 |
| 8 | 7 | 3 | 42.9 | -8.64 | 25 |
| 9 | 3 | 0 | 0 | -30 | 30 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 2555 trades · WR **56.6%** · pnl $513.18 · maxDD $214.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 292 | 178 | 61 | 158.18 | 110.45 |
| armed_dca | 114 | 62 | 54.4 | -12.73 | 86.36 |
| edge_base | 1637 | 910 | 55.6 | 87.73 | 228.18 |
| edge_dca | 512 | 297 | 58 | 280 | 106.36 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 894 | 513 | 57.4 | 193.64 | 134.09 |
| 4 | 1123 | 624 | 55.6 | 85.91 | 136.36 |
| 5 | 312 | 176 | 56.4 | 97.27 | 125 |
| 6 | 115 | 69 | 60 | 97.73 | 37.73 |
| 7 | 64 | 44 | 68.8 | 101.82 | 39.55 |
| 8 | 23 | 11 | 47.8 | -18.64 | 47.27 |
| 9 | 11 | 3 | 27.3 | -49.55 | 49.55 |
| 10 | 7 | 5 | 71.4 | 18.64 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 6219 trades · WR **55.3%** · pnl $187.73 · maxDD $872.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 827 | 481 | 58.2 | 237.73 | 110.45 |
| armed_dca | 346 | 178 | 51.4 | -223.64 | 313.64 |
| edge_base | 3854 | 2104 | 54.6 | -142.73 | 422.73 |
| edge_dca | 1192 | 673 | 56.5 | 316.36 | 250.91 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 2182 | 1199 | 54.9 | -10 | 317.73 |
| 4 | 2724 | 1514 | 55.6 | 191.36 | 274.09 |
| 5 | 724 | 397 | 54.8 | 12.73 | 304.09 |
| 6 | 258 | 150 | 58.1 | 132.27 | 78.64 |
| 7 | 161 | 97 | 60.2 | 89.09 | 68.64 |
| 8 | 78 | 38 | 48.7 | -84.09 | 112.73 |
| 9 | 41 | 21 | 51.2 | -36.36 | 70.45 |
| 10 | 17 | 11 | 64.7 | 24.55 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
