/**
 * Reconcile actual Polymarket wallet balances against the DB's cumulative
 * pnl + cost basis. Used after a backfill (`backfill-resolution-outcomes.ts`)
 * to confirm DB now reflects on-chain reality, and as a periodic sanity check.
 *
 * What it prints:
 *   1. Wallet USDC collateral balance (CLOB getBalanceAllowance, asset_type=COLLATERAL)
 *   2. Open share positions — every poly_orders row with status='pending'
 *      AND side='buy', queries the on-chain CTF balance for that token,
 *      multiplies by the latest poly_share_ticks midpoint → "open position
 *      value at market".
 *   3. DB cumulative realized pnl (SUM(pnl_usdc) WHERE side='buy' AND status='closed')
 *      and cost basis (SUM(size_usdc) WHERE side='buy' AND status='closed').
 *   4. Total liquid value (USDC + open positions value).
 *   5. If --start-balance is passed, expected vs actual delta.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/wallet-reconcile.ts
 *   pnpm --filter @trading-bot/api exec tsx scripts/wallet-reconcile.ts --start-balance=200
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

import { getPool } from '@trading-bot/db';
import { initClobExecutor, getClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';

function parseArgs(): { startBalance: number | null } {
  let startBalance: number | null = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--start-balance=')) {
      const v = Number(arg.slice('--start-balance='.length));
      if (Number.isFinite(v)) startBalance = v;
      else { console.error(`bad --start-balance value: ${arg}`); process.exit(1); }
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: wallet-reconcile.ts [--start-balance=N]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return { startBalance };
}

async function main(): Promise<void> {
  const { startBalance } = parseArgs();
  const pool = getPool();

  // 1. CLOB executor must be available (needs POLY_PRIVATE_KEY in env).
  const ex = await initClobExecutor();
  if (!ex) {
    console.error('ERROR: ClobExecutor not initialised — set POLY_PRIVATE_KEY');
    process.exit(1);
  }
  const exec = getClobExecutor();
  if (!exec) { console.error('ERROR: executor singleton null'); process.exit(1); }

  // 2. Wallet USDC.
  const usdc = await exec.getCollateralBalance();
  console.log('WALLET RECONCILE');
  console.log('────────────────');
  console.log(`Wallet address      : ${usdc.address}`);
  console.log(`USDC balance        : $${usdc.balance.toFixed(2)}`);
  console.log(`USDC allowance      : $${usdc.allowance.toFixed(2)}`);
  console.log();

  // 3. Open positions: pending buys.
  const { rows: openRows } = await pool.query<{
    id: string; market_id: string; direction: 'up'|'down';
    share_price: string; size_usdc: string;
    token_up: string; token_down: string;
    window_end: string;
  }>(
    `SELECT o.id, o.market_id, o.direction,
            o.share_price::text, o.size_usdc::text,
            m.token_up, m.token_down,
            m.window_end::text
       FROM poly_orders o
       JOIN poly_clob_markets m ON m.condition_id = o.market_id
      WHERE o.side = 'buy' AND o.status = 'pending'
      ORDER BY o.ts_entry ASC`,
  );

  console.log(`Open positions      : ${openRows.length}`);
  let openValueAtMarket = 0;
  let openCostBasis     = 0;
  for (const r of openRows) {
    const direction = r.direction;
    const token     = direction === 'up' ? r.token_up : r.token_down;
    const sharesDb  = Number(r.size_usdc) / Number(r.share_price);
    const shares    = await exec.getTokenBalance(token);
    // Use the most recent share-tick midpoint as "market value now".
    const { rows: tickRows } = await pool.query<{ best_bid: string|null; best_ask: string|null }>(
      `SELECT best_bid::text, best_ask::text FROM poly_share_ticks
        WHERE token_id = $1 AND best_bid IS NOT NULL AND best_ask IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
      [token],
    );
    const bid = tickRows[0]?.best_bid != null ? Number(tickRows[0].best_bid) : null;
    const ask = tickRows[0]?.best_ask != null ? Number(tickRows[0].best_ask) : null;
    const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
    const value = mid != null ? shares * mid : 0;
    openValueAtMarket += value;
    openCostBasis     += Number(r.size_usdc);
    console.log(
      `  ${r.id.slice(0, 8)}  ${direction.toUpperCase()}  ` +
      `dbShares=${sharesDb.toFixed(2)}  chainShares=${shares.toFixed(2)}  ` +
      `mid=${mid?.toFixed(3) ?? '-'}  value=$${value.toFixed(2)}  ` +
      `cost=$${Number(r.size_usdc).toFixed(2)}`
    );
  }
  console.log(`Open positions value : $${openValueAtMarket.toFixed(2)} (at mid)`);
  console.log(`Open positions cost  : $${openCostBasis.toFixed(2)}`);
  console.log();

  // 4. DB-side cumulative.
  const { rows: aggRows } = await pool.query<{
    total_pnl: string | null;
    total_size: string | null;
    won_count: string;
    lost_count: string;
    closed_count: string;
  }>(
    `SELECT
        SUM(pnl_usdc)::text  AS total_pnl,
        SUM(size_usdc)::text AS total_size,
        SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END)::text AS won_count,
        SUM(CASE WHEN pnl_usdc <= 0 THEN 1 ELSE 0 END)::text AS lost_count,
        COUNT(*)::text AS closed_count
       FROM poly_orders
      WHERE side = 'buy' AND status = 'closed'`,
  );
  const a = aggRows[0]!;
  const totalPnl  = Number(a.total_pnl ?? 0);
  const totalSize = Number(a.total_size ?? 0);
  const wonCount  = Number(a.won_count);
  const lostCount = Number(a.lost_count);
  const closedCount = Number(a.closed_count);
  const winRate   = closedCount > 0 ? (wonCount / closedCount) * 100 : 0;

  console.log('DB CUMULATIVE (closed buy-side orders)');
  console.log(`  closed orders     : ${closedCount}  (won ${wonCount} / lost ${lostCount}, win rate ${winRate.toFixed(1)}%)`);
  console.log(`  cumulative pnl    : $${totalPnl.toFixed(2)}`);
  console.log(`  cumulative cost   : $${totalSize.toFixed(2)}`);
  console.log();

  // 5. Total liquid value snapshot.
  const totalLiquid = usdc.balance + openValueAtMarket;
  console.log('LIQUID VALUE NOW');
  console.log(`  USDC               : $${usdc.balance.toFixed(2)}`);
  console.log(`  open positions     : $${openValueAtMarket.toFixed(2)}`);
  console.log(`  total              : $${totalLiquid.toFixed(2)}`);
  console.log();

  // 6. Reconcile against starting balance if provided.
  if (startBalance != null) {
    // Expected total liquid value = startBalance + cumulative realized pnl
    // (open positions cost is in `pnl_usdc=null` rows — not in totalPnl yet,
    // but the cost USDC is sitting in open shares, so the open-positions
    // VALUE at mid replaces it 1:1 in the liquid calculation).
    const expected = startBalance + totalPnl;
    const delta    = totalLiquid - expected;
    console.log('CHECK vs starting balance');
    console.log(`  start              : $${startBalance.toFixed(2)}`);
    console.log(`  + realized pnl     : $${totalPnl.toFixed(2)}`);
    console.log(`  = expected liquid  : $${expected.toFixed(2)}`);
    console.log(`  actual liquid      : $${totalLiquid.toFixed(2)}`);
    console.log(`  Δ                  : ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`);
    if (Math.abs(delta) > 1) {
      console.log(`  ⚠ delta > $1 — DB may still have mis-priced rows. Check:`);
      console.log(`    - close_reason='resolution' on tiny-move windows (see backfill-resolution-outcomes.ts)`);
      console.log(`    - close_reason='sl' rows where exit_price might be WS-stale (see backfill-exit-prices.ts)`);
    } else {
      console.log(`  ✅ within $1 — wallet and DB reconciled`);
    }
  } else {
    console.log('Pass --start-balance=N to compute expected vs actual delta.');
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
