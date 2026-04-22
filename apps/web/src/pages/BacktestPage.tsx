import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type Environment, type SignalRow, type SummaryRow, type EquityPoint, type FormulaConfig, type CandleRow } from '../api/client.js';
import EquityChart from '../components/EquityChart.js';
import FormulaEditor from '../components/FormulaEditor.js';
import SignalChart from '../components/SignalChart.js';

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  row:          { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 },
  card:         { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '12px 16px' },
  label:        { fontSize: 11, color: '#8b949e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' },
  value:        { fontSize: 22, fontWeight: 700 },
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:           { background: '#161b22', padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #30363d', color: '#8b949e', fontWeight: 500 },
  td:           { padding: '7px 10px', borderBottom: '1px solid #21262d' },
  btn:          { padding: '6px 14px', borderRadius: 6, border: '1px solid #30363d', cursor: 'pointer', background: '#161b22', color: '#c9d1d9', fontSize: 13 },
  btnActive:    { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff' },
  btnPrim:      { background: '#238636', borderColor: '#238636', color: '#fff' },
  tab:          { padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, background: 'transparent', color: '#8b949e' },
  tabActive:    { background: '#1f6feb33', color: '#79c0ff' },
  select:       { padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13 },
  progressBar:  { height: 8, borderRadius: 4, background: '#21262d', overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: '100%', background: '#1f6feb', transition: 'width 0.3s ease', borderRadius: 4 },
};

function pct(n: number | null | undefined, d = 2) {
  if (n == null) return '—';
  const v = (n * 100).toFixed(d) + '%';
  return <span style={{ color: n >= 0 ? '#3fb950' : '#f85149' }}>{n >= 0 ? '+' : ''}{v}</span>;
}
function num(n: number | null | undefined, d = 2) {
  if (n == null) return '—';
  return n.toFixed(d);
}

// ── Week generation ───────────────────────────────────────────────────────────

interface Week { label: string; from: string; to: string }

function generateWeeks(fromYear = 2025): Week[] {
  const weeks: Week[] = [];
  // First Monday on or after Jan 1 of fromYear
  const start = new Date(Date.UTC(fromYear, 0, 1));
  const dow = start.getUTCDay();
  if (dow !== 1) start.setUTCDate(start.getUTCDate() + ((8 - dow) % 7 || 7));

  const now = new Date();
  let d = new Date(start);
  while (d <= now) {
    const mon = new Date(d);
    const sun = new Date(d); sun.setUTCDate(sun.getUTCDate() + 6);
    const to = sun > now ? new Date(now.getTime() - 60_000) : sun;
    weeks.push({
      label: `${fmt(mon)} → ${fmt(sun)}`,
      from:  mon.toISOString().split('T')[0]!,
      to:    to.toISOString().split('T')[0]!,
    });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return weeks.reverse();
}

function fmt(d: Date) { return d.toISOString().split('T')[0]!; }

// ── Quick range helpers ───────────────────────────────────────────────────────

function lastNDays(n: number): Week {
  const now  = new Date();
  const to   = new Date(now.getTime() - 60_000);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (n - 1));
  return { label: `Last ${n}d (${fmt(from)} → ${fmt(to)})`, from: fmt(from), to: fmt(to) };
}

function sevenDaysFrom(startISO: string): Week {
  const from = new Date(`${startISO}T00:00:00Z`);
  const to   = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);
  return { label: `7d from ${fmt(from)} (${fmt(from)} → ${fmt(to)})`, from: fmt(from), to: fmt(to) };
}

// ── Exit badge ────────────────────────────────────────────────────────────────

