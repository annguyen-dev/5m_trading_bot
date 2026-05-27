# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:51:16.656Z_ · 365d · 105120 bars

Event = bar at streak=3 with body3 > $700 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **373** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=3, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 3 | 214 | 57.4% |
| 4 | 83 | 22.3% |
| 5 | 37 | 9.9% |
| 6 | 23 | 6.2% |
| 7 | 8 | 2.1% |
| 8 | 2 | 0.5% |
| 9 | 3 | 0.8% |
| 10 | 3 | 0.8% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 214 | 57.4% | 57.4% |
| 1 | 83 | 22.3% | 79.6% |
| 2 | 37 | 9.9% | 89.5% |
| 3 | 23 | 6.2% | 95.7% |
| 4 | 8 | 2.1% | 97.9% |
| 5 | 2 | 0.5% | 98.4% |
| 6 | 3 | 0.8% | 99.2% |
| 7 | 3 | 0.8% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 3 | 373 | 214 | **57.4%** | ✅ EV $0.024/sh |
| 4 | 159 | 83 | **52.2%** | ⚠️ EV $-0.028/sh |
| 5 | 76 | 37 | **48.7%** | ⚠️ EV $-0.063/sh |
| 6 | 39 | 23 | **59.0%** | ✅ EV $0.040/sh |
| 7 | 16 | 8 | **50.0%** | ⚠️ EV $-0.050/sh |
| 8 | 8 | 2 | **25.0%** | ⚠️ EV $-0.300/sh |
| 9 | 6 | 3 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 3 | 3 | **100.0%** | ✅ EV $0.450/sh |

