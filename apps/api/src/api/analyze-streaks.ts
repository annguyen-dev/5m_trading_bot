/**
 * Streak pattern analyzer for the Analyze page.
 *
 *   GET /api/analyze/streak-stats?coin=BTC&days=7
 *
 * Pulls 5-minute Binance klines for the requested range, classifies each
 * candle (up / down / doji — doji breaks streaks), then computes:
 *
 *   1. Per-streak-length statistics (count, per-day frequency, last occurrence)
 *   2. High-volatility threshold detection (top quantile + run length)
 *   3. Post-extreme analysis (after a long streak, how long until sideways
 *      streak-3/4 trading dominates again?)
 *   4. Hour-of-day hotness map for "big" streaks
 *   5. Heuristic config suggestion (auto_order_min_streak, dca whitelist)
 *
 * No AI calls — pure deterministic stats + simple heuristics. Anthropic-based
 * suggestion can be layered on top later.
 */
import type { Request, Response } from 'express';
import { withRetry } from '@trading-bot/core/retry';

// Binance kline symbol per coin. HYPE is unavailable on Binance spot; we
// return an explicit error for it (Pyth fallback is worker-only).
const BINANCE_SYMBOL: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  SOL:  'SOLUSDT',
  XRP:  'XRPUSDT',
  DOGE: 'DOGEUSDT',
  BNB:  'BNBUSDT',
};

const WINDOW_MS = 300_000;

interface Bar {
  openTime:  number;
  open:      number;
  close:     number;
  closeTime: number;
}

async function fetchBinance5m(symbol: string, startMs: number, endMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = startMs;
  // Binance returns max 1000 bars per call. Paginate by openTime.
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const resp = await withRetry(`Binance ${symbol}`, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return r.json() as Promise<Array<Array<string | number>>>;
    });
    if (!resp.length) break;
    for (const k of resp) {
      out.push({
        openTime:  Number(k[0]),
        open:      Number(k[1]),
        close:     Number(k[4]),
        closeTime: Number(k[6]),
      });
    }
    cursor = Number(resp[resp.length - 1]![0]) + 1;
  }
  return out;
}

interface StreakRun {
  /** Signed length: positive=UP run, negative=DOWN run. */
  signed:   number;
  /** Index of LAST bar in the run (the bar that ended/closed the streak). */
  lastIdx:  number;
  /** Timestamp of last bar in run. */
  endedAt:  number;
}

/**
 * Walk closed bars and emit one StreakRun per consecutive same-direction
 * sequence (length ≥ 1). Doji bars (close == open) BREAK the run — they
 * neither extend nor join the next run.
 */
function detectStreakRuns(bars: Bar[]): StreakRun[] {
  const runs: StreakRun[] = [];
  let sign = 0;
  let len  = 0;
  let runStartIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
    if (dir === 0) {
      if (len > 0) {
        runs.push({ signed: sign * len, lastIdx: i - 1, endedAt: bars[i - 1]!.closeTime });
        len = 0; sign = 0; runStartIdx = -1;
      }
      continue;
    }
    if (dir === sign) {
      len++;
    } else {
      if (len > 0) {
        runs.push({ signed: sign * len, lastIdx: i - 1, endedAt: bars[i - 1]!.closeTime });
      }
      sign = dir; len = 1; runStartIdx = i;
    }
  }
  if (len > 0) {
    const lastIdx = bars.length - 1;
    runs.push({ signed: sign * len, lastIdx, endedAt: bars[lastIdx]!.closeTime });
  }
  void runStartIdx;
  return runs;
}

function fmtAgo(ms: number): string {
  if (ms < 60_000)         return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000)      return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000)     return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}

function pctl(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}

interface StreakLengthRow {
  length:        number;
  count:         number;
  perDay:        number;
  lastSeenMs:    number;
  lastSeenAgo:   string;
}

interface PostExtremeBucket {
  /** "After streak ≥ N" was followed by this distribution of next-60min states. */
  afterStreakAtLeast: number;
  occurrences:        number;
  /** Avg time (minutes) until next streak ≤ 4 emerges. */
  avgMinsToSideways:  number;
  /** Avg max-streak in the next 60 minutes after the extreme run. */
  avgMaxStreakNext60: number;
  /** % of subsequent 60-min windows where streaks stayed ≤ 4 (sideways). */
  sidewaysFraction:   number;
}

interface SuggestedConfig {
  auto_order_min_streak: number;
  dca_streak_whitelist:  number[];
  reasoning:             string;
}

