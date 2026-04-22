import { getPool } from './src/db/client.js';

async function main() {
  const pool = getPool();

  // Latest backtest run window
  const run = await pool.query<{ id: string; from_ts: string; to_ts: string }>(
    `SELECT id, from_ts::text, to_ts::text FROM backtest_runs ORDER BY created_at DESC LIMIT 1`,
  );
  if (!run.rows[0]) { console.log('no runs'); await pool.end(); return; }
  const { id, from_ts, to_ts } = run.rows[0];
  const fromMs = Number(from_ts), toMs = Number(to_ts);
  console.log('run', id, new Date(fromMs).toISOString(), '→', new Date(toMs).toISOString());

  // Compute streak_5m live from ohlcv_1m grouped by 5m bars (positional groups)
  const rows = await pool.query<{ ts: string; o: string; c: string }>(
    `SELECT ts::text, open::text o, close::text c FROM ohlcv_1m
     WHERE symbol='BTC/USDT' AND ts >= $1 AND ts <= $2 ORDER BY ts`,
    [fromMs, toMs],
  );
  console.log('candles:', rows.rows.length);

  // Group into 5m bars (only complete ones)
  const bars: { open: number; close: number }[] = [];
  for (let i = 0; i + 5 <= rows.rows.length; i += 5) {
    const g = rows.rows.slice(i, i + 5);
    bars.push({ open: Number(g[0]!.o), close: Number(g[4]!.c) });
  }
  console.log('5m bars:', bars.length);

  // Walk streak
  let streak = 0;
  const levelEvents: Record<number, number> = {};
  let prevDir = 0;
  for (const b of bars) {
    const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
    if (dir === 0) continue;
    if (dir === prevDir) streak += dir;
    else streak = dir;
    prevDir = dir;
    const abs = Math.abs(streak);
    if (abs >= 3) levelEvents[abs] = (levelEvents[abs] ?? 0) + 1;
  }
  console.log('\n── expected fires (new-level events, walking 5m bars) ──');
  let total = 0;
  for (const lvl of Object.keys(levelEvents).map(Number).sort((a,b)=>a-b)) {
    console.log(`|s5m|=${lvl}  events=${levelEvents[lvl]}`);
    total += levelEvents[lvl]!;
  }
  console.log('TOTAL expected:', total);

  // Actual signals in this run
  const sig = await pool.query<{ level: string; cnt: string }>(
    `SELECT (regexp_match(rationale, 's5m=(-?\\d+)'))[1] AS level, COUNT(*) cnt
     FROM signals WHERE run_id=$1 AND rationale LIKE '%s5m=%'
     GROUP BY 1 ORDER BY 1`,
    [id],
  );
  console.log('\n── actual signals ──');
  let sigTotal = 0;
  for (const r of sig.rows) { console.log(`s5m=${r.level}  cnt=${r.cnt}`); sigTotal += Number(r.cnt); }
  console.log('TOTAL signals:', sigTotal);

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
