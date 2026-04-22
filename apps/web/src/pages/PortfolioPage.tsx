/**
 * PortfolioPage — PnL aggregates filtered by trading mode.
 *
 * Counts only BUY rows (side='buy') so PnL isn't double-counted from the
 * paired SELL rows. Excludes backtest entirely — those are "what-if" runs,
 * not real positions.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PolyPortfolio } from '../api/client.js';

type Mode = 'simulate' | 'live';

const REFRESH_MS = 5_000;

export default function PortfolioPage() {
  const [mode, setMode] = useState<Mode>('simulate');
  const [data, setData] = useState<PolyPortfolio | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await api.getPolyPortfolio(mode);
      setData(p); setError(null);
    } catch (e) { setError(String(e)); }
  }, [mode]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const winRate = useMemo(() => {
    if (!data) return null;
    const { wins, closed } = data.totals;
    return closed > 0 ? wins / closed : null;
  }, [data]);

  return (
    <div style={S.page}>
      <div style={S.heading}>Portfolio</div>
      <div style={S.subheading}>
        PnL theo mode trading. Backtest <strong>không</strong> tính (replay data).
        Sums chỉ trên BUY rows để không double-count với SELL.
      </div>

      <div style={S.tabs}>
        {(['simulate', 'live'] as Mode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            style={{ ...S.tab, ...(mode === m ? S.tabActive : {}) }}>
            {m.toUpperCase()}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#8b949e' }}>
          auto-refresh {REFRESH_MS / 1000}s
        </span>
      </div>

      {error && <div style={S.errorBar}>{error}</div>}
      {!data && !error && <div style={{ color: '#8b949e' }}>Loading…</div>}
      {data && (
        <>
          <KpiGrid totals={data.totals} winRate={winRate} />
          <BreakdownCards data={data} />
          <RecentTable rows={data.recent} />
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function KpiGrid({
  totals, winRate,
}: {
  totals: PolyPortfolio['totals'];
  winRate: number | null;
}) {
  const pnlColor = totals.realizedPnl > 0 ? '#3fb950'
                 : totals.realizedPnl < 0 ? '#f85149' : '#8b949e';
  const roi = totals.totalSize > 0 ? totals.realizedPnl / totals.totalSize : 0;
  return (
    <div style={S.kpiGrid}>
      <Kpi label="Realized PnL"
           value={`${totals.realizedPnl >= 0 ? '+' : ''}$${totals.realizedPnl.toFixed(2)}`}
           color={pnlColor}
           sub={`ROI ${(roi * 100).toFixed(1)}% · capital $${totals.totalSize.toFixed(2)}`} />
      <Kpi label="Win rate"
           value={winRate != null ? `${(winRate * 100).toFixed(0)}%` : '—'}
           color="#79c0ff"
           sub={`${totals.wins}W / ${totals.losses}L (${totals.closed} closed)`} />
      <Kpi label="Open positions"
           value={`${totals.pending}`}
           color="#f0a500"
           sub={`Tổng ${totals.total} BUY orders`} />
    </div>
  );
}

function Kpi({ label, value, color, sub }: {
  label: string; value: string; color: string; sub: string;
}) {
  return (
    <div style={S.kpi}>
      <div style={S.kpiLabel}>{label}</div>
      <div style={{ ...S.kpiValue, color }}>{value}</div>
      <div style={S.kpiSub}>{sub}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function BreakdownCards({ data }: { data: PolyPortfolio }) {
  const reasonLabel: Record<string, string> = {
    tp: 'SOLD · TP', sl: 'SOLD · SL', resolution: 'RESOLVED', manual: 'manual',
  };
  const pathLabel: Record<string, string> = {
    boundary: 'BOUNDARY (Path A)',
    panic:    'PANIC (Path B)',
    manual:   'Manual click',
  };
  return (
    <div style={S.twoCol}>
      <div style={S.card}>
        <div style={S.cardTitle}>By close reason</div>
        {data.byCloseReason.length === 0
          ? <div style={S.empty}>Chưa có closed orders.</div>
          : data.byCloseReason.map(r => (
            <div key={r.reason} style={S.row}>
              <span>{reasonLabel[r.reason] ?? r.reason}</span>
              <span style={{ color: '#8b949e' }}>{r.count} orders</span>
              <span style={{ fontFamily: 'monospace',
                             color: r.avgPnl > 0 ? '#3fb950' : r.avgPnl < 0 ? '#f85149' : '#8b949e' }}>
                avg {r.avgPnl >= 0 ? '+' : ''}${r.avgPnl.toFixed(2)}
              </span>
            </div>
          ))}
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>By signal path</div>
        {data.bySignalPath.length === 0
          ? <div style={S.empty}>Chưa có orders.</div>
          : data.bySignalPath.map(p => (
            <div key={p.path} style={S.row}>
              <span>{pathLabel[p.path] ?? p.path}</span>
              <span style={{ color: '#8b949e' }}>{p.count} orders</span>
              <span style={{ fontFamily: 'monospace',
                             color: p.totalPnl > 0 ? '#3fb950' : p.totalPnl < 0 ? '#f85149' : '#8b949e' }}>
                {p.totalPnl >= 0 ? '+' : ''}${p.totalPnl.toFixed(2)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function RecentTable({ rows }: { rows: PolyPortfolio['recent'] }) {
  if (!rows.length) return null;
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Recent (last 30)</div>
      <div style={S.table}>
        <div style={S.tableHeader}>
          <span>Time</span>
          <span>Direction</span>
          <span>Entry</span>
          <span>Status</span>
          <span>PnL</span>
        </div>
        {rows.map(r => {
          const pnl = r.pnl_usdc;
          const status = r.status === 'pending' ? 'HOLDING'
                      : r.close_reason === 'tp'   ? 'SOLD · TP'
                      : r.close_reason === 'sl'   ? 'SOLD · SL'
                      : r.close_reason === 'resolution' ? 'RESOLVED'
                      : 'closed';
          return (
            <div key={r.id} style={S.tableRow}>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {new Date(Number(r.ts_entry)).toLocaleString('en-US', {
                  month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit',
                })}
              </span>
              <span style={{ color: r.direction === 'up' ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                {r.direction.toUpperCase()}
              </span>
              <span style={{ fontFamily: 'monospace' }}>{(r.share_price * 100).toFixed(1)}¢</span>
              <span style={{ fontSize: 11,
                              color: r.status === 'pending' ? '#f0a500'
                                   : r.close_reason === 'tp' ? '#3fb950'
                                   : r.close_reason === 'sl' ? '#f85149' : '#8b949e' }}>
                {status}
              </span>
              <span style={{ fontFamily: 'monospace',
                             color: pnl == null ? '#8b949e' : pnl > 0 ? '#3fb950' : '#f85149' }}>
                {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
  heading:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subheading: { fontSize: 13, color: '#8b949e', marginTop: -8 },
  errorBar:   { color: '#f85149', padding: '8px 12px', background: '#21262d',
                borderRadius: 6, fontSize: 13 },

  tabs:       { display: 'flex', gap: 6, alignItems: 'center' },
  tab:        { padding: '6px 14px', borderRadius: 18, border: '1px solid #30363d',
                background: '#161b22', color: '#8b949e', fontSize: 12, fontWeight: 600,
                cursor: 'pointer' },
  tabActive:  { background: '#21262d', color: '#c9d1d9', borderColor: '#444c56' },

  kpiGrid:    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  kpi:        { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },
  kpiLabel:   { fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5 },
  kpiValue:   { fontSize: 28, fontWeight: 700, marginTop: 4, fontFamily: 'monospace' },
  kpiSub:     { fontSize: 12, color: '#8b949e', marginTop: 4 },

  twoCol:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  card:       { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },
  cardTitle:  { fontSize: 14, fontWeight: 600, color: '#c9d1d9', marginBottom: 10 },
  row:        { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr',
                fontSize: 13, color: '#c9d1d9', padding: '6px 0',
                borderBottom: '1px solid #21262d', alignItems: 'center' },
  empty:      { fontSize: 12, color: '#8b949e', padding: '8px 0' },

  table:      { display: 'flex', flexDirection: 'column', gap: 4 },
  tableHeader:{ display: 'grid', gridTemplateColumns: '120px 80px 70px 90px 80px',
                fontSize: 11, color: '#8b949e', padding: '4px 0',
                borderBottom: '1px solid #21262d' },
  tableRow:   { display: 'grid', gridTemplateColumns: '120px 80px 70px 90px 80px',
                fontSize: 13, color: '#c9d1d9', padding: '6px 0', alignItems: 'center' },
};