function ExitBadge({ outcome, reason }: { outcome: string; reason: string | null }) {
  if (outcome === 'win') {
    const label = reason === 'tp' ? '✓ TP' : reason === 'session' ? '✓ sess' : reason === 'timeout' ? '✓ time' : '✓ win';
    return <span style={{ color: '#3fb950', fontWeight: 600 }}>{label}</span>;
  }
  if (outcome === 'loss') {
    const label = reason === 'sl' ? '✗ SL' : reason === 'session' ? '✗ sess' : reason === 'timeout' ? '✗ time' : '✗ loss';
    return <span style={{ color: '#f85149', fontWeight: 600 }}>{label}</span>;
  }
  if (outcome === 'neutral') return <span style={{ color: '#8b949e' }}>— hold</span>;
  return <span style={{ color: '#8b949e' }}>{outcome}</span>;
}

// ── Session-candles panel: aggregated prev 5m + 4 applied 1m candles ─────────
//
// Layout matches the poly-mode execution:
//   • prev     → ONE aggregated 5m candle. Its close is the entry reference.
//   • applied  → FOUR 1m candles (minute 0..3). First = entry bar, 4th = exit.
// PnL is computed against the prev 5m close.

function SessionCandlesPanel({
  prev, applied, signal,
}: {
  prev: CandleRow[];
  applied: CandleRow[];
  signal: SignalRow;
}) {
  const isBuy     = signal.direction === 'BUY';
  const prevClose = prev[0]?.close ?? null;
  const entry     = signal.price_entry ?? prevClose ?? null;
  const exit      = signal.exit_price  ?? applied[applied.length - 1]?.close ?? null;

  const row = (c: CandleRow, kind: 'prev' | 'applied', idx: number, total: number) => {
    const up      = c.close >= c.open;
    const isEntry = kind === 'prev';                           // prev 5m close = entry ref
    const isExit  = kind === 'applied' && idx === total - 1;   // 4th applied 1m = exit
    const label   = kind === 'prev' ? 'prev 5m' : `+${idx}m`;
    return (
      <tr key={`${kind}-${c.ts}`} style={{ background: kind === 'prev' ? '#1a2030' : '#1f252c' }}>
        <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: '#8b949e' }}>
          {new Date(c.ts).toISOString().slice(11, 16)}
        </td>
        <td style={{ padding: '3px 8px', fontSize: 11, color: '#8b949e' }}>
          {label}
          {isEntry && <span style={{ marginLeft: 4, color: '#d29922', fontWeight: 600 }}>entry</span>}
          {isExit  && <span style={{ marginLeft: 4, color: '#79c0ff', fontWeight: 600 }}>exit</span>}
        </td>
        <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11 }}>{c.open.toFixed(2)}</td>
        <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: up ? '#3fb950' : '#f85149' }}>
          {c.close.toFixed(2)} {up ? '▲' : '▼'}
        </td>
        <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: '#8b949e' }}>
          H {c.high.toFixed(2)}  L {c.low.toFixed(2)}
        </td>
      </tr>
    );
  };

  if (prev.length === 0 && applied.length === 0) {
    return (
      <div style={{ padding: 12, color: '#8b949e', fontSize: 12 }}>
        Candles not available for this signal (run candles may not be cached).
      </div>
    );
  }

  const pnlLabel = entry != null && exit != null
    ? (() => {
        const pnl = isBuy ? (exit - entry) / entry : (entry - exit) / entry;
        const color = pnl >= 0 ? '#3fb950' : '#f85149';
        return <span style={{ color, fontWeight: 600 }}>{(pnl * 100).toFixed(3)}%</span>;
      })()
    : '—';

  return (
    <div style={{ padding: '10px 14px', background: '#0d1117' }}>
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 6 }}>
        <strong style={{ color: '#c9d1d9' }}>{signal.direction === 'BUY' ? '▲ up' : '▼ down'}</strong>
        {' '}prediction · entry {entry?.toFixed(2) ?? '—'} (prev 5m close) → exit {exit?.toFixed(2) ?? '—'} (+3m) · PnL {pnlLabel}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ background: '#161b22' }}>
          {['Time', 'Bar', 'Open', 'Close', 'Range'].map(h => (
            <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, color: '#8b949e', fontWeight: 500 }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {prev.map   ((c, i) => row(c, 'prev',    i, prev.length))}
          {applied.map((c, i) => row(c, 'applied', i, applied.length))}
        </tbody>
      </table>
    </div>
  );
}

