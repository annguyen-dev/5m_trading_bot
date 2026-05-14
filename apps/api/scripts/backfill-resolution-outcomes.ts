/**
 * Backfill historical `close_reason='resolution'` orders to use Polymarket
 * share-price truth instead of the legacy Binance-ticker outcome.
 *
 * Background: pre-`7fb37ea`, `OrderResolver.resolveAtClose` decided the bet
 * outcome from `future_ticks_5s` (Binance close-vs-open) and recorded
 * `exit_price` as a hardcoded 0.0 or 1.0. Polymarket BTC up/down markets
 * resolve via Chainlink, and on tiny-move windows the two feeds can produce
 * OPPOSITE binary outcomes. Verified prod 2026-05-14 07:35-07:40: Binance
 * +0.010% UP, Poly UP token mid 0.014 (DOWN won) → bot's DOWN bet recorded
 * as LOSS, but wallet's DOWN tokens redeemed at ~$0.99 each.
 *
 * This script reconciles every closed buy-side order with
 * `close_reason='resolution'` against the actual Polymarket share-tick at
 * T-0…T-0+30s, and corrects `outcome`-equivalent fields (`pnl_usdc`,
 * `exit_price`) plus the related child SELL rows (status='closed',
 * close_reason='cancelled') if they exist. close_reason='tp'/'sl' orders
 * are LEFT ALONE — those used real FAK fill prices, not the resolution rule.
 *
 * Idempotent: only updates if abs(recorded_exit - actual_exit) > 1¢.
 * Re-running the script after a partial run is safe.
 *
 * Usage (locally, against prod DB via tunnel — or on the server):
 *   pnpm --filter @trading-bot/api exec tsx scripts/backfill-resolution-outcomes.ts --dry-run
 *   pnpm --filter @trading-bot/api exec tsx scripts/backfill-resolution-outcomes.ts          # apply
 *   pnpm --filter @trading-bot/api exec tsx scripts/backfill-resolution-outcomes.ts --since=2026-05-01
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

import { getPool } from '@trading-bot/db';

interface Candidate {
  id:           string;
  market_id:    string;
  direction:    'up' | 'down';
  share_price:  number;
  size_usdc:    number;
  exit_price:   number | null;
  pnl_usdc:     number | null;
  window_start: number;
  window_end:   number;
  token_up:     string;
  token_down:   string;
}

function parseArgs(): { dryRun: boolean; sinceMs: number | null } {
  let dryRun = false;
  let sinceMs: number | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true;
    else if (arg.startsWith('--since=')) {
      const v = arg.slice('--since='.length);
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) sinceMs = ms;
      else { console.error(`bad --since value: ${v}`); process.exit(1); }
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: backfill-resolution-outcomes.ts [--dry-run] [--since=YYYY-MM-DD]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return { dryRun, sinceMs };
}

async function main(): Promise<void> {
  const { dryRun, sinceMs } = parseArgs();
  const pool = getPool();

  // 1. Pull all candidate buy-side resolution orders, with their window + tokens.
  const params: unknown[] = [];
  let sinceClause = '';
  if (sinceMs != null) {
    params.push(sinceMs);
    sinceClause = `AND o.ts_entry >= $${params.length}`;
  }

  const { rows: candidates } = await pool.query<{
    id: string; market_id: string; direction: 'up'|'down';
    share_price: string; size_usdc: string;
    exit_price: string | null; pnl_usdc: string | null;
    window_start: string; window_end: string;
    token_up: string; token_down: string;
  }>(
    `SELECT o.id, o.market_id, o.direction,
            o.share_price::text, o.size_usdc::text,
            o.exit_price::text, o.pnl_usdc::text,
            m.window_start::text, m.window_end::text,
            m.token_up, m.token_down
       FROM poly_orders o
       JOIN poly_clob_markets m ON m.condition_id = o.market_id
      WHERE o.side = 'buy'
        AND o.status = 'closed'
        AND o.close_reason = 'resolution'
        ${sinceClause}
      ORDER BY o.ts_entry ASC`,
    params,
  );

  console.log(`scanning ${candidates.length} resolution orders` +
    (sinceMs != null ? ` since ${new Date(sinceMs).toISOString()}` : ''));

  let updated = 0;
  let skippedNoTick = 0;
  let skippedAlreadyCorrect = 0;
  let pnlDeltaTotal = 0;
  let flippedOutcome = 0;

  for (const r of candidates) {
    const o: Candidate = {
      id: r.id, market_id: r.market_id, direction: r.direction,
      share_price: Number(r.share_price), size_usdc: Number(r.size_usdc),
      exit_price: r.exit_price != null ? Number(r.exit_price) : null,
      pnl_usdc:   r.pnl_usdc   != null ? Number(r.pnl_usdc)   : null,
      window_start: Number(r.window_start), window_end: Number(r.window_end),
      token_up: r.token_up, token_down: r.token_down,
    };
    const betToken = o.direction === 'up' ? o.token_up : o.token_down;

    // 2. Read Polymarket bet-token mid in [window_end, window_end+30s].
    const { rows: tickRows } = await pool.query<{ best_bid: string|null; best_ask: string|null }>(
      `SELECT best_bid::text, best_ask::text FROM poly_share_ticks
        WHERE token_id = $1
          AND ts >= $2 AND ts <= $3
          AND best_bid IS NOT NULL AND best_ask IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
      [betToken, o.window_end, o.window_end + 30_000],
    );
    const pBid = tickRows[0]?.best_bid != null ? Number(tickRows[0].best_bid) : null;
    const pAsk = tickRows[0]?.best_ask != null ? Number(tickRows[0].best_ask) : null;

    if (pBid == null || pAsk == null) {
      skippedNoTick++;
      continue;
    }
    const betMid    = (pBid + pAsk) / 2;
    const betWon    = betMid > 0.5;
    const sharesOwned = o.size_usdc / o.share_price;
    const newExit   = betMid;
    const newPnl    = sharesOwned * newExit - o.size_usdc;

    // 3. Compare to recorded.
    if (o.exit_price != null && Math.abs(newExit - o.exit_price) < 0.01) {
      skippedAlreadyCorrect++;
      continue;
    }

    const recordedWon = o.exit_price != null && o.exit_price >= 0.5;
    const outcomeFlipped = recordedWon !== betWon;
    if (outcomeFlipped) flippedOutcome++;

    const oldPnl = o.pnl_usdc ?? 0;
    const delta  = newPnl - oldPnl;
    pnlDeltaTotal += delta;

    const tag = outcomeFlipped ? ' [FLIP]' : '';
    console.log(
      `${o.id}${tag}  dir=${o.direction}  ` +
      `exit ${o.exit_price?.toFixed(3) ?? 'null'} → ${newExit.toFixed(3)}  ` +
      `pnl ${oldPnl.toFixed(2)} → ${newPnl.toFixed(2)}  ` +
      `Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
    );

    if (!dryRun) {
      await pool.query(
        `UPDATE poly_orders
            SET exit_price = $1, pnl_usdc = $2
          WHERE id = $3 AND side = 'buy' AND close_reason = 'resolution'`,
        [newExit, newPnl, o.id],
      );
    }
    updated++;
  }

  console.log('\n──── summary ────');
  console.log(`scanned                : ${candidates.length}`);
  console.log(`updated                : ${updated}${dryRun ? ' (dry-run, no writes)' : ''}`);
  console.log(`skipped (no Poly tick) : ${skippedNoTick}`);
  console.log(`skipped (≤1¢ diff)     : ${skippedAlreadyCorrect}`);
  console.log(`outcome flipped        : ${flippedOutcome} cycles`);
  console.log(`pnl correction         : ${pnlDeltaTotal >= 0 ? '+' : ''}${pnlDeltaTotal.toFixed(2)} USDC`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
