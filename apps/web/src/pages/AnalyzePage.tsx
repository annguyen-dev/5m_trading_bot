/**
 * AnalyzePage — streak pattern analyzer.
 *
 * Pulls 5-min Binance klines for a coin + day range and surfaces:
 *   - Per-streak-length stats (count, per-day, last seen)
 *   - High-volatility threshold + run-duration distribution
 *   - Post-extreme behavior (after a long streak, when does sideways resume?)
 *   - Hour-of-day hotness map
 *   - Heuristic config suggestion (auto_order_min_streak, dca whitelist)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, type StreakStatsResponse } from '../api/client.js';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'] as const;
const DAY_OPTS = [3, 7, 14, 30] as const;

export default function AnalyzePage() {
  const [coin, setCoin] = useState<typeof COINS[number]>('BTC');
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<StreakStatsResponse | null>(null);
  const [err,  setErr]  = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      setData(await api.getStreakStats(coin, days));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [coin, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.page}>
      <div style={S.heading}>Streak pattern analyzer</div>
      <div style={S.subheading}>
        Pulls 5-min Binance candles, classifies each (UP / DOWN / doji-breaks),
        and surfaces the streak distribution + post-extreme behavior. Use to
        tune <code>auto_order_min_streak</code> and <code>dca_streak_whitelist</code>.
      </div>

      <div style={S.controls}>
        <label style={S.label}>
          Coin
          <select
            value={coin}
            onChange={e => setCoin(e.target.value as typeof COINS[number])}
            disabled={busy}
            style={S.select}
          >
            {COINS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={S.label}>
          Range (days)
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            disabled={busy}
            style={S.select}
          >
            {DAY_OPTS.map(d => <option key={d} value={d}>{d}d</option>)}
          </select>
        </label>
        <button onClick={load} disabled={busy} style={S.btn}>
          {busy ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {err && <div style={S.errBar}>{err}</div>}

      {data && (
        <>
          <div style={S.metaLine}>
            {data.totalBars.toLocaleString()} bars · {data.totalRuns.toLocaleString()} streak runs ·
            {' '}{new Date(data.rangeStartMs).toISOString().slice(0,16).replace('T',' ')} →
            {' '}{new Date(data.rangeEndMs).toISOString().slice(0,16).replace('T',' ')} UTC
          </div>

          <SuggestedCard data={data} />
          <StreakLengthTable data={data} />
          <HighVolCard data={data} />
          <StreakGapCard data={data} />
          <ClusterGapCard data={data} />
          <PostExtremeTable data={data} />
          <DayOfWeekHotnessCard data={data} />
          <HourlyHotnessRow data={data} />
        </>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SuggestedCard({ data }: { data: StreakStatsResponse }) {
  const s = data.suggested;
  return (
    <div style={{ ...S.card, borderLeft: '3px solid #1f6feb', marginTop: 16 }}>
      <div style={S.cardTitle}>Suggested config (heuristic)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <KV label="auto_order_min_streak" value={String(s.auto_order_min_streak)} />
        <KV label="dca_streak_whitelist"  value={s.dca_streak_whitelist.length ? s.dca_streak_whitelist.join(', ') : '(empty)'} />
      </div>
      <div style={{ ...S.dim, marginTop: 8, whiteSpace: 'pre-line' }}>{s.reasoning}</div>
    </div>
  );
}

function StreakLengthTable({ data }: { data: StreakStatsResponse }) {
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Streak length distribution</div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, textAlign: 'right' }}>Length</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Total count</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Per day</th>
            <th style={S.th}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.streakLengths.map(r => (
            <tr key={r.length}>
              <td style={{ ...S.td, textAlign: 'right', fontWeight: 600,
                           color: r.length >= data.highVol.threshold ? '#f0a500' : '#c9d1d9' }}>
                {r.length}
              </td>
              <td style={{ ...S.td, textAlign: 'right' }}>{r.count.toLocaleString()}</td>
              <td style={{ ...S.td, textAlign: 'right',
                           color: r.perDay >= 1 ? '#c9d1d9' : '#6e7681' }}>
                {r.perDay >= 1 ? r.perDay.toFixed(1) : r.perDay.toFixed(2)}
              </td>
              <td style={{ ...S.td, color: '#8b949e' }}>
                {r.lastSeenAgo}
                {' '}<span style={{ color: '#484f58', fontSize: 11 }}>
                  ({new Date(r.lastSeenMs).toISOString().slice(5,16).replace('T',' ')} UTC)
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...S.dim, marginTop: 8 }}>
        Length ≥ {data.highVol.threshold} highlighted as "high-vol" (top decile of run lengths).
      </div>
    </div>
  );
}

function HighVolCard({ data }: { data: StreakStatsResponse }) {
  const v = data.highVol;
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>High-volatility regime</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <KV label="Threshold (streak ≥)"     value={String(v.threshold)} accent="#f0a500" />
        <KV label="Occurrences"              value={`${v.occurrences} (${v.perDay.toFixed(1)}/day)`} />
        <KV label="Longest run"              value={`${v.longestRunMin} min`} />
        <KV label="Run duration p50"         value={`${v.p50RunDurationMin} min`} />
        <KV label="Run duration p90"         value={`${v.p90RunDurationMin} min`} />
      </div>
      <div style={{ ...S.dim, marginTop: 8 }}>
        A "high-vol run" = one continuous streak of length ≥ threshold. Duration ≈ length × 5 min.
      </div>
    </div>
  );
}

function fmtMins(m: number): string {
  if (m <= 0)        return '—';
  if (m < 60)        return `${Math.round(m)}m`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const mm = Math.round(m - h * 60);
    return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m - d * 1440) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function StreakGapCard({ data }: { data: StreakStatsResponse }) {
  const { byThreshold, recentEvents } = data.streakGaps;
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Gap giữa các high-streak events</div>
      <div style={{ ...S.dim, marginBottom: 10 }}>
        Cứ mỗi lần streak ≥ N kết thúc (đảo chiều), tính khoảng cách thời gian
        đến lần kế tiếp. Dùng để tune chiến lược "trade-after-extreme":
        <i> arm window từ T+30m → T+(median gap)</i>.
      </div>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, textAlign: 'right' }}>Streak ≥ N</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Lần</th>
            <th style={{ ...S.th, textAlign: 'right' }} title="Trung bình gap">
              Mean
            </th>
            <th style={{ ...S.th, textAlign: 'right' }} title="Median (p50)">
              Median
            </th>
            <th style={{ ...S.th, textAlign: 'right' }} title="10th percentile — gap ngắn nhất bình thường">
              p10
            </th>
            <th style={{ ...S.th, textAlign: 'right' }} title="90th percentile — gap dài bất thường">
              p90
            </th>
            <th style={{ ...S.th, textAlign: 'right' }}>Max</th>
          </tr>
        </thead>
        <tbody>
          {byThreshold.map(b => (
            <tr key={b.thresholdLength}>
              <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#f0a500' }}>
                {b.thresholdLength}
              </td>
              <td style={{ ...S.td, textAlign: 'right' }}>{b.occurrences}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>{fmtMins(b.meanGapMin)}</td>
              <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>
                {fmtMins(b.medianGapMin)}
              </td>
              <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                {fmtMins(b.p10GapMin)}
              </td>
              <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                {fmtMins(b.p90GapMin)}
              </td>
              <td style={{ ...S.td, textAlign: 'right', color: '#6e7681' }}>
                {fmtMins(b.maxGapMin)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ ...S.cardTitle, marginTop: 18 }}>
        Recent events (length ≥ 5, mới nhất trước)
      </div>
      {recentEvents.length === 0 ? (
        <div style={S.dim}>Không có streak ≥ 5 nào trong phạm vi đã chọn.</div>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Khi (UTC)</th>
              <th style={{ ...S.th, textAlign: 'center' }}>Dir</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Length</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Gap so với event trước</th>
            </tr>
          </thead>
          <tbody>
            {recentEvents.map(e => (
              <tr key={e.endedAt}>
                <td style={{ ...S.td, color: '#c9d1d9', fontFamily: 'monospace', fontSize: 12 }}>
                  {new Date(e.endedAt).toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td style={{ ...S.td, textAlign: 'center', fontSize: 14, fontWeight: 700,
                              color: e.signed > 0 ? '#3fb950' : '#f85149' }}>
                  {e.signed > 0 ? '↑' : '↓'}
                </td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#f0a500' }}>
                  {e.length}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                  {e.gapBeforeMin == null ? '—' : fmtMins(e.gapBeforeMin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ClusterGapCard({ data }: { data: StreakStatsResponse }) {
  const { byCluster, recentBySize } = data.clusterGaps;
  // Track which (size, windowMin) bucket is currently selected for "recent events"
  const defaultKey = byCluster.length > 0 ? `${byCluster[0]!.clusterSize}_${byCluster[0]!.windowMin}` : '';
  const [selKey, setSelKey] = useState(defaultKey);
  const recentEvents = (recentBySize[selKey] ?? []) as StreakStatsResponse['clusterGaps']['recentBySize'][string];

  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Cluster gap — khi 2/3 streak ≥5 dồn dập trong window ngắn</div>
      <div style={{ ...S.dim, marginBottom: 10 }}>
        "Cluster event" = N streak-end (length ≥ 5) xảy ra trong W phút.
        Đo gap giữa các lần cluster event lặp lại. Dùng để biết{' '}
        <i>regime "butterfly / vol-cluster" có chu kỳ lặp lại bao lâu</i>.
      </div>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, textAlign: 'right' }}>Cluster size N</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Window W</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Số cluster events</th>
            <th style={{ ...S.th, textAlign: 'right' }} title="Mean gap giữa 2 cluster events liên tiếp">
              Mean gap
            </th>
            <th style={{ ...S.th, textAlign: 'right' }}>Median</th>
            <th style={{ ...S.th, textAlign: 'right' }}>p10</th>
            <th style={{ ...S.th, textAlign: 'right' }}>p90</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Max</th>
          </tr>
        </thead>
        <tbody>
          {byCluster.map(b => {
            const key = `${b.clusterSize}_${b.windowMin}`;
            return (
              <tr key={key}
                  onClick={() => setSelKey(key)}
                  style={{ cursor: 'pointer',
                           background: selKey === key ? 'rgba(31,111,235,0.1)' : 'transparent' }}>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600,
                              color: selKey === key ? '#58a6ff' : '#f0a500' }}>
                  {b.clusterSize}
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>{b.windowMin}m</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{b.occurrences}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{fmtMins(b.meanGapMin)}</td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>
                  {fmtMins(b.medianGapMin)}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                  {fmtMins(b.p10GapMin)}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                  {fmtMins(b.p90GapMin)}
                </td>
                <td style={{ ...S.td, textAlign: 'right', color: '#6e7681' }}>
                  {fmtMins(b.maxGapMin)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ ...S.dim, fontSize: 11, marginTop: 4 }}>
        Click row để xem recent events của combo đó.
      </div>

      {recentEvents.length > 0 && (
        <>
          <div style={{ ...S.cardTitle, marginTop: 18 }}>
            Recent cluster events ({selKey.replace('_', ' streaks ≥5 in ')}m window)
          </div>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Triggered at (UTC)</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Constituents</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Cluster span</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Gap before</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.map(e => {
                const span = e.contributingEndsAt.length > 1
                  ? (e.contributingEndsAt[e.contributingEndsAt.length - 1]! - e.contributingEndsAt[0]!) / 60_000
                  : 0;
                return (
                  <tr key={e.triggeredAt}>
                    <td style={{ ...S.td, color: '#c9d1d9', fontFamily: 'monospace', fontSize: 12 }}>
                      {new Date(e.triggeredAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td style={{ ...S.td, textAlign: 'right', color: '#8b949e', fontSize: 11 }}>
                      {e.contributingEndsAt.length} events
                    </td>
                    <td style={{ ...S.td, textAlign: 'right', color: '#8b949e' }}>
                      {fmtMins(span)}
                    </td>
                    <td style={{ ...S.td, textAlign: 'right', fontWeight: 600,
                                  color: e.gapBeforeMin == null ? '#6e7681' : '#f0a500' }}>
                      {e.gapBeforeMin == null ? '—' : fmtMins(e.gapBeforeMin)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function PostExtremeTable({ data }: { data: StreakStatsResponse }) {
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Post-extreme behavior — what comes after a long streak?</div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, textAlign: 'right' }}>After streak ≥</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Occurrences</th>
            <th style={{ ...S.th, textAlign: 'right' }} title="Average minutes from extreme run end until a streak ≤ 4 emerges">
              Avg mins → sideways
            </th>
            <th style={{ ...S.th, textAlign: 'right' }} title="Avg max streak in next 60 min">
              Avg max next 60m
            </th>
            <th style={{ ...S.th, textAlign: 'right' }} title="% of subsequent windows where ≥50% of runs are ≤4 (sideways dominance)">
              % sideways
            </th>
          </tr>
        </thead>
        <tbody>
          {data.postExtreme.map(b => (
            <tr key={b.afterStreakAtLeast}>
              <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#f0a500' }}>
                {b.afterStreakAtLeast}
              </td>
              <td style={{ ...S.td, textAlign: 'right' }}>{b.occurrences}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>
                {b.avgMinsToSideways > 0 ? `${b.avgMinsToSideways.toFixed(0)} min` : '—'}
              </td>
              <td style={{ ...S.td, textAlign: 'right' }}>
                {b.avgMaxStreakNext60 > 0 ? b.avgMaxStreakNext60.toFixed(1) : '—'}
              </td>
              <td style={{ ...S.td, textAlign: 'right',
                           color: b.sidewaysFraction >= 0.6 ? '#3fb950' : '#c9d1d9' }}>
                {(b.sidewaysFraction * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...S.dim, marginTop: 8 }}>
        Read as: "After a streak ≥ N, the next ~Y minutes show streaks settling
        below 4 (sideways) Z% of the time." Useful for tuning DCA whitelist —
        if sideways dominates after extreme, DCA whitelist should NOT include
        higher streaks (rare, slow recovery).
      </div>
    </div>
  );
}

function DayOfWeekHotnessCard({ data }: { data: StreakStatsResponse }) {
  // Reorder so Mon comes first (more natural for trading week — Sun gets pushed to end).
  const ordered = [
    ...data.dayOfWeekHotness.slice(1),   // Mon..Sat
    data.dayOfWeekHotness[0]!,           // Sun at end
  ];
  const max = Math.max(...ordered.map(d => d.perCandle), 0.01);
  const overallAvg = ordered.reduce((s, d) => s + d.perCandle, 0) / ordered.length;
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Day-of-week hotness (UTC) — % of candles in a high-vol streak</div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Day (UTC)</th>
            <th style={{ ...S.th, textAlign: 'right' }}>High-vol candles</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Total candles</th>
            <th style={{ ...S.th, textAlign: 'right' }}>% high-vol</th>
            <th style={{ ...S.th, textAlign: 'right' }}>vs. avg</th>
            <th style={S.th}></th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(d => {
            const pct      = d.perCandle * 100;
            const vsAvg    = overallAvg > 0 ? (d.perCandle / overallAvg) : 1;
            const isHot    = vsAvg >= 1.2;
            const isCold   = vsAvg <= 0.8;
            const barWidth = (d.perCandle / max) * 100;
            return (
              <tr key={d.dayUtc}>
                <td style={{ ...S.td, fontWeight: 600,
                              color: isHot ? '#f0a500' : isCold ? '#6e7681' : '#c9d1d9' }}>
                  {d.dayName}
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>{d.bigCount.toLocaleString()}</td>
                <td style={{ ...S.td, textAlign: 'right', color: '#6e7681' }}>
                  {d.totalBars.toLocaleString()}
                </td>
                <td style={{ ...S.td, textAlign: 'right',
                              color: isHot ? '#f0a500' : isCold ? '#6e7681' : '#c9d1d9' }}>
                  {pct.toFixed(1)}%
                </td>
                <td style={{ ...S.td, textAlign: 'right',
                              color: isHot ? '#f0a500' : isCold ? '#6e7681' : '#c9d1d9' }}>
                  {vsAvg >= 1 ? '+' : ''}{((vsAvg - 1) * 100).toFixed(0)}%
                </td>
                <td style={{ ...S.td, width: 200 }}>
                  <div style={{
                    height: 8, borderRadius: 4,
                    background: '#0d1117', overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${barWidth}%`, height: '100%',
                      background: isHot ? '#f0a500' : isCold ? '#30363d' : '#79c0ff',
                      transition: 'width 0.2s',
                    }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ ...S.dim, marginTop: 8 }}>
        <b>Hot day</b> (orange) = ≥ +20% above weekly average.{' '}
        <b>Cold day</b> (grey) = ≤ −20%. Bucketed in UTC; if you're in UTC+7
        the day boundary shifts by 7h (e.g., a heavy Friday 18:00 UTC = Saturday
        01:00 local, but the bar is counted under "Fri").
      </div>
    </div>
  );
}

function HourlyHotnessRow({ data }: { data: StreakStatsResponse }) {
  const max = Math.max(...data.hourlyHotness.map(h => h.perCandle), 0.01);
  return (
    <div style={{ ...S.card, marginTop: 16 }}>
      <div style={S.cardTitle}>Hourly hotness (UTC) — % of candles in a high-vol streak</div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 80 }}>
        {data.hourlyHotness.map(h => {
          const heightPct = (h.perCandle / max) * 100;
          const fillColor = h.perCandle >= max * 0.7 ? '#f0a500'
                          : h.perCandle >= max * 0.4 ? '#79c0ff'
                          : '#30363d';
          return (
            <div key={h.hourUtc}
                 style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}
                 title={`${String(h.hourUtc).padStart(2,'0')}h UTC: ${(h.perCandle * 100).toFixed(1)}%`}>
              <div style={{
                width: '100%', minHeight: 1,
                height: `${heightPct}%`,
                background: fillColor,
                borderRadius: '2px 2px 0 0',
                transition: 'height 0.2s',
              }} />
              <div style={{ fontSize: 10, color: '#6e7681' }}>{String(h.hourUtc).padStart(2, '0')}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KV({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 11, color: '#8b949e' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: accent ?? '#c9d1d9', fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 },
  heading:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subheading: { fontSize: 13, color: '#8b949e', marginTop: -4 },
  controls:   { display: 'flex', gap: 12, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' as const },
  label:      { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#8b949e' },
  select:     { padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d',
                background: '#0d1117', color: '#c9d1d9', fontSize: 13, minWidth: 100 },
  btn:        { padding: '7px 16px', borderRadius: 6, border: '1px solid #1f6feb',
                background: '#1f6feb', color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 },
  errBar:     { color: '#f85149', padding: '8px 12px', background: '#21262d',
                borderRadius: 6, fontSize: 13 },
  metaLine:   { fontSize: 12, color: '#6e7681', marginTop: 8 },
  card:       { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '14px 18px',
                overflowX: 'auto' as const, WebkitOverflowScrolling: 'touch' as const },
  cardTitle:  { fontSize: 13, fontWeight: 600, color: '#c9d1d9', marginBottom: 12,
                textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  table:      { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:         { padding: '8px 10px', textAlign: 'left' as const, fontWeight: 600,
                color: '#8b949e', fontSize: 12, borderBottom: '1px solid #30363d',
                background: '#0d1117' },
  td:         { padding: '6px 10px', borderBottom: '1px solid #21262d', color: '#c9d1d9' },
  dim:        { fontSize: 11, color: '#6e7681' },
};
