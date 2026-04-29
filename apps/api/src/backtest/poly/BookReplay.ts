/**
 * BookReplay — read-only view over poly_share_ticks for a single token.
 *
 * Backtest needs to ask "what was the bid / ask at time T?" thousands of
 * times. Loading the full tick stream into memory once and stepping through
 * with a forward cursor is cheaper than per-query SQL.
 *
 * Tick storage caveat: poly_share_ticks only writes a row when top-of-book
 * (best_bid / best_ask) changes — between updates we assume the book is
 * unchanged (last-known-bid model). For volatile periods this slightly
 * under-counts SL hits; documented as a v1 limitation.
 */

import { getPool } from '@trading-bot/db';

interface Tick {
  ts:        number;
  bestBid:   number | null;
  bestAsk:   number | null;
}

export class BookReplay {
  private ticks: Tick[] = [];
  /** Index of the next tick to consume on the next forward step.
   *  Walking strategies should monotonically advance this — random access
   *  defeats the point and forces a binary search. */
  private cursor = 0;

  constructor(public readonly tokenId: string) {}

  /** Load all ticks for `tokenId` in [fromMs, toMs). One SQL roundtrip. */
  async load(fromMs: number, toMs: number): Promise<void> {
    const { rows } = await getPool().query<{
      ts: string; best_bid: number | null; best_ask: number | null;
    }>(
      `SELECT ts::text, best_bid, best_ask
         FROM poly_share_ticks
        WHERE token_id = $1
          AND ts >= $2 AND ts < $3
        ORDER BY ts ASC`,
      [this.tokenId, fromMs, toMs],
    );
    this.ticks = rows.map(r => ({
      ts:      Number(r.ts),
      bestBid: r.best_bid != null ? Number(r.best_bid) : null,
      bestAsk: r.best_ask != null ? Number(r.best_ask) : null,
    }));
    this.cursor = 0;
  }

  get tickCount(): number { return this.ticks.length; }

  /** Reset cursor — used when scanning a new window from start. */
  rewindTo(ts: number): void {
    // Binary search for the first tick >= ts.
    let lo = 0, hi = this.ticks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ticks[mid]!.ts < ts) lo = mid + 1; else hi = mid;
    }
    this.cursor = lo;
  }

  /**
   * Best ask AT or just before `ts` (last-known-ask model). Returns null if
   * no tick has yet provided an ask before this time.
   *
   * Walks backward from cursor — caller should call this in monotonically
   * increasing `ts` order (walking forward through windows).
   */
  bestAskAt(ts: number): number | null {
    // Advance cursor to the latest tick <= ts.
    while (this.cursor < this.ticks.length && this.ticks[this.cursor]!.ts <= ts) {
      this.cursor++;
    }
    // cursor now points just past the relevant tick. Walk back to find ask.
    for (let i = this.cursor - 1; i >= 0; i--) {
      const a = this.ticks[i]!.bestAsk;
      if (a != null && a > 0 && a < 1) return a;
    }
    return null;
  }

  /** Same as bestAskAt but for bid. */
  bestBidAt(ts: number): number | null {
    while (this.cursor < this.ticks.length && this.ticks[this.cursor]!.ts <= ts) {
      this.cursor++;
    }
    for (let i = this.cursor - 1; i >= 0; i--) {
      const b = this.ticks[i]!.bestBid;
      if (b != null && b > 0 && b < 1) return b;
    }
    return null;
  }

  /**
   * Walk forward from `fromTs` until a bid satisfies `pred`, or we reach
   * `toTs`. Returns the matching tick's {ts, bid} or null on no-match.
   *
   * Used for TP/SL trigger detection: scan ticks of the bet token between
   * order entry and window close, fire on first qualifying bid.
   */
  scanForward(
    fromTs: number, toTs: number, pred: (bid: number) => boolean,
  ): { ts: number; bid: number } | null {
    // Binary search for first tick >= fromTs (don't reuse cursor since this
    // is an independent scan, not a monotonic walk).
    let lo = 0, hi = this.ticks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ticks[mid]!.ts < fromTs) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < this.ticks.length; i++) {
      const t = this.ticks[i]!;
      if (t.ts >= toTs) break;
      if (t.bestBid != null && t.bestBid > 0 && t.bestBid < 1 && pred(t.bestBid)) {
        return { ts: t.ts, bid: t.bestBid };
      }
    }
    return null;
  }
}
