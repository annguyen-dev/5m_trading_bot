# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:52:54.233Z_ · 365d · 105120 bars

Event = bar at streak=4 with body3 > $900 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **86** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=4, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 4 | 50 | 58.1% |
| 5 | 20 | 23.3% |
| 6 | 11 | 12.8% |
| 7 | 3 | 3.5% |
| 9 | 1 | 1.2% |
| 10 | 1 | 1.2% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 50 | 58.1% | 58.1% |
| 1 | 20 | 23.3% | 81.4% |
| 2 | 11 | 12.8% | 94.2% |
| 3 | 3 | 3.5% | 97.7% |
| 5 | 1 | 1.2% | 98.8% |
| 6 | 1 | 1.2% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 4 | 86 | 50 | **58.1%** | ✅ EV $0.031/sh |
| 5 | 36 | 20 | **55.6%** | ✅ EV $0.006/sh |
| 6 | 16 | 11 | **68.8%** | ✅ EV $0.138/sh |
| 7 | 5 | 3 | **60.0%** | ✅ EV $0.050/sh |
| 8 | 2 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 9 | 2 | 1 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

