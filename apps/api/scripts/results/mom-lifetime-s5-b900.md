# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T08:12:54.776Z_ · 365d · 105120 bars

Event = bar at streak=5 with body3 > $900 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **46** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=5, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 5 | 24 | 52.2% |
| 6 | 11 | 23.9% |
| 7 | 9 | 19.6% |
| 9 | 1 | 2.2% |
| 15 | 1 | 2.2% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 24 | 52.2% | 52.2% |
| 1 | 11 | 23.9% | 76.1% |
| 2 | 9 | 19.6% | 95.7% |
| 4 | 1 | 2.2% | 97.8% |
| 10 | 1 | 2.2% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 5 | 46 | 24 | **52.2%** | ⚠️ EV $-0.028/sh |
| 6 | 22 | 11 | **50.0%** | ⚠️ EV $-0.050/sh |
| 7 | 11 | 9 | **81.8%** | ✅ EV $0.268/sh |
| 8 | 2 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 9 | 2 | 1 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

