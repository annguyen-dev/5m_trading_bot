/**
 * SnapshotBuilder (Step 2 of KB pipeline)
 *
 * Reads 1m OHLCV candles from PostgreSQL (ohlcv_1m) and macro events
 * (macro_events), then for each candle computes:
 *
 *   - streak_1m / streak_5m (signed: + = up-streak, - = down-streak)
 *   - change_1m / change_5m / change_15m / change_1h
 *   - volume_ratio (vs 20-bar avg), wick_ratio, cvd_1h
 *   - synthesized liquidation proxies
 *   - nearest funding rate + OI change
 *   - active macro context (tone, events within 72h)
 *   - outcome labels (t1m → t1d) using OPEN of next candle as entry
 *
 * Writes rows to kb_snapshots. Resumable: already-inserted rows are skipped
 * (INSERT ON CONFLICT DO NOTHING).
 *
 * Processes in memory-efficient chunks of CHUNK_CANDLES candles at a time.
 */

import type pg from 'pg';
import { getPool, refreshKbStats } from '@trading-bot/db';
import { GDELTHistoricalFetcher, type HistoricalMacroEvent } from './GDELTHistoricalFetcher.js';

// ── Outcome horizons (in 1m candles ahead) ────────────────────────────────────
const T1M   = 1;
const T2M   = 2;
const T3M   = 3;
const T5M   = 5;
const T10M  = 10;
const T15M  = 15;
const T1H   = 60;
const T4H   = 240;
const T1D   = 1440;

// We need T1D future candles past each snapshot → look-forward buffer
const LOOK_FORWARD  = T1D + 10;
// Rolling windows
const VOL_AVG_WIN   = 20;   // 20 × 1m = 20m avg volume
const CVD_WIN       = 60;   // 60 × 1m = 1h CVD
const STREAK_5M_WIN  = 60;    // 60 × 1m  → up to 12 × 5m bars
const STREAK_15M_WIN = 300;   // 300 × 1m → up to 20 × 15m bars
const STREAK_1H_WIN  = 1_200; // 1200 × 1m → up to 20 × 1h bars

// DB batch size for inserts
const INSERT_BATCH  = 500;
// How many candles to load into memory at once (with overlap for rolling windows + look-forward)
const CHUNK_CANDLES = 5_000;
const CHUNK_OVERLAP = LOOK_FORWARD + VOL_AVG_WIN + STREAK_1H_WIN; // 1h streak needs most history

interface OHLCVRow {
  ts: number; open: number; high: number;
  low: number; close: number; volume: number;
}

interface FundingRow { ts: number; rate: number; oi_usd: number }

type SnapshotRow = {
  id: string; exchange: string; symbol: string; ts: number;
  streak_1m: number; streak_5m: number; streak_15m: number; streak_1h: number;
  change_1m: number; change_5m: number; change_15m: number; change_1h: number;
  volume_ratio: number; wick_ratio: number; cvd_1h: number;
  liq_long_usd: number; liq_short_usd: number; liq_cascade: number;
  funding_rate: number; oi_change_1h: number;
  macro_tone: number; macro_events: string;
  entry_price: number | null;
  t1m: number | null; t2m: number | null; t3m: number | null;
  t5m: number | null; t10m: number | null; t15m: number | null;
  t1h: number | null; t4h: number | null; t1d: number | null;
  max_down_1h: number | null; max_up_1h: number | null;
  direction: string | null;
  embedding_text: string;
  pattern_hash: string;
  reliability_score: number;
};

export class SnapshotBuilder {
  private pool: pg.Pool;

  constructor(
    private readonly exchange: string,
    private readonly symbol: string,
  ) {
    this.pool = getPool();
  }