/**
 * "Gap analysis": how often does a high-streak event recur?
 * Used by the new strategy that arms a trading window for ~30min–2h30 after
 * any streak ≥ N occurrence (the assumption being mean-reversion / volatility
 * clustering after extremes).
 */
interface StreakGapBucket {
  thresholdLength: number;     // N
  occurrences:     number;
  /** Gaps in minutes between consecutive run-ends where |length| ≥ N.
   *  All zero if occurrences < 2 (nothing to measure). */
  meanGapMin:      number;
  medianGapMin:    number;
  p10GapMin:       number;     // shortest typical gap (recurrence floor)
  p90GapMin:       number;     // longest typical gap
  maxGapMin:       number;
}

interface StreakGapEvent {
  endedAt:      number;          // unix ms — run ended (= "đảo chiều")
  signed:       number;          // signed length (+UP, -DOWN)
  length:       number;          // abs
  /** Minutes since the prior run with |length| ≥ 5 (lowest threshold).
   *  null for the first such event in the analysis range. */
  gapBeforeMin: number | null;
}

interface StreakStatsResponse {
  coin:           string;
  rangeStartMs:   number;
  rangeEndMs:     number;
  totalBars:      number;
  totalRuns:      number;
  streakLengths:  StreakLengthRow[];
  highVol: {
    threshold:        number;     // streak length considered "high vol"
    occurrences:      number;
    perDay:           number;
    p50RunDurationMin: number;    // typical run length when ≥ threshold
    p90RunDurationMin: number;
    longestRunMin:    number;
  };
  postExtreme:      PostExtremeBucket[];
  hourlyHotness:    Array<{ hourUtc: number; perCandle: number }>;
  dayOfWeekHotness: Array<{
    dayUtc:    number;       // 0=Sun, 6=Sat (UTC)
    dayName:   string;       // 'Sun' … 'Sat'
    perCandle: number;       // fraction of bars in big-streak runs
    bigCount:  number;
    totalBars: number;
  }>;
  streakGaps: {
    /** One row per threshold N (5, 6, 7, 8). */
    byThreshold:  StreakGapBucket[];
    /** Most recent ≤ 20 events with |length| ≥ 5 (lowest threshold), newest first. */
    recentEvents: StreakGapEvent[];
  };
  suggested:        SuggestedConfig;
}

// ── Heuristic config suggester ─────────────────────────────────────────────

