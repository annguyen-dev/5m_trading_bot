/**
 * Backfill historical exit_price + pnl_usdc from worker logs.
 *
 * Background: pre-fix, OrderResolver.closeOrderAt recorded `exit_price = bid`
 * (the WS bid at trigger time) instead of the actual FAK fill VWAP from
 * `placeMarketSell` response. WS bid was occasionally stale during chaotic
 * moves (e.g. cached bid=0.05 while real book had bids at 0.99) → DB recorded
 * fake losses while wallet actually got far better fills.
 *
 * This script:
 *   1. Tails worker.log lines containing both
 *      "CLOB market SELL response (FAK)" (with makingAmount/takingAmount)
 *      AND the next "OrderResolver SL/TP live-sold" (with order id)
 *   2. For each pair, computes `actualFillPrice = takingAmount / makingAmount`
 *   3. UPDATEs `poly_orders` row to set exit_price + recompute pnl_usdc
 *
 * Idempotency: only updates if the difference between recorded and actual
 * exit_price exceeds 1 cent (so re-running is safe, doesn't churn rows that
 * are already correct).
 *
 * Run on prod (where the log file lives):
 *   ssh prod
 *   cd /opt/trading-bot/apps/api
 *   node --loader ts-node/esm scripts/backfill-exit-prices.ts \
 *     /opt/trading-bot/logs/workers.log
 *
 * Or pipe multiple log files in:
 *   cat /opt/trading-bot/logs/workers.log* | node ... scripts/backfill-exit-prices.ts -
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

import { getPool } from '@trading-bot/db';

interface FakResp {
  ts:           number;
  tokenID:      string;
  makingAmount: number;
  takingAmount: number;
  avgPrice:     number;
}

interface SoldEvent {
  ts:       number;
  orderId:  string;
  reason:   'tp' | 'sl';
  bidAtTrigger: number;
  shares:   number;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: backfill-exit-prices.ts <log-file-or-->');
    process.exit(1);
  }
  const stream = arg === '-' ? process.stdin : createReadStream(arg);
  const rl     = createInterface({ input: stream });

  // Pair adjacent FAK response → live-sold lines (same pid, within 2s).
  let pendingFak: FakResp | null = null;
  const pairs: Array<{ orderId: string; reason: 'tp'|'sl';
                        actualFillPrice: number; bidAtTrigger: number;
                        actualShares: number; ts: number }> = [];

  for await (const raw of rl) {
    if (!raw.trim().startsWith('{')) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(raw); } catch { continue; }
    const msg = String(j['msg'] ?? '');
    const ts  = Date.parse(String(j['time'] ?? '0'));

    if (msg === 'CLOB market SELL response (FAK)') {
      const making = Number(j['makingAmount']);
      const taking = Number(j['takingAmount']);
      if (making > 0 && Number.isFinite(taking)) {
        pendingFak = {
          ts, tokenID: String(j['tokenID'] ?? ''),
          makingAmount: making, takingAmount: taking,
          avgPrice: taking / making,
        };
      }
      continue;
    }
    if (msg === 'OrderResolver SL live-sold' || msg === 'OrderResolver TP live-sold') {
      const reason = msg.includes('SL') ? 'sl' : 'tp';
      const orderId = String(j['id'] ?? '');
      const shares  = Number(j['shares']);
      const bid     = Number(j['bid']);
      if (pendingFak && orderId && (ts - pendingFak.ts) <= 2000) {
        pairs.push({
          orderId, reason,
          actualFillPrice: pendingFak.avgPrice,
          actualShares:    pendingFak.makingAmount,
          bidAtTrigger:    bid,
          ts,
        });
      }
      pendingFak = null;
      continue;
    }
  }

  console.log(`parsed ${pairs.length} order pairs from log`);

  // Update DB rows where the recorded exit_price differs from actual fill by ≥ 1¢.
  const pool = getPool();
  let updated = 0, skipped = 0, mismatch_total = 0;
  for (const p of pairs) {
    const { rows } = await pool.query<{
      share_price: string; size_usdc: string; exit_price: string | null;
      pnl_usdc: string | null; status: string;
    }>(
      `SELECT share_price::text, size_usdc::text, exit_price::text, pnl_usdc::text, status
         FROM poly_orders WHERE id = $1 AND side = 'buy'`,
      [p.orderId],
    );
    const r = rows[0];
    if (!r) { skipped++; continue; }
    if (r.status !== 'closed') { skipped++; continue; }
    const recorded = r.exit_price != null ? Number(r.exit_price) : NaN;
    if (!Number.isFinite(recorded)) { skipped++; continue; }
    const diff = Math.abs(p.actualFillPrice - recorded);
    if (diff < 0.01) { skipped++; continue; }   // already correct (within 1¢)

    const entry        = Number(r.share_price);
    const newExitPrice = p.actualFillPrice;
    // Recompute pnl using actual filled shares (handles partial-fill cases).
    const newPnl       = (newExitPrice - entry) * p.actualShares;
    const oldPnl       = r.pnl_usdc != null ? Number(r.pnl_usdc) : 0;
    const pnlDelta     = newPnl - oldPnl;
    mismatch_total += pnlDelta;

    await pool.query(
      `UPDATE poly_orders
          SET exit_price = $1, pnl_usdc = $2
        WHERE id = $3 AND side = 'buy'`,
      [newExitPrice, newPnl, p.orderId],
    );
    updated++;
    console.log(
      `${p.orderId} ${p.reason}  recorded=${recorded.toFixed(4)} → actual=${newExitPrice.toFixed(4)}  ` +
      `pnl: ${oldPnl.toFixed(2)} → ${newPnl.toFixed(2)}  Δ=${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(2)}`
    );
  }
  console.log('\n──── summary ────');
  console.log(`updated      : ${updated}`);
  console.log(`skipped      : ${skipped} (no match / already correct / not closed)`);
  console.log(`pnl correction: ${mismatch_total >= 0 ? '+' : ''}${mismatch_total.toFixed(2)} USDC`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