  async build(from: Date, to: Date): Promise<number> {
    // Load funding + macro for entire range (they're small)
    const funding   = await this.loadFunding(from, to);
    const macroAll  = await this.loadMacroEvents(from, to);

    // Process OHLCV in overlapping chunks
    const totalMs   = to.getTime() - from.getTime();
    const chunkMs   = CHUNK_CANDLES * 60_000;
    let totalWritten = 0;

    let chunkStart = from.getTime();
    while (chunkStart < to.getTime()) {
      const chunkEnd = Math.min(chunkStart + chunkMs, to.getTime());
      // Load chunk + look-forward buffer
      const bufferEnd = chunkEnd + CHUNK_OVERLAP * 60_000;

      const candles = await this.loadCandles(chunkStart, bufferEnd);
      if (candles.length === 0) { chunkStart = chunkEnd; continue; }

      // Find index boundary: only process candles up to chunkEnd
      const processLimit = candles.findIndex(c => c.ts >= chunkEnd);
      const limit = processLimit === -1 ? candles.length : processLimit;

      const rows = this.buildSnapshots(candles, limit, funding, macroAll);
      if (rows.length > 0) {
        totalWritten += await this.insertSnapshots(rows);
      }

      const pct = Math.min(((chunkEnd - from.getTime()) / totalMs) * 100, 100);
      process.stdout.write(`\r  SnapshotBuilder: ${pct.toFixed(1)}% (${totalWritten} rows)`);

      chunkStart = chunkEnd;
    }

    process.stdout.write('\n');

    if (totalWritten > 0) {
      process.stdout.write('  Refreshing kb_daily_reversal_stats...');
      await refreshKbStats();
      process.stdout.write(' done\n');
    }

    return totalWritten;
  }

  // ── Core snapshot logic ───────────────────────────────────────────────────

  private buildSnapshots(
    candles: OHLCVRow[],
    limit: number,
    funding: FundingRow[],
    macroAll: HistoricalMacroEvent[],
  ): SnapshotRow[] {
    const rows: SnapshotRow[] = [];

    // Pre-compute rolling avg volumes
    const avgVols = buildRollingAvg(candles.map(c => c.volume), VOL_AVG_WIN);

    for (let i = VOL_AVG_WIN; i < limit; i++) {
      const c = candles[i]!;

      // ── Streak ──────────────────────────────────────────────────────────
      const streak1m  = computeStreak1m(candles, i);
      const streak5m  = computeStreak5m(candles, i);
      const streak15m = computeStreakNm(candles, i, 15, STREAK_15M_WIN);
      const streak1h  = computeStreakNm(candles, i, 60, STREAK_1H_WIN);

      // ── Price changes ────────────────────────────────────────────────────
      const change1m  = pctChange(candles, i, 1);   // last 1m: (open[i] - close[i-1]) / close[i-1]
      const change5m  = pctChange(candles, i, 5);
      const change15m = pctChange(candles, i, 15);
      const change1h  = pctChange(candles, i, 60);

      // ── Volume / shape ───────────────────────────────────────────────────
      const volRatio  = avgVols[i]! > 0 ? c.volume / avgVols[i]! : 1;
      const body      = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const wickRatio = body > 0 ? Math.max(upperWick, lowerWick) / body : 0;

      // ── CVD proxy (1h = 60 bars) ─────────────────────────────────────────
      const cvd1h = computeCVD(candles, i, CVD_WIN);

      // ── Liquidation proxy ─────────────────────────────────────────────────
      const { liqLong, liqShort, liqCascade } = synthLiquidations(c, volRatio);

      // ── Funding + OI ─────────────────────────────────────────────────────
      const { fundingRate, oiChange1h } = nearestFunding(c.ts, funding);

      // ── Macro context ─────────────────────────────────────────────────────
      const activeEvents = GDELTHistoricalFetcher.getActiveEvents(c.ts, macroAll);
      const macroTone = activeEvents.length > 0
        ? activeEvents.reduce((s, e) => s + e.tone, 0) / activeEvents.length
        : 0;

      // ── Outcomes ──────────────────────────────────────────────────────────
      const entry = candles[i + 1]?.open ?? null;
      const outcome = entry !== null ? computeOutcomes(candles, i, entry) : null;

      // ── Pattern hash (for feedback loop) ─────────────────────────────────
      const patternHash = computePatternHash(streak5m, streak15m, change1h, volRatio);

      // ── Embedding text ────────────────────────────────────────────────────
      const embText = buildEmbeddingText(c, {
        streak1m, streak5m, change1m, change5m, change15m, change1h,
        volRatio, wickRatio, cvd1h, liqLong, liqShort, liqCascade,
        fundingRate, macroTone, activeEvents, outcome,
      });

      rows.push({
        id:           `${this.exchange}_${this.symbol}_${c.ts}`,
        exchange:     this.exchange,
        symbol:       this.symbol,
        ts:           c.ts,
        streak_1m:    streak1m,
        streak_5m:    streak5m,
        streak_15m:   streak15m,
        streak_1h:    streak1h,
        change_1m:    change1m,
        change_5m:    change5m,
        change_15m:   change15m,
        change_1h:    change1h,
        volume_ratio: volRatio,
        wick_ratio:   wickRatio,
        cvd_1h:       cvd1h,
        liq_long_usd:  liqLong,
        liq_short_usd: liqShort,
        liq_cascade:   liqCascade ? 1 : 0,
        funding_rate:  fundingRate,
        oi_change_1h:  oiChange1h,
        macro_tone:    macroTone,
        macro_events:  JSON.stringify(activeEvents),
        entry_price:   entry,
        t1m:           outcome?.t1m  ?? null,
        t2m:           outcome?.t2m  ?? null,
        t3m:           outcome?.t3m  ?? null,
        t5m:           outcome?.t5m  ?? null,
        t10m:          outcome?.t10m ?? null,
        t15m:          outcome?.t15m ?? null,
        t1h:           outcome?.t1h  ?? null,
        t4h:           outcome?.t4h  ?? null,
        t1d:           outcome?.t1d  ?? null,
        max_down_1h:   outcome?.maxDown1h ?? null,
        max_up_1h:     outcome?.maxUp1h   ?? null,
        direction:         outcome?.direction ?? null,
        embedding_text:    embText,
        pattern_hash:      patternHash,
        reliability_score: 1.0,
      });
    }

    return rows;
  }

