# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T08:06:20.239Z_ · 365d · 105120 bars

Event = bar at streak=5 with body3 > $700 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **101** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=5, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 5 | 47 | 46.5% |
| 6 | 25 | 24.8% |
| 7 | 18 | 17.8% |
| 8 | 4 | 4.0% |
| 9 | 3 | 3.0% |
| 10 | 3 | 3.0% |
| 15 | 1 | 1.0% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 47 | 46.5% | 46.5% |
| 1 | 25 | 24.8% | 71.3% |
| 2 | 18 | 17.8% | 89.1% |
| 3 | 4 | 4.0% | 93.1% |
| 4 | 3 | 3.0% | 96.0% |
| 5 | 3 | 3.0% | 99.0% |
| 10 | 1 | 1.0% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 5 | 101 | 47 | **46.5%** | ⚠️ EV $-0.085/sh |
| 6 | 54 | 25 | **46.3%** | ⚠️ EV $-0.087/sh |
| 7 | 29 | 18 | **62.1%** | ✅ EV $0.071/sh |
| 8 | 11 | 4 | **36.4%** | ⚠️ EV $-0.186/sh |
| 9 | 7 | 3 | **42.9%** | ⚠️ EV $-0.121/sh |
| 10 | 4 | 3 | **75.0%** | ✅ EV $0.200/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

