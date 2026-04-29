/**
 * SettingsPage — bot configuration.
 *
 * Sections:
 *   1. Per-coin strategy config  (backed by /api/coin-configs)
 *   2. Telegram channels routing (backed by /api/telegram-channels)
 *
 * Each section is independently loaded and saved.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  api,
  type CoinConfigRow, type CoinMode, type AutoScheduleEntry,
  type TelegramChannel, type TelegramInfoType, type CoinSymbol,
} from '../api/client.js';

const ALL_COINS: CoinSymbol[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB'];

export default function SettingsPage() {
  const [rows,  setRows]  = useState<CoinConfigRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.getCoinConfigs()); setError(null); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.page}>
      <div style={S.heading}>Per-coin strategy config</div>
      <div style={S.subheading}>
        Enable/disable coins, set mode (signal-only vs auto-order), and tune
        streak threshold + sizing per symbol. Streak strategy only for now.
      </div>
      {error && <div style={S.errorBar}>{error}</div>}

      {rows ? (
        <>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Coin</th>
                  <th style={S.th}>Enabled</th>
                  <th style={S.th}>Mode</th>
                  <th style={{ ...S.th, textAlign: 'right' }} title="Emit T+4 signal when |streak| ≥ this">Signal ≥</th>
                  <th style={{ ...S.th, textAlign: 'right' }} title="Place order at T-3s when |streak| ≥ this">Auto ≥</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Size $</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Limit ¢</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>TP ¢</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>SL ¢</th>
                  <th style={{ ...S.th, textAlign: 'right' }} title="DCA size = previous_loser_size × this. Default 1.5">DCA mult</th>
                  <th style={S.th} title="Hour-of-day (UTC) overrides for Auto ≥. Empty = always use base.">Schedule</th>
                  <th style={S.th} title="DCA fires only when parent boundary streak matches one of these. Empty = always.">DCA streaks</th>
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
        </>
      ) : (
        <div style={{ color: '#8b949e' }}>Loading…</div>
      )}

      <TelegramChannelsSection />
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
  const [draft,           setDraft]           = useState<CoinConfigRow>(initial);
  const [saving,          setSaving]          = useState(false);
  const [err,             setErr]             = useState<string | null>(null);
  const [flash,           setFlash]           = useState(false);
  const [scheduleOpen,    setScheduleOpen]    = useState(false);
  const [dcaOpen,         setDcaOpen]         = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);

  // Array equality via JSON stringify is sufficient for the schedule shape
  // (small, flat). Falls back to string compare, O(n) per row.
  const scheduleDirty =
    JSON.stringify(draft.auto_schedule ?? []) !== JSON.stringify(initial.auto_schedule ?? []);
  const dcaWhitelistDirty =
    JSON.stringify([...(draft.dca_streak_whitelist ?? [])].sort())
      !== JSON.stringify([...(initial.dca_streak_whitelist ?? [])].sort());

  const dirty =
       draft.enabled               !== initial.enabled
    || draft.mode                  !== initial.mode
    || draft.streak_min            !== initial.streak_min
    || draft.auto_order_min_streak !== initial.auto_order_min_streak
    || draft.size_usdc             !== initial.size_usdc
    || draft.limit_price_cents     !== initial.limit_price_cents
    || draft.tp_cents              !== initial.tp_cents
    || draft.sl_cents              !== initial.sl_cents
    || draft.dca_multiplier        !== initial.dca_multiplier
    || scheduleDirty
    || dcaWhitelistDirty;

  const scheduleValid = (draft.auto_schedule ?? []).every(e =>
       Number.isInteger(e.start_hour)     && e.start_hour     >= 0 && e.start_hour     <= 23
    && Number.isInteger(e.duration_hours) && e.duration_hours >= 1 && e.duration_hours <= 24
    && Number.isInteger(e.threshold)      && e.threshold      >= 1 && e.threshold      <= 20,
  );

  const valid =
       draft.streak_min            >= 1 && draft.streak_min            <= 20
    && draft.auto_order_min_streak >= 1 && draft.auto_order_min_streak <= 20
    && draft.size_usdc              > 0 && draft.size_usdc            <= 10_000
    && draft.limit_price_cents     >= 1 && draft.limit_price_cents     <= 99
    && draft.tp_cents              >= 1 && draft.tp_cents              <= 99
    && draft.sl_cents              >= 1 && draft.sl_cents              <= 99
    && draft.dca_multiplier        >= 1.0 && draft.dca_multiplier      <= 10.0
    && draft.tp_cents > draft.sl_cents
    && draft.auto_order_min_streak >= draft.streak_min
    && scheduleValid;

  async function save() {
    if (!dirty || !valid) return;
    setSaving(true); setErr(null);
    try {
      await api.updateCoinConfig(draft.symbol, {
        enabled:               draft.enabled,
        mode:                  draft.mode,
        streak_min:            draft.streak_min,
        auto_order_min_streak: draft.auto_order_min_streak,
        auto_schedule:         draft.auto_schedule ?? [],
        size_usdc:             draft.size_usdc,
        limit_price_cents:     draft.limit_price_cents,
        tp_cents:              draft.tp_cents,
        sl_cents:              draft.sl_cents,
        dca_multiplier:        draft.dca_multiplier,
        dca_streak_whitelist:  [...(draft.dca_streak_whitelist ?? [])].sort((a, b) => a - b),
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
        <td style={{ ...S.td, textAlign: 'right' }}>
          <NumInput
            value={draft.dca_multiplier}
            min={1.0} max={10.0} step={0.1}
            disabled={saving || !draft.enabled}
            onChange={v => setDraft({ ...draft, dca_multiplier: v })}
          />
        </td>
        <td style={S.td}>
          <button
            onClick={() => setScheduleOpen(o => !o)}
            disabled={saving || !draft.enabled}
            style={{
              ...S.scheduleBtn,
              borderColor: scheduleDirty ? '#58a6ff' : '#30363d',
              color: (draft.auto_schedule?.length ?? 0) > 0 ? '#c9d1d9' : '#6e7681',
            }}
            title={scheduleTitle(draft.auto_schedule ?? [])}
          >
            {scheduleOpen ? '▾' : '▸'}
            &nbsp;{scheduleSummary(draft.auto_schedule ?? [])}
          </button>
        </td>
        <td style={S.td}>
          <button
            onClick={() => setDcaOpen(o => !o)}
            disabled={saving || !draft.enabled}
            style={{
              ...S.scheduleBtn,
              borderColor: dcaWhitelistDirty ? '#58a6ff' : '#30363d',
              color: (draft.dca_streak_whitelist?.length ?? 0) > 0 ? '#c9d1d9' : '#6e7681',
            }}
            title={
              (draft.dca_streak_whitelist?.length ?? 0) > 0
                ? `DCA fires only at parent streak: ${draft.dca_streak_whitelist!.join(', ')}`
                : 'DCA fires on every loss (no whitelist)'
            }
          >
            {dcaOpen ? '▾' : '▸'}
            &nbsp;{(draft.dca_streak_whitelist?.length ?? 0) === 0
              ? '—'
              : draft.dca_streak_whitelist!.join(',')}
          </button>
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
      {scheduleOpen && (
        <tr style={{ background: '#0a0d12' }}>
          <td colSpan={13} style={{ padding: '12px 24px', borderBottom: '1px solid #21262d' }}>
            <ScheduleEditor
              value={draft.auto_schedule ?? []}
              baseThreshold={draft.auto_order_min_streak}
              disabled={saving || !draft.enabled}
              onChange={s => setDraft({ ...draft, auto_schedule: s })}
            />
          </td>
        </tr>
      )}
      {dcaOpen && (
        <tr style={{ background: '#0a0d12' }}>
          <td colSpan={13} style={{ padding: '12px 24px', borderBottom: '1px solid #21262d' }}>
            <DcaWhitelistEditor
              value={draft.dca_streak_whitelist ?? []}
              disabled={saving || !draft.enabled}
              onChange={ws => setDraft({ ...draft, dca_streak_whitelist: ws })}
            />
          </td>
        </tr>
      )}
      {err && (
        <tr>
          <td colSpan={13} style={{ ...S.td, color: '#f85149', fontSize: 11 }}>
            {err}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Schedule editor ─────────────────────────────────────────────────────────

// User picks hours in LOCAL timezone. Backend stores UTC (bot checks
// `new Date().getUTCHours()`). Integer offset assumed — fractional timezones
// (e.g. India +5:30) round to nearest hour for display; bot still fires on
// the UTC boundary.
const TZ_HOURS = Math.round(-new Date().getTimezoneOffset() / 60);
const TZ_LABEL = `UTC${TZ_HOURS >= 0 ? '+' : ''}${TZ_HOURS}`;

function utcToLocalHour(utc: number): number {
  return ((utc + TZ_HOURS) % 24 + 24) % 24;
}
function localToUtcHour(local: number): number {
  return ((local - TZ_HOURS) % 24 + 24) % 24;
}

/** Compact summary shown on the Schedule column button. "—" | "08-10h→3" | "2 rules". */
function scheduleSummary(entries: AutoScheduleEntry[]): string {
  if (!entries.length) return '—';
  if (entries.length === 1) {
    const e = entries[0]!;
    const sLocal = utcToLocalHour(e.start_hour);
    const eLocal = (sLocal + e.duration_hours) % 24;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(sLocal)}-${pad(eLocal)}h→${e.threshold}`;
  }
  return `${entries.length} rules`;
}

/** Tooltip lists each rule in local time so the user doesn't have to expand. */
function scheduleTitle(entries: AutoScheduleEntry[]): string {
  if (!entries.length) return 'No schedule — base threshold used all day';
  const pad = (n: number) => String(n).padStart(2, '0');
  return entries.map(e => {
    const sLocal = utcToLocalHour(e.start_hour);
    const eLocal = (sLocal + e.duration_hours) % 24;
    return `${pad(sLocal)}-${pad(eLocal)}h (${TZ_LABEL}) → Auto ≥ ${e.threshold}`;
  }).join('\n');
}

function ScheduleEditor({
  value, baseThreshold, onChange, disabled,
}: {
  value:         AutoScheduleEntry[];
  baseThreshold: number;
  onChange:      (next: AutoScheduleEntry[]) => void;
  disabled?:     boolean;
}) {
  const add = () => onChange([
    ...value,
    {
      // Default: "now" in local time → convert to UTC for storage.
      start_hour: localToUtcHour(new Date().getHours()),
      duration_hours: 2,
      threshold: Math.max(1, baseThreshold - 2),
    },
  ]);
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const patchAt = (i: number, patch: Partial<AutoScheduleEntry>) =>
    onChange(value.map((e, idx) => idx === i ? { ...e, ...patch } : e));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#8b949e' }}>
        Hour-of-day (<b>{TZ_LABEL}</b>, your local time) overrides for <b>Auto ≥</b>.
        Each rule: during the window, use <b>threshold</b> instead of the base
        value ({baseThreshold}). Ranges wrap midnight (e.g. 22h + 4h covers 22, 23,
        00, 01). First match wins. Stored internally as UTC.
      </div>
      {value.length === 0 && (
        <div style={{ fontSize: 12, color: '#6e7681', fontStyle: 'italic' }}>
          No rules — base <b>Auto ≥ {baseThreshold}</b> used all day.
        </div>
      )}
      {value.length > 0 && (
        <table style={{ ...S.table, maxWidth: 620 }}>
          <thead>
            <tr>
              <th style={{ ...S.th, textAlign: 'right' }} title="0-23 local">Start h ({TZ_LABEL})</th>
              <th style={{ ...S.th, textAlign: 'right' }} title="1-24">Duration (h)</th>
              <th style={{ ...S.th, textAlign: 'right' }} title="1-20">Threshold (Auto ≥)</th>
              <th style={{ ...S.th, width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {value.map((entry, i) => {
              const startLocal = utcToLocalHour(entry.start_hour);
              const endLocal   = (startLocal + entry.duration_hours) % 24;
              const endUtc     = (entry.start_hour + entry.duration_hours) % 24;
              return (
                <tr key={i}>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <NumInput
                      value={startLocal} min={0} max={23}
                      disabled={disabled}
                      onChange={v => patchAt(i, { start_hour: localToUtcHour(v) })}
                    />
                    <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 6 }}>
                      → {String(endLocal).padStart(2, '0')}h
                      <span style={{ color: '#484f58', marginLeft: 6 }}>
                        (UTC {String(entry.start_hour).padStart(2, '0')}-{String(endUtc).padStart(2, '0')})
                      </span>
                    </span>
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <NumInput
                      value={entry.duration_hours} min={1} max={24}
                      disabled={disabled}
                      onChange={v => patchAt(i, { duration_hours: v })}
                    />
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <NumInput
                      value={entry.threshold} min={1} max={20}
                      disabled={disabled}
                      onChange={v => patchAt(i, { threshold: v })}
                    />
                  </td>
                  <td style={S.td}>
                    <button
                      onClick={() => removeAt(i)}
                      disabled={disabled}
                      style={S.removeBtn}
                      title="Remove rule"
                    >×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div>
        <button
          onClick={add}
          disabled={disabled || value.length >= 8}
          style={S.addBtn}
        >
          + Add rule
        </button>
        {value.length >= 8 && (
          <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 8 }}>(max 8)</span>
        )}
      </div>
    </div>
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
  value, onChange, min, max, step, disabled,
}: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; disabled?: boolean;
}) {
  const inRange = value >= min && value <= max && Number.isFinite(value);
  return (
    <input
      type="number"
      min={min} max={max} step={step ?? 1}
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

// ── DCA streak whitelist editor ─────────────────────────────────────────────

/** Range of streak values shown as togglable chips. */
const DCA_STREAK_CHIPS: number[] = Array.from({ length: 14 }, (_, i) => i + 2);   // 2..15

function DcaWhitelistEditor({
  value, onChange, disabled,
}: {
  value:    number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  const set = new Set(value);
  const toggle = (n: number) => {
    if (set.has(n)) set.delete(n); else set.add(n);
    onChange(Array.from(set).sort((a, b) => a - b));
  };
  const clear = () => onChange([]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#8b949e' }}>
        DCA <b>only fires</b> when the parent boundary's |streak| matches one of
        the selected values — at <b>any hour</b>, independent of the schedule.
        <b> None selected</b> = DCA fires on every loss (default).
        Example: BTC <code>4, 6, 9, 10</code> → DCA fires only after a streak-4
        / 6 / 9 / 10 boundary loss.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {DCA_STREAK_CHIPS.map(n => {
          const on = set.has(n);
          return (
            <button
              key={n}
              onClick={() => toggle(n)}
              disabled={disabled}
              style={{
                ...S.chip,
                background: on ? '#3fb950' : 'transparent',
                color:      on ? '#fff'    : '#8b949e',
                borderColor: on ? '#3fb950' : '#30363d',
                minWidth: 30,
              }}
              title={on ? `Remove streak ${n}` : `Add streak ${n}`}
            >
              {n}
            </button>
          );
        })}
        {value.length > 0 && (
          <button
            onClick={clear}
            disabled={disabled}
            style={{ ...S.chip, color: '#f85149', borderColor: '#30363d', marginLeft: 6 }}
            title="Clear all (= DCA fires on every loss)"
          >
            clear
          </button>
        )}
        {value.length === 0 && (
          <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 8, fontStyle: 'italic' }}>
            (none — DCA always fires on loss)
          </span>
        )}
      </div>
    </div>
  );
}

// ── Telegram channels section ─────────────────────────────────────────────

function uid(): string {
  // lightweight id; fine for local row keys + server uniqueness check
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function TelegramChannelsSection() {
  const [draft,  setDraft]  = useState<TelegramChannel[] | null>(null);
  const [saved,  setSaved]  = useState<TelegramChannel[] | null>(null);  // last server state, for dirty compare
  const [err,    setErr]    = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash,  setFlash]  = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.getTelegramChannels();
      setDraft(list); setSaved(list); setErr(null);
    } catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!draft || !saved) {
    return (
      <>
        <div style={{ ...S.heading, marginTop: 24 }}>Telegram channels</div>
        <div style={{ color: '#8b949e' }}>{err ?? 'Loading…'}</div>
      </>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const valid = draft.every(ch =>
       ch.id.length > 0 && ch.channel_id.trim().length > 0 && ch.name.length <= 100,
  );

  function addChannel() {
    setDraft([
      ...(draft ?? []),
      { id: uid(), name: '', channel_id: '', enabled: true, coins: [], info_types: [] },
    ]);
  }
  function removeChannel(id: string) {
    setDraft((draft ?? []).filter(c => c.id !== id));
  }
  function patchChannel(id: string, patch: Partial<TelegramChannel>) {
    setDraft((draft ?? []).map(c => c.id === id ? { ...c, ...patch } : c));
  }

  async function save() {
    if (!dirty || !valid || !draft) return;
    setSaving(true); setErr(null);
    try {
      const next = await api.saveTelegramChannels(draft);
      setSaved(next); setDraft(next);
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
    } catch (e) {
      setErr(String(e).replace(/^Error: API [^:]+: \d+: /, ''));
    } finally { setSaving(false); }
  }

  return (
    <>
      <div style={{ ...S.heading, marginTop: 24 }}>Telegram channels</div>
      <div style={S.subheading}>
        Gửi tin nhắn tới nhiều channel với filter theo coin + loại thông tin.
        Bỏ trống <b>Coins</b> = nhận tất cả coins. Bỏ trống <b>Info</b> = nhận cả
        signal và order. Info mapping: <code>signal</code> = T+4, <code>order</code>
        = T+0 / T-3s / T-0. Bot cần <code>TELEGRAM_TOKEN</code> trong .env.
      </div>
      {err && <div style={S.errorBar}>{err}</div>}

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Enabled</th>
              <th style={S.th}>Name</th>
              <th style={S.th} title="Telegram chat/channel ID (e.g. -1001234567890)">Channel ID</th>
              <th style={S.th}>Coins</th>
              <th style={S.th}>Info</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {draft.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...S.td, color: '#6e7681', fontStyle: 'italic', padding: 20, textAlign: 'center' }}>
                  Chưa có channel. Tin nhắn rơi vào fallback <code>TELEGRAM_CHANNEL_ID</code>
                  trong .env (nếu set). Thêm channel để route.
                </td>
              </tr>
            )}
            {draft.map(ch => (
              <TelegramChannelRow
                key={ch.id}
                value={ch}
                onChange={p => patchChannel(ch.id, p)}
                onRemove={() => removeChannel(ch.id)}
                disabled={saving}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={addChannel}
          disabled={saving || draft.length >= 32}
          style={S.addBtn}
        >
          + Add channel
        </button>
        <button
          onClick={save}
          disabled={!dirty || !valid || saving}
          style={{
            ...S.saveBtn,
            background: dirty && valid ? '#1f6feb' : '#21262d',
            color:      dirty && valid ? '#fff'    : '#8b949e',
            cursor:     dirty && valid && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : dirty ? 'Save channels' : (flash ? '✓ Saved' : 'No changes')}
        </button>
        {!valid && <span style={{ fontSize: 12, color: '#f85149' }}>Check required fields</span>}
      </div>
    </>
  );
}

function TelegramChannelRow({
  value, onChange, onRemove, disabled,
}: {
  value:    TelegramChannel;
  onChange: (patch: Partial<TelegramChannel>) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const toggleCoin = (c: CoinSymbol) => {
    const has = value.coins.includes(c);
    onChange({ coins: has ? value.coins.filter(x => x !== c) : [...value.coins, c] });
  };
  const toggleInfo = (i: TelegramInfoType) => {
    const has = value.info_types.includes(i);
    onChange({ info_types: has ? value.info_types.filter(x => x !== i) : [...value.info_types, i] });
  };

  const idValid = value.channel_id.trim().length > 0;

  return (
    <tr>
      <td style={S.td}>
        <Toggle
          checked={value.enabled}
          onChange={v => onChange({ enabled: v })}
          disabled={disabled}
        />
      </td>
      <td style={S.td}>
        <input
          type="text"
          value={value.name}
          placeholder="Label"
          disabled={disabled}
          onChange={e => onChange({ name: e.target.value })}
          style={{ ...S.textInput, width: 160 }}
        />
      </td>
      <td style={S.td}>
        <input
          type="text"
          value={value.channel_id}
          placeholder="-100123…"
          disabled={disabled}
          onChange={e => onChange({ channel_id: e.target.value })}
          style={{
            ...S.textInput, width: 180,
            borderColor: idValid ? '#30363d' : '#f85149',
          }}
        />
      </td>
      <td style={S.td}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {ALL_COINS.map(c => {
            const on = value.coins.includes(c);
            return (
              <button
                key={c}
                onClick={() => toggleCoin(c)}
                disabled={disabled}
                style={{
                  ...S.chip,
                  background: on ? '#1f6feb' : 'transparent',
                  color:      on ? '#fff'    : '#8b949e',
                  borderColor: on ? '#1f6feb' : '#30363d',
                }}
                title={on ? `Remove ${c}` : `Add ${c}`}
              >
                {c}
              </button>
            );
          })}
          {value.coins.length === 0 && (
            <span style={{ fontSize: 11, color: '#6e7681', alignSelf: 'center', marginLeft: 4 }}>
              (all)
            </span>
          )}
        </div>
      </td>
      <td style={S.td}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['signal', 'order'] as TelegramInfoType[]).map(i => {
            const on = value.info_types.includes(i);
            return (
              <button
                key={i}
                onClick={() => toggleInfo(i)}
                disabled={disabled}
                style={{
                  ...S.chip,
                  background: on ? '#3fb950' : 'transparent',
                  color:      on ? '#fff'    : '#8b949e',
                  borderColor: on ? '#3fb950' : '#30363d',
                }}
              >
                {i}
              </button>
            );
          })}
          {value.info_types.length === 0 && (
            <span style={{ fontSize: 11, color: '#6e7681', alignSelf: 'center', marginLeft: 4 }}>
              (all)
            </span>
          )}
        </div>
      </td>
      <td style={S.td}>
        <button
          onClick={onRemove}
          disabled={disabled}
          style={S.removeBtn}
          title="Remove channel"
        >×</button>
      </td>
    </tr>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 },
  heading:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subheading: { fontSize: 13, color: '#8b949e', marginTop: -4 },
  errorBar:   { color: '#f85149', padding: '8px 12px', background: '#21262d',
                borderRadius: 6, fontSize: 13 },

  tableWrap:  { background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                overflowX: 'auto' as const, WebkitOverflowScrolling: 'touch' as const },
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
  textInput:  { padding: '4px 8px', background: '#0d1117',
                border: '1px solid #30363d', color: '#c9d1d9', borderRadius: 4,
                fontSize: 12 },
  chip:       { padding: '2px 8px', borderRadius: 12, border: '1px solid #30363d',
                fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  saveBtn:    { padding: '4px 12px', borderRadius: 4, border: 'none',
                fontSize: 12, fontWeight: 600, minWidth: 56 },
  scheduleBtn:{ padding: '4px 10px', borderRadius: 4, border: '1px solid #30363d',
                background: '#0d1117', color: '#c9d1d9', fontSize: 12, cursor: 'pointer',
                minWidth: 70, textAlign: 'left' as const },
  addBtn:     { padding: '4px 12px', borderRadius: 4, border: '1px solid #30363d',
                background: '#0d1117', color: '#58a6ff', fontSize: 12, cursor: 'pointer' },
  removeBtn:  { padding: '2px 8px', borderRadius: 4, border: '1px solid #30363d',
                background: '#0d1117', color: '#f85149', fontSize: 14, fontWeight: 700,
                cursor: 'pointer', width: 28 },
  subSection: { padding: '12px 14px', background: '#0d1117',
                border: '1px solid #21262d', borderRadius: 6 },

  note:       { fontSize: 12, color: '#79c0ff', background: '#0d1f33',
                border: '1px solid #1e3a5f', borderRadius: 6, padding: '8px 12px',
                marginTop: 8 },
};
