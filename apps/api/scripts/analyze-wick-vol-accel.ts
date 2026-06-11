/**
 * Pattern discovery round 2 — wick/rejection, volume climax, body acceleration.
 * Orthogonal candle-shape signals beyond streak/ratio/magnitude/clustering.
 *
 *   rejWick  = rejection wick in the streak dir / bar range. Up-streak: a long
 *              UPPER wick (high−close) = buyers rejected = exhaustion. Down:
 *              lower wick (close−low). Big = the streak's last push got slapped.
 *   volSpike = last bar volume / 48-bar avg volume. Climax bar = blow-off top.
 *   accel    = last bar |body| / mean |body| of the streak bars. <1 = the move
 *              is DECELERATING (running out of steam) → should fade better.
 *   bigWick3 = max rejWick over the last 3 bars (rejection anywhere recent).
 *
 * Feasibility note: live bot bars carry open/close/volume but NOT high/low, so
 * wick edges would need high/low threaded into fetchBars+edgeContext; volume &
 * accel are computable from existing data.
 *
 * Entry $0.55, breakeven 55%, base $5. TRAIN/TEST 70/30. ★ = full≥55 n≥40 AND
 * OOS≥55 n≥30. Percentile buckets reveal monotonic = real (vs noise).
 *
 * Usage: tsx scripts/analyze-wick-vol-accel.ts [--interval=5m] [--days=365]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts:number; open:number; high:number; low:number; close:number; vol:number; dir:1|-1|0 }

async function fetchKlines(days:number, interval:string): Promise<Bar[]> {
  const endMs=Date.now(), startMs=endMs-days*86400_000; const all:Bar[]=[]; let cursor=startMs, pages=0;
  while(cursor<endMs){
    const url=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res=await fetch(url); if(!res.ok) throw new Error(`Binance ${res.status}`);
    const rows=(await res.json()) as unknown[][]; if(!rows.length) break;
    for(const r of rows){ const ts=Number(r[0]),o=Number(r[1]),h=Number(r[2]),l=Number(r[3]),c=Number(r[4]),v=Number(r[5]);
      all.push({ts,open:o,high:h,low:l,close:c,vol:v,dir:c>o?1:c<o?-1:0}); }
    const lastTs=Number(rows[rows.length-1]?.[0]??0); if(lastTs<=cursor) break; cursor=lastTs+1; pages++;
    if(pages%15===0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r=>setTimeout(r,75));
  }
  return all;
}

const BASE=5, ENTRY=0.55, WIN=BASE*(1-ENTRY)/ENTRY, LOSS=-BASE, BE=BASE/(BASE+WIN);

interface Trig { ts:number; streak:number; regime:1|-1; nextDir:1|-1|0;
  rejWick:number; volSpike:number; accel:number; bigWick3:number }

function wr(list:Trig[]){ const s=list.filter(t=>t.nextDir!==0); if(!s.length) return {wr:0,n:0,pnl:0};
  const w=s.filter(t=>t.nextDir!==t.regime).length; return {wr:w/s.length,n:s.length,pnl:w*WIN+(s.length-w)*LOSS}; }
function topStat(list:Trig[], key:(t:Trig)=>number, frac:number, cutTs:number){
  const sorted=[...list].sort((a,b)=>key(b)-key(a)); const top=sorted.slice(0,Math.max(1,Math.floor(sorted.length*frac)));
  return { full:wr(top), oos:wr(top.filter(t=>t.ts>=cutTs)), cut: key(sorted[Math.floor(sorted.length*frac)]??sorted[sorted.length-1]!) };
}
function rejWickOf(b:Bar, regime:1|-1):number { const range=b.high-b.low; if(range<=0) return 0;
  const w = regime===1 ? (b.high-b.close) : (b.close-b.low); return Math.max(0,w)/range; }

async function main(): Promise<void> {
  const interval=process.argv.find(a=>a.startsWith('--interval='))?.slice(11) ?? '5m';
  const days=Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? (interval==='1h'?730:365));
  console.error(`Fetching ${days}d ${interval}…`); const bars=await fetchKlines(days, interval); console.error(`${bars.length} bars\n`);

  const sl=new Array<number>(bars.length).fill(0);
  for(let i=0;i<bars.length;i++) sl[i]=bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);

  const trigs:Trig[]=[];
  for(let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<2||s>5) continue; if(sl[i-1]!==s-1) continue;
    const regime=bars[i]!.dir; if(regime===0) continue;
    const avgVol=(()=>{ let v=0; for(let j=i-48;j<i;j++) v+=bars[j]!.vol; return v/48; })();
    const streakBodies:number[]=[]; for(let j=0;j<Math.min(s,5);j++) streakBodies.push(Math.abs(bars[i-j]!.close-bars[i-j]!.open));
    const meanBody=streakBodies.reduce((a,b)=>a+b,0)/streakBodies.length;
    const lastBody=Math.abs(bars[i]!.close-bars[i]!.open);
    trigs.push({ ts:bars[i]!.ts, streak:s, regime:regime as 1|-1, nextDir:bars[i+1]!.dir,
      rejWick: rejWickOf(bars[i]!, regime as 1|-1),
      volSpike: avgVol>0?bars[i]!.vol/avgVol:0,
      accel: meanBody>0?lastBody/meanBody:1,
      bigWick3: Math.max(rejWickOf(bars[i]!,regime as 1|-1), rejWickOf(bars[i-1]!,regime as 1|-1), rejWickOf(bars[Math.max(0,i-2)]!,regime as 1|-1)),
    });
  }
  const cutTs=trigs.length?[...trigs].sort((a,b)=>a.ts-b.ts)[Math.floor(trigs.length*0.7)]!.ts:0;

  console.log(`══════════ WICK / VOLUME / ACCEL SCAN — ${interval} (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Entry $${ENTRY}, breakeven ${(BE*100).toFixed(0)}%. ★ = full≥BE n≥40 AND OOS≥BE n≥30. accel: top% = LOWEST (decelerating).\n`);

  // For accel, the hypothesis is LOW (decel) fades better → sort ascending. Others descending (more = more exhaustion).
  const measures:[string,(t:Trig)=>number,boolean][]=[
    ['rejWick', t=>t.rejWick, false], ['bigWick3', t=>t.bigWick3, false],
    ['volSpike', t=>t.volSpike, false], ['accel(low)', t=>-t.accel, false],
  ];
  const robust:string[]=[];
  for(const s of [2,3,4,5]){
    const ss=trigs.filter(t=>t.streak===s); if(ss.length<50) continue;
    const base=wr(ss);
    console.log(`── streak=${s} (baseline ${(base.wr*100).toFixed(0)}% n=${base.n}, $${(base.pnl/days).toFixed(2)}/day) ──`);
    for(const [name,key] of measures){
      const parts:string[]=[];
      for(const frac of [0.5,0.3,0.2,0.1]){
        const {full,oos,cut}=topStat(ss,key,frac,cutTs);
        const star=full.wr>=BE&&full.n>=40&&oos.wr>=BE&&oos.n>=30;
        parts.push(`t${(frac*100).toFixed(0)} ${(full.wr*100).toFixed(0)}/${(oos.wr*100).toFixed(0)}oos${star?'★':' '}`);
        if(star) robust.push(`${interval} s${s} ${name} top${(frac*100).toFixed(0)}% (≥${Math.abs(cut).toFixed(2)}): WR ${(full.wr*100).toFixed(0)}% n${full.n} $${(full.pnl/days).toFixed(2)}/d · OOS ${(oos.wr*100).toFixed(0)}%(n${oos.n})`);
      }
      console.log(`  ${name.padEnd(11)}: ${parts.join(' | ')}`);
    }
    console.log();
  }
  console.log('════════════ ★ ROBUST WICK/VOL/ACCEL EDGES ════════════');
  if(!robust.length) console.log('  (none — these candle-shape signals do not add a robust fade edge)');
  else robust.forEach(r=>console.log('  '+r));
}
main().catch(e=>{ console.error(e); process.exit(1); });