  // ── DB helpers ────────────────────────────────────────────────────────────

  private async loadCandles(fromMs: number, toMs: number): Promise<OHLCVRow[]> {
    const res = await this.pool.query<{
      ts: string; open: string; high: string; low: string; close: string; volume: string;
    }>(
      `SELECT ts,open,high,low,close,volume
       FROM ohlcv_1m
       WHERE exchange=$1 AND symbol=$2 AND ts>=$3 AND ts<$4
       ORDER BY ts`,
      [this.exchange, this.symbol, fromMs, toMs],
    );
    return res.rows.map(r => ({
      ts:     Number(r.ts),
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
    }));
  }

  private async loadFunding(from: Date, to: Date): Promise<FundingRow[]> {
    const res = await this.pool.query<{ ts: string; rate: string; oi_usd: string }>(
      `SELECT ts,rate,oi_usd FROM funding_rates
       WHERE exchange=$1 AND symbol=$2 AND ts>=$3 AND ts<$4
       ORDER BY ts`,
      [this.exchange, this.symbol, from.getTime(), to.getTime()],
    );
    return res.rows.map(r => ({
      ts:     Number(r.ts),
      rate:   Number(r.rate),
      oi_usd: Number(r.oi_usd),
    }));
  }

  private async loadMacroEvents(from: Date, to: Date): Promise<HistoricalMacroEvent[]> {
    // Load 72h before `from` so the very first candles have macro context
    const paddedFrom = new Date(from.getTime() - 72 * 3600_000);
    const res = await this.pool.query<{
      ts: string; category: string; title: string;
      tone: string; lag_hours: string; source: string;
    }>(
      `SELECT ts, category, title, tone, lag_hours, source
       FROM macro_events WHERE ts >= $1 AND ts < $2 ORDER BY ts`,
      [paddedFrom.getTime(), to.getTime()],
    );
    return res.rows.map(r => ({
      timestamp: Number(r.ts),
      date:      new Date(Number(r.ts)).toISOString().split('T')[0]!,
      category:  r.category as import('../types/macro.js').MacroEventCategory,
      title:     r.title,
      tone:      Number(r.tone),
      lagHours:  Number(r.lag_hours),
      source:    r.source as 'gdelt' | 'fred',
    }));
  }

