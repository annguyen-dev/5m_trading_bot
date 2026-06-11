/**
 * Does UTC hour-of-day add on top of the edge filters? Crypto sessions differ
 * (Asia calm / EU+US active) — fades might work better in ranging hours. But
 * hour-range is an overfit magnet, so: coarse blocks only (3×8h sessions + 6×4h),
 * OOS-validated, and we trust only LARGE + CONTIGUOUS + OOS-holding effects.
 *
 * Tests the live edges by hour:
 *   5m streak=3 + momentum≥0.38%   (the flagship)
 *   1h streak=4 + cumMove≥1.85%
 * plus the raw per-streak fade for context.
 *
 * Entry $0.55, breakeven 55%, base $5. TRAIN/TEST 70/30.
 *
 * Usage: tsx scripts/analyze-hour-range.ts [--interval=5m] [--days=365]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts:number; open:number; close:number; vol:number; dir:1|-1|0 }
async function fetchKlines(days:number, interval:string): Promise<Bar[]> {
  const endMs=Date.now(), startMs=endMs-days*86400_000; const all:Bar[]=[]; let cursor=startMs, pages=0;
  while(cursor<endMs){
    const url=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res=await fetch(url); if(!res.ok) throw new Error(`Binance ${res.status}`);
    const rows=(await res.json()) as unknown[][]; if(!rows.length) break;
    for(const r of rows){ const ts=Number(r[0]),o=Number(r[1]),c=Number(r[4]),v=Number(r[5]); all.push({ts,open:o,close:c,vol:v,dir:c>o?1:c<o?-1:0}); }
    const lastTs=Number(rows[rows.length-1]?.[0]??0); if(lastTs<=cursor) break; cursor=lastTs+1; pages++;
    if(pages%15===0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r=>setTimeout(r,75));
  }
  return all;
}
const BASE=5, ENTRY=0.55, WIN=BASE*(1-ENTRY)/ENTRY, LOSS=-BASE, BE=BASE/(BASE+WIN);
// hour-of-day from epoch ms without Date(): ms→s→ (s/3600 mod 24)
const hourOf=(ts:number)=> Math.floor(ts/3600_000) % 24;
interface Trig { ts:number; hour:number; streak:number; regime:1|-1; nextDir:1|-1|0; mom:number; cum:number; ratio:number }
function wr(l:Trig[]){ const s=l.filter(t=>t.nextDir!==0); if(!s.length) return {wr:0,n:0,pnl:0};
  const w=s.filter(t=>t.nextDir!==t.regime).length; return {wr:w/s.length,n:s.length,pnl:w*WIN+(s.length-w)*LOSS}; }

async function main(): Promise<void> {
  const interval=process.argv.find(a=>a.startsWith('--interval='))?.slice(11) ?? '5m';
  const days=Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? (interval==='1h'?730:365));
  const W1=interval==='1h'?1:12;
  console.error(`Fetching ${days}d ${interval}…`); const bars=await fetchKlines(days, interval); console.error(`${bars.length} bars\n`);
  const sl=new Array<number>(bars.length).fill(0);
  for(let i=0;i<bars.length;i++) sl[i]=bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);
  const trigs:Trig[]=[];
  for(let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<2||s>7) continue; if(sl[i-1]!==s-1) continue;
    const regime=bars[i]!.dir; if(regime===0) continue;
    const runStart=i-s+1;
    const mom=bars[i-W1]!.close>0?(bars[i]!.close-bars[i-W1]!.close)/bars[i-W1]!.close*100*regime:0;
    const cum=bars[runStart]!.open>0?(bars[i]!.close-bars[runStart]!.open)/bars[runStart]!.open*100*regime:0;
    let b3=0; for(let j=0;j<Math.min(3,s);j++) b3+=Math.abs(bars[i-j]!.close-bars[i-j]!.open);
    let sb=0; for(let j=i-48;j<i;j++) sb+=Math.abs(bars[j]!.close-bars[j]!.open); const avg=sb/48;
    trigs.push({ ts:bars[i]!.ts, hour:hourOf(bars[i]!.ts), streak:s, regime:regime as 1|-1, nextDir:bars[i+1]!.dir, mom, cum, ratio: avg>0?b3/(avg*3):0 });
  }
  const cutTs=trigs.length?[...trigs].sort((a,b)=>a.ts-b.ts)[Math.floor(trigs.length*0.7)]!.ts:0;
  const oos=(l:Trig[])=>l.filter(t=>t.ts>=cutTs);

  console.log(`══════════ HOUR-RANGE × EDGE — ${interval} (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Entry $${ENTRY}, breakeven ${(BE*100).toFixed(0)}%. ⚠ overfit-prone — trust only large+contiguous+OOS-holding.\n`);

  function byHour(label:string, sub:Trig[]): void {
    const base=wr(sub), bOos=wr(oos(sub));
    console.log(`── ${label} · all hours: ${(base.wr*100).toFixed(0)}% n${base.n} · OOS ${(bOos.wr*100).toFixed(0)}%(n${bOos.n}) ──`);
    const sess:[string,(h:number)=>boolean][]=[['Asia 00-08',h=>h<8],['EU 08-16',h=>h>=8&&h<16],['US 16-24',h=>h>=16]];
    for(const [sn,f] of sess){ const g=sub.filter(t=>f(t.hour)); const w=wr(g), o=wr(oos(g));
      const d=w.wr-base.wr; console.log(`   ${sn.padEnd(11)}: ${(w.wr*100).toFixed(0)}% n${String(w.n).padStart(4)} · OOS ${(o.wr*100).toFixed(0)}%(n${o.n}) · vs all ${d>=0?'+':''}${(d*100).toFixed(0)}pp`); }
    const blk:string[]=[];
    for(let b=0;b<6;b++){ const g=sub.filter(t=>Math.floor(t.hour/4)===b); if(g.length<20){ blk.push(`${b*4}-${b*4+4}:n/a`); continue; }
      const w=wr(g), o=wr(oos(g)); blk.push(`${String(b*4).padStart(2)}-${b*4+4} ${(w.wr*100).toFixed(0)}/${(o.wr*100).toFixed(0)}o`); }
    console.log(`   4h blocks (full/OOS): ${blk.join(' | ')}`);
    console.log();
  }

  // context: raw fade by streak (3-7 combined) — does time matter at all?
  byHour('raw fade s3-7', trigs.filter(t=>t.streak>=3&&t.streak<=7));
  if(interval==='5m'){
    byHour('LIVE 5m s3 + mom≥0.38', trigs.filter(t=>t.streak===3&&t.mom>=0.38));
    byHour('5m s3 + ratio≥1.2',     trigs.filter(t=>t.streak===3&&t.ratio>=1.2));
  } else {
    byHour('LIVE 1h s4 + cum≥1.85', trigs.filter(t=>t.streak===4&&t.cum>=1.85));
    byHour('1h s2 + cum≥0.90',      trigs.filter(t=>t.streak===2&&t.cum>=0.90));
  }
  console.log('Đọc: nếu vs-all nhỏ (±1-2pp) và OOS lung tung → hour-range KHÔNG add. Cần 1 block/session lệch LỚN + OOS giữ + liền mạch mới đáng.');
}
main().catch(e=>{ console.error(e); process.exit(1); });
