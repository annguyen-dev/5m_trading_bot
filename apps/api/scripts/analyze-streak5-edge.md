# Streak 5 & 6 edge-case investigation (BTC, 2026-05-26)

Builds on `analyze-body3-by-streak.md` (the per-(streak × body3) reversal grid).
Base config: **B (tight)** applied live 2026-05-25:
`win=60 sig=3 base=6 idleB=500 armB=350 armT=100 dca=[2]`, edges `streak3/440/250 · streak4/420/300 · streak7/120/100`.

---

## Mechanism constraint (important)

Edge cases ONLY fire when `effectiveStreak < threshold` (PriceMonitoringWorker.ts:1420).
With `baseline=6` (idle threshold):

| streak | what runs |
|---|---|
| 3, 4, 5 | edge loop (idle); `streak3` / `streak4` / `streak5` edges eligible |
| **6** | normal idle gate (`idle_body3_min=500`) — edge NOT consulted |
| **7+** | normal idle gate (`idle_body3_min=500`) — edge NOT consulted; `streak7` edge in config is **dead code** at baseline≥7 |

Armed mode (`adapt.mode==='aggressive'`) bypasses edges entirely — uses `armed_body3_min=350` regardless of streak.

→ Streak6 edge would be **dead code** under current baseline. Streak6 idle is already gated by `idle_body3_min=500`, which matches the data sweet spot.

---

## Streak 5 — data (raw single-bar reversal %, n)

| body3 bucket | 365d | 180d |
|---|---|---|
| 0-100 | 46% (718) | 47% (418) |
| 100-200 | 50% (935) | 51% (435) |
| 200-300 | 48% (571) | 50% (232) |
| 300-400 | 54% (268) | 50% (114) |
| **400-500** | **61% (138)** | **67% (49)** |
| **500-700** | **59% (148)** | **62% (69)** |
| 700+ | 46% (102) | 46% (52) |

Sweet spot **body3 ∈ [400, 700)** at ~59-62% reversal. Below 400 is hover-around-break-even; above 700 the momentum continues (46%).

Under config B without a streak5 edge, **streak5 idle never fires** (5 < baseline 6, no edge match) → this entire band is currently missed.

---

## Streak 5 — floor sweep (backtest, end-to-end with DCA, 365d BTC)

Base = B, vary `streak5` edge `body3Min`:

| config | 90d (trades / WR / pnl / DD) | 180d | 365d |
|---|---|---|---|
| **B baseline** (no s5) | 467 / 62.3% / +$381 / 46 | 1330 / 57.5% / +$347 / 241 | 3244 / 56.0% / +$310 / 398 |
| B + s5/350 | 508 / 62.0% / +$421 / 72 | 1460 / 57.2% / +$407 / 236 | 3565 / 55.8% / +$255 / 525 |
| **B + s5/400** ⭐ | 494 / 62.1% / +$415 / 62 | 1419 / 57.5% / **+$435** / 189 | 3474 / 56.0% / **+$389** / 444 |
| B + s5/500 | 477 / 62.1% / +$381 / 56 | 1383 / 57.2% / +$348 / 229 | 3378 / 55.8% / +$258 / 430 |

**Floor=400 wins:** +$79 PnL/365d (+25% vs B), WR unchanged 56.0%, DD only +$46. 180d shows DD actually *lower* than B (−$52) with +$88 PnL.

- Floor 350 trades the marginal 350-400 bucket (~54% reversal) → −$134 vs 400 over 365d.
- Floor 500 misses the 400-500 sweet spot (61%) → −$131 vs 400.

---

## Streak 5 — composition breakdown (B + s5/400 vs B, 365d)

By-mode:

| mode | B trades / WR / pnl | B+s5/400 trades / WR / pnl |
|---|---|---|
| idle_base | 26 / 57.7% / +$6 | 26 / 57.7% / +$6 |
| idle_dca | 11 / 63.6% / +$17 | 11 / 63.6% / +$17 |
| armed_base | 991 / 57.3% / +$209 | 917 / 56.9% / +$160 |
| armed_dca | 422 / 53.3% / **−$129** | 395 / 54.2% / **−$59** |
| edge_base | 1262 / 55.8% / +$90 | 1501 / 55.8% / +$104 |
| edge_dca | 532 / 56.2% / +$116 | 624 / 56.4% / +$160 |

Streak5 row: B = 191 trades (all armed), +$31; B+s5/400 = **428 trades, 55.6%, +$46** (added ~237 idle-edge trades).

Side-effects worth noting:
- `armed_dca` loss shrinks **−$129 → −$59**: streak5 idle absorbs some losing setups that would otherwise have chained into armed-mode DCA.
- `edge_dca` rises +$44: DCA continuations from streak5 edge are profitable.
- WR overall unchanged (56.0%), DD modestly higher.

---

## Recommended edge case

```json
{
  "id": "s5_400",
  "label": "streak5",
  "enabled": true,
  "streakMin": 5,
  "streakMax": 5,
  "body3Min": 400,
  "dcaBody3Min": 350
}
```

Add to `echo_edge_cases` → 4 edges total: `streak3/440 · streak4/420 · streak5/400 (new) · streak7/120 (latent dead code, see below)`.

---

## Streak 6 — no new edge needed

Idle gate (`idle_body3_min=500`) already captures the data sweet spot:

| body3 bucket | 365d | 180d |
|---|---|---|
| 0-100 | 48% (344) | 47% (202) |
| 100-200 | 55% (462) | 51% (206) |
| 200-300 | 51% (270) | 51% (115) |
| 300-400 | 46% (138) | 49% (57) |
| 400-500 | 57% (75) | 47% (30) |
| **500-700** | **62% (74)** | **76% (33)** |
| 700+ | 54% (61) | 55% (31) |

Streak6 ≥500 = 58-66% reversal (good); below 500 is 46-57% (marginal/noisy). Current `idle_body3_min=500` cuts exactly there. Adding a streak6 edge would be **dead code** under baseline=6 (edge gate requires `effectiveStreak<threshold`).

---

## Side finding — `streak7` edge in current config is dead

`streak7` edge (`body3Min=120, dcaBody3Min=100`) cannot fire at `baseline≤7` because edge cases only run when `effectiveStreak<threshold`. At streak7 idle, the normal gate (`idle_body3_min=500`) applies; at streak7 armed, `armed_body3_min=350` applies. The 120-floor is unreachable.

Either disable/remove it or raise baseline to ≥8 (which would also change idle behavior for streak6/7).

---

## Artifacts

- Reversal grid: `analyze-body3-by-streak.ts` + `analyze-body3-by-streak.md` (365d) + `analyze-body3-180.md` (180d)
- Sweep backtests: `bt-B-s5_350.md`, `bt-B-s5_400.md`, `bt-B-s5_500.md`
- Base: `bt-B-tight.md`