  private async insertSnapshots(rows: SnapshotRow[]): Promise<number> {
    // 38 columns × 500 rows = 19000 params (well under pg's 65535 limit)
    const COLS = 38;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;

      for (const r of batch) {
        const slots = Array.from({ length: COLS }, (_, k) => `$${p + k}`).join(',');
        placeholders.push(`(${slots})`);
        values.push(
          r.id, r.exchange, r.symbol, r.ts,
          r.streak_1m, r.streak_5m, r.streak_15m, r.streak_1h,
          r.change_1m, r.change_5m, r.change_15m, r.change_1h,
          r.volume_ratio, r.wick_ratio, r.cvd_1h,
          r.liq_long_usd, r.liq_short_usd, r.liq_cascade,
          r.funding_rate, r.oi_change_1h,
          r.macro_tone, r.macro_events,
          r.entry_price, r.t1m, r.t2m, r.t3m, r.t5m,
          r.t10m, r.t15m, r.t1h, r.t4h, r.t1d,
          r.max_down_1h, r.max_up_1h,
          r.direction, r.embedding_text,
          r.pattern_hash, r.reliability_score,
        );
        p += COLS;
      }

      const sql = `
        INSERT INTO kb_snapshots (
          id, exchange, symbol, ts,
          streak_1m, streak_5m, streak_15m, streak_1h,
          change_1m, change_5m, change_15m, change_1h,
          volume_ratio, wick_ratio, cvd_1h,
          liq_long_usd, liq_short_usd, liq_cascade,
          funding_rate, oi_change_1h,
          macro_tone, macro_events,
          entry_price, t1m, t2m, t3m, t5m, t10m, t15m, t1h, t4h, t1d,
          max_down_1h, max_up_1h,
          direction, embedding_text,
          pattern_hash, reliability_score
        )
        VALUES ${placeholders.join(',')}
        ON CONFLICT DO NOTHING
      `;
      const result = await this.pool.query(sql, values);
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }
}

// ── Streak computation ────────────────────────────────────────────────────────

/**
 * Returns signed streak: how many consecutive same-direction 1m candles
 * ending at index i. Positive = up (close > open), negative = down.
 */
function computeStreak1m(candles: OHLCVRow[], i: number): number {
  const isUp = (c: OHLCVRow) => c.close > c.open;
  const dir  = isUp(candles[i]!);
  let count  = 1;
  for (let j = i - 1; j >= 0; j--) {
    if (isUp(candles[j]!) !== dir) break;
    count++;
    if (count >= 30) break; // cap at 30 to avoid unbounded loops
  }
  return dir ? count : -count;
}

/**
 * Aggregate the last STREAK_5M_WIN (60) 1m candles into 5m bars,
 * then count consecutive same-direction 5m bars ending at current position.
 */
function computeStreak5m(candles: OHLCVRow[], i: number): number {
  // Build up to 12 five-minute bars from the last 60 1m candles
  const bars5m: { up: boolean }[] = [];
  const lookback = Math.min(STREAK_5M_WIN, i + 1);
  const start    = i - lookback + 1;

  for (let b = start; b <= i - 4; b += 5) {
    const slice = candles.slice(b, b + 5);
    if (slice.length < 5) continue;
    const barOpen  = slice[0]!.open;
    const barClose = slice[4]!.close;
    bars5m.push({ up: barClose > barOpen });
  }

  if (bars5m.length === 0) return 0;

  const lastBar = bars5m[bars5m.length - 1]!;
  let count = 1;
  for (let k = bars5m.length - 2; k >= 0; k--) {
    if (bars5m[k]!.up !== lastBar.up) break;
    count++;
  }
  return lastBar.up ? count : -count;
}

/**
 * Generic N-minute streak: aggregate 1m candles into N-minute bars,
 * count consecutive same-direction bars ending at the current position.
 * barSize = 15 for 15m streak, 60 for 1h streak.
 */
function computeStreakNm(
  candles: OHLCVRow[], i: number, barSize: number, maxLookback: number,
): number {
  const bars: { up: boolean }[] = [];
  const lookback = Math.min(maxLookback, i + 1);
  const start    = i - lookback + 1;

  for (let b = start; b <= i - (barSize - 1); b += barSize) {
    const slice = candles.slice(b, b + barSize);
    if (slice.length < barSize) continue;
    const barOpen  = slice[0]!.open;
    const barClose = slice[barSize - 1]!.close;
    bars.push({ up: barClose > barOpen });
  }

  if (bars.length === 0) return 0;

  const lastBar = bars[bars.length - 1]!;
  let count = 1;
  for (let k = bars.length - 2; k >= 0; k--) {
    if (bars[k]!.up !== lastBar.up) break;
    count++;
  }
  return lastBar.up ? count : -count;
}

/**
 * Pattern hash: bucketed key features → stable string ID.
 * Used by the feedback loop to find and update similar patterns.
 *
 * Format: "s5:{N}_s15:{N}_ch1h:{bucket}_vol:{low|norm|high}"
 */
