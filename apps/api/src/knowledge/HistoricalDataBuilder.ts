/**
 * HistoricalDataBuilder
 *
 * Fetches 1m OHLCV candles + funding rates from exchanges via ccxt REST,
 * then persists them into PostgreSQL (ohlcv_1m + funding_rates tables).
 *
 * Resumable: rows already in the DB are skipped via INSERT ON CONFLICT DO NOTHING.
 * Progress is tracked by checking the latest ts already stored, so interrupted
 * runs continue from where they left off.
 *
 * Exchanges: Binance Futures, OKX, Bybit
 * All public endpoints — no API key required.
 */

import ccxt, { Exchange, type OHLCV } from 'ccxt';
import type pg from 'pg';
import { getPool } from '@trading-bot/db';

const CANDLES_PER_REQUEST = 500;
const RATE_LIMIT_MS       = 250;
const INSERT_BATCH        = 1000;   // rows per pg INSERT batch

const SYMBOL_MAP: Record<string, Record<string, string>> = {
  binance: { 'BTC/USDT': 'BTC/USDT:USDT' },
  okx:     { 'BTC/USDT': 'BTC-USDT-SWAP' },
  bybit:   { 'BTC/USDT': 'BTC/USDT:USDT' },
};

export class HistoricalDataBuilder {
  private exchanges: Map<string, Exchange> = new Map();
  private pool: pg.Pool;

  constructor(private readonly exchangeIds: string[]) {
    this.pool = getPool();
  }

  async build(symbol: string, from: Date, to: Date): Promise<void> {
    for (const exchangeId of this.exchangeIds) {
      console.log(`\n[HistoricalDataBuilder] ${exchangeId}: ${symbol} ${fmt(from)} → ${fmt(to)}`);
      try {
        await this.fetchExchange(exchangeId, symbol, from, to);
      } catch (err) {
        console.warn(`[HistoricalDataBuilder] ${exchangeId} failed — skipping: ${String(err)}`);
      }
    }
  }

  async close(): Promise<void> {
    for (const ex of this.exchanges.values()) await ex.close?.();
  }

  // ── Per-exchange ──────────────────────────────────────────────────────────

  private async fetchExchange(
    exchangeId: string,
    symbol: string,
    from: Date,
    to: Date,
  ): Promise<void> {
    const ex = this.getExchange(exchangeId);
    const futuresSymbol = SYMBOL_MAP[exchangeId]?.[symbol] ?? symbol;

    // Find where to resume from
    const resumeFrom = await this.getResumePoint(exchangeId, symbol, from);
    if (resumeFrom >= to.getTime()) {
      console.log(`  [skip] ${exchangeId} already fully fetched`);
      return;
    }
    if (resumeFrom > from.getTime()) {
      console.log(`  [resume] ${exchangeId} from ${new Date(resumeFrom).toISOString()}`);
    }

    await Promise.all([
      this.fetchAllCandles(ex, exchangeId, symbol, futuresSymbol, new Date(resumeFrom), to),
      this.fetchFundingHistory(ex, exchangeId, symbol, futuresSymbol, from, to),
    ]);
  }

  // ── OHLCV pagination → pg ─────────────────────────────────────────────────

  private async fetchAllCandles(
    ex: Exchange,
    exchangeId: string,
    symbol: string,
    futuresSymbol: string,
    from: Date,
    to: Date,
  ): Promise<void> {
    let since = from.getTime();
    const toMs = to.getTime();
    let totalInserted = 0;
    const buffer: OHLCV[] = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const rows = buffer.splice(0);
      totalInserted += await this.insertCandles(exchangeId, symbol, rows);
    };

    while (since < toMs) {
      await sleep(RATE_LIMIT_MS);

      let batch: OHLCV[];
      try {
        batch = await ex.fetchOHLCV(futuresSymbol, '1m', since, CANDLES_PER_REQUEST);
      } catch (err) {
        console.warn(`  fetchOHLCV error at ${new Date(since).toISOString()}: ${String(err)}`);
        break;
      }

      if (batch.length === 0) break;

      for (const c of batch) {
        const ts = (c[0] ?? 0) as number;
        if (ts >= toMs) { await flush(); return; }
        buffer.push(c);
      }

      if (buffer.length >= INSERT_BATCH) await flush();

      const lastTs = (batch[batch.length - 1]?.[0] ?? 0) as number;
      if (lastTs <= since) break;
      since = lastTs + 60_000; // advance by 1 minute

      const pct = Math.min(((since - from.getTime()) / (toMs - from.getTime())) * 100, 100);
      process.stdout.write(`\r  OHLCV: ${pct.toFixed(1)}% (${totalInserted} inserted)`);
    }

