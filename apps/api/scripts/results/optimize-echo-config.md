# Echo config optimization — BTC

_Generated 2026-05-25T10:15:01.369Z_ · grid 648 combos · entry $0.55 (WR pricing-independent, PnL relative)

Held fixed: `echo_trigger_streak`, `echo_window_minutes`, edge cases, `dca_body3_min_*`.
Swept: armed streak, idle baseline (99 = idle off), arm-trigger body3, idle body3, armed body3, DCA scale.

## Baseline (current live config)

`sig=3 base=5 armT=100 idleB=150 armB=150 dca=[2]` (live)

| period | trades / WR / pnl$ / maxDD$ |
|---|---|
| 90d  | 1747 / 55.5% / +13 / 517 |
| 180d | 3857 / 55.3% / +92 / 517 |
| 365d | 9408 / 54.1% / -733 / 1302 |

## Pareto-better configs (WR ≥ and PnL ≥ baseline on ALL 3 periods): 365 found

| config | 90d WR/pnl | 180d WR/pnl | 365d WR/pnl | trades 365d |
|---|---|---|---|---|
| `sig=3 base=5 armT=300 idleB=300 armB=350 dca=[3,4]` | 60.8% / +319 | 56.8% / +438 | 55.8% / +465 | 3850 |
| `sig=3 base=6 armT=300 idleB=300 armB=350 dca=[2]` | 61.3% / +338 | 57.2% / +340 | 55.8% / +319 | 3391 |
| `sig=3 base=5 armT=100 idleB=300 armB=350 dca=[3,4]` | 60.8% / +315 | 57% / +493 | 55.7% / +593 | 4054 |
| `sig=3 base=6 armT=200 idleB=300 armB=350 dca=[2]` | 60.8% / +317 | 57.2% / +338 | 55.9% / +310 | 3516 |
| `sig=3 base=5 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.9% / +308 | 57.1% / +450 | 55.8% / +725 | 3825 |
| `sig=3 base=off armT=100 idleB=150 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=off armT=100 idleB=300 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=off armT=100 idleB=450 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=6 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.6% / +287 | 57% / +445 | 55.8% / +733 | 3774 |
| `sig=3 base=5 armT=200 idleB=300 armB=350 dca=[3,4]` | 60.1% / +283 | 56.8% / +422 | 55.9% / +568 | 3919 |
| `sig=3 base=5 armT=200 idleB=450 armB=350 dca=[3,4]` | 60.4% / +281 | 56.8% / +376 | 55.8% / +665 | 3629 |
| `sig=3 base=7 armT=200 idleB=300 armB=350 dca=[2]` | 60.9% / +303 | 57% / +303 | 55.8% / +279 | 3451 |
| `sig=3 base=7 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.5% / +271 | 56.8% / +377 | 55.7% / +652 | 3740 |
| `sig=3 base=7 armT=200 idleB=450 armB=350 dca=[2]` | 60.9% / +305 | 56.9% / +293 | 55.8% / +268 | 3437 |
| `sig=3 base=6 armT=100 idleB=150 armB=350 dca=[3,4]` | 60.3% / +266 | 56.9% / +435 | 55.8% / +696 | 3886 |

## Top configs by robustness (worst-period PnL, then total)

| config | 90d WR/pnl | 180d WR/pnl | 365d WR/pnl | trades 365d |
|---|---|---|---|---|
| `sig=3 base=5 armT=300 idleB=300 armB=350 dca=[3,4]` | 60.8% / +319 | 56.8% / +438 | 55.8% / +465 | 3850 |
| `sig=3 base=6 armT=300 idleB=300 armB=350 dca=[2]` | 61.3% / +338 | 57.2% / +340 | 55.8% / +319 | 3391 |
| `sig=3 base=5 armT=100 idleB=300 armB=350 dca=[3,4]` | 60.8% / +315 | 57% / +493 | 55.7% / +593 | 4054 |
| `sig=3 base=6 armT=200 idleB=300 armB=350 dca=[2]` | 60.8% / +317 | 57.2% / +338 | 55.9% / +310 | 3516 |
| `sig=3 base=5 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.9% / +308 | 57.1% / +450 | 55.8% / +725 | 3825 |
| `sig=3 base=off armT=100 idleB=150 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=off armT=100 idleB=300 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=off armT=100 idleB=450 armB=350 dca=[3,4]` | 60.7% / +295 | 57.1% / +422 | 55.7% / +664 | 3777 |
| `sig=3 base=6 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.6% / +287 | 57% / +445 | 55.8% / +733 | 3774 |
| `sig=3 base=5 armT=200 idleB=300 armB=350 dca=[3,4]` | 60.1% / +283 | 56.8% / +422 | 55.9% / +568 | 3919 |
| `sig=3 base=5 armT=200 idleB=450 armB=350 dca=[3,4]` | 60.4% / +281 | 56.8% / +376 | 55.8% / +665 | 3629 |
| `sig=3 base=7 armT=200 idleB=300 armB=350 dca=[2]` | 60.9% / +303 | 57% / +303 | 55.8% / +279 | 3451 |
| `sig=3 base=7 armT=100 idleB=450 armB=350 dca=[3,4]` | 60.5% / +271 | 56.8% / +377 | 55.7% / +652 | 3740 |
| `sig=3 base=7 armT=200 idleB=450 armB=350 dca=[2]` | 60.9% / +305 | 56.9% / +293 | 55.8% / +268 | 3437 |
| `sig=3 base=6 armT=100 idleB=150 armB=350 dca=[3,4]` | 60.3% / +266 | 56.9% / +435 | 55.8% / +696 | 3886 |

## Recommended

`sig=3 base=5 armT=300 idleB=300 armB=350 dca=[3,4]`

| period | baseline (trades/WR/pnl/DD) | recommended |
|---|---|---|
| 90d  | 1747 / 55.5% / +13 / 517 | 561 / 60.8% / +319 / 136 |
| 180d | 3857 / 55.3% / +92 / 517 | 1578 / 56.8% / +438 / 250 |
| 365d | 9408 / 54.1% / -733 / 1302 | 3850 / 55.8% / +465 / 593 |

Full config to apply (other fields unchanged from live):

```json
{
  "echo_signal_min_streak": 3,
  "echo_baseline_streak": 5,
  "arm_trigger_body3_min": 300,
  "idle_body3_min": 300,
  "armed_body3_min": 350,
  "echo_dca_scale": [
    3,
    4
  ],
  "echo_dca_scale_idle": [
    3,
    4
  ]
}
```

_Caveat: single in-sample period per window (no walk-forward); robustness proxied by requiring improvement across 90/180/365d. PnL at flat $0.55 — real entries differ. Re-validate before sizing up._
