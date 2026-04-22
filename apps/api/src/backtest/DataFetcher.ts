import { pro } from 'ccxt';
import type { Candle, Trade } from '../types/market.js';
import type { BacktestConfig, HistoricalDataset } from './types.js';
import { getPool } from '@trading-bot/db';

const OHLCV_TIMEFRAME     = '1m';
const CANDLES_PER_REQUEST = 1000;
const TRADES_PER_REQUEST  = 1000;

export class DataFetcher {
  private _exchange: InstanceType<typeof pro.binance> | null = null;

  constructor(private readonly config: BacktestConfig) {}

  async fetch(): Promise<HistoricalDataset> {
    // 1. DB — primary source (data pulled via build:pull) — skipped when noCache
    if (!this.config.noCache) {
      const dbCandles = await this.loadFromDb();
      if (dbCandles.length > 0) {
        const expected = Math.floor((this.config.endDate.getTime() - this.config.startDate.getTime()) / 60_000);
        const coverage = ((dbCandles.length / expected) * 100).toFixed(1);
        console.log(`[DataFetcher] DB: ${dbCandles.length} candles (${coverage}% coverage)`);
        return { candles: dbCandles, trades: this.simulateTrades(dbCandles) };
      }
    }

    // 2. Exchange API — either fallback (DB empty) or forced (noCache)
    const reason = this.config.noCache ? 'noCache=true' : 'DB empty for range';
    console.log(`[DataFetcher] ${reason} — fetching from exchange API`);
    const candles = await this.fetchFromApi();
    console.log(`[DataFetcher] API: ${candles.length} candles — saving to DB`);
    await this.saveToDb(candles);

    const trades = this.config.simulateTrades
      ? this.simulateTrades(candles)
      : await this.fetchRealTrades();

    return { candles, trades };
  }

  // ── DB ────────────────────────────────────────────────────────────────────

  private async loadFromDb(): Promise<Candle[]> {
    try {
      const { rows } = await getPool().query<{
        ts: string; open: string; high: string; low: string; close: string; volume: string;
      }>(
        `SELECT ts, open, high, low, close, volume
         FROM ohlcv_1m
         WHERE exchange = $1 AND symbol = $2 AND ts >= $3 AND ts <= $4
         ORDER BY ts ASC`,
        [this.config.exchangeId, this.config.symbol,
         this.config.startDate.getTime(), this.config.endDate.getTime()],
      );
      return rows.map(r => ({
        timestamp: Number(r.ts), open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
      }));
    } catch {
      return [];
    }
  }

  private async saveToDb(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;
    const pool = getPool();
    const CHUNK = 1000;
    for (let i = 0; i < candles.length; i += CHUNK) {
      const chunk = candles.slice(i, i + CHUNK);
      const values = chunk.map((_, j) => {
        const base = j * 8;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
      }).join(',');
      const params = chunk.flatMap(c => [
        this.config.exchangeId, this.config.symbol,
        c.timestamp, c.open, c.high, c.low, c.close, c.volume,
      ]);
      await pool.query(
        `INSERT INTO ohlcv_1m (exchange,symbol,ts,open,high,low,close,volume)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        params,
      );
    }
  }

  // ── Exchange API ──────────────────────────────────────────────────────────

  private getExchange(): InstanceType<typeof pro.binance> {
    if (!this._exchange) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Cls = (pro as any)[this.config.exchangeId] as new (opts: object) => InstanceType<typeof pro.binance>;
      if (!Cls) throw new Error(`Unsupported exchange: ${this.config.exchangeId}`);
      this._exchange = new Cls({ enableRateLimit: true });
    }
    return this._exchange;
  }

  private async fetchFromApi(): Promise<Candle[]> {
    const candles: Candle[] = [];
    let since = this.config.startDate.getTime();
    const until = this.config.endDate.getTime();

    while (since < until) {
      const raw = await (this.getExchange() as {
        fetchOHLCV(symbol: string, tf: string, since: number, limit: number): Promise<number[][]>;
      }).fetchOHLCV(this.config.symbol, OHLCV_TIMEFRAME, since, CANDLES_PER_REQUEST);

      if (!raw?.length) break;
      for (const c of raw) {
        if ((c[0] ?? 0) > until) break;
        candles.push({ timestamp: c[0] ?? 0, open: c[1] ?? 0, high: c[2] ?? 0, low: c[3] ?? 0, close: c[4] ?? 0, volume: c[5] ?? 0 });
      }
      const last = raw[raw.length - 1]?.[0];
      if (!last || last <= since) break;
      since = last + 60_000;
      await sleep(200);
    }

    return candles.filter(c => c.timestamp >= this.config.startDate.getTime() && c.timestamp <= until);
  }

  private async fetchRealTrades(): Promise<Trade[]> {
    const trades: Trade[] = [];
    let since = this.config.startDate.getTime();
    const until = this.config.endDate.getTime();

    while (since < until) {
      const raw = await (this.getExchange() as {
        fetchTrades(symbol: string, since: number, limit: number): Promise<{ id: string|number; timestamp: number; price: number; amount: number; side: string }[]>;
      }).fetchTrades(this.config.symbol, since, TRADES_PER_REQUEST);

      if (!raw?.length) break;
      for (const t of raw) {
        if (t.timestamp > until) break;
        trades.push({ id: String(t.id), timestamp: t.timestamp, price: t.price, amount: t.amount, side: t.side as 'buy' | 'sell' });
      }
      const last = raw[raw.length - 1]?.timestamp;
      if (!last || last <= since) break;
      since = last + 1;
      await sleep(300);
      if (trades.length > 500_000) { console.warn('[DataFetcher] 500k trade limit reached'); break; }
    }

    return trades.filter(t => t.timestamp >= this.config.startDate.getTime() && t.timestamp <= until);
  }

  // ── Trade simulation ──────────────────────────────────────────────────────

  private simulateTrades(candles: Candle[]): Trade[] {
    const trades: Trade[] = [];
    let id = 0;
    const splits  = [0.3, 0.25, 0.25, 0.2];
    const offsets  = [0, 15_000, 30_000, 50_000];

    for (const c of candles) {
      const buyRatio = c.close >= c.open ? 0.65 : 0.35;
      const prices   = [c.open, (c.open + c.close) / 2, c.close, c.close];
      for (let i = 0; i < 4; i++) {
        trades.push({ id: String(++id), timestamp: c.timestamp + offsets[i]!, price: prices[i]!, amount: c.volume * splits[i]!, side: Math.random() < buyRatio ? 'buy' : 'sell' });
      }
    }
    return trades.sort((a, b) => a.timestamp - b.timestamp);
  }

  async close(): Promise<void> {
    await this._exchange?.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
