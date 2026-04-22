import React, { useState } from 'react';
import { api, type FormulaAnalyzeResult, type FormulaWeights } from '../api/client.js';

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  section:  { marginBottom: 28 },
  heading:  { fontSize: 12, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 },
  card:     { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '16px 20px' },
  table:    { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:       { background: '#0d1117', padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid #30363d', color: '#8b949e', fontWeight: 500 },
  td:       { padding: '6px 10px', borderBottom: '1px solid #21262d', color: '#c9d1d9' },
  btn:      { padding: '7px 16px', borderRadius: 6, border: '1px solid #30363d', cursor: 'pointer', background: '#161b22', color: '#c9d1d9', fontSize: 13 },
  btnPrim:  { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff' },
  btnGrn:   { background: '#238636', borderColor: '#238636', color: '#fff' },
  select:   { padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13 },
  input:    { padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13, width: 70 },
  tag:      { display: 'inline-block', fontSize: 11, padding: '2px 7px', borderRadius: 4, fontFamily: 'monospace' },
  insight:  { padding: '8px 12px', borderRadius: 6, background: '#1f3a5f', borderLeft: '3px solid #1f6feb', fontSize: 13, color: '#c9d1d9', marginBottom: 8 },
  err:      { color: '#f85149', fontSize: 13, marginTop: 8 },
  weight:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  wKey:     { width: 160, fontSize: 13, color: '#8b949e' },
  wVal:     { fontFamily: 'monospace', fontSize: 14, color: '#79c0ff', fontWeight: 700 },
  wReason:  { fontSize: 12, color: '#8b949e', flex: 1 },
};

function pct(r: number) {
  const color = r >= 0.55 ? '#3fb950' : r >= 0.48 ? '#e3b341' : '#f85149';
  return <span style={{ color, fontFamily: 'monospace' }}>{(r * 100).toFixed(1)}%</span>;
}

function RateBar({ rate }: { rate: number }) {
  const color = rate >= 0.6 ? '#3fb950' : rate >= 0.5 ? '#e3b341' : '#f85149';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 80, height: 6, background: '#21262d', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, rate * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      {pct(rate)}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AnalyzePage() {
  const [days,       setDays]       = useState(90);
  const [minSamples, setMinSamples] = useState(30);
  const [loading,    setLoading]    = useState(false);
  const [result,     setResult]     = useState<FormulaAnalyzeResult | null>(null);
  const [err,        setErr]        = useState<string | null>(null);
  const [saved,      setSaved]      = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [configName, setConfigName] = useState('');

  function defaultName() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `AI_GENERATED_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  async function handleRun() {
    setLoading(true); setErr(null); setResult(null); setSaved(false); setConfigName(defaultName());
    try {
      const r = await api.analyzeFormula(days, minSamples);
      setResult(r);
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }

  async function handleApply() {
    if (!result) return;
    setSaving(true);
    try {
      const name = configName.trim() || defaultName();
      await api.createFormulaConfig(name, result.suggestedWeights, `Auto-generated from ${days}-day analysis`);
      setSaved(true);
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  }

  const WEIGHT_LABELS: Record<keyof FormulaWeights, string> = {
    wKnn:                'wKnn',
    wStreak:             'wStreak',
    wIntraday:           'wIntraday',
    wVolume:             'wVolume',
    confidenceThreshold: 'Threshold',
    streakScale:         'Streak scale',
    streakCap:           'Streak cap',
    thresholdByStreak:   'Threshold/streak',
    volBoostMinRatio:    'VolBoost min ratio',
    volBoostMinWick:     'VolBoost min wick',
    volBoostGain:        'VolBoost gain',
    volBoostMax:         'VolBoost max',
    liqBoost:            'Liq-break boost',
  };

  return (
    <div style={{ maxWidth: 900 }}>
      {/* ── Settings ── */}
      <div style={{ ...s.section, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#8b949e' }}>Days of data</span>
          <select style={s.select} value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#8b949e' }}>Min samples</span>
          <input
            type="number" min={10} max={500} value={minSamples}
            style={s.input}
            onChange={e => setMinSamples(Math.max(10, Number(e.target.value)))}
          />
        </div>
        <button style={{ ...s.btn, ...s.btnPrim }} onClick={handleRun} disabled={loading}>
          {loading ? 'Analyzing…' : '▶ Run Analysis'}
        </button>
        {loading && (
          <span style={{ fontSize: 12, color: '#8b949e' }}>
            Computing stats + calling Claude… (~10–20s)
          </span>
        )}
      </div>

      {err && <div style={s.err}>⚠ {err}</div>}

      {result && (
        <>
          {/* ── Stats ── */}
          <div style={s.section}>
            <div style={s.heading}>
              Data Stats — {result.stats.daysOfData} days, {result.stats.totalSamples.toLocaleString()} samples
            </div>

            {/* Row 1: streak_1m + streak_5m */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              {(['byStreak1m', 'byStreak5m'] as const).map(key => (
                <div key={key} style={s.card}>
                  <div style={{ ...s.heading, marginBottom: 8 }}>
                    Reversal rate by {key === 'byStreak1m' ? 'streak_1m' : 'streak_5m'}
                  </div>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>Streak</th>
                        <th style={s.th}>n</th>
                        <th style={s.th}>Reversal 1h</th>
                        <th style={s.th}>Avg vol</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.stats[key].map(r => (
                        <tr key={r.absStreak}>
                          <td style={s.td}>{r.absStreak}</td>
                          <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                          <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                          <td style={{ ...s.td, fontFamily: 'monospace', color: '#8b949e' }}>{r.avgVolRatio.toFixed(2)}</td>
                        </tr>
                      ))}
                      {result.stats[key].length === 0 && (
                        <tr><td colSpan={4} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {/* Row 2: timing + volume + combo */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16 }}>
              {/* Timing */}
              <div style={s.card}>
                <div style={{ ...s.heading, marginBottom: 8 }}>Reversal timing + continuation (streak_1m)</div>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Streak</th>
                      <th style={s.th}>n</th>
                      <th style={s.th}>Rev 5m</th>
                      <th style={s.th}>Rev 1h</th>
                      <th style={s.th}>Cont +1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stats.byTiming.map(r => (
                      <tr key={r.absStreak}>
                        <td style={s.td}>{r.absStreak}</td>
                        <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                        <td style={s.td}>{pct(r.reversal5mRate)}</td>
                        <td style={s.td}>{pct(r.reversal1hRate)}</td>
                        <td style={s.td}>{pct(r.contRate)}</td>
                      </tr>
                    ))}
                    {result.stats.byTiming.length === 0 && (
                      <tr><td colSpan={5} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Volume */}
              <div style={s.card}>
                <div style={{ ...s.heading, marginBottom: 8 }}>Volume effect (streak ≥ 3)</div>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Vol</th>
                      <th style={s.th}>n</th>
                      <th style={s.th}>Rev %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stats.byVolume.map(r => (
                      <tr key={r.bucket}>
                        <td style={s.td}>{r.bucket}</td>
                        <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                        <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                      </tr>
                    ))}
                    {result.stats.byVolume.length === 0 && (
                      <tr><td colSpan={3} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Combo */}
              <div style={s.card}>
                <div style={{ ...s.heading, marginBottom: 8 }}>1m vs 5m combo</div>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={s.th}>Combo</th>
                      <th style={s.th}>n</th>
                      <th style={s.th}>Rev %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stats.byCombo.map(r => (
                      <tr key={r.combo}>
                        <td style={s.td}>{r.combo}</td>
                        <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                        <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                      </tr>
                    ))}
                    {result.stats.byCombo.length === 0 && (
                      <tr><td colSpan={3} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Cross-tab ── */}
          <div style={s.section}>
            <div style={s.heading}>Cross-tabulation — streak_5m × volume × alignment (sorted by reversal rate)</div>
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>streak_5m</th>
                    <th style={s.th}>Volume</th>
                    <th style={s.th}>1m vs 5m</th>
                    <th style={s.th}>n</th>
                    <th style={s.th}>Reversal 1h</th>
                    <th style={s.th}>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stats.crossTab.map((r, i) => {
                    const edge = Math.abs(r.reversalRate - 0.5);
                    const signal = r.reversalRate >= 0.58 ? '↩ reversal'
                                 : r.reversalRate <= 0.42 ? '→ continuation'
                                 : '— neutral';
                    const sigColor = r.reversalRate >= 0.58 ? '#3fb950'
                                   : r.reversalRate <= 0.42 ? '#f85149'
                                   : '#8b949e';
                    return (
                      <tr key={i} style={{ opacity: edge < 0.04 ? 0.5 : 1 }}>
                        <td style={{ ...s.td, fontFamily: 'monospace' }}>{r.streak5mRange}</td>
                        <td style={s.td}>{r.volBucket}</td>
                        <td style={s.td}>{r.alignment}</td>
                        <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                        <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                        <td style={{ ...s.td, color: sigColor, fontSize: 12, fontWeight: 600 }}>{signal}</td>
                      </tr>
                    );
                  })}
                  {result.stats.crossTab.length === 0 && (
                    <tr><td colSpan={6} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#8b949e', marginTop: 8 }}>
                Rows with edge &lt; 4% from 50% are dimmed. Reversal ≥58% = reversal signal. ≤42% = continuation signal.
              </div>
            </div>
          </div>

          {/* ── Streak_5m × Volume bucket ── */}
          <div style={s.section}>
            <div style={s.heading}>Streak_5m × volume bucket — quantifies volBoost effect</div>
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>|streak_5m|</th>
                    <th style={s.th}>Volume</th>
                    <th style={s.th}>n</th>
                    <th style={s.th}>Reversal 1h</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stats.byStreakVolume.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...s.td, fontFamily: 'monospace' }}>{r.absStreak5m}</td>
                      <td style={s.td}>{r.volBucket}</td>
                      <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                      <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                    </tr>
                  ))}
                  {result.stats.byStreakVolume.length === 0 && (
                    <tr><td colSpan={4} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#8b949e', marginTop: 8 }}>
                Compare rows with same |streak_5m| across volume buckets — lift in reversal rate = evidence for volBoost.
              </div>
            </div>
          </div>

          {/* ── Streak_5m × Liquidity break ── */}
          <div style={s.section}>
            <div style={s.heading}>Streak_5m × liquidity break — quantifies liqBoost effect</div>
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>|streak_5m|</th>
                    <th style={s.th}>Broke liq?</th>
                    <th style={s.th}>n</th>
                    <th style={s.th}>Reversal 1h</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stats.byLiqBreak.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...s.td, fontFamily: 'monospace' }}>{r.absStreak5m}</td>
                      <td style={{ ...s.td, color: r.brokeLiq ? '#3fb950' : '#8b949e' }}>
                        {r.brokeLiq ? '✓ yes' : '✗ no'}
                      </td>
                      <td style={{ ...s.td, color: '#8b949e' }}>{r.total.toLocaleString()}</td>
                      <td style={s.td}><RateBar rate={r.reversalRate} /></td>
                    </tr>
                  ))}
                  {result.stats.byLiqBreak.length === 0 && (
                    <tr><td colSpan={4} style={{ ...s.td, color: '#8b949e' }}>No data</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#8b949e', marginTop: 8 }}>
                broke_liq=true when candle wick pierced prior 4h/24h high/low or $500 round number.
                Lift in reversal rate when true = evidence for liqBoost.
              </div>
            </div>
          </div>

          {/* ── AI Suggestions ── */}
          <div style={s.section}>
            <div style={s.heading}>AI Suggested Weights</div>
            <div style={s.card}>
              {/* Weights (scalar only — thresholdByStreak rendered separately below) */}
              <div style={{ marginBottom: 20 }}>
                {(Object.keys(WEIGHT_LABELS) as (keyof FormulaWeights)[]).map(key => {
                  if (key === 'thresholdByStreak') return null;
                  const val = result.suggestedWeights[key];
                  if (val === undefined || typeof val !== 'number') return null;
                  return (
                    <div key={key} style={s.weight}>
                      <span style={s.wKey}>{WEIGHT_LABELS[key]}</span>
                      <span style={s.wVal}>{val.toFixed(2)}</span>
                      <span style={s.wReason}>{result.reasoning?.[key] ?? ''}</span>
                    </div>
                  );
                })}
              </div>

              {/* Per-streak_5m threshold grid (compared with observed reversal rate) */}
              {result.suggestedWeights.thresholdByStreak
                && Object.keys(result.suggestedWeights.thresholdByStreak).length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ ...s.heading, marginBottom: 8 }}>
                    Per-|streak_5m| threshold — suggested vs observed reversal
                  </div>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>|streak_5m|</th>
                        <th style={s.th}>Suggested threshold</th>
                        <th style={s.th}>Observed reversal 1h</th>
                        <th style={s.th}>n</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(result.suggestedWeights.thresholdByStreak)
                        .map(([k, v]) => [Number(k), v as number] as const)
                        .sort((a, b) => a[0] - b[0])
                        .map(([lvl, thr]) => {
                          const obs = result.stats.byStreak5m.find(r => r.absStreak === lvl);
                          return (
                            <tr key={lvl}>
                              <td style={{ ...s.td, fontFamily: 'monospace' }}>{lvl}</td>
                              <td style={{ ...s.td, fontFamily: 'monospace', color: '#79c0ff', fontWeight: 700 }}>
                                {thr.toFixed(2)}
                              </td>
                              <td style={s.td}>
                                {obs ? <RateBar rate={obs.reversalRate} /> : <span style={{ color: '#8b949e' }}>—</span>}
                              </td>
                              <td style={{ ...s.td, color: '#8b949e' }}>
                                {obs ? obs.total.toLocaleString() : '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  {result.reasoning?.thresholdByStreak && (
                    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 8 }}>
                      {result.reasoning.thresholdByStreak}
                    </div>
                  )}
                </div>
              )}

              {/* Insights */}
              <div style={{ ...s.heading, marginBottom: 8 }}>Key Insights</div>
              {(result.insights ?? []).map((ins, i) => (
                <div key={i} style={s.insight}>{ins}</div>
              ))}

              {/* Apply button */}
              <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={configName}
                  onChange={e => setConfigName(e.target.value)}
                  placeholder={defaultName()}
                  disabled={saved}
                  style={{
                    flex: 1, minWidth: 240, padding: '6px 10px', borderRadius: 6,
                    border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13,
                  }}
                />
                <button
                  style={{ ...s.btn, ...s.btnGrn, whiteSpace: 'nowrap' }}
                  onClick={handleApply}
                  disabled={saving || saved}
                >
                  {saving ? 'Saving…' : saved ? '✓ Saved' : '+ Save as new config'}
                </button>
                {saved && (
                  <span style={{ fontSize: 12, color: '#3fb950' }}>
                    Go to Backtest → Formula tab to activate it
                  </span>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
