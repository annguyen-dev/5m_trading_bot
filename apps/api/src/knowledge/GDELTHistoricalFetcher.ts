/**
 * GDELTHistoricalFetcher
 *
 * Pulls historical macro/geopolitical events for a date range from:
 *   1. GDELT DOC 2.0 API  — news articles with tone scores
 *   2. FRED API           — Fed meeting dates, CPI releases (free, no key)
 *
 * After fetching, events are persisted to PostgreSQL (macro_events table).
 * Per-chunk file cache in cacheDir avoids re-fetching from the external APIs.
 * The pg table is the authoritative store used by SnapshotBuilder.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type pg from 'pg';
import { getPool } from '@trading-bot/db';
import type { ActiveMacroContext } from '../types/knowledge.js';
import type { MacroEventCategory } from '../types/macro.js';

// ── FRED series IDs ────────────────────────────────────────────────────────────
// Uses the public CSV download endpoint (no API key required).
// Params: id only — server returns full series; we filter by date in code.
const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const FRED_SERIES: Record<string, MacroEventCategory> = {
  'FEDFUNDS':  'fed_rate',
  'CPIAUCSL':  'inflation',
  'DTWEXBGS':  'macro_liquidity',
  'M2SL':      'macro_liquidity',
};

// ── GDELT DOC API ─────────────────────────────────────────────────────────────
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERY   = 'bitcoin OR cryptocurrency OR "Federal Reserve" OR inflation OR "interest rate"';

function classifyGDELT(title: string): MacroEventCategory {
  const t = title.toLowerCase();
  if (t.includes('fed') || t.includes('rate') || t.includes('fomc') || t.includes('powell')) return 'fed_rate';
  if (t.includes('cpi') || t.includes('inflation') || t.includes('pce'))                      return 'inflation';
  if (t.includes('sec') || t.includes('regulat') || t.includes('ban') || t.includes('etf'))   return 'regulatory';
  if (t.includes('war') || t.includes('sanction') || t.includes('geopolit'))                  return 'geopolitical';
  if (t.includes('etf') || t.includes('microstrategy') || t.includes('institutional'))        return 'adoption';
  if (t.includes('liquidit') || t.includes('m2') || t.includes('qe') || t.includes('dollar')) return 'macro_liquidity';
  if (t.includes('hack') || t.includes('collapse') || t.includes('bankrupt') || t.includes('crash')) return 'black_swan';
  return 'geopolitical';
}

function estimateLag(category: MacroEventCategory): number {
  const lags: Record<MacroEventCategory, number> = {
    fed_rate: 48, inflation: 24, regulatory: 72, adoption: 24,
    black_swan: 4, halving: 4320, macro_liquidity: 168, geopolitical: 48,
  };
  return lags[category] ?? 48;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface GDELTArticleRaw {
  url:      string;
  title:    string;
  seendate: string; // YYYYMMDDTHHmmssZ
  domain:   string;
  language: string;
}

export interface HistoricalMacroEvent {
  timestamp:  number;
  date:       string;
  category:   MacroEventCategory;
  title:      string;
  tone:       number;
  lagHours:   number;
  source:     'gdelt' | 'fred';
}

// ── Fetcher class ─────────────────────────────────────────────────────────────

export class GDELTHistoricalFetcher {
  private pool: pg.Pool;

  constructor(private readonly cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true });
    this.pool = getPool();
  }

  /**
   * Fetch macro events for the date range, persist to pg, and return them.
   * Already-stored events (by id) are skipped on INSERT CONFLICT.
   */
  async fetch(from: Date, to: Date, forceRefetch = false): Promise<HistoricalMacroEvent[]> {
    // Per-range cache for quick re-runs of downstream steps
    const cacheKey  = `macro_${fmtDate(from)}_${fmtDate(to)}`;
    const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);

    if (!forceRefetch && fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as HistoricalMacroEvent[];
      // Skip empty caches — they likely came from a previous failed run
      if (cached.length > 0) {
        console.log(`  [macro cache hit] ${cached.length} events from ${cachePath}`);
        return cached;
      }
      console.log(`  [macro cache empty — re-fetching] ${cachePath}`);
    }

    console.log(`\n[GDELTHistoricalFetcher] Fetching macro events ${fmtDate(from)} → ${fmtDate(to)}`);

    const [gdelt, fred] = await Promise.allSettled([
      this.fetchGDELT(from, to),
      this.fetchFRED(from, to),
    ]);

    const gdeltEvents = gdelt.status === 'fulfilled' ? gdelt.value : [];
    const fredEvents  = fred.status  === 'fulfilled' ? fred.value  : [];

    // Both GDELT and FRED are already persisted as they complete — nothing to do here

    const events = [...gdeltEvents, ...fredEvents].sort((a, b) => a.timestamp - b.timestamp);

    console.log(
      `[GDELTHistoricalFetcher] ${events.length} total events ` +
      `(GDELT: ${gdeltEvents.length}, FRED: ${fredEvents.length})`,
    );

    // Only cache if we got something
    if (events.length > 0) {
      fs.writeFileSync(cachePath, JSON.stringify(events));
    }
    return events;
  }

  /**
   * Load macro events for a date range from pg (for SnapshotBuilder).
   */
  async loadFromDB(from: Date, to: Date): Promise<HistoricalMacroEvent[]> {
    const res = await this.pool.query<{
      id: string; ts: string; category: string; title: string;
      tone: string; lag_hours: string; source: string;
    }>(
      `SELECT id, ts, category, title, tone, lag_hours, source
       FROM macro_events WHERE ts >= $1 AND ts < $2 ORDER BY ts`,
      [from.getTime(), to.getTime()],
    );
    return res.rows.map(r => ({
      timestamp: Number(r.ts),
      date:      new Date(Number(r.ts)).toISOString().split('T')[0]!,
      category:  r.category as MacroEventCategory,
      title:     r.title,
      tone:      Number(r.tone),
      lagHours:  Number(r.lag_hours),
      source:    r.source as 'gdelt' | 'fred',
    }));
  }

  /**
   * Build ActiveMacroContext[] for a given timestamp.
   * Returns events that occurred within the last 72h and are still within their lag window.
   */
  static getActiveEvents(
    timestamp: number,
    allEvents: HistoricalMacroEvent[],
  ): ActiveMacroContext[] {
    const active: ActiveMacroContext[] = [];
    for (const evt of allEvents) {
      const hoursAgo = (timestamp - evt.timestamp) / 3_600_000;
      if (hoursAgo < 0 || hoursAgo > 72) continue;
      const lagRemaining = Math.max(0, evt.lagHours - hoursAgo);
      active.push({
        eventId:      `${evt.source}:${evt.timestamp}`,
        category:     evt.category,
        title:        evt.title,
        hoursAgo:     Math.round(hoursAgo * 10) / 10,
        tone:         evt.tone,
        lagRemaining: Math.round(lagRemaining),
      });
    }
    return active.slice(0, 5);
  }

  // ── Persist to pg ─────────────────────────────────────────────────────────

  private async persistEvents(events: HistoricalMacroEvent[]): Promise<void> {
    if (events.length === 0) return;
    const CHUNK = 200;
    for (let i = 0; i < events.length; i += CHUNK) {
      const batch = events.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;
      for (const e of batch) {
        placeholders.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6})`);
        values.push(
          `${e.source}:${e.timestamp}`,
          e.timestamp, e.category, e.title, e.tone, e.lagHours, e.source,
        );
        p += 7;
      }
      await this.pool.query(
        `INSERT INTO macro_events (id,ts,category,title,tone,lag_hours,source)
         VALUES ${placeholders.join(',')}
         ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }

  // ── GDELT fetch ───────────────────────────────────────────────────────────

  private async fetchGDELT(from: Date, to: Date): Promise<HistoricalMacroEvent[]> {
    const chunks = chunkDateRange(from, to, 30); // 30-day chunks
    const allEvents: HistoricalMacroEvent[] = [];
    let chunkNum = 0;

    for (const [chunkStart, chunkEnd] of chunks) {
      chunkNum++;
      console.log(`  GDELT chunk ${chunkNum}/${chunks.length}: ${fmtDate(chunkStart)} → ${fmtDate(chunkEnd)}`);

      const chunkEvents = await this.fetchGDELTChunk(chunkStart, chunkEnd);
      if (chunkEvents.length > 0) {
        await this.persistEvents(chunkEvents);
        allEvents.push(...chunkEvents);
      }
      console.log(`    → ${chunkEvents.length} articles`);

      // GDELT rate limit: 1 request per 5 seconds
      await sleep(6_000);
    }

    return allEvents;
  }

  private async fetchGDELTChunk(from: Date, to: Date): Promise<HistoricalMacroEvent[]> {
    // Up to 3 attempts with backoff; skip chunk on failure (not every chunk is critical)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await axios.get<{ articles?: GDELTArticleRaw[] }>(GDELT_DOC_API, {
          timeout: 15_000,
          params: {
            query:         GDELT_QUERY,
            mode:          'artlist',
            maxrecords:    250,
            format:        'json',
            startdatetime: formatGDELTDate(from),
            enddatetime:   formatGDELTDate(to),
          },
        });

        const articles = resp.data.articles ?? [];
        return articles
          .filter(a => a.title && a.seendate)
          .map(a => {
            const timestamp = parseGDELTDate(a.seendate) ?? from.getTime();
            const category  = classifyGDELT(a.title);
            return {
              timestamp,
              date:     new Date(timestamp).toISOString().split('T')[0]!,
              category,
              title:    a.title.slice(0, 200),
              tone:     0, // artlist mode doesn't return tone; use 0
              lagHours: estimateLag(category),
              source:   'gdelt' as const,
            };
          });
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429) {
          const delay = attempt * 10_000; // 10s, 20s, 30s
          console.warn(`    GDELT 429 — attempt ${attempt}/3, waiting ${delay / 1000}s`);
          await sleep(delay);
        } else {
          console.warn(`    GDELT chunk failed (attempt ${attempt}): ${String(err)}`);
          if (attempt < 3) await sleep(3_000);
        }
      }
    }
    console.warn(`    GDELT chunk skipped after 3 failed attempts`);
    return [];
  }

  // ── FRED fetch ────────────────────────────────────────────────────────────

  private async fetchFRED(from: Date, to: Date): Promise<HistoricalMacroEvent[]> {
    const events: HistoricalMacroEvent[] = [];
    const fromMs = from.getTime();
    const toMs   = to.getTime();

    for (const [seriesId, category] of Object.entries(FRED_SERIES)) {
      await sleep(300);
      let seriesCount = 0;
      try {
        // fredgraph.csv only accepts ?id= — returns full series, we filter by date in code
        const resp = await axios.get<string>(FRED_BASE, {
          timeout: 10_000,
          params: { id: seriesId },
          responseType: 'text',
        });

        const seriesEvents: HistoricalMacroEvent[] = [];
        const lines = (resp.data as string).split('\n').slice(1); // skip header row
        for (const line of lines) {
          const [dateStr, valueStr] = line.trim().split(',');
          if (!dateStr || !valueStr || valueStr === '.') continue;
          const timestamp = new Date(dateStr).getTime();
          if (isNaN(timestamp) || timestamp < fromMs || timestamp > toMs) continue;
          const value = parseFloat(valueStr);
          if (isNaN(value)) continue;
          seriesEvents.push({
            timestamp,
            date:     dateStr,
            category,
            title:    buildFREDTitle(seriesId, value),
            tone:     buildFREDTone(seriesId, value),
            lagHours: estimateLag(category),
            source:   'fred',
          });
          seriesCount++;
        }
        // Persist immediately — don't wait for GDELT to finish
        if (seriesEvents.length > 0) await this.persistEvents(seriesEvents);
        events.push(...seriesEvents);
        console.log(`  FRED ${seriesId}: ${seriesCount} observations inserted`);
      } catch (err) {
        console.warn(`  FRED ${seriesId} failed: ${String(err)}`);
      }
    }
    return events;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildFREDTitle(seriesId: string, value: number): string {
  switch (seriesId) {
    case 'FEDFUNDS':  return `Fed Funds Rate: ${value.toFixed(2)}%`;
    case 'CPIAUCSL':  return `CPI (All Items): ${value.toFixed(1)}`;
    case 'DTWEXBGS':  return `DXY Trade-Weighted Dollar: ${value.toFixed(1)}`;
    case 'M2SL':      return `M2 Money Supply: $${(value / 1000).toFixed(1)}T`;
    default:          return `${seriesId}: ${value}`;
  }
}

function buildFREDTone(seriesId: string, value: number): number {
  switch (seriesId) {
    case 'FEDFUNDS':  return value > 3 ? -value / 2 : 0;
    case 'CPIAUCSL':  return value > 4 ? -(value - 4) : value > 2 ? 0 : 2;
    case 'DTWEXBGS':  return value > 105 ? -3 : value < 95 ? 3 : 0;
    case 'M2SL':      return 2;
    default:          return 0;
  }
}

function formatGDELTDate(d: Date): string {
  // GDELT requires exactly 14 chars: YYYYMMDDHHMMSS
  return d.toISOString().replace(/[-:T]/g, '').split('.')[0]!;
}

function parseGDELTDate(s: string): number | null {
  try {
    return new Date(
      s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
    ).getTime();
  } catch { return null; }
}

function fmtDate(d: Date): string {
  return d.toISOString().split('T')[0]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}


function chunkDateRange(from: Date, to: Date, days: number): [Date, Date][] {
  const chunks: [Date, Date][] = [];
  let cur = new Date(from);
  while (cur < to) {
    const next = new Date(Math.min(cur.getTime() + days * 86_400_000, to.getTime()));
    chunks.push([new Date(cur), next]);
    cur = next;
  }
  return chunks;
}
