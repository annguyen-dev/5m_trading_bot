/**
 * CoinsPage — per-coin strategy config.
 *
 * Backed by GET/PUT /api/coin-configs. Each row tracks its own dirty state;
 * Save button enabled only when row has unsaved changes.
 *
 * Caveat: PriceMonitoringWorker loads enabled coins once at start. Enabling
 * a new coin here does NOT take effect until backend restart — shown as
 * a banner at the bottom.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, type CoinConfigRow, type CoinMode } from '../api/client.js';

export default function CoinsPage() {
  const [rows,  setRows]  = useState<CoinConfigRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.getCoinConfigs()); setError(null); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!rows) {
    return (
      <div style={S.page}>
        <div style={S.heading}>Coins</div>
        <div style={{ color: '#8b949e' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.heading}>Per-coin strategy config</div>
      <div style={S.subheading}>
        Enable/disable coins, set mode (signal-only vs auto-order), and tune
        streak threshold + sizing per symbol. Streak strategy only for now.
      </div>
      {error && <div style={S.errorBar}>{error}</div>}

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Coin</th>
              <th style={S.th}>Enabled</th>
              <th style={S.th}>Mode</th>
              <th style={{ ...S.th, textAlign: 'right' }} title="Emit T+4 signal when |streak| ≥ this">Signal ≥</th>
              <th style={{ ...S.th, textAlign: 'right' }} title="Place order at T-30s when |streak| ≥ this">Auto ≥</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Size $</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Limit ¢</th>
              <th style={{ ...S.th, textAlign: 'right' }}>TP ¢</th>
              <th style={{ ...S.th, textAlign: 'right' }}>SL ¢</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <CoinRow key={row.symbol} initial={row} onSaved={load} />
            ))}
          </tbody>
        </table>
      </div>

      <div style={S.note}>
        ℹ Worker sync coin list mỗi 5s — bật/tắt coin hoặc đổi mode/streak_min
        sẽ có hiệu lực trong 1 tick tiếp theo, <strong>không cần restart</strong>.
      </div>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function CoinRow({
  initial, onSaved,
}: {
  initial: CoinConfigRow;
  onSaved: () => void;
}) {
  const [draft,   setDraft]  = useState<CoinConfigRow>(initial);
  const [saving,  setSaving] = useState(false);
  const [err,     setErr]    = useState<string | null>(null);
  const [flash,   setFlash]  = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);

  const dirty =
       draft.enabled               !== initial.enabled
    || draft.mode                  !== initial.mode
    || draft.streak_min            !== initial.streak_min
    || draft.auto_order_min_streak !== initial.auto_order_min_streak
    || draft.size_usdc             !== initial.size_usdc
    || draft.limit_price_cents     !== initial.limit_price_cents
    || draft.tp_cents              !== initial.tp_cents
    || draft.sl_cents              !== initial.sl_cents;

  const valid =
       draft.streak_min            >= 1 && draft.streak_min            <= 20
    && draft.auto_order_min_streak >= 1 && draft.auto_order_min_streak <= 20
    && draft.size_usdc              > 0 && draft.size_usdc            <= 10_000
    && draft.limit_price_cents     >= 1 && draft.limit_price_cents     <= 99
    && draft.tp_cents              >= 1 && draft.tp_cents              <= 99
    && draft.sl_cents              >= 1 && draft.sl_cents              <= 99
    && draft.tp_cents > draft.sl_cents
    && draft.auto_order_min_streak >= draft.streak_min;

  async function save() {
    if (!dirty || !valid) return;
    setSaving(true); setErr(null);
    try {
      await api.updateCoinConfig(draft.symbol, {
        enabled:               draft.enabled,
        mode:                  draft.mode,
        streak_min:            draft.streak_min,
        auto_order_min_streak: draft.auto_order_min_streak,
        size_usdc:             draft.size_usdc,
        limit_price_cents:     draft.limit_price_cents,
        tp_cents:              draft.tp_cents,
        sl_cents:              draft.sl_cents,
      });
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(String(e).replace(/^Error: API [^:]+: \d+: /, ''));
    } finally { setSaving(false); }
  }

  const rowBg = draft.enabled ? '#0d1117' : '#0a0d12';

  return (
    <>
      <tr style={{ background: rowBg }}>
        <td style={{ ...S.td, fontWeight: 600, color: draft.enabled ? '#c9d1d9' : '#6e7681' }}>
          {draft.symbol}
        </td>
        <td style={S.td}>
          <Toggle
            checked={draft.enabled}
            onChange={v => setDraft({ ...draft, enabled: v })}
            disabled={saving}
          />
        </td>
        <td style={S.td}>
          <select
            value={draft.mode}
            onChange={e => setDraft({ ...draft, mode: e.target.value as CoinMode })}
            disabled={saving || !draft.enabled}
            style={S.select}
          >
            <option value="signal_only">signal_only</option>
            <option value="signal_and_order">signal_and_order</option>
          </select>
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.streak_min}
            min={1} max={20}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, streak_min: v })}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.auto_order_min_streak}
            min={1} max={20}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, auto_order_min_streak: v })}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.size_usdc}
            min={1} max={10_000}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, size_usdc: v })}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.limit_price_cents}
            min={1} max={99}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, limit_price_cents: v })}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.tp_cents}
            min={1} max={99}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, tp_cents: v })}
          />
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.sl_cents}
            min={1} max={99}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, sl_cents: v })}
          />
        </td>
        <td style={S.td}>
          <button
            onClick={save}
            disabled={!dirty || !valid || saving}
            style={{
              ...S.saveBtn,
              background: dirty && valid ? '#1f6feb' : '#21262d',
              color:      dirty && valid ? '#fff' : '#8b949e',
              cursor:     dirty && valid && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? '…' : dirty ? 'Save' : (flash ? '✓' : '—')}
          </button>
        </td>
      </tr>
      {err && (
        <tr>
          <td colSpan={10} style={{ ...S.td, color: '#f85149', fontSize: 11 }}>
            {err}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tiny inputs ─────────────────────────────────────────────────────────────

function Toggle({
  checked, onChange, disabled,
}: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none',
        background: checked ? '#3fb950' : '#30363d',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 8, background: '#fff',
        transition: 'left 0.15s',
      }} />
    </button>
  );
}

function NumInput({
  value, onChange, min, max, disabled,
}: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; disabled?: boolean;
}) {
  const inRange = value >= min && value <= max && Number.isFinite(value);
  return (
    <input
      type="number"
      min={min} max={max}
      value={Number.isNaN(value) ? '' : value}
      onChange={e => onChange(Number(e.target.value))}
      disabled={disabled}
      style={{
        ...S.numInput,
        borderColor: inRange ? '#30363d' : '#f85149',
        opacity: disabled ? 0.5 : 1,
      }}
    />
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 },
  heading:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subheading: { fontSize: 13, color: '#8b949e', marginTop: -4 },
  errorBar:   { color: '#f85149', padding: '8px 12px', background: '#21262d',
                borderRadius: 6, fontSize: 13 },

  tableWrap:  { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, overflow: 'hidden' },
  table:      { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:         { padding: '10px 12px', textAlign: 'left' as const, fontWeight: 600,
                color: '#8b949e', fontSize: 12, borderBottom: '1px solid #30363d',
                background: '#0d1117' },
  td:         { padding: '8px 12px', borderBottom: '1px solid #21262d', color: '#c9d1d9' },

  select:     { background: '#0d1117', color: '#c9d1d9', border: '1px solid #30363d',
                borderRadius: 4, padding: '4px 6px', fontSize: 12 },
  numInput:   { width: 60, padding: '4px 6px', background: '#0d1117',
                border: '1px solid #30363d', color: '#c9d1d9', borderRadius: 4,
                fontSize: 12, textAlign: 'right' as const },
  saveBtn:    { padding: '4px 12px', borderRadius: 4, border: 'none',
                fontSize: 12, fontWeight: 600, minWidth: 56 },

  note:       { fontSize: 12, color: '#79c0ff', background: '#0d1f33',
                border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 12px',
                marginTop: 8 },
};