    await flush();
    process.stdout.write('\n');
    console.log(`  ${exchangeId}: ${totalInserted} candles inserted`);
  }

  private async insertCandles(
    exchangeId: string,
    symbol: string,
    rows: OHLCV[],
  ): Promise<number> {
    if (rows.length === 0) return 0;

    // Build VALUES clause
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const c of rows) {
      placeholders.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7})`);
      values.push(exchangeId, symbol, c[0], c[1], c[2], c[3], c[4], c[5]);
      p += 8;
    }

    const sql = `
      INSERT INTO ohlcv_1m (exchange,symbol,ts,open,high,low,close,volume)
      VALUES ${placeholders.join(',')}
      ON CONFLICT DO NOTHING
    `;

    const result = await this.pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  // ── Funding rates → pg ────────────────────────────────────────────────────

  private async fetchFundingHistory(
    ex: Exchange,
    exchangeId: string,
    symbol: string,
    futuresSymbol: string,
    from: Date,
    to: Date,
  ): Promise<void> {
    if (!ex.has['fetchFundingRateHistory']) return;

    let since = from.getTime();
    const toMs = to.getTime();
    const buffer: { ts: number; rate: number }[] = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const rows = buffer.splice(0);
      await this.insertFunding(exchangeId, symbol, rows);
    };

    // Enrich with OI first (best effort)
    const oiMap = await this.fetchOIHistory(ex, futuresSymbol, from, to);

    while (since < toMs) {
      await sleep(RATE_LIMIT_MS);
      try {
        const batch = await (ex as any).fetchFundingRateHistory(futuresSymbol, since, 100);
        if (!batch || batch.length === 0) break;

        for (const r of batch) {
          const ts   = r.timestamp as number;
          const rate = r.fundingRate as number;
          if (ts >= toMs) { await flush(); return; }
          buffer.push({ ts, rate });
        }

        const lastTs = (batch[batch.length - 1]?.timestamp ?? 0) as number;
        if (lastTs <= since) break;
        since = lastTs + 8 * 3600_000;
      } catch (err) {
        console.warn(`  fundingHistory error: ${String(err)}`);
        break;
      }
    }

    await flush();

    // Back-fill OI into funding_rates
    if (oiMap.size > 0) await this.backfillOI(exchangeId, symbol, oiMap);
  }

  private async insertFunding(
    exchangeId: string,
    symbol: string,
    rows: { ts: number; rate: number }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const r of rows) {
      placeholders.push(`($${p},$${p+1},$${p+2},$${p+3})`);
      values.push(exchangeId, symbol, r.ts, r.rate);
      p += 4;
    }
    await this.pool.query(
      `INSERT INTO funding_rates (exchange,symbol,ts,rate)
       VALUES ${placeholders.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async fetchOIHistory(
    ex: Exchange,
    futuresSymbol: string,
    from: Date,
    to: Date,
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!ex.has['fetchOpenInterestHistory']) return map;

    try {
      let since = from.getTime();
      const toMs = to.getTime();
      while (since < toMs) {
        await sleep(RATE_LIMIT_MS);
        const batch = await (ex as any).fetchOpenInterestHistory(futuresSymbol, '1h', since, 200);
        if (!batch || batch.length === 0) break;
        for (const b of batch) {
          if (b.timestamp && b.openInterestValue) {
            map.set(b.timestamp as number, b.openInterestValue as number);
          }
        }
        const lastTs = batch[batch.length - 1]?.timestamp ?? 0;
        if (lastTs <= since) break;
        since = lastTs + 3600_000;
      }
    } catch { /* best-effort */ }
    return map;
  }

  private async backfillOI(
    exchangeId: string,
    symbol: string,
    oiMap: Map<number, number>,
  ): Promise<void> {
    const entries = [...oiMap.entries()];
    for (const [ts, oi] of entries) {
      // Find nearest funding record ±8h
      await this.pool.query(
        `UPDATE funding_rates SET oi_usd = $1
         WHERE exchange = $2 AND symbol = $3
           AND ABS(ts - $4) = (
             SELECT MIN(ABS(ts - $4))
             FROM funding_rates
             WHERE exchange = $2 AND symbol = $3
               AND ABS(ts - $4) < 28800000
           )`,
        [oi, exchangeId, symbol, ts],
      );
    }
  }

  // ── Resume logic ──────────────────────────────────────────────────────────

  private async getResumePoint(
    exchangeId: string,
    symbol: string,
    from: Date,
  ): Promise<number> {
    const res = await this.pool.query<{ max_ts: string }>(
      `SELECT MAX(ts) AS max_ts FROM ohlcv_1m WHERE exchange=$1 AND symbol=$2`,
      [exchangeId, symbol],
    );
    const maxTs = res.rows[0]?.max_ts ? Number(res.rows[0].max_ts) : null;
    return maxTs ? maxTs + 60_000 : from.getTime();
  }

  // ── Exchange factory ──────────────────────────────────────────────────────

  private getExchange(id: string): Exchange {
    if (this.exchanges.has(id)) return this.exchanges.get(id)!;
    const ExchangeClass = (ccxt as any)[id] as new (config: object) => Exchange;
    if (!ExchangeClass) throw new Error(`Unknown exchange: ${id}`);
    const ex = new ExchangeClass({
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
    this.exchanges.set(id, ex);
    return ex;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0]!;
}