function computePatternHash(
  streak5m: number, streak15m: number, change1h: number, volRatio: number,
): string {
  const s5    = Math.max(-6, Math.min(6, streak5m));
  const s15   = Math.max(-4, Math.min(4, streak15m));
  const ch    = Math.max(-5, Math.min(5, Math.round(change1h / 0.005)));
  const vol   = volRatio > 1.5 ? 'high' : volRatio < 0.7 ? 'low' : 'norm';
  return `s5:${s5}_s15:${s15}_ch1h:${ch}_vol:${vol}`;
}

// ── Price change ──────────────────────────────────────────────────────────────

function pctChange(candles: OHLCVRow[], i: number, lookback: number): number {
  const prev = candles[i - lookback];
  if (!prev) return 0;
  return prev.close > 0 ? (candles[i]!.open - prev.close) / prev.close : 0;
}

// ── Rolling average ───────────────────────────────────────────────────────────

function buildRollingAvg(values: number[], window: number): number[] {
  return values.map((_, i) => {
    if (i < window) return values[i]!;
    const slice = values.slice(i - window, i);
    return slice.reduce((s, v) => s + v, 0) / window;
  });
}

// ── CVD proxy ─────────────────────────────────────────────────────────────────

function computeCVD(candles: OHLCVRow[], i: number, window: number): number {
  let cvd = 0;
  const start = Math.max(0, i - window);
  for (let j = start; j <= i; j++) {
    const c = candles[j]!;
    cvd += c.close >= c.open ? c.volume : -c.volume;
  }
  return cvd;
}

// ── Liquidation proxy ─────────────────────────────────────────────────────────

function synthLiquidations(
  c: OHLCVRow,
  volRatio: number,
): { liqLong: number; liqShort: number; liqCascade: boolean } {
  const body      = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const range     = c.high - c.low;

  if (range === 0 || c.open === 0) return { liqLong: 0, liqShort: 0, liqCascade: false };

  // Estimate liq from wick direction + volume spike
  const wickLongFrac  = upperWick / range;  // big upper wick → long liq
  const wickShortFrac = lowerWick / range;  // big lower wick → short liq
  const baseUsd = c.volume * c.close * 0.001; // rough USD notional estimate

  const liqLong  = wickLongFrac  * volRatio * baseUsd;
  const liqShort = wickShortFrac * volRatio * baseUsd;
  const liqCascade = (liqLong + liqShort) > 50_000_000 || (volRatio > 5 && body / range > 0.7);

  return { liqLong, liqShort, liqCascade };
}

// ── Funding ───────────────────────────────────────────────────────────────────

function nearestFunding(
  ts: number,
  funding: FundingRow[],
): { fundingRate: number; oiChange1h: number } {
  if (funding.length === 0) return { fundingRate: 0, oiChange1h: 0 };

  // Binary-search-ish: find nearest ts
  let best = funding[0]!;
  let bestDiff = Math.abs(best.ts - ts);
  for (const f of funding) {
    const diff = Math.abs(f.ts - ts);
    if (diff < bestDiff) { best = f; bestDiff = diff; }
    if (f.ts > ts + 8 * 3600_000) break; // funding is sparse, don't go too far
  }

  // Simple OI change: compare to previous entry
  const idx = funding.indexOf(best);
  const prev = idx > 0 ? funding[idx - 1] : null;
  const oiChange1h = (prev && prev.oi_usd > 0)
    ? (best.oi_usd - prev.oi_usd) / prev.oi_usd * 100
    : 0;

  return { fundingRate: best.rate, oiChange1h };
}

// ── Outcome labels ────────────────────────────────────────────────────────────

interface Outcomes {
  t1m: number; t2m: number; t3m: number;
  t5m: number; t10m: number; t15m: number;
  t1h: number; t4h: number; t1d: number;
  maxDown1h: number; maxUp1h: number;
  direction: 'up' | 'down' | 'flat';
}

