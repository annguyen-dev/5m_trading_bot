/**
 * PolyBacktestTab — replays the live PMW strategy against historical Poly
 * tick data for BTC. Sub-tab inside the Backtest page.
 *
 * Sections (top → bottom):
 *   1. Date range picker (default last 30d)
 *   2. BTC config (loaded from coin_configs, inline-editable)
 *   3. Time rules (skip UTC hours, skip days-of-week)
 *   4. Run button + progress bar
 *   5. Results: summary cards, equity chart, trade table, skip-reason chart
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type PolyBacktestRequestBody, type PolyBacktestResult,
  type PolyBacktestCoinConfig, type PolyBacktestAutoScheduleEntry,
  type CoinConfigRow,
} from '../api/client.js';
import EquityChart from './EquityChart.js';

const DAYS = (n: number) => n * 24 * 60 * 60 * 1000;
const fmtTs   = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseDate = (s: string) => new Date(s + 'T00:00:00Z').getTime();

// Local-time helpers — same convention as Settings page's ScheduleEditor.
const TZ_HOURS = Math.round(-new Date().getTimezoneOffset() / 60);
const TZ_LABEL = `UTC${TZ_HOURS >= 0 ? '+' : ''}${TZ_HOURS}`;
const utcToLocalHour = (utc: number) => ((utc + TZ_HOURS) % 24 + 24) % 24;
const localToUtcHour = (local: number) => ((local - TZ_HOURS) % 24 + 24) % 24;

export default function PolyBacktestTab() {
  // ── Date range ──
  const now = Date.now();
  const [fromDate, setFromDate] = useState<string>(fmtDate(now - DAYS(30)));
  const [toDate,   setToDate]   = useState<string>(fmtDate(now));

  // ── Config (load from BTC's coin_configs row) ──
  const [config, setConfig] = useState<PolyBacktestCoinConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  useEffect(() => {
    api.getCoinConfigs()
      .then(rows => {
        const btc = rows.find((r: CoinConfigRow) => r.symbol === 'BTC');
        if (!btc) { setConfigError('BTC not found in coin_configs'); return; }
        setConfig({
          symbol:                'BTC',
          size_usdc:             btc.size_usdc,
          streak_min:            btc.streak_min,
          auto_order_min_streak: btc.auto_order_min_streak,
          limit_price_cents:     btc.limit_price_cents,
          tp_cents:              btc.tp_cents,
          sl_cents:              btc.sl_cents,
          dca_multiplier:        btc.dca_multiplier,
          dca_streak_whitelist:  btc.dca_streak_whitelist ?? [],
          auto_schedule:         btc.auto_schedule ?? [],
        });
      })
      .catch(e => setConfigError(String(e)));
  }, []);

  // ── Run state ──
  const [running,  setRunning]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [result, setResult] = useState<PolyBacktestResult | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const cancelSse = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
  }, []);
  useEffect(() => () => cancelSse(), [cancelSse]);

  async function run() {
    if (!config || running) return;
    setRunning(true);
    setProgress(0);
    setProgressMsg('Starting...');
    setError(null);
    setResult(null);

    const fromMs = parseDate(fromDate);
    const toMs   = parseDate(toDate) + DAYS(1);    // include the to-day fully

    const body: PolyBacktestRequestBody = { fromMs, toMs, config };

    try {
      const { jobId } = await api.runPolyBacktest(body);

      // Subscribe to SSE progress
      const token = (() => { try { return localStorage.getItem('tb_admin_token'); } catch { return null; } })();
      const url = `/api/backtest/poly/progress/${encodeURIComponent(jobId)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const sse = new EventSource(url);
      sseRef.current = sse;

      sse.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'progress') {
            setProgress(ev.pct);
            setProgressMsg(ev.msg);
          } else if (ev.type === 'done') {
            setProgress(100);
            setResult(ev.result as PolyBacktestResult);
            setRunning(false);
            cancelSse();
          } else if (ev.type === 'error') {
            setError(ev.msg);
            setRunning(false);
            cancelSse();
          }
        } catch (err) { console.warn('poly-bt parse', err); }
      };
      sse.onerror = () => {
        // EventSource will auto-retry; surface stalled state via spinner staying on.
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  // ── Render ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={S.title}>Poly Backtest — BTC</div>
      <div style={S.subtitle}>
        Replay live strategy (streak + DCA) trên dữ liệu Poly 5s thực tế.
        Edit config + rules bên dưới rồi click Run.
      </div>

      {/* Date range */}
      <div style={S.card}>
        <div style={S.cardTitle}>Date range</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13 }}>
            From <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                        style={S.dateInput} />
          </label>
          <label style={{ fontSize: 13 }}>
            To <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                      style={S.dateInput} />
          </label>
          <span style={{ fontSize: 12, color: '#8b949e' }}>
            ({Math.round((parseDate(toDate) - parseDate(fromDate)) / DAYS(1))} ngày)
          </span>
          <button style={S.preset} onClick={() => { setFromDate(fmtDate(now - DAYS(7)));  setToDate(fmtDate(now)); }}>7d</button>
          <button style={S.preset} onClick={() => { setFromDate(fmtDate(now - DAYS(14))); setToDate(fmtDate(now)); }}>14d</button>
          <button style={S.preset} onClick={() => { setFromDate(fmtDate(now - DAYS(30))); setToDate(fmtDate(now)); }}>30d</button>
        </div>
      </div>

      {/* BTC config */}
      <div style={S.card}>
        <div style={S.cardTitle}>BTC config (chỉnh trực tiếp ở đây — không lưu vào DB)</div>
        {configError && <div style={S.error}>{configError}</div>}
        {config && (
          <ConfigGrid config={config} onChange={setConfig} />
        )}
      </div>

      {/* Schedule (per-hour Auto ≥ overrides — same model as Settings page) */}
      {config && (
        <div style={S.card}>
          <div style={S.cardTitle}>Time schedule — override Auto ≥ theo giờ</div>
          <ScheduleEditor
            value={config.auto_schedule}
            baseThreshold={config.auto_order_min_streak}
            onChange={s => setConfig({ ...config, auto_schedule: s })}
          />
        </div>
      )}

      {/* Run button + progress */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button onClick={run} disabled={!config || running} style={S.runBtn}>
          {running ? 'Running...' : '▶ Run backtest'}
        </button>
        {running && (
          <div style={{ flex: 1 }}>
            <div style={S.progressBar}>
              <div style={{ ...S.progressFill, width: `${progress}%` }} />
            </div>
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 4 }}>{progress}% — {progressMsg}</div>
          </div>
        )}
      </div>

      {error && <div style={S.error}>{error}</div>}

      {/* Results */}
      {result && <ResultPanel result={result} />}
    </div>
  );
}

