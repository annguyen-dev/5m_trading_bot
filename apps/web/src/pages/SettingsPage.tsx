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
  type CoinConfigRow, type CoinMode, type CoinStrategy, type EchoEdgeCase, type AutoScheduleEntry,
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
                  <th style={S.th} title="streak = simple baseline; echo = trade only in arm-window after a high-streak event">Strategy</th>
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
  // Local raw-text state for the DCA scale input. We can't bind directly to
  // `draft.echo_dca_scale.join(',')` because typing a comma triggers
  // parse-then-stringify which strips the trailing "," before the user can
  // type the next digit. Keep the literal string here; sync to draft array on
  // each keystroke (for dirty/valid/save), and re-sync FROM initial when the
  // parent reloads the row (e.g. after a successful save).
  const [scaleStr, setScaleStr] = useState<string>(
    () => (initial.echo_dca_scale ?? []).join(','),
  );
  // Same shadow-string pattern for the IDLE-mode DCA scale input.
  const [scaleStrIdle, setScaleStrIdle] = useState<string>(
    () => (initial.echo_dca_scale_idle ?? []).join(','),
  );
  const [dcaOpen,         setDcaOpen]         = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);
  // Re-sync the input string ONLY when the upstream array would parse to
  // something different from what the current string already does. This
  // catches external reloads (after save / initial fetch) without clobbering
  // mid-typed strings like "3," whose parsed equivalent equals the upstream.
  useEffect(() => {
    const parsed = scaleStr
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
    const upstream = initial.echo_dca_scale ?? [];
    const same = parsed.length === upstream.length
      && parsed.every((v, i) => v === upstream[i]);
    if (!same) setScaleStr(upstream.join(','));
    // Intentionally exclude scaleStr from deps — only re-run when initial changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.echo_dca_scale]);
  // Same pattern for idle scale.
  useEffect(() => {
    const parsed = scaleStrIdle.split(',').map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);
    const upstream = initial.echo_dca_scale_idle ?? [];
    const same = parsed.length === upstream.length && parsed.every((v, i) => v === upstream[i]);
    if (!same) setScaleStrIdle(upstream.join(','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.echo_dca_scale_idle]);

  // Array equality via JSON stringify is sufficient for the schedule shape
  // (small, flat). Falls back to string compare, O(n) per row.
  const scheduleDirty =
    JSON.stringify(draft.auto_schedule ?? []) !== JSON.stringify(initial.auto_schedule ?? []);
  const dcaWhitelistDirty =
    JSON.stringify([...(draft.dca_streak_whitelist ?? [])].sort())
      !== JSON.stringify([...(initial.dca_streak_whitelist ?? [])].sort());

  const dirty =
       draft.enabled                   !== initial.enabled
    || draft.strategy                  !== initial.strategy
    || draft.mode                      !== initial.mode
    || draft.streak_min                !== initial.streak_min
    || draft.auto_order_min_streak     !== initial.auto_order_min_streak
    || draft.size_usdc                 !== initial.size_usdc
    || draft.limit_price_cents         !== initial.limit_price_cents
    || draft.tp_cents                  !== initial.tp_cents
    || draft.sl_cents                  !== initial.sl_cents
    || draft.dca_multiplier            !== initial.dca_multiplier
    || draft.echo_trigger_streak    !== initial.echo_trigger_streak
    || draft.echo_window_minutes    !== initial.echo_window_minutes
    || draft.echo_signal_min_streak !== initial.echo_signal_min_streak
    || draft.echo_baseline_streak   !== initial.echo_baseline_streak
    || draft.echo_require_high_body !== initial.echo_require_high_body
    || JSON.stringify([...(draft.echo_edge_cases ?? [])].sort())
       !== JSON.stringify([...(initial.echo_edge_cases ?? [])].sort())
    || JSON.stringify(draft.echo_dca_scale ?? []) !== JSON.stringify(initial.echo_dca_scale ?? [])
    || JSON.stringify(draft.echo_dca_scale_idle ?? []) !== JSON.stringify(initial.echo_dca_scale_idle ?? [])
    || draft.echo_defensive_enabled          !== initial.echo_defensive_enabled
    || draft.echo_defensive_streak_threshold !== initial.echo_defensive_streak_threshold
    || draft.echo_defensive_overdue_minutes  !== initial.echo_defensive_overdue_minutes
    || draft.echo_defensive_action           !== initial.echo_defensive_action
    || (draft.idle_body3_min       ?? 0) !== (initial.idle_body3_min       ?? 0)
    || (draft.armed_body3_min      ?? 0) !== (initial.armed_body3_min      ?? 0)
    || (draft.dca_body3_min_idle   ?? 0) !== (initial.dca_body3_min_idle   ?? 0)
    || (draft.dca_body3_min_armed  ?? 0) !== (initial.dca_body3_min_armed  ?? 0)
    || scheduleDirty
    || dcaWhitelistDirty;

  const scheduleValid = (draft.auto_schedule ?? []).every(e =>
       Number.isInteger(e.start_hour)     && e.start_hour     >= 0 && e.start_hour     <= 23
    && Number.isInteger(e.duration_hours) && e.duration_hours >= 1 && e.duration_hours <= 24
    && Number.isInteger(e.threshold)      && e.threshold      >= 1 && e.threshold      <= 20,
  );

  // Echo params validate independently — even when strategy=streak we keep them
  // in valid range so toggling to echo doesn't suddenly require fixing values.
  const echoValid =
       draft.echo_trigger_streak    >= 1 && draft.echo_trigger_streak    <= 20
    && draft.echo_window_minutes    >= 1 && draft.echo_window_minutes    <= 240
    && draft.echo_signal_min_streak >= 1 && draft.echo_signal_min_streak <= 20
    && draft.echo_baseline_streak   >= 1 && draft.echo_baseline_streak   <= 20
    && draft.echo_signal_min_streak <= draft.echo_baseline_streak
    && (draft.echo_dca_scale ?? []).every(s => Number.isFinite(s) && s >= 1 && s <= 20);

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
    // Body-3 bounds: 0 = disabled; up to 10000 to cover BTC (price-USD units).
    && (draft.idle_body3_min       ?? 0) >= 0 && (draft.idle_body3_min       ?? 0) <= 10_000
    && (draft.armed_body3_min      ?? 0) >= 0 && (draft.armed_body3_min      ?? 0) <= 10_000
    && (draft.dca_body3_min_idle   ?? 0) >= 0 && (draft.dca_body3_min_idle   ?? 0) <= 10_000
    && (draft.dca_body3_min_armed  ?? 0) >= 0 && (draft.dca_body3_min_armed  ?? 0) <= 10_000
    && scheduleValid
    && echoValid;

  async function save() {
    if (!dirty || !valid) return;
    setSaving(true); setErr(null);
    try {
      await api.updateCoinConfig(draft.symbol, {
        enabled:                   draft.enabled,
        strategy:                  draft.strategy,
        mode:                      draft.mode,
        streak_min:                draft.streak_min,
        auto_order_min_streak:     draft.auto_order_min_streak,
        auto_schedule:             draft.auto_schedule ?? [],
        size_usdc:                 draft.size_usdc,
        limit_price_cents:         draft.limit_price_cents,
        tp_cents:                  draft.tp_cents,
        sl_cents:                  draft.sl_cents,
        dca_multiplier:            draft.dca_multiplier,
        dca_streak_whitelist:      [...(draft.dca_streak_whitelist ?? [])].sort((a, b) => a - b),
        echo_trigger_streak:    draft.echo_trigger_streak,
        echo_window_minutes:    draft.echo_window_minutes,
        echo_signal_min_streak: draft.echo_signal_min_streak,
        echo_baseline_streak:   draft.echo_baseline_streak,
        echo_require_high_body: draft.echo_require_high_body,
        echo_edge_cases:        draft.echo_edge_cases ?? [],
        echo_dca_scale:         draft.echo_dca_scale ?? [],
        echo_dca_scale_idle:    draft.echo_dca_scale_idle ?? [],
        echo_defensive_enabled:          draft.echo_defensive_enabled,
        echo_defensive_streak_threshold: draft.echo_defensive_streak_threshold,
        echo_defensive_overdue_minutes:  draft.echo_defensive_overdue_minutes,
        echo_defensive_action:           draft.echo_defensive_action,
        idle_body3_min:                  draft.idle_body3_min       ?? 0,
        armed_body3_min:                 draft.armed_body3_min      ?? 0,
        dca_body3_min_idle:              draft.dca_body3_min_idle   ?? 0,
        dca_body3_min_armed:             draft.dca_body3_min_armed  ?? 0,
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
            value={draft.strategy}
            onChange={e => setDraft({ ...draft, strategy: e.target.value as CoinStrategy })}
            disabled={saving || !draft.enabled}
            style={S.select}
            title={draft.strategy === 'echo'
              ? 'Echo Hunt: only signals in 30min arm window after a high-streak event ends. ~78–96% WR on BTC.'
              : 'Simple baseline: contrarian whenever |streak| ≥ Auto. ~52% WR.'}
          >
            <option value="streak">streak</option>
            <option value="echo">echo</option>
          </select>
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
      {/* Echo Hunt params — inline second row when strategy=echo. Keeps the
          main row narrow while making all 4 echo params visible at a glance. */}
      {draft.strategy === 'echo' && (
        <tr style={{ background: '#0a0d12' }}>
          <td colSpan={14} style={{ padding: '8px 24px', borderBottom: '1px solid #21262d' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: '#79c0ff', fontWeight: 600 }}>Echo Hunt:</span>
              <label style={{ color: '#8b949e' }}
                     title="Idle baseline threshold — bot uses this when NOT armed (between trigger events).">
                Baseline streak ≥{' '}
                <NumInput value={draft.echo_baseline_streak}
                          min={draft.echo_signal_min_streak} max={20}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, echo_baseline_streak: v })} />
              </label>
              <label style={{ color: '#8b949e' }}>
                Trigger streak ≥{' '}
                <NumInput value={draft.echo_trigger_streak}
                          min={3} max={20}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, echo_trigger_streak: v })} />
              </label>
              <label style={{ color: '#8b949e' }}>
                Arm window (min){' '}
                <NumInput value={draft.echo_window_minutes}
                          min={5} max={240}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, echo_window_minutes: v })} />
              </label>
              <label style={{ color: '#8b949e' }}>
                Signal streak ≥{' '}
                <NumInput value={draft.echo_signal_min_streak}
                          min={1} max={draft.echo_trigger_streak}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, echo_signal_min_streak: v })} />
              </label>
              <label style={{ color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}
                     title="V9 filter (IDLE mode only): when streak has no high-body bar (>1.5× avg), bump baseline threshold +2 (e.g. 6→8) to wait for a stronger streak. Armed mode unaffected.">
                <input type="checkbox"
                       checked={draft.echo_require_high_body}
                       disabled={saving || !draft.enabled}
                       onChange={e => setDraft({ ...draft, echo_require_high_body: e.target.checked })}
                       style={{ margin: 0 }} />
                Body filter (idle: bump +2 if no high-body)
              </label>
              <label style={{ color: '#8b949e' }}
                     title="Body-3 idle gate (price USD): sum of |close-open| over last 3 closed bars must be ≥ this to fire in idle mode. 0 = disabled. BTC 365d analysis: streak=5 + body3 ≥ 400 → P(rev)=63%, vs 46-52% below 300. Set per coin (BTC ~400, ETH ~30, SOL ~5).">
                Idle body3 ≥{' '}
                <NumInput value={draft.idle_body3_min ?? 0}
                          min={0} max={10_000} step={10}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, idle_body3_min: v })} />
              </label>
              <label style={{ color: '#8b949e' }}
                     title="Body-3 armed gate (price USD): same as idle but for armed mode. Recommended lower than idle (armed has higher base edge). BTC ~300.">
                Armed body3 ≥{' '}
                <NumInput value={draft.armed_body3_min ?? 0}
                          min={0} max={10_000} step={10}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, armed_body3_min: v })} />
              </label>
              <label style={{ color: '#8b949e' }}
                     title="Body-3 DCA gate when cycle was opened in IDLE mode. After a loss, recompute body3 on new bar set; skip DCA if body3 < this. Recommended lower than idle entry (averaging-down at lower price tolerates weaker signal). BTC ~200.">
                DCA idle body3 ≥{' '}
                <NumInput value={draft.dca_body3_min_idle ?? 0}
                          min={0} max={10_000} step={10}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, dca_body3_min_idle: v })} />
              </label>
              <label style={{ color: '#8b949e' }}
                     title="Body-3 DCA gate when cycle was opened in ARMED mode. Typically lowest threshold of the four (armed cycle already validated regime). BTC ~150.">
                DCA armed body3 ≥{' '}
                <NumInput value={draft.dca_body3_min_armed ?? 0}
                          min={0} max={10_000} step={10}
                          disabled={saving || !draft.enabled}
                          onChange={v => setDraft({ ...draft, dca_body3_min_armed: v })} />
              </label>
              <label style={{ color: '#8b949e' }}
                     title="ARMED-mode DCA — comma-separated multipliers indexed by loss-count. e.g. '3,4' = base×3 after L1, base×4 after L2, then stop.">
                DCA armed{' '}
                <input
                  type="text"
                  value={scaleStr}
                  disabled={saving || !draft.enabled}
                  onChange={e => {
                    const text = e.target.value;
                    setScaleStr(text);
                    const parsed = text
                      .split(',')
                      .map(s => Number(s.trim()))
                      .filter(n => Number.isFinite(n) && n > 0);
                    setDraft({ ...draft, echo_dca_scale: parsed });
                  }}
                  placeholder="3,4"
                  style={{ width: 80, padding: '4px 6px', borderRadius: 4,
                           border: '1px solid #30363d', background: '#0d1117',
                           color: '#c9d1d9', fontSize: 12, fontFamily: 'monospace' }}
                />
              </label>
              <label style={{ color: '#8b949e' }}
                     title="IDLE-mode DCA — separate scale for cycles opened at baseline threshold. Empty = use armed scale (above) for both modes.">
                DCA idle{' '}
                <input
                  type="text"
                  value={scaleStrIdle}
                  disabled={saving || !draft.enabled}
                  onChange={e => {
                    const text = e.target.value;
                    setScaleStrIdle(text);
                    const parsed = text
                      .split(',')
                      .map(s => Number(s.trim()))
                      .filter(n => Number.isFinite(n) && n > 0);
                    setDraft({ ...draft, echo_dca_scale_idle: parsed });
                  }}
                  placeholder="(use armed)"
                  style={{ width: 90, padding: '4px 6px', borderRadius: 4,
                           border: '1px solid #30363d', background: '#0d1117',
                           color: '#c9d1d9', fontSize: 12, fontFamily: 'monospace' }}
                />
              </label>
              <span style={{ color: '#6e7681', fontSize: 11, fontStyle: 'italic' }}>
                Echo idle → threshold = <b>Baseline streak ≥</b>. Echo armed → threshold = <b>Signal streak ≥</b>.
                Auto ≥ / Schedule / DCA streaks / DCA mult không áp dụng cho echo.
              </span>
              <div style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, paddingTop: 4, borderTop: '1px solid #21262d' }}>
                <span style={{ color: '#f0a500', fontWeight: 600, fontSize: 11 }}>Defensive regime:</span>
                <label style={{ color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}
                       title="When enabled, bot tracks time since last extreme streak. If gap exceeds the overdue threshold, applies the defensive action.">
                  <input type="checkbox"
                         checked={draft.echo_defensive_enabled}
                         disabled={saving || !draft.enabled}
                         onChange={e => setDraft({ ...draft, echo_defensive_enabled: e.target.checked })}
                         style={{ margin: 0 }} />
                  Enabled
                </label>
                <label style={{ color: '#8b949e' }}
                       title="Streak length that resets the 'last extreme' timer. Default 7.">
                  Extreme streak ≥{' '}
                  <NumInput value={draft.echo_defensive_streak_threshold}
                            min={3} max={20}
                            disabled={saving || !draft.enabled || !draft.echo_defensive_enabled}
                            onChange={v => setDraft({ ...draft, echo_defensive_streak_threshold: v })} />
                </label>
                <label style={{ color: '#8b949e' }}
                       title="Minutes since last extreme before bot enters defensive mode. Default 1440 (24h).">
                  Overdue (min){' '}
                  <NumInput value={draft.echo_defensive_overdue_minutes}
                            min={10} max={43200}
                            disabled={saving || !draft.enabled || !draft.echo_defensive_enabled}
                            onChange={v => setDraft({ ...draft, echo_defensive_overdue_minutes: v })} />
                </label>
                <label style={{ color: '#8b949e' }}
                       title="disable_armed: bot still trades baseline but never lowers to armed threshold. skip_all: suspend placement entirely.">
                  Action{' '}
                  <select value={draft.echo_defensive_action}
                          disabled={saving || !draft.enabled || !draft.echo_defensive_enabled}
                          onChange={e => setDraft({ ...draft, echo_defensive_action: e.target.value as 'disable_armed' | 'skip_all' })}
                          style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid #30363d',
                                   background: '#0d1117', color: '#c9d1d9', fontSize: 12 }}>
                    <option value="disable_armed">disable_armed</option>
                    <option value="skip_all">skip_all</option>
                  </select>
                </label>
              </div>
              <div style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, paddingTop: 4, borderTop: '1px solid #21262d' }}>
                <span style={{ color: '#79c0ff', fontWeight: 600, fontSize: 11 }}>Idle edge-case overrides:</span>
                <label style={{ color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}
                       title="A1: streak 3-4 + mean body > 1.5× avg → fire even when threshold not met. WR 58.1% (n=1384) on BTC 180d, +4.5% over baseline.">
                  <input type="checkbox"
                         checked={(draft.echo_edge_cases ?? []).includes('short_streak_strong_mean')}
                         disabled={saving || !draft.enabled}
                         onChange={e => {
                           const cur = new Set(draft.echo_edge_cases ?? []);
                           if (e.target.checked) cur.add('short_streak_strong_mean');
                           else                  cur.delete('short_streak_strong_mean');
                           setDraft({ ...draft, echo_edge_cases: Array.from(cur) as EchoEdgeCase[] });
                         }}
                         style={{ margin: 0 }} />
                  A1: streak 3-4 + strong mean body
                </label>
                <label style={{ color: '#8b949e', display: 'flex', alignItems: 'center', gap: 4 }}
                       title="A3: streak 5-7 + ≥1 very-extreme body bar (>4× avg) → fire. WR 58.5% (n=217) on BTC 180d, +6.2% over baseline.">
                  <input type="checkbox"
                         checked={(draft.echo_edge_cases ?? []).includes('mid_streak_very_extreme')}
                         disabled={saving || !draft.enabled}
                         onChange={e => {
                           const cur = new Set(draft.echo_edge_cases ?? []);
                           if (e.target.checked) cur.add('mid_streak_very_extreme');
                           else                  cur.delete('mid_streak_very_extreme');
                           setDraft({ ...draft, echo_edge_cases: Array.from(cur) as EchoEdgeCase[] });
                         }}
                         style={{ margin: 0 }} />
                  A3: streak 5-7 + very-extreme bar
                </label>
              </div>
            </div>
          </td>
        </tr>
      )}
      {scheduleOpen && (
        <tr style={{ background: '#0a0d12' }}>
          <td colSpan={14} style={{ padding: '12px 24px', borderBottom: '1px solid #21262d' }}>
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
          <td colSpan={14} style={{ padding: '12px 24px', borderBottom: '1px solid #21262d' }}>
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
          <td colSpan={14} style={{ ...S.td, color: '#f85149', fontSize: 11 }}>
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
