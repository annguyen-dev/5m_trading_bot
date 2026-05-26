# Echo config — max WR with frequency floor (BTC)

_Generated 2026-05-25T10:33:49.788Z_ · grid 2592 combos · entry $0.55 · band 5–8 orders/day

Objective: **maximise WR** subject to **5–8 orders/day** in EVERY period and PnL ≥ baseline.
Held fixed: `echo_trigger_streak`, `echo_window_minutes`, edge cases, `dca_body3_min_*`. Swept: armed streak, idle baseline (99=off), arm-trigger/idle/armed body3, DCA scale.

## Baseline (current live config)

`sig=3 base=5 armT=100 idleB=150 armB=150 dca=[2]` (live)

| period | trades (per day) / WR / pnl$ / maxDD$ |
|---|---|
| 90d  | 1747 (19.4/d) / 55.5% / +13 / 517 |
| 180d | 3857 (21.4/d) / 55.3% / +92 / 517 |
| 365d | 9408 (25.8/d) / 54.1% / -733 / 1302 |

## Top by WR — 5–8/day AND PnL ≥ baseline (18 qualify)

| config | 90d WR / per-day | 180d WR / per-day | 365d WR / per-day | 365d pnl$ |
|---|---|---|---|---|
| `win=120 sig=4 base=8 armT=300 idleB=700 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 8 | +142 |
| `win=120 sig=4 base=off armT=300 idleB=300 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=120 sig=4 base=off armT=300 idleB=500 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=120 sig=4 base=off armT=300 idleB=700 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=90 sig=5 base=8 armT=300 idleB=700 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.6% / 7.5 | +80 |
| `win=120 sig=4 base=8 armT=300 idleB=500 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.5% / 8 | +127 |
| `win=120 sig=4 base=8 armT=300 idleB=300 armB=350 dca=[2]` | 58.6% / 5.1 | 55.9% / 6.9 | 55.5% / 8 | +115 |
| `win=90 sig=5 base=off armT=300 idleB=300 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=off armT=300 idleB=500 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=off armT=300 idleB=700 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=8 armT=300 idleB=500 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +65 |
| `win=90 sig=5 base=8 armT=300 idleB=300 armB=350 dca=[2]` | 58.4% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +54 |
| `win=60 sig=5 base=8 armT=300 idleB=700 armB=350 dca=[2]` | 58.6% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | +16 |
| `win=60 sig=5 base=off armT=300 idleB=300 armB=350 dca=[2]` | 58.6% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | +12 |
| `win=60 sig=5 base=off armT=300 idleB=500 armB=350 dca=[2]` | 58.6% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | +12 |
| `win=60 sig=5 base=off armT=300 idleB=700 armB=350 dca=[2]` | 58.6% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | +12 |
| `win=60 sig=5 base=8 armT=300 idleB=500 armB=350 dca=[2]` | 58.6% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | +1 |
| `win=60 sig=5 base=8 armT=300 idleB=300 armB=350 dca=[2]` | 58.5% / 5.2 | 56.3% / 6.9 | 55.3% / 7.9 | -2 |

## Top by WR — 5–8/day only (35 qualify)

| config | 90d WR / per-day | 180d WR / per-day | 365d WR / per-day | 365d pnl$ |
|---|---|---|---|---|
| `win=120 sig=4 base=8 armT=300 idleB=700 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 8 | +142 |
| `win=120 sig=4 base=off armT=300 idleB=300 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=120 sig=4 base=off armT=300 idleB=500 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=120 sig=4 base=off armT=300 idleB=700 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.6% / 7.9 | +138 |
| `win=90 sig=5 base=8 armT=300 idleB=700 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.6% / 7.5 | +80 |
| `win=120 sig=4 base=8 armT=300 idleB=500 armB=350 dca=[2]` | 58.7% / 5 | 55.9% / 6.9 | 55.5% / 8 | +127 |
| `win=120 sig=4 base=8 armT=300 idleB=300 armB=350 dca=[2]` | 58.6% / 5.1 | 55.9% / 6.9 | 55.5% / 8 | +115 |
| `win=90 sig=5 base=off armT=300 idleB=300 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=off armT=300 idleB=500 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=off armT=300 idleB=700 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +76 |
| `win=90 sig=5 base=8 armT=300 idleB=500 armB=350 dca=[2]` | 58.5% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +65 |
| `win=90 sig=5 base=8 armT=300 idleB=300 armB=350 dca=[2]` | 58.4% / 5 | 56.4% / 6.5 | 55.5% / 7.5 | +54 |
| `win=90 sig=5 base=off armT=300 idleB=300 armB=500 dca=[3,4]` | 58.3% / 5 | 55.4% / 6.8 | 55.6% / 7.8 | +345 |
| `win=90 sig=5 base=off armT=300 idleB=500 armB=500 dca=[3,4]` | 58.3% / 5 | 55.4% / 6.8 | 55.6% / 7.8 | +345 |
| `win=90 sig=5 base=off armT=300 idleB=700 armB=500 dca=[3,4]` | 58.3% / 5 | 55.4% / 6.8 | 55.6% / 7.8 | +345 |
| `win=90 sig=5 base=8 armT=300 idleB=500 armB=500 dca=[3,4]` | 58.3% / 5 | 55.4% / 6.8 | 55.6% / 7.8 | +305 |
| `win=90 sig=5 base=8 armT=300 idleB=700 armB=500 dca=[3,4]` | 58.3% / 5 | 55.4% / 6.8 | 55.6% / 7.8 | +305 |
| `win=60 sig=5 base=off armT=300 idleB=300 armB=650 dca=[3,4]` | 58.2% / 5.2 | 55.3% / 7.1 | 55.7% / 8 | +455 |
| `win=60 sig=5 base=off armT=300 idleB=500 armB=650 dca=[3,4]` | 58.2% / 5.2 | 55.3% / 7.1 | 55.7% / 8 | +455 |
| `win=60 sig=5 base=off armT=300 idleB=700 armB=650 dca=[3,4]` | 58.2% / 5.2 | 55.3% / 7.1 | 55.7% / 8 | +455 |

## Recommended (highest WR meeting the frequency floor)

`win=120 sig=4 base=8 armT=300 idleB=700 armB=350 dca=[2]`

| period | baseline: trades(/d)/WR/pnl/DD | recommended |
|---|---|---|
| 90d  | 1747 (19.4/d) / 55.5% / +13 / 517 | 453 (5/d) / 58.7% / +169 / 146 |
| 180d | 3857 (21.4/d) / 55.3% / +92 / 517 | 1237 (6.9/d) / 55.9% / +107 / 217 |
| 365d | 9408 (25.8/d) / 54.1% / -733 / 1302 | 2902 (8/d) / 55.6% / +142 / 296 |

Full config to apply (other fields unchanged from live):

```json
{
  "echo_window_minutes": 120,
  "echo_signal_min_streak": 4,
  "echo_baseline_streak": 8,
  "arm_trigger_body3_min": 300,
  "idle_body3_min": 700,
  "armed_body3_min": 350,
  "echo_dca_scale": [
    2
  ],
  "echo_dca_scale_idle": [
    2
  ]
}
```

_Caveat: higher WR comes from tighter filters → fewer trades. Frequency floor = 5/day keeps volume. Single in-sample period per window (no walk-forward); PnL at flat $0.55 — real entries differ. Validate at small size before scaling._
