/**
 * Does STREAK FREQUENCY predict fade WR? (user idea: too many streak-3 today →
 * disable; rare streak-2 + a signal → tradeable.) Both = "streak frequency as a
 * regime detector": few streaks = ranging = fade better; many = trending = worse.
 *
 * Caveats this tests for:
 *   - Redundancy with ratio: frequency ≈ volatility, which body3/avgBody already
 *     normalizes. We bucket the ALREADY-FILTERED edge subset to see if frequency
 *     adds anything beyond the existing gate.
 *   - Rolling window (last 24h), NOT calendar day (no arbitrary 00:00 reset).
 *
 * recentCount(i) = # of same-streak first-hits in the prior `--win` hours.
 * Buckets = terciles (low/mid/high frequency). If WR falls monotonically as
 * frequency rises → the idea works (and we'd gate on it).
 *
 * Entry $0.55, breakeven 55%, base $5. TRAIN/TEST 70/30.
 * Usage: tsx scripts/analyze-streak-frequency.ts [--interval=5m] [--days=365] [--win=24]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts:number; open:number; close:number; dir:1|-1|0 }
async function fetchKlines(days:number, interval:string): Promise<Bar[]> {
  const endMs=Date.now(), startMs=endMs-days*86400_000; const all:Bar[]=[]; let cursor=startMs, pages=0;
  while(cursor<endMs){
    const url=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res=await fetch(url); if(!res.ok) throw new Error(`Binance ${res.status}`);
    const rows=(await res.json()) as unknown[][]; if(!rows.length) break;
    for(const r of rows){ const ts=Number(r[0]),o=Number(r[1]),c=Number(r[4]); all.push({ts,open:o,close:c,dir:c>o?1:c<o?-1:0}); }
    const lastTs=Number(rows[rows.length-1]?.[0]??0); if(lastTs<=cursor) break; cursor=lastTs+1; pages++;
    if(pages%15===0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r=>setTimeout(r,75));
  }
  return all;
}
const BASE=5, ENTRY=0.55, WIN=BASE*(1-ENTRY)/ENTRY, LOSS=-BASE, BE=BASE/(BASE+WIN);
interface Trig { ts:number; streak:number; regime:1|-1; nextDir:1|-1|0; mom:number; cum:number; ratio:number; recent:number }
function wr(l:Trig[]){ const s=l.filter(t=>t.nextDir!==0); if(!s.length) return {wr:0,n:0,pnl:0};
  const w=s.filter(t=>t.nextDir!==t.regime).length; return {wr:w/s.length,n:s.length,pnl:w*WIN+(s.length-w)*LOSS}; }

async function main(): Promise<void> {
  const interval=process.argv.find(a=>a.startsWith('--interval='))?.slice(11) ?? '5m';
  const days=Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? (interval==='1h'?730:365));
  const winH=Number(process.argv.find(a=>a.startsWith('--win='))?.slice(6) ?? 24);
  const W1=interval==='1h'?1:12;
  console.error(`Fetching ${days}d ${interval}…`); const bars=await fetchKlines(days, interval); console.error(`${bars.length} bars\n`);
  const sl=new Array<number>(bars.length).fill(0);
  for(let i=0;i<bars.length;i++) sl[i]=bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);
  const all:Trig[]=[];
  for(let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<2||s>5) continue; if(sl[i-1]!==s-1) continue;
    const regime=bars[i]!.dir; if(regime===0) continue;
    const runStart=i-s+1;
    const mom=bars[i-W1]!.close>0?(bars[i]!.close-bars[i-W1]!.close)/bars[i-W1]!.close*100*regime:0;
    const cum=bars[runStart]!.open>0?(bars[i]!.close-bars[runStart]!.open)/bars[runStart]!.open*100*regime:0;
    let b3=0; for(let j=0;j<Math.min(3,s);j++) b3+=Math.abs(bars[i-j]!.close-bars[i-j]!.open);
    let sb=0; for(let j=i-48;j<i;j++) sb+=Math.abs(bars[j]!.close-bars[j]!.open); const avg=sb/48;
    all.push({ ts:bars[i]!.ts, streak:s, regime:regime as 1|-1, nextDir:bars[i+1]!.dir, mom, cum, ratio: avg>0?b3/(avg*3):0, recent:0 });
  }
  // recentCount per streak via sliding window over same-streak triggers
  const winMs=winH*3600_000;
  for(let s=2;s<=5;s++){
    const grp=all.filter(t=>t.streak===s).sort((a,b)=>a.ts-b.ts);
    let lo=0;
    for(let k=0;k<grp.length;k++){ while(grp[lo]!.ts < grp[k]!.ts-winMs) lo++; grp[k]!.recent = k-lo; }
  }
  const cutTs=all.length?[...all].sort((a,b)=>a.ts-b.ts)[Math.floor(all.length*0.7)]!.ts:0;
  const oos=(l:Trig[])=>l.filter(t=>t.ts>=cutTs);

  console.log(`══════════ STREAK FREQUENCY × WR — ${interval} (${days}d, rolling ${winH}h window) ══════════`);
  console.log(`Bucket each subset into terciles by recentCount (prior same-streak hits in ${winH}h). Idea works if WR falls as freq rises.\n`);

  function terciles(label:string, sub:Trig[]): void {
    if(sub.length<60){ console.log(`── ${label}: n=${sub.length} too few ──\n`); return; }
    const sorted=[...sub].sort((a,b)=>a.recent-b.recent);
    const t=Math.floor(sorted.length/3);
    const lo=sorted.slice(0,t), mid=sorted.slice(t,2*t), hi=sorted.slice(2*t);
    const base=wr(sub);
    console.log(`── ${label} · all: ${(base.wr*100).toFixed(0)}% n${base.n} · OOS ${(wr(oos(sub)).wr*100).toFixed(0)}% ──`);
    for(const [nm,g] of [['LOW freq (rare)',lo],['MID',mid],['HIGH freq (saturated)',hi]] as [string,Trig[]][]){
      const w=wr(g), o=wr(oos(g));
      const rng=`recent ${g[0]!.recent}-${g[g.length-1]!.recent}`;
      console.log(`   ${nm.padEnd(22)} [${rng.padEnd(12)}]: ${(w.wr*100).toFixed(0)}% n${String(w.n).padStart(4)} $${(w.pnl/days).toFixed(2)}/d · OOS ${(o.wr*100).toFixed(0)}%(n${o.n})`);
    }
    console.log();
  }

  for(const s of [2,3,4]){
    terciles(`streak=${s} RAW`, all.filter(t=>t.streak===s));
  }
  // does frequency add ON TOP of the live filter?
  if(interval==='5m') terciles('streak=3 + mom≥0.38 (LIVE edge)', all.filter(t=>t.streak===3&&t.mom>=0.38));
  else { terciles('streak=4 + cum≥1.85 (LIVE)', all.filter(t=>t.streak===4&&t.cum>=1.85));
         terciles('streak=2 + cum≥0.90 (LIVE)', all.filter(t=>t.streak===2&&t.cum>=0.90)); }

  console.log('Đọc: WR phải GIẢM rõ từ LOW→HIGH (và OOS giữ) thì frequency mới là tín hiệu. Nếu 3 tercile ~bằng nhau → redundant với ratio/đã có filter.');
}
main().catch(e=>{ console.error(e); process.exit(1); });
