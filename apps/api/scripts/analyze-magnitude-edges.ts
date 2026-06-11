/**
 * Magnitude / over-extension edge discovery — "đã tăng bao nhiêu thì fade tốt".
 *
 * Beyond streak-length and body3-ratio, test whether the SIZE of the move makes
 * a low streak (≥2) fadeable. Measures (all signed in the streak direction, so
 * bigger = more stretched the way we'd fade):
 *   cumMove   = % move over the streak bars        (how far this run pushed)
 *   mom1h     = % change over last 12 bars (5m)     (recent momentum)
 *   mom4h     = % change over last 48 bars          (medium momentum)
 *   distSMA   = (close - SMA48)/SMA48               (over-extension from mean)
 *   ratio     = body3/(avgBody×3)                   (local impulse — existing gate)
 *
 * Hypothesis tension: more stretched → exhaustion (fade better) VS stronger
 * trend (fade worse). Only data decides, per streak.
 *
 * Method: per (streak, measure) bucket triggers by percentile of the measure
 * (top 50/30/20/10% = most stretched) and report fade WR + OOS. Then combos
 * (most-stretched + ratio). Entry $0.55, breakeven 55%, base $5. TRAIN/TEST 70/30.
 *
 * Usage: tsx scripts/analyze-magnitude-edges.ts [--interval=5m] [--days=365]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts:number; open:number; close:number; body:number; dir:1|-1|0 }

async function fetchKlines(days:number, interval:string): Promise<Bar[]> {
  const endMs=Date.now(), startMs=endMs-days*86400_000; const all:Bar[]=[]; let cursor=startMs, pages=0;
  while(cursor<endMs){
    const url=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res=await fetch(url); if(!res.ok) throw new Error(`Binance ${res.status}`);
    const rows=(await res.json()) as unknown[][]; if(!rows.length) break;
    for(const r of rows){ const ts=Number(r[0]),o=Number(r[1]),c=Number(r[4]); all.push({ts,open:o,close:c,body:c-o,dir:c>o?1:c<o?-1:0}); }
    const lastTs=Number(rows[rows.length-1]?.[0]??0); if(lastTs<=cursor) break; cursor=lastTs+1; pages++;
    if(pages%15===0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r=>setTimeout(r,75));
  }
  return all;
}

const BASE=5, ENTRY=0.55, WIN=BASE*(1-ENTRY)/ENTRY, LOSS=-BASE, BE=BASE/(BASE+WIN);

interface Trig { ts:number; streak:number; regime:1|-1; nextDir:1|-1|0;
  cumMove:number; mom1h:number; mom4h:number; distSMA:number; ratio:number }

function wr(list:Trig[]): {wr:number;n:number;pnl:number} {
  const s=list.filter(t=>t.nextDir!==0); if(!s.length) return {wr:0,n:0,pnl:0};
  const w=s.filter(t=>t.nextDir!==t.regime).length; return {wr:w/s.length,n:s.length,pnl:w*WIN+(s.length-w)*LOSS};
}
// top fraction by a measure (descending) → WR + OOS
function topStat(list:Trig[], key:(t:Trig)=>number, frac:number, cutTs:number): {full:{wr:number;n:number;pnl:number};oos:{wr:number;n:number}} {
  const sorted=[...list].sort((a,b)=>key(b)-key(a));
  const top=sorted.slice(0, Math.max(1, Math.floor(sorted.length*frac)));
  return { full: wr(top), oos: wr(top.filter(t=>t.ts>=cutTs)) };
}

async function main(): Promise<void> {
  const interval=process.argv.find(a=>a.startsWith('--interval='))?.slice(11) ?? '5m';
  const days=Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? (interval==='1h'?730:365));
  const W1=interval==='1h'?1:12, W4=interval==='1h'?4:48;   // "1h" & "4h" in bars
  console.error(`Fetching ${days}d ${interval}…`); const bars=await fetchKlines(days, interval); console.error(`${bars.length} bars\n`);

  const sl=new Array<number>(bars.length).fill(0);
  for(let i=0;i<bars.length;i++) sl[i]=bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);
  const sma=new Array<number>(bars.length).fill(0);
  for(let i=48;i<bars.length;i++){ let s=0; for(let j=i-48;j<i;j++) s+=bars[j]!.close; sma[i]=s/48; }

  const trigs:Trig[]=[];
  for(let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<2||s>5) continue; if(sl[i-1]!==s-1) continue;
    const regime=bars[i]!.dir; if(regime===0) continue;
    const runStart=i-s+1;
    const cumMove=(bars[i]!.close-bars[runStart]!.open)/bars[runStart]!.open*100*regime;
    const mom1h=(bars[i]!.close-bars[i-W1]!.close)/bars[i-W1]!.close*100*regime;
    const mom4h=(bars[i]!.close-bars[i-W4]!.close)/bars[i-W4]!.close*100*regime;
    const distSMA=sma[i]!>0?(bars[i]!.close-sma[i]!)/sma[i]!*100*regime:0;
    let b3=0; for(let j=0;j<Math.min(3,s);j++) b3+=Math.abs(bars[i-j]!.body);
    let sb=0; for(let j=i-48;j<i;j++) sb+=Math.abs(bars[j]!.body); const avg=sb/48;
    trigs.push({ ts:bars[i]!.ts, streak:s, regime:regime as 1|-1, nextDir:bars[i+1]!.dir,
      cumMove, mom1h, mom4h, distSMA, ratio: avg>0?b3/(avg*3):0 });
  }
  const cutTs=trigs.length?[...trigs].sort((a,b)=>a.ts-b.ts)[Math.floor(trigs.length*0.7)]!.ts:0;

  console.log(`══════════ MAGNITUDE / OVER-EXTENSION EDGE SCAN — ${interval} (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Entry $${ENTRY}, breakeven ${(BE*100).toFixed(0)}%. "top X%" = most stretched in fade direction. ★ = full≥BE n≥40 AND OOS≥BE n≥30.\n`);

  const measures:[string,(t:Trig)=>number][]=[['cumMove',t=>t.cumMove],['mom1h',t=>t.mom1h],['mom4h',t=>t.mom4h],['distSMA',t=>t.distSMA],['ratio',t=>t.ratio]];
  const robust:string[]=[];
  for(const s of [2,3,4,5]){
    const ss=trigs.filter(t=>t.streak===s); if(ss.length<50) continue;
    const base=wr(ss);
    console.log(`── streak=${s} (baseline fade WR ${(base.wr*100).toFixed(0)}% n=${base.n}, $${(base.pnl/days).toFixed(2)}/day) ──`);
    for(const [name,key] of measures){
      const parts:string[]=[];
      const sortedDesc=[...ss].sort((a,b)=>key(b)-key(a));
      for(const frac of [0.5,0.3,0.2,0.1]){
        const {full,oos}=topStat(ss,key,frac,cutTs);
        const star=full.wr>=BE&&full.n>=40&&oos.wr>=BE&&oos.n>=30;
        parts.push(`t${(frac*100).toFixed(0)} ${(full.wr*100).toFixed(0)}%/${(oos.wr*100).toFixed(0)}oos${star?'★':' '}`);
        if(star) robust.push(`${interval} s${s} ${name} top${(frac*100).toFixed(0)}%: WR ${(full.wr*100).toFixed(0)}% n${full.n} $${(full.pnl/days).toFixed(2)}/d · OOS ${(oos.wr*100).toFixed(0)}%(n${oos.n})`);
      }
      // concrete cutoffs (value at the top20% / top10% boundary) for implementation
      const c20=sortedDesc[Math.floor(sortedDesc.length*0.2)], c10=sortedDesc[Math.floor(sortedDesc.length*0.1)];
      const unit=name==='ratio'?'':'%';
      console.log(`  ${name.padEnd(8)}: ${parts.join(' | ')}  ⟶ cutoff t20≥${key(c20!).toFixed(2)}${unit} t10≥${key(c10!).toFixed(2)}${unit}`);
    }
    // combo: most-stretched (top30% cumMove or distSMA) + ratio≥1.0
    for(const [mn,key] of [['cumMove',(t:Trig)=>t.cumMove] as [string,(t:Trig)=>number],['distSMA',(t:Trig)=>t.distSMA]]){
      const sorted=[...ss].sort((a,b)=>key(b)-key(a)); const top=sorted.slice(0,Math.floor(sorted.length*0.3));
      for(const rmin of [1.0,1.2]){
        const sub=top.filter(t=>t.ratio>=rmin); const f=wr(sub); const o=wr(sub.filter(t=>t.ts>=cutTs));
        if(f.n<40) continue;
        const star=f.wr>=BE&&o.wr>=BE&&o.n>=30;
        console.log(`  COMBO top30%${mn}+ratio≥${rmin}: ${(f.wr*100).toFixed(0)}% n${f.n} $${(f.pnl/days).toFixed(2)}/d · OOS ${(o.wr*100).toFixed(0)}%(n${o.n})${star?' ★':''}`);
        if(star) robust.push(`${interval} s${s} top30%${mn}+ratio≥${rmin}: WR ${(f.wr*100).toFixed(0)}% n${f.n} $${(f.pnl/days).toFixed(2)}/d · OOS ${(o.wr*100).toFixed(0)}%(n${o.n})`);
      }
    }
    console.log();
  }

  console.log('════════════ ★ ROBUST MAGNITUDE EDGES ════════════');
  if(!robust.length) console.log('  (none — magnitude alone does not make low streaks fadeable)');
  else robust.forEach(r=>console.log('  '+r));
}
main().catch(e=>{ console.error(e); process.exit(1); });
