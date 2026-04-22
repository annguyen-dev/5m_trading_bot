import { getPool } from './src/db/client.js';

async function main() {
  const pool = getPool();

  // Inspect kb_snapshots ts range
  const r = await pool.query<{ min_ts: string; max_ts: string; cnt: string }>(
    `SELECT MIN(ts)::text AS min_ts, MAX(ts)::text AS max_ts, COUNT(*)::text AS cnt FROM kb_snapshots`,
  );
  console.log('kb_snapshots:', r.rows[0]);
  const minMs = Number(r.rows[0]!.min_ts);
  const maxMs = Number(r.rows[0]!.max_ts);
  console.log('min ts:', new Date(minMs).toISOString());
  console.log('max ts:', new Date(maxMs).toISOString());

  // Overall |streak_5m| distribution
  const levels = await pool.query<{ level: string; cnt: string }>(
    `SELECT ABS(streak_5m)::text AS level, COUNT(*) AS cnt
     FROM kb_snapshots GROUP BY ABS(streak_5m) ORDER BY ABS(streak_5m)`,
  );
  console.log('\n── kb_snapshots |streak_5m| distribution (ALL data) ──');
  for (const x of levels.rows) console.log(`|s5m|=${x.level.padStart(2)}  rows=${x.cnt}`);

  // New-level events over all data
  const events = await pool.query<{ level: string; events: string }>(
    `WITH w AS (
       SELECT ts, streak_5m, LAG(streak_5m) OVER (ORDER BY ts) AS prev
       FROM kb_snapshots
     )
     SELECT ABS(streak_5m)::text AS level, COUNT(*) AS events
     FROM w
     WHERE ABS(streak_5m) >= 3
       AND (prev IS NULL OR ABS(streak_5m) > ABS(prev) OR SIGN(streak_5m) <> SIGN(prev))
     GROUP BY ABS(streak_5m) ORDER BY ABS(streak_5m)`,
  );
  const daysOfData = (maxMs - minMs) / 86_400_000;
  console.log(`\n── New-level events across ${daysOfData.toFixed(1)} days ──`);
  let total = 0;
  for (const x of events.rows) {
    console.log(`|s5m|=${x.level.padStart(2)}  events=${x.events}  (${(Number(x.events)/daysOfData).toFixed(1)}/day)`);
    total += Number(x.events);
  }
  console.log(`TOTAL=${total}  (${(total/daysOfData).toFixed(1)}/day)`);

  // ohlcv_1m range to see what BacktestEngine sees
  const o = await pool.query<{ min_ts: string; max_ts: string; cnt: string }>(
    `SELECT MIN(ts)::text AS min_ts, MAX(ts)::text AS max_ts, COUNT(*)::text AS cnt
     FROM ohlcv_1m WHERE symbol = 'BTC/USDT'`,
  );
  console.log('\nohlcv_1m:', o.rows[0]);
  console.log('min:', new Date(Number(o.rows[0]!.min_ts)).toISOString());
  console.log('max:', new Date(Number(o.rows[0]!.max_ts)).toISOString());

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
