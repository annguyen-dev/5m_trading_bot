import React, { useState, useCallback, useMemo } from 'react';
import { api, type CandleRow, type PolyResult } from '../api/client.js';
import CandleChart from '../components/CandleChart.js';

const s: Record<string, React.CSSProperties> = {
  row:    { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 },
  input:  { padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13 },
  btn:    { padding: '7px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  card:   { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },
  badge:  { display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 },
  th:     { padding: '6px 10px', textAlign: 'left', color: '#8b949e', fontWeight: 500, fontSize: 12 },
  td:     { padding: '6px 10px', fontSize: 13 },
};

/** Aggregate 1m candles into N-minute bars */
function aggregate(candles: CandleRow[], minutes: number): CandleRow[] {
  if (candles.length === 0) return [];
  const buckets = new Map<number, CandleRow[]>();
  const ms = minutes * 60 * 1000;
  for (const c of candles) {
    const key = Math.floor(c.ts / ms) * ms;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, bars]) => ({
      ts,
      open:   bars[0].open,
      high:   Math.max(...bars.map(b => b.high)),
      low:    Math.min(...bars.map(b => b.low)),
      close:  bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    }));
}

export default function PolySignalPage() {
  const now        = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const [from,       setFrom]       = useState(fmtDatetime(oneWeekAgo));
  const [to,         setTo]         = useState(fmtDatetime(now));
  const [candles1m,  setCandles1m]  = useState<CandleRow[]>([]);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [result,     setResult]     = useState<PolyResult | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [running,    setRunning]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const candles5m = useMemo(() => aggregate(candles1m, 5), [candles1m]);

  async function loadCandles() {
    setLoading(true);
    setError(null);
    setCandles1m([]);
    setSelectedTs(null);
    setResult(null);
    try {
      const data = await api.getSimulateCandles(from, to);
      setCandles1m(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const handleSelect = useCallback((ts: number) => {
    setSelectedTs(ts);
    setResult(null);
  }, []);

  async function runSignal() {
    if (!selectedTs) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.runPolySimulate(selectedTs);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div style={s.row}>
        <label style={{ fontSize: 13 }}>From</label>
        <input style={s.input} type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} />
        <label style={{ fontSize: 13 }}>To</label>
        <input style={s.input} type="datetime-local" value={to} onChange={e => setTo(e.target.value)} />
        <button style={{ ...s.btn, background: '#1f6feb', color: '#fff' }} onClick={loadCandles} disabled={loading}>
          {loading ? 'Loading…' : 'Load Chart'}
        </button>
      </div>

      {error && <div style={{ color: '#f85149', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {candles5m.length > 0 && (
        <div style={{ ...s.card, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>
            {candles5m.length} × 5m bars · Click a bar to select
          </div>
          <CandleChart candles={candles5m} onSelect={handleSelect} selectedTs={selectedTs} />
        </div>
      )}

      {selectedTs && (
        <div style={{ ...s.row }}>
          <span style={{ fontSize: 13, color: '#8b949e' }}>
            Selected: <strong style={{ color: '#c9d1d9' }}>{new Date(selectedTs).toLocaleString()}</strong>
          </span>
          <button style={{ ...s.btn, background: '#3fb950', color: '#000' }} onClick={runSignal} disabled={running}>
            {running ? 'Running…' : '▶ Run PM Signal'}
          </button>
        </div>
      )}

      {result && <PolyResult result={result} />}
    </div>
  );
}

function PolyResult({ result }: { result: PolyResult }) {
  const { direction, p_signal, macroBias, components, outcome, skipReason } = result;
  const isUp   = direction === 'up';
  const isSkip = direction === 'skip';

  return (
    <div style={{ ...s.card, marginTop: 16 }}>
      {/* Header row */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {outcome && (
          <span style={{
            ...s.badge,
            background: outcome.correct ? '#1a4731' : '#4a1a1a',
            color: outcome.correct ? '#3fb950' : '#f85149',
            fontSize: 14,
          }}>
            {outcome.correct ? 'WIN' : 'LOSS'}
          </span>
        )}
        <span style={{
          ...s.badge,
          background: isSkip ? '#21262d' : isUp ? '#1a4731' : '#4a1a1a',
          color:      isSkip ? '#8b949e' : isUp ? '#3fb950' : '#f85149',
          fontSize: 16, padding: '4px 12px',
        }}>
          {isSkip ? 'SKIP' : isUp ? '↑ UP' : '↓ DOWN'}
        </span>
        <span style={{ fontSize: 13, color: '#8b949e' }}>
          P <strong style={{ color: '#c9d1d9' }}>{(p_signal * 100).toFixed(1)}%</strong>
        </span>
        {outcome && (
          <span style={{ fontSize: 13, color: outcome.correct ? '#3fb950' : '#f85149', fontWeight: 600 }}>
            {outcome.pnlPct >= 0 ? '+' : ''}{(outcome.pnlPct * 100).toFixed(2)}%
          </span>
        )}
      </div>

      {/* Actual candle movement — shown on win or loss */}
      {outcome && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13,
          background: outcome.correct ? '#0d1f0d' : '#1f0d0d',
          border: `1px solid ${outcome.correct ? '#238636' : '#da3633'}`,
        }}>
          <span style={{ color: '#8b949e' }}>Actual candle: </span>
          <strong>${outcome.entryPrice.toFixed(2)}</strong>
          <span style={{ color: '#8b949e' }}> → </span>
          <strong>${outcome.exitPrice.toFixed(2)}</strong>
          <span style={{
            marginLeft: 10, fontWeight: 700,
            color: outcome.changeUsd >= 0 ? '#3fb950' : '#f85149',
          }}>
            {outcome.changeUsd >= 0 ? '+' : ''}${outcome.changeUsd.toFixed(2)}
            {' '}({outcome.changePct >= 0 ? '+' : ''}{(outcome.changePct * 100).toFixed(3)}%)
          </span>
          <span style={{ marginLeft: 10, color: '#8b949e' }}>
            → <strong style={{ color: outcome.actual === 'up' ? '#3fb950' : '#f85149' }}>
              {outcome.actual.toUpperCase()}
            </strong>
          </span>
        </div>
      )}

      {/* Skip reason */}
      {skipReason && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#21262d', borderRadius: 6, fontSize: 12, color: '#f0a500' }}>
          ⚠ {skipReason}
        </div>
      )}

      {/* Macro bias */}
      <div style={{ marginBottom: 12, padding: '8px 12px', background: '#0d1117', borderRadius: 6, fontSize: 13 }}>
        <span style={{ color: '#8b949e' }}>Macro: </span>
        <strong style={{ color: macroBias.bias === 'bullish' ? '#3fb950' : macroBias.bias === 'bearish' ? '#f85149' : '#8b949e' }}>
          {macroBias.bias.toUpperCase()}
        </strong>
        <span style={{ color: '#8b949e' }}> · strength {(macroBias.strength * 100).toFixed(0)}%</span>
        <span style={{ color: '#8b949e' }}> · 24h {(macroBias.change24h * 100).toFixed(2)}%</span>
      </div>

      {/* Component table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #30363d' }}>
            <th style={s.th}>Component</th>
            <th style={s.th}>P(UP)</th>
            <th style={s.th}>Details</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={s.td}>Quota (30%)</td>
            <td style={s.td}><Pbar p={components.quota.p} /></td>
            <td style={s.td}>
              streak {components.quota.streak5m} · {components.quota.todayCount}/{components.quota.avgCount.toFixed(1)} reversals today · P(rev) {(components.quota.pReversal * 100).toFixed(0)}%
            </td>
          </tr>
          <tr>
            <td style={s.td}>Trend (35%)</td>
            <td style={s.td}><Pbar p={components.trend.p} /></td>
            <td style={s.td}>
              15m {components.trend.trend15m} · 1h {components.trend.trend1h} · score {(components.trend.score * 100).toFixed(0)}%
            </td>
          </tr>
          <tr>
            <td style={s.td}>Pattern (20%)</td>
            <td style={s.td}><Pbar p={components.pattern.p} /></td>
            <td style={s.td}>
              {components.pattern.total} neighbors · ↑{components.pattern.upVotes} ↓{components.pattern.downVotes} ({(components.pattern.pUp * 100).toFixed(0)}% up)
            </td>
          </tr>
          <tr>
            <td style={s.td}>Liq (15%)</td>
            <td style={s.td}><Pbar p={components.liq.p} /></td>
            <td style={s.td}>
              long ${(components.liq.liqLong / 1e6).toFixed(2)}M · short ${(components.liq.liqShort / 1e6).toFixed(2)}M
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Pbar({ p }: { p: number }) {
  const pct = (p * 100).toFixed(1) + '%';
  const color = p >= 0.6 ? '#3fb950' : p <= 0.4 ? '#f85149' : '#f0a500';
  return <span style={{ color, fontWeight: 600 }}>{pct}</span>;
}

function fmtDatetime(d: Date) {
  return d.toISOString().slice(0, 16);
}