// ── Config grid (inline-editable) ─────────────────────────────────────────

function ConfigGrid({
  config, onChange,
}: { config: PolyBacktestCoinConfig; onChange: (c: PolyBacktestCoinConfig) => void }) {
  const set = <K extends keyof PolyBacktestCoinConfig>(k: K, v: PolyBacktestCoinConfig[K]) =>
    onChange({ ...config, [k]: v });

  return (
    <div style={S.configGrid}>
      <Field label="Size $"           value={config.size_usdc}             onChange={n => set('size_usdc', n)} />
      <Field label="Streak min"       value={config.streak_min}            onChange={n => set('streak_min', n)} />
      <Field label="Auto ≥"           value={config.auto_order_min_streak} onChange={n => set('auto_order_min_streak', n)} />
      <Field label="Limit ¢"          value={config.limit_price_cents}     onChange={n => set('limit_price_cents', n)} />
      <Field label="TP ¢"             value={config.tp_cents}              onChange={n => set('tp_cents', n)} />
      <Field label="SL ¢"             value={config.sl_cents}              onChange={n => set('sl_cents', n)} />
      <Field label="DCA mult"         value={config.dca_multiplier}        step={0.1} onChange={n => set('dca_multiplier', n)} />
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#8b949e', minWidth: 90 }}>DCA whitelist</span>
        {Array.from({ length: 14 }, (_, i) => i + 2).map(n => {
          const on = config.dca_streak_whitelist.includes(n);
          return (
            <button key={n} style={{ ...S.chip,
              background: on ? '#1a4731' : 'transparent',
              color:      on ? '#3fb950' : '#8b949e',
              borderColor: on ? '#3fb950' : '#30363d',
              minWidth: 28 }}
              onClick={() => set('dca_streak_whitelist',
                on ? config.dca_streak_whitelist.filter(x => x !== n)
                   : [...config.dca_streak_whitelist, n].sort((a, b) => a - b))}>
              {n}
            </button>
          );
        })}
        <span style={{ fontSize: 11, color: '#6e7681', fontStyle: 'italic' }}>
          {config.dca_streak_whitelist.length === 0 ? '(empty = DCA fires on every loss)' : ''}
        </span>
      </div>
    </div>
  );
}

