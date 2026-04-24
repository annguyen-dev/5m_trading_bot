/**
 * Binance kline fetcher for BTC + SOL.
 *
 * - 7d of 5m candles  → streak + volatility regime analysis
 * - 2d of 1s candles  → intra-window path analysis (TP/SL timing, traps)
 *
 * Writes compact JSON to analysis/data/. Polite rate limit (100ms between calls).
 * Run: npx tsx analysis/fetch.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'data');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SYMBOLS = ['BTCUSDT', 'SOLUSDT'] as const;
const BASE = 'https://api.binance.com/api/v3/klines';

interface Kline {
  openTime: number;   open: number;  high: number;  low: number;
  close:    number;   volume: number; closeTime: number;
}

async function fetchRange(
  symbol: string, interval: '5m' | '1s',
  startMs: number, endMs: number, limit = 1000,
): Promise<Kline[]> {
  const out: Kline[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BASE}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${limit}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    const rows = (await r.json()) as unknown[][];
    if (!rows.length) break;
    for (const row of rows) {
      out.push({
        openTime:  Number(row[0]),
        open:      Number(row[1]),
        high:      Number(row[2]),
        low:       Number(row[3]),
        close:     Number(row[4]),
        volume:    Number(row[5]),
        closeTime: Number(row[6]),
      });
    }
    const last = Number(rows[rows.length - 1]![0]);
    cursor = last + 1;
    // Polite — Binance allows 1200 req/min but be nice
    await new Promise(r => setTimeout(r, 100));
    // Progress for long pulls
    if (out.length % 10_000 < rows.length) {
      process.stdout.write(`  ${symbol} ${interval}: ${out.length} candles\r`);
    }
  }
  return out;
}

async function main() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const symbol of SYMBOLS) {
    console.log(`\n=== ${symbol} ===`);

    // 7d of 5m
    console.log(`Fetching 7d of 5m...`);
    const klines5m = await fetchRange(symbol, '5m', now - 7 * DAY, now);
    const p5m = path.join(OUT_DIR, `${symbol}_5m_7d.json`);
    fs.writeFileSync(p5m, JSON.stringify(klines5m));
    console.log(`  saved ${klines5m.length} candles → ${p5m}`);

    // 2d of 1s
    console.log(`Fetching 2d of 1s...`);
    const klines1s = await fetchRange(symbol, '1s', now - 2 * DAY, now);
    const p1s = path.join(OUT_DIR, `${symbol}_1s_2d.json`);
    fs.writeFileSync(p1s, JSON.stringify(klines1s));
    console.log(`  saved ${klines1s.length} candles → ${p1s}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