// ── Summary recompute (client-side, from filtered signals) ────────────────────

interface FilteredSummary {
  total: number;
  wins: number;
  losses: number;
  neutral: number;
  winRate: number;          // wins / (wins + losses)
  avgReturnPct: number | null;
  totalPnl: number | null;
}

function computeSummary(rows: SignalRow[]): FilteredSummary {
  const wins    = rows.filter(s => s.outcome === 'win').length;
  const losses  = rows.filter(s => s.outcome === 'loss').length;
  const neutral = rows.filter(s => s.outcome === 'neutral').length;
  const decided = wins + losses;
  const pnls    = rows.map(s => s.pnl_pct).filter((v): v is number => v != null);
  return {
    total:        rows.length,
    wins,
    losses,
    neutral,
    winRate:      decided > 0 ? wins / decided : 0,
    avgReturnPct: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
    totalPnl:     pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) : null,
  };
}

// ── Main component ────────────────────────────────────────────────────────────

type PageTab = 'run' | 'results' | 'formula';
const BACKTEST_TABS: Record<PageTab, true> = { run: true, results: true, formula: true };

export default function BacktestPage() {
  // Derive active tab from URL so /backtest/run|results|formula deep-links work.
  const location = useLocation();
  const navigate = useNavigate();
  const segment  = location.pathname.split('/')[2] as PageTab | undefined;
  const tab: PageTab = segment && BACKTEST_TABS[segment] ? segment : 'run';

  // Run tab state
  const weeks = generateWeeks(2025);
  const [selectedWeek, setSelectedWeek] = useState<Week>(weeks[0]!);
  const [customFrom,   setCustomFrom]   = useState<string>(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 7);
    return fmt(d);
  });
  const [configs,      setConfigs]      = useState<FormulaConfig[]>([]);
  const [activeConfig, setActiveConfig] = useState<FormulaConfig | null>(null);
  const [selConfigId,  setSelConfigId]  = useState<string>('');
  const [noCache,      setNoCache]      = useState(false);
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState(0);
  const [progressMsg,  setProgressMsg]  = useState('');
  const [runError,     setRunError]     = useState<string | null>(null);
  const [lastRunId,    setLastRunId]    = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  // Results tab state
  const [envs,       setEnvs]       = useState<Environment[]>([]);
  const [envId,      setEnvId]      = useState<string | null>(null);
  const [summary,    setSummary]    = useState<SummaryRow | null>(null);
  const [signals,    setSignals]    = useState<SignalRow[]>([]);
  const [candles,    setCandles]    = useState<CandleRow[]>([]);
  const [equity,     setEquity]     = useState<EquityPoint[]>([]);
  const [page,       setPage]       = useState(0);
  const [loading,    setLoading]    = useState(false);
  const [filterOutcome,    setFilterOutcome]    = useState<'all' | 'win' | 'loss'>('all');
  const [filterStreak,     setFilterStreak]     = useState(0);   // abs(streak_5m) >= N; 0 = no filter
  const [filterMinConf,    setFilterMinConf]    = useState(0);   // confidence (%) >= N; 0 = no filter
  const [filterStatus,     setFilterStatus]     = useState<'all' | 'auto' | 'manual'>('all');
  const [expandedId,       setExpandedId]       = useState<string | null>(null);
  const PAGE_SIZE = 100;

  // Load formula configs
  const loadConfigs = () => {
    api.getFormulaConfigs().then(cfgs => {
      setConfigs(cfgs);
      const act = cfgs.find(c => c.is_active);
      setActiveConfig(act ?? null);
      if (!selConfigId) setSelConfigId(act?.id ?? '');
    }).catch(console.error);
  };

  useEffect(() => { loadConfigs(); }, []);

  // Load environments for Results tab — DB runs only (no legacy file runs)
  const loadEnvs = () => {
    api.getEnvironments().then(list => {
      setEnvs(list.filter(e => e.id.startsWith('run/')));
    }).catch(console.error);
  };
  useEffect(() => { loadEnvs(); }, []);

  // Load signals when env selected — pull all signals + candles in one shot so filtering,
  // summary recompute, and per-signal candle lookup all happen client-side.
  useEffect(() => {
    if (!envId) return;
    setLoading(true);
    setPage(0);
    setExpandedId(null);
    Promise.all([
      api.getSummary(envId),
      api.getAllSignals(envId),
    ]).then(([sum, res]) => {
      setSummary(sum);
      setSignals(res.signals);
    }).catch(console.error).finally(() => setLoading(false));

    if (envId.startsWith('run/')) {
      const runId = envId.replace('run/', '');
      api.getEquity(runId).then(setEquity).catch(() => setEquity([]));
      api.getRunCandles(runId).then(setCandles).catch(() => setCandles([]));
    } else {
      setEquity([]);
      setCandles([]);
    }
  }, [envId]);

  // ── Run backtest ──────────────────────────────────────────────────────────

  async function handleRun() {
    if (running) return;
    sseRef.current?.close();
    setRunning(true); setProgress(0); setProgressMsg('Starting…'); setRunError(null); setLastRunId(null);

    try {
      const { jobId } = await api.runBacktest(
        selectedWeek.from, selectedWeek.to,
        selConfigId || undefined,
        noCache,
      );

      const sse = new EventSource(`/api/backtest/progress/${jobId}`);
      sseRef.current = sse;

      sse.onmessage = (e) => {
        const data = JSON.parse(e.data) as { type: string; pct?: number; msg?: string; runId?: string; totalSignals?: number };
        if (data.type === 'progress') {
          setProgress(data.pct ?? 0);
          setProgressMsg(data.msg ?? '');
        } else if (data.type === 'done') {
          setProgress(100);
          setProgressMsg(`Done${data.totalSignals != null ? ` — ${data.totalSignals} signals` : ''}`);
          setLastRunId(data.runId ?? null);
          setRunning(false);
          sse.close();
          loadEnvs();    // refresh results list
          loadConfigs();
        } else if (data.type === 'error') {
          setRunError(data.msg ?? 'Unknown error');
          setRunning(false);
          sse.close();
        }
      };
      sse.onerror = () => {
        if (running) { setRunError('Connection lost'); setRunning(false); }
        sse.close();
      };
    } catch (e) {
      setRunError(String(e));
      setRunning(false);
    }
  }

  const horizons = summary ? Object.entries(summary.by_horizon).filter(([, m]) => m.total > 0) : [];

  function parseStreak(rationale: string | null): number {
    // Prefer s5m= (streak_5m, added later); fall back to streak= (streak_1m, legacy)
    const m5 = rationale?.match(/s5m=([+-]?\d+)/);
    if (m5) return Math.abs(parseInt(m5[1]!));
    const m1 = rationale?.match(/streak=([+-]?\d+)/);
    return m1 ? Math.abs(parseInt(m1[1]!)) : 0;
  }

  const filteredSignals = signals.filter(sig => {
    if (filterOutcome !== 'all' && sig.outcome !== filterOutcome) return false;
    if (filterStreak > 0 && parseStreak(sig.rationale) < filterStreak) return false;
    if (filterMinConf > 0 && ((sig.confidence ?? 0) * 100) < filterMinConf) return false;
    if (filterStatus !== 'all' && (sig.status ?? 'auto') !== filterStatus) return false;
    return true;
  });

  // Summary recomputed from current filters. When no filters are active, matches
  // the server-side summary exactly; otherwise reflects the filtered subset.
  const anyFilterActive = filterOutcome !== 'all' || filterStreak > 0 || filterMinConf > 0 || filterStatus !== 'all';
  const liveSummary = computeSummary(filteredSignals);

  // Paginate the filtered signals client-side
  const pagedSignals = filteredSignals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages   = Math.max(1, Math.ceil(filteredSignals.length / PAGE_SIZE));

  // Reset page when filters change and current page would be out of range
  useEffect(() => {
    if (page >= totalPages) setPage(0);
  }, [totalPages, page]);

  /**
   * Around a signal ts, return:
   *   • prev    — ONE aggregated 5m candle for the streak-completing session
   *               (the 5m bar whose close triggered the signal).
   *   • applied — FOUR 1m candles of the applied session (minute 0..3). Entry is
   *               the prev 5m close; exit is the 4th candle's close.
   */
  function sessionCandles(sigTs: number): { prev: CandleRow[]; applied: CandleRow[] } {
    if (candles.length === 0) return { prev: [], applied: [] };
    const sessionStart = Math.floor(sigTs / 300_000) * 300_000;
    const appliedStart = sessionStart + 300_000;
    const appliedEnd   = appliedStart + 180_000;   // 4th candle (minute 3) = exit

    const prev1m = candles
      .filter(c => c.ts >= sessionStart && c.ts <= sessionStart + 240_000)
      .sort((a, b) => a.ts - b.ts);
    const prev: CandleRow[] = prev1m.length === 0 ? [] : [{
      ts:     sessionStart,
      open:   prev1m[0]!.open,
      high:   Math.max(...prev1m.map(c => c.high)),
      low:    Math.min(...prev1m.map(c => c.low)),
      close:  prev1m[prev1m.length - 1]!.close,
      volume: prev1m.reduce((s, c) => s + c.volume, 0),
    }];
    const applied = candles.filter(c => c.ts >= appliedStart && c.ts <= appliedEnd);
    return { prev, applied };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Sub-tabs — each is a distinct URL so state survives deep-links & refresh */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #30363d', paddingBottom: 12 }}>
        {([['run', 'Run Backtest'], ['results', 'Results'], ['formula', 'Formula']] as [PageTab, string][]).map(([id, label]) => (
          <NavLink
            key={id}
            to={`/backtest/${id}`}
            style={({ isActive }) => ({ ...s.tab, ...(isActive || tab === id ? s.tabActive : {}), textDecoration: 'none' })}
          >
            {label}
          </NavLink>
        ))}
      </div>

      {/* ── RUN TAB ── */}
      {tab === 'run' && (
        <div>
          {/* Quick presets */}
          <div style={{ ...s.row, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Quick</span>
            {[7, 14, 21].map(n => (
              <button key={n} style={s.btn} onClick={() => setSelectedWeek(lastNDays(n))}>
                Last {n}d
              </button>
            ))}
            <span style={{ width: 1, height: 20, background: '#30363d', margin: '0 4px' }} />
            <span style={{ fontSize: 12, color: '#8b949e' }}>7d from</span>
            <input
              type="date"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              style={{ ...s.select, padding: '5px 8px' }}
            />
            <button
              style={s.btn}
              onClick={() => customFrom && setSelectedWeek(sevenDaysFrom(customFrom))}
              disabled={!customFrom}
            >
              Apply
            </button>
          </div>

          <div style={{ ...s.row, alignItems: 'flex-end' }}>
            <div>
              <div style={{ ...s.label, marginBottom: 6 }}>Range</div>
              <select
                style={{ ...s.select, minWidth: 280 }}
                value={`${selectedWeek.from}|${selectedWeek.to}`}
                onChange={e => {
                  const [from, to] = e.target.value.split('|');
                  setSelectedWeek({ label: e.target.options[e.target.selectedIndex]!.text, from: from!, to: to! });
                }}
              >
                {(() => {
                  const key     = `${selectedWeek.from}|${selectedWeek.to}`;
                  const matched = weeks.some(w => `${w.from}|${w.to}` === key);
                  return matched ? null : (
                    <option key="custom" value={key}>{selectedWeek.label}</option>
                  );
                })()}
                {weeks.map(w => (
                  <option key={w.from} value={`${w.from}|${w.to}`}>{w.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ ...s.label, marginBottom: 6 }}>Formula</div>
              <select
                style={{ ...s.select, minWidth: 200 }}
                value={selConfigId}
                onChange={e => setSelConfigId(e.target.value)}
              >
                {configs.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.is_active ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <label
              title="Bypass DB cache and pull fresh OHLCV from the exchange API"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#c9d1d9', cursor: 'pointer', userSelect: 'none' }}
            >
              <input
                type="checkbox"
                checked={noCache}
                onChange={e => setNoCache(e.target.checked)}
                style={{ accentColor: '#1f6feb' }}
              />
              No cache
            </label>

            <button
              style={{ ...s.btn, ...s.btnPrim, padding: '7px 20px', opacity: running ? 0.6 : 1 }}
              onClick={handleRun}
              disabled={running}
            >
              {running ? 'Running…' : '▶ Run'}
            </button>
          </div>

          {/* Progress */}
          {(running || progress > 0) && (
            <div style={{ ...s.card, marginBottom: 20 }}>
              <div style={s.progressBar}>
                <div style={{ ...s.progressFill, width: `${progress}%` }} />
              </div>
              <div style={{ fontSize: 13, color: '#8b949e' }}>{progressMsg}</div>
              {runError && <div style={{ color: '#f85149', fontSize: 13, marginTop: 6 }}>✗ {runError}</div>}
              {lastRunId && (
                <div style={{ color: '#3fb950', fontSize: 13, marginTop: 6 }}>
                  ✓ Complete —{' '}
                  <button style={{ ...s.btn, padding: '2px 10px', fontSize: 12 }} onClick={() => { setEnvId(`run/${lastRunId}`); navigate('/backtest/results'); }}>
                    View Results →
                  </button>
                </div>
              )}
            </div>
          )}

          {runError && !running && (
            <div style={{ background: '#2d1a1a', border: '1px solid #f85149', borderRadius: 6, padding: '10px 14px', color: '#f85149', fontSize: 13 }}>
              {runError}
            </div>
          )}

          {/* Active formula info */}
          {activeConfig && (
            <div style={{ ...s.card, marginTop: 16 }}>
              <div style={{ ...s.label, marginBottom: 8 }}>Active Formula: {activeConfig.name}</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, fontFamily: 'monospace' }}>
                {Object.entries(activeConfig.weights).map(([k, v]) => {
                  let display: string;
                  if (typeof v === 'number') {
                    display = v.toFixed(2);
                  } else if (v && typeof v === 'object') {
                    const entries = Object.entries(v as Record<string, number>);
                    if (entries.length === 0) return null;
                    display = entries.map(([kk, vv]) => `${kk}:${(vv as number).toFixed(2)}`).join(' ');
                  } else {
                    return null;
                  }
                  return (
                    <span key={k} style={{ color: '#8b949e' }}>
                      {k}: <span style={{ color: '#79c0ff' }}>{display}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── RESULTS TAB ── */}
      {tab === 'results' && (
        <div>
          {/* Run selector */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {envs.map(e => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <button
                  style={{ ...s.btn, ...(envId === e.id ? s.btnActive : {}), borderRadius: '6px 0 0 6px' }}
                  onClick={() => setEnvId(e.id)}
                >
                  {e.label}
                  {e.signalCount > 0 && <span style={{ marginLeft: 5, opacity: 0.7, fontSize: 11 }}>({e.signalCount})</span>}
                  {e.formulaName && <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.6 }}>· {e.formulaName}</span>}
                </button>
                <button
                  title="Delete run"
                  style={{ ...s.btn, borderRadius: '0 6px 6px 0', borderLeft: 'none', padding: '6px 8px', color: '#f85149' }}
                  onClick={() => {
                    if (!confirm(`Delete "${e.label}"?`)) return;
                    api.deleteBacktestRun(e.id).then(() => {
                      if (envId === e.id) { setEnvId(null); setSummary(null); setSignals([]); }
                      loadEnvs();
                    }).catch(err => alert(String(err)));
                  }}
                >✕</button>
              </div>
            ))}
            {envs.length === 0 && <span style={{ color: '#8b949e', fontSize: 13 }}>No backtest runs yet. Go to Run tab.</span>}
          </div>

          {loading && <div style={{ color: '#8b949e' }}>Loading…</div>}

          {summary && !loading && (
            <>
              {/* Stats — recomputed from filtered signals. Label shows "(filtered)" when any filter is active. */}
              <div style={s.row}>
                {[
                  { label: 'Signals',    value: `${liveSummary.total}${anyFilterActive ? ` / ${signals.length}` : ''}` },
                  { label: 'Win Rate',   value: `${(liveSummary.winRate * 100).toFixed(1)}%` },
                  { label: 'Wins',       value: <span style={{ color: '#3fb950' }}>{liveSummary.wins}</span> },
                  { label: 'Losses',     value: <span style={{ color: '#f85149' }}>{liveSummary.losses}</span> },
                  { label: 'Neutral',    value: liveSummary.neutral },
                  { label: 'Avg Return', value: pct(liveSummary.avgReturnPct) },
                ].map(c => (
                  <div key={c.label} style={{ ...s.card, minWidth: 100 }}>
                    <div style={s.label}>
                      {c.label}
                      {anyFilterActive && <span style={{ color: '#d29922', marginLeft: 4 }}>(filtered)</span>}
                    </div>
                    <div style={s.value}>{c.value}</div>
                  </div>
                ))}
              </div>

              {summary.data_range && (
                <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 16 }}>
                  {summary.data_range.from.split('T')[0]} → {summary.data_range.to.split('T')[0]}
                  &nbsp;·&nbsp;{summary.data_range.totalCandles.toLocaleString()} candles
                </div>
              )}

              {equity.length > 1 && (
                <div style={{ ...s.card, marginBottom: 20 }}>
                  <div style={s.label}>Equity Curve</div>
                  <EquityChart data={equity} />
                </div>
              )}

              {horizons.length > 0 && (
                <div style={{ ...s.card, marginBottom: 20 }}>
                  <div style={{ ...s.label, marginBottom: 8 }}>By Horizon</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={s.table}>
                      <thead><tr>
                        {['Horizon','Total','Win%','Avg Ret%','Sharpe','Max DD%','PF','Expectancy'].map(h => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {horizons.map(([h, m]) => (
                          <tr key={h}>
                            <td style={s.td}><strong>{h}</strong></td>
                            <td style={s.td}>{m.total}</td>
                            <td style={s.td}>{pct(m.winRate, 1)}</td>
                            <td style={s.td}>{pct(m.avgReturnPct)}</td>
                            <td style={s.td}>{num(m.sharpeRatio)}</td>
                            <td style={s.td}>{pct(m.maxDrawdownPct, 1)}</td>
                            <td style={s.td}>{m.profitFactor === Infinity ? '∞' : num(m.profitFactor)}</td>
                            <td style={s.td}>{pct(m.expectancy, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Signals table */}
              <div style={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>
                    Signals ({filteredSignals.length}{filteredSignals.length !== signals.length ? `/${signals.length}` : ''})
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {/* Outcome filter */}
                    <select
                      style={s.select}
                      value={filterOutcome}
                      onChange={e => { setFilterOutcome(e.target.value as 'all' | 'win' | 'loss'); setPage(0); }}
                    >
                      <option value="all">All outcomes</option>
                      <option value="win">Win only</option>
                      <option value="loss">Loss only</option>
                    </select>
                    {/* Status filter (auto vs manual) */}
                    <select
                      style={s.select}
                      value={filterStatus}
                      onChange={e => { setFilterStatus(e.target.value as 'all' | 'auto' | 'manual'); setPage(0); }}
                      title="auto = confidence ≥ threshold (bot trades); manual = below threshold"
                    >
                      <option value="all">All status</option>
                      <option value="auto">Auto only</option>
                      <option value="manual">Manual only</option>
                    </select>
                    {/* Streak filter */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>5m streak ≥</span>
                      <input
                        type="number" min={0} max={20} value={filterStreak}
                        style={{ ...s.select, width: 54, padding: '5px 8px' }}
                        onChange={e => { setFilterStreak(Math.max(0, parseInt(e.target.value) || 0)); setPage(0); }}
                      />
                    </div>
                    {/* Confidence threshold filter */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 12, color: '#8b949e' }}>Conf ≥</span>
                      <input
                        type="number" min={0} max={100} step={1} value={filterMinConf}
                        style={{ ...s.select, width: 60, padding: '5px 8px' }}
                        onChange={e => { setFilterMinConf(Math.max(0, Math.min(100, parseInt(e.target.value) || 0))); setPage(0); }}
                      />
                      <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                    </div>
                    <button style={s.btn} disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
                    <span style={{ fontSize: 12, color: '#8b949e' }}>{page + 1} / {totalPages}</span>
                    <button style={s.btn} disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={s.table}>
                    <thead><tr>
                      {['','Time','Dir','Status','Horizon','Conf','Inputs','Entry','Exit','Result','Ret%'].map((h, i) => (
                        <th key={i} style={s.th}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {pagedSignals.map(sig => {
                        const st       = sig.status ?? 'auto';
                        const expanded = expandedId === sig.id;
                        const sc       = expanded ? sessionCandles(sig.ts) : { prev: [], applied: [] };
                        return (
                          <React.Fragment key={sig.id}>
                            <tr>
                              <td style={{ ...s.td, width: 24, padding: '4px 6px', cursor: 'pointer', userSelect: 'none' }}
                                  onClick={() => setExpandedId(expanded ? null : sig.id)}
                                  title={expanded ? 'Collapse' : 'Expand: show prev + applied candles'}>
                                <span style={{ color: '#8b949e', fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>
                              </td>
                              <td style={s.td}>{new Date(sig.ts).toLocaleString()}</td>
                              <td style={s.td}><span style={{ color: sig.direction === 'BUY' ? '#3fb950' : sig.direction === 'SELL' ? '#f85149' : '#8b949e', fontWeight: 600 }}>
                                {sig.direction === 'BUY' ? '▲ up' : sig.direction === 'SELL' ? '▼ down' : sig.direction}
                              </span></td>
                              <td style={s.td}>
                                <span
                                  title={st === 'auto' ? 'Bot trades automatically — confidence ≥ threshold' : 'User review — confidence below threshold'}
                                  style={{
                                    fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                                    background: st === 'auto' ? '#238636' : '#30363d',
                                    color:      st === 'auto' ? '#fff'    : '#8b949e',
                                  }}
                                >{st}</span>
                              </td>
                              <td style={s.td}>{sig.horizon}</td>
                              <td style={s.td}>{sig.confidence != null ? (sig.confidence * 100).toFixed(0) + '%' : '—'}</td>
                              <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' }}>
                                {sig.rationale ? sig.rationale.split('|').pop()?.trim() ?? '—' : '—'}
                              </td>
                              <td style={s.td}>{sig.price_entry?.toFixed(2) ?? '—'}</td>
                              <td style={s.td}>{sig.exit_price?.toFixed(2) ?? '—'}</td>
                              <td style={s.td}><ExitBadge outcome={sig.outcome} reason={sig.exit_reason} /></td>
                              <td style={s.td}>{pct(sig.return_pct)}</td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={11} style={{ padding: 0, borderBottom: '1px solid #30363d', background: '#0d1117' }}>
                                  {candles.length > 0 && (
                                    <div style={{ padding: '10px 14px 0', borderBottom: '1px solid #21262d' }}>
                                      <SignalChart candles1m={candles} signal={sig} />
                                    </div>
                                  )}
                                  <SessionCandlesPanel prev={sc.prev} applied={sc.applied} signal={sig} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {filteredSignals.length === 0 && (
                        <tr><td colSpan={11} style={{ ...s.td, color: '#8b949e', textAlign: 'center', padding: 20 }}>
                          {signals.length > 0 ? 'No signals match filters' : 'No signals'}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── FORMULA TAB ── */}
      {tab === 'formula' && (
        <FormulaEditor configs={configs} onConfigsChange={loadConfigs} />
      )}
    </div>
  );
}