function computeOutcomes(
  candles: OHLCVRow[],
  i: number,
  entry: number,
): Outcomes | null {
  const get = (offset: number) => candles[i + offset + 1]?.open ?? null;
  const ret = (offset: number) => {
    const p = get(offset);
    return p !== null && entry > 0 ? (p - entry) / entry : null;
  };

  const t1m  = ret(T1M);
  const t2m  = ret(T2M);
  const t3m  = ret(T3M);
  const t5m  = ret(T5M);
  const t10m = ret(T10M);
  const t15m = ret(T15M);
  const t1h  = ret(T1H);
  const t4h  = ret(T4H);
  const t1d  = ret(T1D);

  // Need at least t1h for direction
  if (t1h === null) return null;

  // Max adverse / favourable in first 60 bars
  let maxDown1h = 0;
  let maxUp1h   = 0;
  for (let k = 1; k <= T1H && i + k < candles.length; k++) {
    const c = candles[i + k]!;
    maxDown1h = Math.max(maxDown1h, entry > 0 ? (entry - c.low)  / entry : 0);
    maxUp1h   = Math.max(maxUp1h,   entry > 0 ? (c.high - entry) / entry : 0);
  }

  const direction: 'up' | 'down' | 'flat' =
    t1h >  0.005 ? 'up' :
    t1h < -0.005 ? 'down' :
    'flat';

  return {
    t1m:  t1m ?? 0,  t2m:  t2m ?? 0,  t3m:  t3m ?? 0,
    t5m:  t5m ?? 0,  t10m: t10m ?? 0, t15m: t15m ?? 0,
    t1h,             t4h:  t4h ?? 0,   t1d:  t1d ?? 0,
    maxDown1h, maxUp1h, direction,
  };
}

// ── Embedding text ────────────────────────────────────────────────────────────

function buildEmbeddingText(
  c: OHLCVRow,
  ctx: {
    streak1m: number; streak5m: number;
    change1m: number; change5m: number; change15m: number; change1h: number;
    volRatio: number; wickRatio: number; cvd1h: number;
    liqLong: number; liqShort: number; liqCascade: boolean;
    fundingRate: number; macroTone: number;
    activeEvents: { category: string; hoursAgo: number; tone: number }[];
    outcome: Outcomes | null;
  },
): string {
  const date   = new Date(c.ts).toISOString().replace('T', ' ').substring(0, 16);
  const streak = ctx.streak1m > 0
    ? `${ctx.streak1m} consecutive UP candles (1m)`
    : `${Math.abs(ctx.streak1m)} consecutive DOWN candles (1m)`;
  const streak5 = ctx.streak5m > 0
    ? `${ctx.streak5m} consecutive UP 5m bars`
    : `${Math.abs(ctx.streak5m)} consecutive DOWN 5m bars`;

  const liqDesc = (ctx.liqLong + ctx.liqShort) > 1_000_000
    ? `${ctx.liqCascade ? 'CASCADE' : 'spike'} long=$${(ctx.liqLong / 1e6).toFixed(1)}M short=$${(ctx.liqShort / 1e6).toFixed(1)}M`
    : 'no significant liquidations';

  const macroDesc = ctx.activeEvents.length > 0
    ? ctx.activeEvents.map(e => `${e.category}(${e.hoursAgo.toFixed(0)}h ago, tone ${e.tone.toFixed(1)})`).join(', ')
    : 'no active macro events';

  const outcomeDesc = ctx.outcome
    ? `t1m ${pctStr(ctx.outcome.t1m)} t5m ${pctStr(ctx.outcome.t5m)} t1h ${pctStr(ctx.outcome.t1h)} dir:${ctx.outcome.direction} maxUp1h:${pctStr(ctx.outcome.maxUp1h)} maxDown1h:${pctStr(-ctx.outcome.maxDown1h)}`
    : 'outcome: unknown';

  return [
    `Date: ${date}  Price: $${c.close.toLocaleString()}`,
    `Streak: ${streak}  ${streak5}`,
    `Change: 1m ${pctStr(ctx.change1m)}  5m ${pctStr(ctx.change5m)}  15m ${pctStr(ctx.change15m)}  1h ${pctStr(ctx.change1h)}`,
    `Volume ratio: ${ctx.volRatio.toFixed(2)}  CVD(1h): ${ctx.cvd1h.toFixed(0)}  Wick ratio: ${ctx.wickRatio.toFixed(2)}`,
    `Funding: ${(ctx.fundingRate * 100).toFixed(4)}%  Liquidations: ${liqDesc}`,
    `Macro: tone=${ctx.macroTone.toFixed(1)}  ${macroDesc}`,
    `Outcome: ${outcomeDesc}`,
  ].join('\n');
}

function pctStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}