function Field({ label, value, step, onChange }: {
  label: string; value: number; step?: number; onChange: (n: number) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 11, color: '#8b949e' }}>{label}</span>
      <input type="number" value={value} step={step ?? 1}
             onChange={e => onChange(Number(e.target.value) || 0)}
             style={S.numInput} />
    </label>
  );
}

// ── Schedule editor (mirror of SettingsPage's — kept local to this tab so
//    it stays in sync with the inline-config model). ──────────────────────

function ScheduleEditor({
  value, baseThreshold, onChange,
}: {
  value:          PolyBacktestAutoScheduleEntry[];
  baseThreshold:  number;
  onChange:       (next: PolyBacktestAutoScheduleEntry[]) => void;
}) {
  const add = () => onChange([
    ...value,
    {
      start_hour:     localToUtcHour(new Date().getHours()),
      duration_hours: 2,
      threshold:      Math.max(1, baseThreshold - 2),
    },
  ]);
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const patchAt  = (i: number, patch: Partial<PolyBacktestAutoScheduleEntry>) =>
    onChange(value.map((e, idx) => idx === i ? { ...e, ...patch } : e));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#8b949e' }}>
        Hour-of-day (<b>{TZ_LABEL}</b>) overrides for <b>Auto ≥</b>. Trong window,
        dùng <b>threshold</b> thay base ({baseThreshold}). Ranges wrap midnight.
        First match wins. Stored as UTC.
      </div>
      {value.length === 0 && (
        <div style={{ fontSize: 12, color: '#6e7681', fontStyle: 'italic' }}>
          No rules — base <b>Auto ≥ {baseThreshold}</b> dùng cả ngày.
        </div>
      )}
      {value.length > 0 && (
        <table style={{ width: '100%', maxWidth: 620, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={S.th}>Start ({TZ_LABEL})</th>
              <th style={S.th}>Duration (h)</th>
              <th style={S.th}>Threshold</th>
              <th style={{ ...S.th, width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {value.map((entry, i) => {
              const startLocal = utcToLocalHour(entry.start_hour);
              const endLocal   = (startLocal + entry.duration_hours) % 24;
              const endUtc     = (entry.start_hour + entry.duration_hours) % 24;
              return (
                <tr key={i}>
                  <td style={S.td}>
                    <input type="number" min={0} max={23} value={startLocal}
                      onChange={e => patchAt(i, { start_hour: localToUtcHour(Number(e.target.value)) })}
                      style={S.scheduleInput} />
                    <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 6 }}>
                      → {String(endLocal).padStart(2, '0')}h
                      <span style={{ color: '#484f58', marginLeft: 6 }}>
                        (UTC {String(entry.start_hour).padStart(2, '0')}-{String(endUtc).padStart(2, '0')})
                      </span>
                    </span>
                  </td>
                  <td style={S.td}>
                    <input type="number" min={1} max={24} value={entry.duration_hours}
                      onChange={e => patchAt(i, { duration_hours: Number(e.target.value) })}
                      style={S.scheduleInput} />
                  </td>
                  <td style={S.td}>
                    <input type="number" min={1} max={20} value={entry.threshold}
                      onChange={e => patchAt(i, { threshold: Number(e.target.value) })}
                      style={S.scheduleInput} />
                  </td>
                  <td style={S.td}>
                    <button onClick={() => removeAt(i)} style={S.removeBtn} title="Remove rule">×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div>
        <button onClick={add} disabled={value.length >= 8} style={S.addBtn}>
          + Add rule
        </button>
        {value.length >= 8 && (
          <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 8 }}>(max 8)</span>
        )}
      </div>
    </div>
  );
}

// ── Results panel ─────────────────────────────────────────────────────────

function ResultPanel({ result }: { result: PolyBacktestResult }) {
  const { summary, trades, equity } = result;
  // EquityChart expects EquityPoint[] = {ts, equity}[] which is already our shape.
  const equityPoints = useMemo(() => equity.map(p => ({ ts: p.ts, equity: p.equity })), [equity]);

  const pnlColor = summary.totalPnlUsdc >= 0 ? '#3fb950' : '#f85149';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={S.card}>
        <div style={S.cardTitle}>Kết quả</div>
        <div style={S.summaryGrid}>
          <Stat label="Trades"     value={String(summary.trades)} />
          <Stat label="Wins"       value={String(summary.wins)} color="#3fb950" />
          <Stat label="Losses"     value={String(summary.losses)} color="#f85149" />
          <Stat label="Win rate"   value={`${(summary.winRate * 100).toFixed(1)}%`} />
          <Stat label="Total PnL"  value={`$${summary.totalPnlUsdc.toFixed(2)}`} color={pnlColor} />
          <Stat label="Avg / trade" value={`$${summary.avgPnlPerTrade.toFixed(2)}`} />
          <Stat label="Max DD"     value={`$${summary.maxDrawdownUsdc.toFixed(2)}`} color="#f85149" />
          <Stat label="Windows"    value={String(summary.windowsEvaluated)} />
        </div>
        <div style={{ fontSize: 11, color: '#6e7681', marginTop: 8 }}>
          Range data: {summary.coveredFromMs ? fmtTs(summary.coveredFromMs) : '—'} →{' '}
          {summary.coveredToMs   ? fmtTs(summary.coveredToMs)   : '—'}
        </div>
      </div>

      {equityPoints.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Equity curve (USDC running PnL)</div>
          <EquityChart data={equityPoints} height={240} />
        </div>
      )}

      {Object.keys(summary.skipReasons).length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Skip reasons (lý do bỏ qua)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(summary.skipReasons)
              .sort(([, a], [, b]) => b - a)
              .map(([reason, count]) => (
                <div key={reason} style={{ display: 'flex', justifyContent: 'space-between',
                                          fontSize: 12, color: '#c9d1d9' }}>
                  <span style={{ fontFamily: 'monospace' }}>{reason}</span>
                  <span style={{ color: '#8b949e' }}>{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardTitle}>Trade log ({trades.length})</div>
        <TradeTable trades={trades} />
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8b949e' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color ?? '#c9d1d9',
                    fontVariantNumeric: 'tabular-nums' as const }}>
        {value}
      </div>
    </div>
  );
}

// ── Trade table (paginated) ───────────────────────────────────────────────

function TradeTable({ trades }: { trades: PolyBacktestResult['trades'] }) {
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const slice = trades.slice(page * PAGE, (page + 1) * PAGE);
  const totalPages = Math.ceil(trades.length / PAGE);

  if (trades.length === 0) {
    return <div style={{ fontSize: 12, color: '#8b949e', fontStyle: 'italic' }}>
      Không có trade — backtest config có thể quá strict (streak quá cao hoặc time rule chặn hết).
    </div>;
  }

  return (
    <div className="scroll-x">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: '#0d1117' }}>
            <th style={S.th}>Window</th>
            <th style={S.th}>Dir</th>
            <th style={S.th}>Path</th>
            <th style={S.th}>Streak</th>
            <th style={S.th}>Entry</th>
            <th style={S.th}>Size</th>
            <th style={S.th}>Exit</th>
            <th style={S.th}>Reason</th>
            <th style={S.th}>PnL</th>
          </tr>
        </thead>
        <tbody>
          {slice.map((t, i) => (
            <tr key={`${t.windowStart}-${i}`} style={{ borderBottom: '1px solid #21262d' }}>
              <td style={S.td}>{fmtTs(t.windowStart)}</td>
              <td style={{ ...S.td, color: t.direction === 'up' ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                {t.direction.toUpperCase()}
              </td>
              <td style={S.td}>
                <span style={{ ...S.pathBadge,
                  background: t.signalPath === 'dca' ? '#0d2438' : '#0e3a1c',
                  color:      t.signalPath === 'dca' ? '#79c0ff' : '#3fb950' }}>
                  {t.signalPath.toUpperCase()}{t.dcaRound > 0 ? `·${t.dcaRound}` : ''}
                </span>
              </td>
              <td style={S.td}>{t.streakAtEntry > 0 ? '+' : ''}{t.streakAtEntry}</td>
              <td style={S.td}>{(t.entryPrice * 100).toFixed(1)}¢</td>
              <td style={S.td}>${t.sizeUsdc.toFixed(2)}</td>
              <td style={S.td}>{(t.exitPrice * 100).toFixed(1)}¢</td>
              <td style={S.td}>{t.exitReason}</td>
              <td style={{ ...S.td, color: t.pnlUsdc >= 0 ? '#3fb950' : '#f85149',
                          fontWeight: 600, fontVariantNumeric: 'tabular-nums' as const }}>
                {t.pnlUsdc >= 0 ? '+' : ''}${t.pnlUsdc.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 12, alignItems: 'center' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={S.pageBtn}>← Prev</button>
          <span>Page {page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={S.pageBtn}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  title:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subtitle: { fontSize: 13, color: '#8b949e' },

  card: { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 14,
          display: 'flex', flexDirection: 'column', gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: '#c9d1d9' },

  label: { fontSize: 12, color: '#8b949e' },

  dateInput: { padding: '4px 8px', background: '#0d1117', border: '1px solid #30363d',
               color: '#c9d1d9', borderRadius: 4, fontSize: 13, marginLeft: 4 },
  preset:    { padding: '4px 8px', background: '#21262d', color: '#c9d1d9',
               border: '1px solid #30363d', borderRadius: 4, fontSize: 11, cursor: 'pointer' },
  numInput:  { width: 70, padding: '4px 6px', background: '#0d1117', border: '1px solid #30363d',
               color: '#c9d1d9', borderRadius: 4, fontSize: 13, textAlign: 'right' },

  configGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                gap: 10 },

  chip: { padding: '3px 8px', borderRadius: 12, border: '1px solid #30363d',
          fontSize: 11, fontWeight: 600, cursor: 'pointer', minWidth: 30 },

  runBtn: { padding: '10px 24px', background: '#1f6feb', color: '#fff', border: 'none',
            borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            minWidth: 160 },
  progressBar:  { height: 8, borderRadius: 4, background: '#21262d', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#1f6feb', transition: 'width 0.2s' },

  error: { padding: '6px 10px', fontSize: 12, color: '#f85149',
           background: '#40121a', border: '1px solid #7d1a2a', borderRadius: 6 },

  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12 },

  th: { padding: '6px 8px', textAlign: 'left' as const, fontWeight: 600,
        color: '#8b949e', fontSize: 11, borderBottom: '1px solid #30363d' },
  td: { padding: '4px 8px', color: '#c9d1d9', whiteSpace: 'nowrap' as const },

  pathBadge: { padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 700 },

  pageBtn: { padding: '4px 10px', background: '#21262d', color: '#c9d1d9',
             border: '1px solid #30363d', borderRadius: 4, fontSize: 11, cursor: 'pointer' },

  scheduleInput: { width: 56, padding: '4px 6px', background: '#0d1117', border: '1px solid #30363d',
                   color: '#c9d1d9', borderRadius: 4, fontSize: 12, textAlign: 'right' as const },
  removeBtn: { padding: '2px 6px', borderRadius: 4, border: '1px solid #30363d',
               background: '#0d1117', color: '#f85149', fontSize: 13, fontWeight: 700,
               cursor: 'pointer', width: 26 },
  addBtn:    { padding: '4px 12px', borderRadius: 4, border: '1px solid #30363d',
               background: '#0d1117', color: '#58a6ff', fontSize: 12, cursor: 'pointer' },
};
