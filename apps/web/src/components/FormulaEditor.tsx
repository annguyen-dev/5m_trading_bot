import React, { useState } from 'react';
import { api, type FormulaConfig, type FormulaWeights } from '../api/client.js';

interface Props {
  configs: FormulaConfig[];
  onConfigsChange: () => void;
}

const DEFAULT_WEIGHTS: FormulaWeights = {
  wKnn: 0.20, wStreak: 0.35, wIntraday: 0.35, wVolume: 0.10,
  confidenceThreshold: 0.58,
  streakScale: 0.10,
  streakCap: 0.85,
};

const s: Record<string, React.CSSProperties> = {
  card:    { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '16px 20px' },
  label:   { fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.05em' },
  row:     { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  key:     { width: 130, fontSize: 13, color: '#c9d1d9', flexShrink: 0 },
  slider:  { flex: 1, accentColor: '#1f6feb' },
  numVal:  { width: 52, textAlign: 'right', fontSize: 13, fontFamily: 'monospace', color: '#79c0ff' },
  btn:     { padding: '6px 14px', borderRadius: 6, border: '1px solid #30363d', cursor: 'pointer', background: '#161b22', color: '#c9d1d9', fontSize: 13 },
  btnPrim: { background: '#1f6feb', borderColor: '#1f6feb', color: '#fff' },
  btnGrn:  { background: '#238636', borderColor: '#238636', color: '#fff' },
  btnDang: { background: 'transparent', borderColor: '#f85149', color: '#f85149' },
  tag:     { fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#1f6feb33', color: '#79c0ff', marginLeft: 6 },
  tagSel:  { fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#1f6feb66', color: '#79c0ff', marginLeft: 6 },
  warn:    { color: '#f0a500', fontSize: 12, marginTop: 4 },
};

function WeightSlider({ label, value, onChange, min = 0, max = 1, step = 0.01, decimals = 2 }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; decimals?: number;
}) {
  return (
    <div style={s.row}>
      <span style={s.key}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        style={s.slider}
        onChange={e => onChange(parseFloat(e.target.value))} />
      <span style={s.numVal}>{value.toFixed(decimals)}</span>
    </div>
  );
}

const STREAK_LEVELS = [4, 5, 6, 7, 8, 9, 10];

function ThresholdByStreakEditor({ map, onChange }: {
  map: Record<number, number>;
  onChange: (m: Record<number, number>) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 12 }}>
      {STREAK_LEVELS.map(lvl => {
        const v = map[lvl];
        return (
          <div key={lvl} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 11, color: '#8b949e' }}>s5m={lvl}</span>
            <input
              type="number"
              min={0.3} max={0.95} step={0.01}
              placeholder="—"
              value={v ?? ''}
              onChange={e => {
                const next = { ...map };
                const s = e.target.value.trim();
                if (s === '') delete next[lvl];
                else {
                  const n = parseFloat(s);
                  if (!Number.isNaN(n)) next[lvl] = n;
                }
                onChange(next);
              }}
              style={{
                width: '100%', padding: '4px 6px', borderRadius: 4,
                border: '1px solid #30363d', background: '#0d1117',
                color: '#79c0ff', fontSize: 12, fontFamily: 'monospace',
                textAlign: 'center',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function FormulaEditor({ configs, onConfigsChange }: Props) {
  const active = configs.find(c => c.is_active);

  // selectedId: which config is loaded in the editor (null = blank new config)
  const [selectedId, setSelectedId] = useState<string | null>(active?.id ?? null);
  const [weights,    setWeights]    = useState<FormulaWeights>(active?.weights ?? DEFAULT_WEIGHTS);
  const [name,       setName]       = useState(active?.name ?? '');
  const [saving,     setSaving]     = useState(false);
  const [err,        setErr]        = useState<string | null>(null);

  const wSum = weights.wKnn + weights.wStreak + weights.wIntraday + weights.wVolume;
  const sumOk = Math.abs(wSum - 1.0) < 0.02;

  function selectConfig(cfg: FormulaConfig) {
    setSelectedId(cfg.id);
    setWeights({ ...cfg.weights });
    setName(cfg.name);
    setErr(null);
  }

  function clearSelection() {
    setSelectedId(null);
    setWeights(DEFAULT_WEIGHTS);
    setName('');
    setErr(null);
  }

  async function handleUpdate() {
    if (!selectedId) return;
    if (!name.trim()) { setErr('Name cannot be empty'); return; }
    if (!sumOk) { setErr(`Weights sum to ${wSum.toFixed(2)}, must be 1.00`); return; }
    setSaving(true); setErr(null);
    try {
      await api.updateFormulaConfig(selectedId, name.trim(), weights);
      onConfigsChange();
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  }

  async function handleSaveNew() {
    if (!name.trim()) { setErr('Enter a config name'); return; }
    if (!sumOk) { setErr(`Weights sum to ${wSum.toFixed(2)}, must be 1.00`); return; }
    setSaving(true); setErr(null);
    try {
      await api.createFormulaConfig(name.trim(), weights);
      onConfigsChange();
      clearSelection();
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  }

  async function handleActivate(id: string) {
    try { await api.activateFormulaConfig(id); onConfigsChange(); }
    catch (e) { setErr(String(e)); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this config?')) return;
    try {
      await api.deleteFormulaConfig(id);
      if (selectedId === id) clearSelection();
      onConfigsChange();
    } catch (e) { setErr(String(e)); }
  }

  return (
    <div>
      {/* Config list */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={s.label}>Saved Configs</span>
          {selectedId && (
            <button style={{ ...s.btn, fontSize: 12, padding: '3px 10px' }} onClick={clearSelection}>
              + New config
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {configs.map(cfg => (
            <div key={cfg.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: 6,
              outline: selectedId === cfg.id ? '2px solid #1f6feb' : 'none',
            }}>
              <button
                style={{ ...s.btn, flex: 1, textAlign: 'left' }}
                onClick={() => selectConfig(cfg)}
              >
                {cfg.name}
                {cfg.is_active && <span style={s.tag}>active</span>}
                {selectedId === cfg.id && <span style={s.tagSel}>editing</span>}
              </button>
              {!cfg.is_active && (
                <button style={s.btn} onClick={() => handleActivate(cfg.id)}>Set active</button>
              )}
              {cfg.id !== 'default' && !cfg.is_active && (
                <button style={{ ...s.btn, ...s.btnDang }} onClick={() => handleDelete(cfg.id)}>✕</button>
              )}
            </div>
          ))}
          {configs.length === 0 && <span style={{ color: '#8b949e', fontSize: 13 }}>No configs yet</span>}
        </div>
      </div>

      {/* Weight editor */}
      <div style={s.card}>
        <div style={{ ...s.label, marginBottom: 12 }}>
          {selectedId ? `Editing: ${name}` : 'New Config'}
        </div>

        <WeightSlider label="kNN"       value={weights.wKnn}      onChange={v => setWeights(w => ({ ...w, wKnn: v }))} />
        <WeightSlider label="Streak"    value={weights.wStreak}   onChange={v => setWeights(w => ({ ...w, wStreak: v }))} />
        <WeightSlider label="Intraday"  value={weights.wIntraday} onChange={v => setWeights(w => ({ ...w, wIntraday: v }))} />
        <WeightSlider label="Volume"    value={weights.wVolume}   onChange={v => setWeights(w => ({ ...w, wVolume: v }))} />
        <WeightSlider label="Threshold" value={weights.confidenceThreshold} onChange={v => setWeights(w => ({ ...w, confidenceThreshold: v }))} min={0.1} max={0.9} />

        <div style={{ ...s.label, margin: '12px 0 8px', borderTop: '1px solid #30363d', paddingTop: 12 }}>
          Streak Formula — P = min(cap, streak × scale + volBoost)
        </div>
        <WeightSlider
          label="Scale (/candle)"
          value={weights.streakScale ?? 0.10}
          onChange={v => setWeights(w => ({ ...w, streakScale: v }))}
          min={0.01} max={0.30} step={0.01}
        />
        <WeightSlider
          label="Cap (max P)"
          value={weights.streakCap ?? 0.85}
          onChange={v => setWeights(w => ({ ...w, streakCap: v }))}
          min={0.50} max={1.00} step={0.01}
        />

        <div style={{ ...s.label, margin: '12px 0 8px', borderTop: '1px solid #30363d', paddingTop: 12 }}>
          Volume Exhaustion Boost (added to pStreak when vol &gt; min & wick &gt; min)
        </div>
        <WeightSlider
          label="Min vol ratio"
          value={weights.volBoostMinRatio ?? 1.5}
          onChange={v => setWeights(w => ({ ...w, volBoostMinRatio: v }))}
          min={1.0} max={3.0} step={0.1} decimals={1}
        />
        <WeightSlider
          label="Min wick"
          value={weights.volBoostMinWick ?? 0.4}
          onChange={v => setWeights(w => ({ ...w, volBoostMinWick: v }))}
          min={0.1} max={0.9} step={0.05}
        />
        <WeightSlider
          label="Gain"
          value={weights.volBoostGain ?? 0.10}
          onChange={v => setWeights(w => ({ ...w, volBoostGain: v }))}
          min={0.0} max={0.30} step={0.01}
        />
        <WeightSlider
          label="Max boost"
          value={weights.volBoostMax ?? 0.15}
          onChange={v => setWeights(w => ({ ...w, volBoostMax: v }))}
          min={0.0} max={0.30} step={0.01}
        />

        <div style={{ ...s.label, margin: '12px 0 8px', borderTop: '1px solid #30363d', paddingTop: 12 }}>
          Liquidity Break Boost (wick pierces 4h/24h high/low or round number)
        </div>
        <WeightSlider
          label="Liq boost"
          value={weights.liqBoost ?? 0.10}
          onChange={v => setWeights(w => ({ ...w, liqBoost: v }))}
          min={0.0} max={0.30} step={0.01}
        />

        <div style={{ ...s.label, margin: '12px 0 8px', borderTop: '1px solid #30363d', paddingTop: 12 }}>
          Per-|streak_5m| threshold (overrides global Threshold above)
        </div>
        <ThresholdByStreakEditor
          map={weights.thresholdByStreak ?? {}}
          onChange={m => setWeights(w => ({ ...w, thresholdByStreak: m }))}
        />

        <div style={{ fontSize: 12, color: sumOk ? '#3fb950' : '#f0a500', marginBottom: 14 }}>
          Weight sum: {wSum.toFixed(2)} {sumOk ? '✓' : '(must equal 1.00)'}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Config name…"
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9', fontSize: 13 }}
          />
          {selectedId && (
            <button
              style={{ ...s.btn, ...s.btnGrn }}
              onClick={handleUpdate}
              disabled={saving || !sumOk}
            >
              {saving ? 'Saving…' : '↑ Update'}
            </button>
          )}
          <button
            style={{ ...s.btn, ...s.btnPrim }}
            onClick={handleSaveNew}
            disabled={saving || !sumOk}
          >
            {saving ? 'Saving…' : '+ Save New'}
          </button>
        </div>
        {err && <div style={{ ...s.warn, marginTop: 8 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}
