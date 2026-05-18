/**
 * Daily volatility regime tracker. Plots:
 *   - Average |body| per day (bar magnitude)
 *   - Count of streak ≥5 events per day (vol cluster freq)
 *   - Distribution of bar bodies (small vs medium vs large)
 *   - Body3 distribution at streak=5 entry points (filter qualification rate)
 *
 * Lets user spot regime shifts: e.g., "last 5 days bodies dropped 40% vs prior
 * month" → body3 filter set for previous regime now over-restricts.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs, pages = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const ts = Number(r[0]), open = Number(r[1]), close = Number(r[4]);
      all.push({ ts, open, close, body: close - open, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const days = 60;
  console.error(`Fetching ${days}d of BTC 5m bars…`);
  const bars = await fetchKlines(days);
  console.error(`Got ${bars.length} bars\n`);

  // Streak length
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // Group bars by day (UTC)
  const byDay = new Map<string, { bodies: number[]; streak5Ends: number; entryBody3: number[]; closePrice: number }>();
  for (let i = 0; i < bars.length; i++) {
    const day = new Date(bars[i]!.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { bodies: [], streak5Ends: 0, entryBody3: [], closePrice: bars[i]!.close });
    const slot = byDay.get(day)!;
    slot.bodies.push(Math.abs(bars[i]!.body));
    slot.closePrice = bars[i]!.close;
    // Detect streak ≥5 end (next bar opposite or doji)
    if (streakLen[i]! >= 5 && i+1 < bars.length && bars[i+1]!.dir !== bars[i]!.dir) {
      slot.streak5Ends += 1;
    }
    // Body3 at entry points (streak first reaches 3 or 4)
    if ((streakLen[i] === 3 || streakLen[i] === 4) && streakLen[i-1] !== streakLen[i] && i >= 3) {
      const b3 = Math.abs(bars[i]!.body) + Math.abs(bars[i-1]!.body) + Math.abs(bars[i-2]!.body);
      slot.entryBody3.push(b3);
    }
  }

  console.log('Daily regime indicators (last 60 days):');
  console.log('| Date       | n   | avg |body| | median | p75 |body| | streak≥5 ends | entry-body3 p50 | qualify @ $250 | qualify @ $400 |');
  console.log('|------------|-----|------------|--------|-----------|---------------|-----------------|----------------|----------------|');
  const days_sorted = Array.from(byDay.keys()).sort();
  for (const day of days_sorted) {
    const d = byDay.get(day)!;
    if (d.bodies.length < 100) continue;  // skip partial first day
    const avg = d.bodies.reduce((a, b) => a + b, 0) / d.bodies.length;
    const median = pct(d.bodies, 0.5);
    const p75 = pct(d.bodies, 0.75);
    const body3p50 = d.entryBody3.length > 0 ? pct(d.entryBody3, 0.5) : 0;
    const qualify250 = d.entryBody3.length > 0 ? d.entryBody3.filter(b => b >= 250).length / d.entryBody3.length : 0;
    const qualify400 = d.entryBody3.length > 0 ? d.entryBody3.filter(b => b >= 400).length / d.entryBody3.length : 0;
    console.log(
      `| ${day} | ${String(d.bodies.length).padStart(3)} | ${avg.toFixed(1).padStart(10)} | ${median.toFixed(1).padStart(6)} | ${p75.toFixed(1).padStart(9)} | ${String(d.streak5Ends).padStart(13)} | ${body3p50.toFixed(0).padStart(15)} | ${(qualify250*100).toFixed(0).padStart(11)}% | ${(qualify400*100).toFixed(0).padStart(11)}% |`
    );
  }

  // 7d vs 30d comparison
  console.log('\n═══ 7d vs 30d comparison ═══');
  const all7d = days_sorted.slice(-7).map(d => byDay.get(d)!).filter(d => d.bodies.length >= 100);
  const all30d = days_sorted.slice(-30).map(d => byDay.get(d)!).filter(d => d.bodies.length >= 100);

  function aggregate(label: string, list: typeof all7d): void {
    const allBodies = list.flatMap(d => d.bodies);
    const allEntryBody3 = list.flatMap(d => d.entryBody3);
    const totalStreak5 = list.reduce((s, d) => s + d.streak5Ends, 0);
    console.log(`\n  ${label}  (${list.length} days)`);
    console.log(`    avg |body|              : $${(allBodies.reduce((a,b)=>a+b,0)/allBodies.length).toFixed(2)}`);
    console.log(`    median |body|           : $${pct(allBodies, 0.5).toFixed(2)}`);
    console.log(`    p75 |body|              : $${pct(allBodies, 0.75).toFixed(2)}`);
    console.log(`    p95 |body|              : $${pct(allBodies, 0.95).toFixed(2)}`);
    console.log(`    streak≥5 ends / day     : ${(totalStreak5/list.length).toFixed(1)}`);
    console.log(`    entry-body3 median      : $${pct(allEntryBody3, 0.5).toFixed(0)}`);
    console.log(`    entry-body3 p75         : $${pct(allEntryBody3, 0.75).toFixed(0)}`);
    console.log(`    qualify @ $250 (armed)  : ${(allEntryBody3.filter(b=>b>=250).length/allEntryBody3.length*100).toFixed(1)}%`);
    console.log(`    qualify @ $400 (idle)   : ${(allEntryBody3.filter(b=>b>=400).length/allEntryBody3.length*100).toFixed(1)}%`);
  }
  aggregate('Last 7 days', all7d);
  aggregate('Last 30 days', all30d);

  // Suggest adjusted thresholds for current regime
  console.log('\n═══ THRESHOLD SUGGESTIONS for current 7d regime ═══');
  const allEntryBody3_7d = all7d.flatMap(d => d.entryBody3);
  if (allEntryBody3_7d.length > 0) {
    console.log(`  To keep ~30% qualify rate (current = quality filter):  body3 ≥ $${pct(allEntryBody3_7d, 0.7).toFixed(0)}`);
    console.log(`  To keep ~20% qualify rate (strict):                     body3 ≥ $${pct(allEntryBody3_7d, 0.8).toFixed(0)}`);
    console.log(`  To keep ~50% qualify rate (looser):                     body3 ≥ $${pct(allEntryBody3_7d, 0.5).toFixed(0)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