function suggestConfig(rows: StreakLengthRow[], totalBars: number): SuggestedConfig {
  // auto_order_min_streak: pick the streak where its frequency drops below
  // ~5/day (rare enough to be a strong signal but still occurs daily).
  // Fall back to lowest length with perDay ≤ 5.
  const sortedByLen = [...rows].sort((a, b) => a.length - b.length);
  let autoMin = 4;
  for (const r of sortedByLen) {
    if (r.perDay > 0 && r.perDay <= 5 && r.length >= 4) {
      autoMin = r.length;
      break;
    }
  }
  if (autoMin > 7) autoMin = 7;
  if (autoMin < 3) autoMin = 3;

  // DCA whitelist: every other streak from autoMin up to where occurrences
  // become extremely rare (perDay < 0.5). E.g., autoMin=4 → [4, 6, 8].
  const whitelist: number[] = [];
  for (let n = autoMin; n <= 14; n += 2) {
    const row = rows.find(r => r.length === n);
    if (!row || row.count === 0) break;
    if (row.perDay < 0.2) break;
    whitelist.push(n);
    if (whitelist.length >= 4) break;
  }

  return {
    auto_order_min_streak: autoMin,
    dca_streak_whitelist:  whitelist,
    reasoning: [
      `auto_order_min_streak=${autoMin}: streak ≥ ${autoMin} occurs ~${(rows.find(r => r.length === autoMin)?.perDay ?? 0).toFixed(1)}/day`,
      `dca_streak_whitelist=[${whitelist.join(',')}]: every other streak from ${autoMin} up where perDay ≥ 0.2`,
      `Based on ${totalBars} 5-min bars from Binance.`,
    ].join('\n'),
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function getStreakStats(req: Request, res: Response): Promise<void> {
  const coinRaw = String(req.query['coin']  ?? 'BTC').toUpperCase();
  const daysRaw = Number(req.query['days']  ?? '7');
  const days    = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 60 ? daysRaw : 7;

  const symbol = BINANCE_SYMBOL[coinRaw];
  if (!symbol) {
    res.status(400).json({ error: `unsupported coin (no Binance feed): ${coinRaw}` });
    return;
  }

  try {
    const now = Date.now();
    const start = now - days * 24 * 60 * 60 * 1000;
    const bars = await fetchBinance5m(symbol, start, now);

    if (bars.length < 100) {
      res.status(502).json({ error: 'insufficient data from Binance', bars: bars.length });
      return;
    }

    const runs = detectStreakRuns(bars);

    // Per-length stats
    const byLen = new Map<number, { count: number; lastSeenMs: number }>();
    for (const r of runs) {
      const L = Math.abs(r.signed);
      const cur = byLen.get(L) ?? { count: 0, lastSeenMs: 0 };
      cur.count++;
      if (r.endedAt > cur.lastSeenMs) cur.lastSeenMs = r.endedAt;
      byLen.set(L, cur);
    }
    const streakLengths: StreakLengthRow[] = Array.from(byLen.entries())
      .map(([length, v]) => ({
        length,
        count:       v.count,
        perDay:      v.count / days,
        lastSeenMs:  v.lastSeenMs,
        lastSeenAgo: fmtAgo(now - v.lastSeenMs),
      }))
      .sort((a, b) => a.length - b.length);

    // High-volatility threshold = streak length at p90 of run lengths
    const allLens = runs.map(r => Math.abs(r.signed));
    const highThreshold = Math.max(5, Math.floor(pctl(allLens, 0.90)));
    const highRuns = runs.filter(r => Math.abs(r.signed) >= highThreshold);
    const highRunDurMins = highRuns.map(r => Math.abs(r.signed) * 5);
    const highVol = {
      threshold:         highThreshold,
      occurrences:       highRuns.length,
      perDay:            highRuns.length / days,
      p50RunDurationMin: pctl(highRunDurMins, 0.50),
      p90RunDurationMin: pctl(highRunDurMins, 0.90),
      longestRunMin:     highRunDurMins.length ? Math.max(...highRunDurMins) : 0,
    };

    // Post-extreme analysis: pick a few "extreme" thresholds (≥ p75, ≥ p90,
    // ≥ p99 of run lengths). For each, compute what happens in the next 60min.
    const extremeThresholds = Array.from(new Set([
      Math.max(5, Math.floor(pctl(allLens, 0.75))),
      Math.max(6, Math.floor(pctl(allLens, 0.90))),
      Math.max(8, Math.floor(pctl(allLens, 0.99))),
    ])).sort((a, b) => a - b);

    const postExtreme: PostExtremeBucket[] = extremeThresholds.map(thr => {
      const events = runs.filter(r => Math.abs(r.signed) >= thr);
      // For each event, look at runs that START within 60min after this event ends.
      const lookaheadMs = 60 * 60_000;
      const minsToSideways: number[] = [];
      const maxStreaks: number[] = [];
      let sidewaysCount = 0;
      for (const ev of events) {
        const winStart = ev.endedAt;
        const winEnd   = winStart + lookaheadMs;
        const subsequent = runs.filter(r =>
          r.endedAt > winStart && r.endedAt <= winEnd && r !== ev,
        );
        if (!subsequent.length) continue;
        const subMaxStreak = Math.max(...subsequent.map(r => Math.abs(r.signed)));
        maxStreaks.push(subMaxStreak);
        // First "sideways" run (length ≤ 4) — minutes from event end to that run's end
        const firstSideways = subsequent.find(r => Math.abs(r.signed) <= 4);
        if (firstSideways) {
          minsToSideways.push((firstSideways.endedAt - winStart) / 60_000);
        }
        // sideways fraction = % of subsequent runs that are length ≤ 4
        const sw = subsequent.filter(r => Math.abs(r.signed) <= 4).length;
        if (sw / subsequent.length >= 0.5) sidewaysCount++;
      }
      return {
        afterStreakAtLeast: thr,
        occurrences:        events.length,
        avgMinsToSideways:  minsToSideways.length
          ? minsToSideways.reduce((a, b) => a + b, 0) / minsToSideways.length
          : 0,
        avgMaxStreakNext60: maxStreaks.length
          ? maxStreaks.reduce((a, b) => a + b, 0) / maxStreaks.length
          : 0,
        sidewaysFraction:   events.length ? sidewaysCount / events.length : 0,
      };
    });

    // Hourly + day-of-week hotness — fraction of bars in each bucket that
    // belong to a "big" streak (≥ highVol threshold). Bucketed in UTC; FE
    // labels them clearly so user can mentally adjust to local timezone.
    const hourCounts: Record<number, { total: number; big: number }> = {};
    const dowCounts:  Record<number, { total: number; big: number }> = {};
    for (let h = 0; h < 24; h++) hourCounts[h] = { total: 0, big: 0 };
    for (let d = 0; d < 7;  d++) dowCounts[d]  = { total: 0, big: 0 };

    let runIdx = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const dt = new Date(b.openTime);
      const h  = dt.getUTCHours();
      const d  = dt.getUTCDay();   // 0=Sun … 6=Sat
      hourCounts[h]!.total++;
      dowCounts[d]!.total++;
      while (runIdx < runs.length && runs[runIdx]!.lastIdx < i) runIdx++;
      const r = runs[runIdx];
      if (r && Math.abs(r.signed) >= highThreshold) {
        hourCounts[h]!.big++;
        dowCounts[d]!.big++;
      }
    }
    const hourlyHotness = Array.from({ length: 24 }, (_, h) => ({
      hourUtc:   h,
      perCandle: hourCounts[h]!.total > 0
        ? hourCounts[h]!.big / hourCounts[h]!.total
        : 0,
    }));
    const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayOfWeekHotness = Array.from({ length: 7 }, (_, d) => ({
      dayUtc:    d,
      dayName:   DOW_NAMES[d]!,
      perCandle: dowCounts[d]!.total > 0
        ? dowCounts[d]!.big / dowCounts[d]!.total
        : 0,
      bigCount:  dowCounts[d]!.big,
      totalBars: dowCounts[d]!.total,
    }));

    // Streak gap analysis: for each threshold N in [5,6,7,8], measure time
    // between consecutive run-ends where |length| ≥ N. Drives the new
    // "trade-after-extreme" strategy — knowing avg recurrence interval lets
    // the user pick a sensible armed window (e.g. T+30m → T+median gap).
    const GAP_THRESHOLDS = [5, 6, 7, 8] as const;
    const RECENT_EVENT_MIN = 5;       // lowest threshold for the recent list
    const RECENT_EVENT_LIMIT = 20;
    const sortedRuns = [...runs].sort((a, b) => a.endedAt - b.endedAt);
    const byThreshold: StreakGapBucket[] = GAP_THRESHOLDS.map(N => {
      const events = sortedRuns.filter(r => Math.abs(r.signed) >= N);
      if (events.length < 2) {
        return {
          thresholdLength: N, occurrences: events.length,
          meanGapMin: 0, medianGapMin: 0, p10GapMin: 0, p90GapMin: 0, maxGapMin: 0,
        };
      }
      const gaps: number[] = [];
      for (let i = 1; i < events.length; i++) {
        gaps.push((events[i]!.endedAt - events[i - 1]!.endedAt) / 60_000);
      }
      return {
        thresholdLength: N,
        occurrences:     events.length,
        meanGapMin:      gaps.reduce((a, b) => a + b, 0) / gaps.length,
        medianGapMin:    pctl(gaps, 0.50),
        p10GapMin:       pctl(gaps, 0.10),
        p90GapMin:       pctl(gaps, 0.90),
        maxGapMin:       Math.max(...gaps),
      };
    });
    // Recent events: last N events with |length| >= RECENT_EVENT_MIN, with
    // gap-from-prior-event computed against the FULL filtered list (so the
    // "first row in the slice" still has a meaningful gap if a prior event
    // exists outside the displayed window).
    const recentAll = sortedRuns.filter(r => Math.abs(r.signed) >= RECENT_EVENT_MIN);
    const sliceStart = Math.max(0, recentAll.length - RECENT_EVENT_LIMIT);
    const recentSlice = recentAll.slice(sliceStart);
    const recentEvents: StreakGapEvent[] = recentSlice.map((r, i) => {
      const fullIdx = sliceStart + i;
      const prev = fullIdx > 0 ? recentAll[fullIdx - 1]! : null;
      return {
        endedAt:      r.endedAt,
        signed:       r.signed,
        length:       Math.abs(r.signed),
        gapBeforeMin: prev ? (r.endedAt - prev.endedAt) / 60_000 : null,
      };
    }).reverse();   // newest first for UI

    const suggested = suggestConfig(streakLengths, bars.length);

    const body: StreakStatsResponse = {
      coin:             coinRaw,
      rangeStartMs:     start,
      rangeEndMs:       now,
      totalBars:        bars.length,
      totalRuns:        runs.length,
      streakLengths,
      highVol,
      postExtreme,
      hourlyHotness,
      dayOfWeekHotness,
      streakGaps:       { byThreshold, recentEvents },
      suggested,
    };
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
