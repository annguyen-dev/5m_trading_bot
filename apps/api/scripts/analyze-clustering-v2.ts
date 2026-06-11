/**
 * Streak-clustering edge discovery v2 — broaden the streak=4+prior≥5 finding.
 *
 * v1 found: streak=4 + a prior same-dir peak≥5 within 30-60m fades at ~58%
 * (OOS 61%), and it's the ONLY robust way to trade streak=4 (plain ratio gate
 * fails OOS). This script hunts MORE clustering edges along 4 new axes:
 *
 *   A. clustering + ratio   — does body3/avgBody ratio stack on top of priming?
 *   B. opposite-dir priming — prior DOWN streak → fade UP (whipsaw regime)
 *   C. double clustering    — ≥2 prior peaks≥K (stronger exhaustion signal)
 *   D. streak=3 clustering  — high-volume; even a small edge = many trades
 *
 * Entry $0.55 flat (conservative — real fade entry is cheaper), base $5.
 * WIN +$4.09, LOSS -$5, breakeven 55%. TRAIN/TEST 70/30 OOS. To curb the
 * multiple-comparisons trap (many combos scanned), a row is ★ ROBUST only if:
 *   full WR≥55, n≥40, OOS WR≥55, OOS n≥30, AND OOS beats raw-streak by ≥2pp.
 *
 * Usage: tsx scripts/analyze-clustering-v2.ts [--days=365]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs, pages = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url); if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = (await res.json()) as unknown[][]; if (!rows.length) break;
    for (const r of rows) { const ts=Number(r[0]),o=Number(r[1]),c=Number(r[4]); all.push({ ts, open:o, close:c, body:c-o, dir: c>o?1:c<o?-1:0 }); }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0); if (lastTs<=cursor) break; cursor=lastTs+1; pages++;
    if (pages%15===0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r=>setTimeout(r,75));
  }
  return all;
}

const BASE=5, ENTRY=0.55, WIN=BASE*(1-ENTRY)/ENTRY, LOSS=-BASE, BE=BASE/(BASE+WIN);

interface PriorPeak { streak: number; dir: 1|-1; barsBefore: number }
interface Trig { ts:number; i:number; streak:number; regime:1|-1; ratio:number; nextDir:1|-1|0; priors: PriorPeak[] }

function stat(list: Trig[]): { wr:number; pnl:number; n:number } {
  const sub = list.filter(t => t.nextDir !== 0);
  if (!sub.length) return { wr:0, pnl:0, n:0 };
  const w = sub.filter(t => t.nextDir !== t.regime).length;
  return { wr: w/sub.length, n: sub.length, pnl: w*WIN + (sub.length-w)*LOSS };
}

async function main(): Promise<void> {
  const days = Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? 365);
  console.error(`Fetching ${days}d 5m…`); const bars = await fetchKlines(days); console.error(`${bars.length} bars\n`);

  const sl = new Array<number>(bars.length).fill(0);
  for (let i=0;i<bars.length;i++) sl[i] = bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);

  interface Peak { i:number; ts:number; streak:number; dir:1|-1 }
  const peaks: Peak[] = [];
  for (let i=0;i<bars.length;i++){ if(bars[i]!.dir===0)continue; if(i+1>=bars.length||bars[i+1]!.dir!==bars[i]!.dir) peaks.push({i,ts:bars[i]!.ts,streak:sl[i]!,dir:bars[i]!.dir as 1|-1}); }

  const ratioAt=(i:number,s:number):number=>{ let b3=0;for(let j=0;j<Math.min(3,s);j++)b3+=Math.abs(bars[i-j]!.body); let sb=0;for(let j=i-48;j<i;j++)sb+=Math.abs(bars[j]!.body); const a=sb/48; return a>0?b3/(a*3):0; };

  const MAXW = 24; // 120m max lookback; per-combo windows filter via barsBefore
  const trigs: Trig[] = [];
  let pkPtr = 0;
  for (let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<3||s>7)continue; if(sl[i-1]!==s-1)continue;
    const regime=bars[i]!.dir; if(regime===0)continue;
    const runStart=i-s+1; const runStartTs=bars[runStart]!.ts; const winStartTs=runStartTs-MAXW*5*60_000;
    const priors:PriorPeak[]=[];
    for(const p of peaks){ if(p.ts>=runStartTs)break; if(p.ts<winStartTs)continue; if(p.i>=runStart)continue; priors.push({streak:p.streak,dir:p.dir,barsBefore:Math.round((runStartTs-p.ts)/(5*60_000))}); }
    trigs.push({ts:bars[i]!.ts,i,streak:s,regime:regime as 1|-1,ratio:ratioAt(i,s),nextDir:bars[i+1]!.dir,priors});
  }
  void pkPtr;

  const cutTs = trigs.length ? [...trigs].sort((a,b)=>a.ts-b.ts)[Math.floor(trigs.length*0.7)]!.ts : 0;

  console.log(`══════════ CLUSTERING EDGE DISCOVERY v2 — 5m (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Entry $${ENTRY}, breakeven ${(BE*100).toFixed(0)}%. ★ = full WR≥55 n≥40 AND OOS WR≥55 n≥30 AND OOS≥raw+2pp.\n`);

  // raw per-streak baselines (for lift)
  const raw: Record<number,{wr:number;oos:number}> = {};
  for (let s=3;s<=7;s++){ const all=stat(trigs.filter(t=>t.streak===s)); const oo=stat(trigs.filter(t=>t.streak===s&&t.ts>=cutTs)); raw[s]={wr:all.wr,oos:oo.wr}; }

  const robust: string[] = [];
  function evalSet(label: string, sub: Trig[], rawStreak: number): void {
    const full=stat(sub); if(full.n<20)return;
    const oos=stat(sub.filter(t=>t.ts>=cutTs));
    const liftFull=full.wr-raw[rawStreak]!.wr, liftOos=oos.wr-raw[rawStreak]!.oos;
    const star = full.wr>=BE && full.n>=40 && oos.wr>=BE && oos.n>=30 && liftOos>=0.02;
    const tag = star?'★ ROBUST':full.wr>=BE&&oos.wr>=BE?'  ok':'  no';
    console.log(`  ${label.padEnd(46)} | ${(full.wr*100).toFixed(0)}% n${String(full.n).padStart(4)} $${(full.pnl/days).toFixed(2).padStart(5)} | OOS ${(oos.wr*100).toFixed(0)}% n${String(oos.n).padStart(3)} | raw ${(raw[rawStreak]!.wr*100).toFixed(0)}%→ ${liftOos>=0?'+':''}${(liftOos*100).toFixed(0)}pp | ${tag}`);
    if(star) robust.push(`${label}: WR ${(full.wr*100).toFixed(0)}% n${full.n} $${(full.pnl/days).toFixed(2)}/d · OOS ${(oos.wr*100).toFixed(0)}%(n${oos.n}) · +${(liftOos*100).toFixed(0)}pp`);
  }
  const hasPrior=(t:Trig,K:number,W:number,dir:'same'|'opp'|'any'):boolean=>t.priors.some(p=>p.barsBefore<=W&&p.streak>=K&&(dir==='same'?p.dir===t.regime:dir==='opp'?p.dir!==t.regime:true));
  const countPrior=(t:Trig,K:number,W:number):number=>t.priors.filter(p=>p.barsBefore<=W&&p.streak>=K&&p.dir===t.regime).length;

  console.log('── A. CLUSTERING + RATIO (does ratio stack on priming?) ──');
  console.log(`  ${'set'.padEnd(46)} | FULL WR/n/\$d        | OOS WR/n  | vs raw      | verdict`);
  for(const trig of [3,4,5]) for(const W of [6,12]) for(const K of [5,6]) for(const rmin of [0,1.0,1.2]){
    const sub=trigs.filter(t=>t.streak===trig&&hasPrior(t,K,W,'same')&&t.ratio>=rmin);
    evalSet(`s${trig} prior≥${K}/${W*5}m${rmin?` ratio≥${rmin}`:''}`, sub, trig);
  }
  console.log();

  console.log('── B. OPPOSITE-DIR priming (prior opposite streak → fade) ──');
  for(const trig of [3,4,5]) for(const W of [6,12]) for(const K of [5,6]){
    evalSet(`s${trig} OPP-prior≥${K}/${W*5}m`, trigs.filter(t=>t.streak===trig&&hasPrior(t,K,W,'opp')), trig);
  }
  console.log();

  console.log('── C. DOUBLE clustering (≥2 prior same-dir peaks≥K) ──');
  for(const trig of [3,4,5]) for(const W of [12,24]) for(const K of [4,5]){
    evalSet(`s${trig} ≥2×prior≥${K}/${W*5}m`, trigs.filter(t=>t.streak===trig&&countPrior(t,K,W)>=2), trig);
  }
  console.log();

  console.log('── D. streak=3 clustering (+ratio), high-volume ──');
  for(const W of [6,12]) for(const K of [5,6,7]) for(const rmin of [0,1.2,1.5]){
    evalSet(`s3 prior≥${K}/${W*5}m${rmin?` ratio≥${rmin}`:''}`, trigs.filter(t=>t.streak===3&&hasPrior(t,K,W,'same')&&t.ratio>=rmin), 3);
  }
  console.log();

  console.log('════════════ ★ ROBUST CLUSTERING EDGES ════════════');
  if(!robust.length) console.log('  (none beyond v1 — clustering edge is narrow)');
  else robust.forEach(r=>console.log('  '+r));
}

main().catch(e=>{ console.error(e); process.exit(1); });
