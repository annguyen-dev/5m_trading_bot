/**
 * Does WICK / CLIMAX add ON TOP of momentum? Wick & vol-climax were dead/modest
 * standalone — but the real exhaustion thesis is 2-stage: over-extended (high
 * momentum) AND the last bar gets slapped back (rejection wick) or blows off
 * (climax body/volume). Test the intersection vs momentum-alone.
 *
 * Base subset per streak = top-30% by momentum (the over-extended fades). Within
 * it, filter by the upper half of each confirm signal and measure the WR lift:
 *   rejWick   = rejection wick in streak dir / range (last bar rejected)
 *   bodyClmx  = |last body| / 48-bar avg body  (single blow-off candle)
 *   volClmx   = last vol / 48-bar avg vol       (volume climax)
 *
 * Entry $0.55, breakeven 55%, base $5. TRAIN/TEST 70/30. ★ = combo OOS≥55 n≥30
 * AND beats momentum-alone OOS by ≥2pp (i.e. the confirm actually ADDS).
 *
 * Usage: tsx scripts/analyze-momentum-combos.ts [--interval=5m] [--days=365]
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
interface Trig { ts:number; streak:number; regime:1|-1; nextDir:1|-1|0; mom:number; rejWick:number; bodyClmx:number; volClmx:number }
function wr(l:Trig[]){ const s=l.filter(t=>t.nextDir!==0); if(!s.length) return {wr:0,n:0,pnl:0};
  const w=s.filter(t=>t.nextDir!==t.regime).length; return {wr:w/s.length,n:s.length,pnl:w*WIN+(s.length-w)*LOSS}; }
const median=(xs:number[])=>{ const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)] ?? 0; };

async function main(): Promise<void> {
  const interval=process.argv.find(a=>a.startsWith('--interval='))?.slice(11) ?? '5m';
  const days=Number(process.argv.find(a=>a.startsWith('--days='))?.slice(7) ?? (interval==='1h'?730:365));
  const W1=interval==='1h'?1:12;
  console.error(`Fetching ${days}d ${interval}…`); const bars=await fetchKlines(days, interval); console.error(`${bars.length} bars\n`);
  const sl=new Array<number>(bars.length).fill(0);
  for(let i=0;i<bars.length;i++) sl[i]=bars[i]!.dir===0?0:(i>0&&bars[i-1]!.dir===bars[i]!.dir?sl[i-1]!+1:1);

  const trigs:Trig[]=[];
  for(let i=48;i+1<bars.length;i++){
    const s=sl[i]!; if(s<2||s>4) continue; if(sl[i-1]!==s-1) continue;
    const regime=bars[i]!.dir; if(regime===0) continue;
    const b=bars[i]!; const range=b.high-b.low;
    const rejWick = range>0 ? Math.max(0, regime===1?(b.high-b.close):(b.close-b.low))/range : 0;
    let avgB=0,avgV=0; for(let j=i-48;j<i;j++){ avgB+=Math.abs(bars[j]!.close-bars[j]!.open); avgV+=bars[j]!.vol; } avgB/=48; avgV/=48;
    const mom = bars[i-W1]!.close>0 ? (b.close-bars[i-W1]!.close)/bars[i-W1]!.close*100*regime : 0;
    trigs.push({ ts:b.ts, streak:s, regime:regime as 1|-1, nextDir:bars[i+1]!.dir, mom,
      rejWick, bodyClmx: avgB>0?Math.abs(b.close-b.open)/avgB:0, volClmx: avgV>0?b.vol/avgV:0 });
  }
  const cutTs=trigs.length?[...trigs].sort((a,b)=>a.ts-b.ts)[Math.floor(trigs.length*0.7)]!.ts:0;

  console.log(`══════════ MOMENTUM × WICK/CLIMAX COMBO — ${interval} (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Base = top-30% momentum per streak. ★ = combo OOS≥${(BE*100).toFixed(0)} n≥30 AND OOS beats mom-alone by ≥2pp.\n`);

  const confirms:[string,(t:Trig)=>number][]=[['+rejWick',t=>t.rejWick],['+bodyClimax',t=>t.bodyClmx],['+volClimax',t=>t.volClmx]];
  for(const s of [2,3,4]){
    const ss=trigs.filter(t=>t.streak===s); if(ss.length<60) continue;
    const momSorted=[...ss].sort((a,b)=>b.mom-a.mom);
    const momBase=momSorted.slice(0, Math.floor(momSorted.length*0.3));   // over-extended subset
    const mb=wr(momBase), mbOos=wr(momBase.filter(t=>t.ts>=cutTs));
    console.log(`── streak=${s} · momentum-only (top30%): WR ${(mb.wr*100).toFixed(0)}% n${mb.n} $${(mb.pnl/days).toFixed(2)}/d · OOS ${(mbOos.wr*100).toFixed(0)}%(n${mbOos.n}) ──`);
    for(const [name,key] of confirms){
      const med=median(momBase.map(key));
      const combo=momBase.filter(t=>key(t)>=med);            // upper half of the confirm, within momentum base
      const c=wr(combo), cOos=wr(combo.filter(t=>t.ts>=cutTs));
      const lift=cOos.wr-mbOos.wr;
      const star=cOos.wr>=BE && cOos.n>=30 && lift>=0.02;
      console.log(`   ${name.padEnd(12)}(≥${med.toFixed(2)}): WR ${(c.wr*100).toFixed(0)}% n${c.n} $${(c.pnl/days).toFixed(2)}/d · OOS ${(cOos.wr*100).toFixed(0)}%(n${cOos.n}) · vs mom ${lift>=0?'+':''}${(lift*100).toFixed(0)}pp ${star?'★ ADDS':''}`);
    }
    console.log();
  }
  console.log('Đọc: nếu mọi dòng vs mom ≤0pp → wick/climax KHÔNG add gì lên momentum (momentum đã nuốt hết tín hiệu).');
}
main().catch(e=>{ console.error(e); process.exit(1); });
