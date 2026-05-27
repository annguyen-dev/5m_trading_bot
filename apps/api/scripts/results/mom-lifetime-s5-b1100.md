# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T08:13:22.821Z_ · 365d · 105120 bars

Event = bar at streak=5 with body3 > $1100 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **27** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=5, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 5 | 12 | 44.4% |
| 6 | 9 | 33.3% |
| 7 | 4 | 14.8% |
| 9 | 1 | 3.7% |
| 15 | 1 | 3.7% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 12 | 44.4% | 44.4% |
| 1 | 9 | 33.3% | 77.8% |
| 2 | 4 | 14.8% | 92.6% |
| 4 | 1 | 3.7% | 96.3% |
| 10 | 1 | 3.7% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 5 | 27 | 12 | **44.4%** | ⚠️ EV $-0.106/sh |
| 6 | 15 | 9 | **60.0%** | ✅ EV $0.050/sh |
| 7 | 6 | 4 | **66.7%** | ✅ EV $0.117/sh |
| 8 | 2 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 9 | 2 | 1 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

