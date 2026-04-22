/**
 * SettingsPage — runtime config for the trading bot.
 *
 * Currently-supported keys (backend whitelist in api/settings.ts):
 *   trading_mode            'simulate' | 'live'
 *   signal_min_streak       integer 1-10 — min |streak| to emit a signal
 *   auto_order_min_streak   integer 1-10 — ≥ this streak → auto-place order
 *                                           (between signal_min and this →
 *                                            manual: signal shown, user clicks)
 *
 * Invariants (enforced server-side):
 *   - live mode requires POLYMARKET_API_KEY env
 *   - auto_order_min_streak ≥ signal_min_streak
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, type SettingsResponse } from '../api/client.js';

const STREAK_MIN = 1;
const STREAK_MAX = 10;
const LIMIT_PRICE_MIN = 1;
const LIMIT_PRICE_MAX = 99;
const USDC_MAX = 100;

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error,    setError]    = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSettings(await api.getSettings()); setError(null); }
    catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!settings) {
    return (
      <div style={S.page}>
        <div style={S.heading}>Settings</div>
        <div style={{ color: '#8b949e' }}>{error ?? 'Loading…'}</div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.heading}>Settings</div>
      <div style={S.subheading}>
        Cấu hình runtime của bot. Thay đổi lưu ngay vào DB — engine sẽ đọc ở chu kỳ tiếp theo.
      </div>
      {error && <div style={S.errorBar}>{error}</div>}

      <TradingModeCard  settings={settings} onChanged={load} />
      <StreakCard       settings={settings} onChanged={load} />
      <SizeDcaCard      settings={settings} onChanged={load} />
      <LimitPriceCard   settings={settings} onChanged={load} />
      <TpSlCard         settings={settings} onChanged={load} />
      <DcaCard          settings={settings} onChanged={load} />
      <PanicCard        settings={settings} onChanged={load} />
      <RulesExplainer   settings={settings} />
      <DangerZoneCard />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function TradingModeCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState<string | null>(null);

  async function setMode(mode: 'simulate' | 'live') {
    if (settings.effectiveTradingMode === mode) return;
    setSaving(true); setErr(null);
    try {
      await api.updateSetting('trading_mode', mode);
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally { setSaving(false); }
  }

  const { effectiveTradingMode, hasPolymarketKey } = settings;
  const stored = settings.settings['trading_mode'] ?? 'simulate';
  const forced = stored === 'live' && !hasPolymarketKey;

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Trading mode</div>
      <div style={S.cardHint}>
        Pool tiền được dùng khi đặt lệnh. Simulate = ghi DB không on-chain. Live = đặt lệnh
        thật trên Polymarket (cần <code>POLYMARKET_API_KEY</code> + wallet — Phase 3).
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => setMode('simulate')}
          disabled={saving}
          style={{ ...S.pill, ...(effectiveTradingMode === 'simulate' ? S.pillActiveOrange : {}) }}
        >Simulate</button>
        <button
          onClick={() => hasPolymarketKey && setMode('live')}
          disabled={saving || !hasPolymarketKey}
          title={hasPolymarketKey
            ? 'Enable real trading on Polymarket'
            : 'POLYMARKET_API_KEY not configured — live mode locked'}
          style={{
            ...S.pill,
            ...(effectiveTradingMode === 'live' ? S.pillActiveGreen : {}),
            cursor: hasPolymarketKey ? 'pointer' : 'not-allowed',
            opacity: hasPolymarketKey ? 1 : 0.5,
          }}
        >Live</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: '#8b949e', alignSelf: 'center' }}>
          Stored: <code>{stored}</code> · Effective: <code>{effectiveTradingMode}</code>
          {forced && <span style={{ color: '#f0a500', marginLeft: 8 }}>⚠ forced to simulate</span>}
        </span>
      </div>
      {err && <div style={S.fieldError}>{err}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function StreakCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const signalStored = Number(settings.settings['signal_min_streak']     ?? 3);
  const autoStored   = Number(settings.settings['auto_order_min_streak'] ?? 4);

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Signal trigger theo 5m streak</div>
      <div style={S.cardHint}>
        Bot theo dõi số nến 5m liên tiếp cùng chiều (|streak|). Khi |streak| vượt ngưỡng bên dưới,
        engine sẽ emit signal và (nếu đủ lớn) đặt lệnh tự động.
      </div>

      <StreakField
        label="Min streak để emit signal"
        fieldKey="signal_min_streak"
        initial={signalStored}
        helper="Dưới ngưỡng này → không emit signal, không có lệnh."
        onSaved={onChanged}
      />

      <StreakField
        label="Min streak để đặt AUTO order"
        fieldKey="auto_order_min_streak"
        initial={autoStored}
        helper="Từ ngưỡng này trở lên → engine đặt lệnh tự động. Giữa signal_min và auto_order_min → lệnh MANUAL (user click)."
        onSaved={onChanged}
      />
    </div>
  );
}

function StreakField({
  label, fieldKey, initial, helper, onSaved,
}: {
  label:    string;
  fieldKey: 'signal_min_streak' | 'auto_order_min_streak';
  initial:  number;
  helper:   string;
  onSaved:  () => void;
}) {
  return (
    <IntegerField
      label={label} fieldKey={fieldKey} initial={initial}
      min={STREAK_MIN} max={STREAK_MAX} step={1}
      suffix="" helper={helper} onSaved={onSaved}
    />
  );
}

function IntegerField({
  label, fieldKey, initial, min, max, step, suffix, helper, onSaved,
}: {
  label:    string;
  fieldKey: string;
  initial:  number;
  min:      number;
  max:      number;
  step:     number;
  suffix:   string;
  helper:   string;
  onSaved:  () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => { setValue(initial); }, [initial]);

  const dirty = value !== initial;
  const inRange = value >= min && value <= max && Number.isInteger(value);

  async function save() {
    if (!dirty || !inRange) return;
    setSaving(true); setErr(null);
    try {
      await api.updateSetting(fieldKey, String(value));
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(String(e).replace(/^Error: API [^:]+: \d+: /, ''));
    } finally { setSaving(false); }
  }

  return (
    <div style={S.field}>
      <div style={S.fieldLabel}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button style={S.qtyBtn}
                onClick={() => setValue(v => Math.max(min, v - step))}
                disabled={saving}>-</button>
        <input
          type="number"
          min={min} max={max} step={step}
          value={Number.isNaN(value) ? '' : value}
          onChange={e => setValue(Number(e.target.value))}
          style={{ ...S.qtyInput, borderColor: inRange ? '#30363d' : '#f85149' }}
          disabled={saving}
        />
        {suffix && <span style={{ fontSize: 13, color: '#8b949e' }}>{suffix}</span>}
        <button style={S.qtyBtn}
                onClick={() => setValue(v => Math.min(max, v + step))}
                disabled={saving}>+</button>
        <button
          onClick={save}
          disabled={!dirty || !inRange || saving}
          style={{
            ...S.saveBtn,
            background: dirty && inRange ? '#1f6feb' : '#21262d',
            color:      dirty && inRange ? '#fff' : '#8b949e',
            cursor:     dirty && inRange && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : dirty ? 'Save' : (savedFlash ? '✓ Saved' : '—')}
        </button>
        <span style={{ fontSize: 11, color: '#8b949e' }}>
          stored: <code>{initial}{suffix}</code>
        </span>
      </div>
      <div style={S.fieldHint}>{helper}</div>
      {err && <div style={S.fieldError}>{err}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function LimitPriceCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const stored = Number(settings.settings['auto_order_limit_price_cents'] ?? 55);
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Auto order — Limit price (entry)</div>
      <div style={S.cardHint}>
        Khi signal ≥ auto threshold, engine check giá best_ask hiện tại với limit này:
        {' '}≤ limit → đặt lệnh ở best_ask; &gt; limit → SKIP (giá quá đắt).
      </div>

      <IntegerField
        label="Max giá để auto mua"
        fieldKey="auto_order_limit_price_cents"
        initial={stored}
        min={LIMIT_PRICE_MIN} max={LIMIT_PRICE_MAX} step={1}
        suffix="¢"
        helper="VD: 55 = chỉ auto mua nếu ask ≤ 55¢."
        onSaved={onChanged}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function TpSlCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const tp = Number(settings.settings['auto_order_tp_cents'] ?? 75);
  const sl = Number(settings.settings['auto_order_sl_cents'] ?? 25);
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Take Profit / Stop Loss (exit)</div>
      <div style={S.cardHint}>
        Áp dụng cho <strong>tất cả</strong> pending sim orders (manual + auto).
        OrderResolver poll mỗi 5s, khi bestBid của direction mình giữ chạm ngưỡng:
        ≥ TP → bán chốt lời; ≤ SL → bán cắt lỗ. Không hit thì đóng theo resolution lúc window end.
        Invariant: TP &gt; SL. Set TP=99 hoặc SL=1 để effectively disable.
      </div>

      <IntegerField
        label="Take Profit (TP)"
        fieldKey="auto_order_tp_cents"
        initial={tp}
        min={LIMIT_PRICE_MIN} max={LIMIT_PRICE_MAX} step={1}
        suffix="¢"
        helper="VD 75 = bán chốt lời khi bestBid ≥ 75¢. Share @ 75¢ → market 75% confident theo mình."
        onSaved={onChanged}
      />
      <IntegerField
        label="Stop Loss (SL)"
        fieldKey="auto_order_sl_cents"
        initial={sl}
        min={LIMIT_PRICE_MIN} max={LIMIT_PRICE_MAX} step={1}
        suffix="¢"
        helper="VD 25 = bán cắt lỗ khi bestBid ≤ 25¢. Share @ 25¢ → market 75% confident ngược mình → recovery khó."
        onSaved={onChanged}
      />

      <div style={{ marginTop: 12, padding: 10, background: '#0d1117', borderRadius: 4,
                    fontSize: 11, color: '#8b949e', lineHeight: 1.6 }}>
        <strong style={{ color: '#c9d1d9' }}>Payoff example</strong> — buy UP @ 45¢, 10 shares:
        <br />
        {' '}• TP @ {tp}¢ hit → sell {tp}¢ → <span style={{ color: '#3fb950' }}>PnL = +${((tp/100 - 0.45) * 10).toFixed(2)}</span>
        <br />
        {' '}• SL @ {sl}¢ hit → sell {sl}¢ → <span style={{ color: '#f85149' }}>PnL = ${((sl/100 - 0.45) * 10).toFixed(2)}</span>
        <br />
        {' '}• Hold to close + win → $1.00 → <span style={{ color: '#3fb950' }}>PnL = +${(1.00 - 0.45) * 10}</span>
        <br />
        {' '}• Hold to close + lose → $0.00 → <span style={{ color: '#f85149' }}>PnL = -$4.50</span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function SizeDcaCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const base = Number(settings.settings['auto_order_base_size_usdc'] ?? 5);
  const step = Number(settings.settings['auto_order_dca_step_usdc']  ?? 5);

  // Preview first 6 orders of a losing streak
  const preview: number[] = [];
  for (let i = 0; i < 6; i++) preview.push(Math.min(base + step * i, 100));

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Order size + DCA (Path A)</div>
      <div style={S.cardHint}>
        <strong>Base size</strong>: USDC mỗi lệnh khi không có loss trước đó (reset sau WIN).
        <br />
        <strong>DCA step</strong>: cộng thêm bao nhiêu USDC cho mỗi loss Path A liên tiếp. Set = 0 để tắt DCA.
        <br />
        Công thức: <code>size = base + step × consecutive_losses</code> (cap $100, chỉ đếm Path A auto + closed).
        <br />
        <strong>Chỉ áp dụng cho Path A</strong>. Path B luôn dùng base size (đã có risk asymmetry sẵn).
      </div>

      <IntegerField
        label="Base size"
        fieldKey="auto_order_base_size_usdc"
        initial={base}
        min={1} max={USDC_MAX} step={1}
        suffix="$"
        helper="VD 5 = mỗi lệnh base $5. Reset sau mỗi WIN."
        onSaved={onChanged}
      />
      <IntegerField
        label="DCA step"
        fieldKey="auto_order_dca_step_usdc"
        initial={step}
        min={0} max={USDC_MAX} step={1}
        suffix="$"
        helper="VD 5 = sau mỗi loss cộng thêm $5. Set 0 = tắt DCA (always base size)."
        onSaved={onChanged}
      />

      <div style={{ marginTop: 12, padding: 10, background: '#0d1117', borderRadius: 4,
                    fontSize: 11, color: '#8b949e', lineHeight: 1.6 }}>
        <strong style={{ color: '#c9d1d9' }}>Preview</strong> — liên tiếp loss, size Path A sẽ là:
        <br />
        <span style={{ fontFamily: 'monospace' }}>
          {preview.map((s, i) => (
            <span key={i}>
              {i > 0 && ' → '}
              <span style={{ color: s >= 100 ? '#f85149' : '#c9d1d9' }}>${s}</span>
            </span>
          ))}
          {step > 0 && ' → …'}
          {step === 0 && ' (DCA disabled)'}
        </span>
      </div>
    </div>
  );
}

function DcaCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const max  = Number(settings.settings['dca_max_entry_cents'] ?? 40);
  const base = Number(settings.settings['auto_order_base_size_usdc'] ?? 5);
  const tp   = Number(settings.settings['auto_order_tp_cents']   ?? 75);
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>DCA — average down existing BOUNDARY position</div>
      <div style={S.cardHint}>
        <strong>Trigger</strong>: đã có pending BOUNDARY BUY cho current window (auto, từ boundary trước),
        rồi ask của held direction sụt ≤ max entry (default 40¢) + còn &gt; 1m30s.
        <br />
        <strong>Action</strong>: mua thêm (market) với size = base_size để giảm avg entry.
        <br />
        <strong>Exit</strong>: TP inherit từ global (75¢) — profit together với parent BOUNDARY. Không SL
        (add rồi cut lỗ sẽ negate averaging-down). Fire tối đa 1 lần / market.
      </div>

      <IntegerField
        label="Max entry (¢)"
        fieldKey="dca_max_entry_cents"
        initial={max}
        min={LIMIT_PRICE_MIN} max={LIMIT_PRICE_MAX} step={1}
        suffix="¢"
        helper="VD 40 = trigger DCA-add nếu ask sụt xuống ≤ 40¢ (từ entry thường ~50¢)."
        onSaved={onChanged}
      />

      <div style={{ marginTop: 12, padding: 10, background: '#0d1117', borderRadius: 4,
                    fontSize: 11, color: '#8b949e', lineHeight: 1.6 }}>
        <strong style={{ color: '#c9d1d9' }}>DCA example</strong>:
        <br />
        {' '}Parent BOUNDARY: BUY @ 52¢, size $5 = 9.6 shares
        <br />
        {' '}Price drops to {max}¢ mid-window → DCA fires
        <br />
        {' '}DCA: BUY @ {max}¢, size ${base} = {(base / (max/100)).toFixed(1)} shares
        <br />
        {' '}Combined: {(9.6 + base / (max/100)).toFixed(1)} shares @ avg {((52*9.6 + max*base/(max/100)) / (9.6 + base/(max/100))).toFixed(1)}¢
        <br />
        {' '}If price recovers to {tp}¢ → <span style={{ color: '#3fb950' }}>both TP</span>, combined PnL ≈
        +${((tp/100 - 0.52) * 9.6 + (tp/100 - max/100) * (base/(max/100))).toFixed(2)}
      </div>
    </div>
  );
}

function PanicCard({
  settings, onChanged,
}: {
  settings: SettingsResponse;
  onChanged: () => void;
}) {
  const entry   = Number(settings.settings['panic_entry_cents']    ?? 5);
  const tp      = Number(settings.settings['panic_tp_cents']       ?? 20);
  const winS    = Number(settings.settings['panic_first_window_s'] ?? 180);
  const base    = Number(settings.settings['auto_order_base_size_usdc'] ?? 5);
  const signalMin = Number(settings.settings['signal_min_streak']      ?? 3);
  const autoMin   = Number(settings.settings['auto_order_min_streak']  ?? 4);
  const shares = entry > 0 ? base / (entry / 100) : 0;
  const proceed = shares * (tp / 100);
  const pnl = proceed - base;
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>PANIC — bottom-fishing current window (momentum)</div>
      <div style={S.cardHint}>
        <strong>When</strong>: streak sits in the gap [{signalMin}, {autoMin}) — signal exists
        nhưng BOUNDARY KHÔNG fire cho next window. Trong first {Math.round(winS / 60)}m của current window,
        ask của hướng streak sụt ≤ entry (default {entry}¢) → market BUY hướng đó.
        <br />
        <strong>Logic</strong>: vd streak +2 UP closed, mid-window dump mạnh làm UP token crash
        xuống {entry}¢. Bet rằng BTC hồi lên, UP token đóng cao. <strong>Momentum</strong>, không contrarian.
        <br />
        <strong>Exit</strong>: limit SELL @ panic TP ({tp}¢). Không SL. Fire tối đa 1 lần / market.
      </div>

      <IntegerField
        label="Entry (¢)"
        fieldKey="panic_entry_cents"
        initial={entry}
        min={1} max={50} step={1}
        suffix="¢"
        helper={`Mua khi streak-side ask ≤ giá này. Thấp = đáy sâu hơn = ít fire hơn.`}
        onSaved={onChanged}
      />
      <IntegerField
        label="TP (¢)"
        fieldKey="panic_tp_cents"
        initial={tp}
        min={2} max={99} step={1}
        suffix="¢"
        helper="Limit SELL exit. Phải > entry."
        onSaved={onChanged}
      />
      <IntegerField
        label="First window (s)"
        fieldKey="panic_first_window_s"
        initial={winS}
        min={30} max={270} step={10}
        suffix="s"
        helper="Chỉ fire trong X giây đầu của window (cần thời gian hồi giá)."
        onSaved={onChanged}
      />

      <div style={{ marginTop: 12, padding: 10, background: '#0d1117', borderRadius: 4,
                    fontSize: 11, color: '#8b949e', lineHeight: 1.6 }}>
        <strong style={{ color: '#c9d1d9' }}>PANIC example</strong> (streak +2 UP, auto_min=3):
        <br />
        {' '}First {Math.round(winS / 60)}m mid-window, UP ask crash xuống {entry}¢
        <br />
        {' '}→ Panic BUY UP @ {entry}¢, size ${base} = {shares.toFixed(1)} shares
        <br />
        {' '}→ Hồi lên {tp}¢ trong window → TP fill, nhận ${proceed.toFixed(2)}, PnL&nbsp;
        <span style={{ color: pnl >= 0 ? '#3fb950' : '#f85149' }}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </span>
        <br />
        {' '}→ Nếu BTC resolve UP (share=$1) dù chưa fill TP → nhận ${shares.toFixed(2)}
      </div>
    </div>
  );
}

function DangerZoneCard() {
  const [busy,    setBusy]    = useState(false);
  const [result,  setResult]  = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  async function reset() {
    const ok = window.confirm(
      'Xoá TẤT CẢ orders trong simulate + backtest mode?\n\n' +
      'Live orders sẽ KHÔNG bị xoá.\n' +
      'Hành động không thể undo.'
    );
    if (!ok) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.resetTestData();
      setResult(`✓ Đã xoá ${r.deleted} orders. ${r.kept_live} live orders giữ nguyên.`);
    } catch (e) {
      setError(String(e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ ...S.card, borderColor: '#7d1f1f' }}>
      <div style={{ ...S.cardTitle, color: '#f85149' }}>Danger zone</div>
      <div style={S.cardHint}>
        Reset tất cả test data (simulate + backtest orders). Live orders KHÔNG ảnh hưởng.
        Dùng để dọn dẹp khi muốn test lại từ đầu.
      </div>
      <button
        onClick={reset}
        disabled={busy}
        style={{
          marginTop: 12, padding: '8px 16px', borderRadius: 6,
          background: busy ? '#21262d' : '#4a1a1a',
          color: busy ? '#8b949e' : '#f85149',
          border: '1px solid #7d1f1f',
          cursor: busy ? 'wait' : 'pointer',
          fontSize: 13, fontWeight: 600,
        }}
      >{busy ? 'Đang xoá…' : '🗑 Reset test data (sim + backtest)'}</button>
      {result && <div style={{ marginTop: 8, fontSize: 12, color: '#3fb950' }}>{result}</div>}
      {error  && <div style={{ marginTop: 8, fontSize: 12, color: '#f85149' }}>{error}</div>}
    </div>
  );
}

function RulesExplainer({ settings }: { settings: SettingsResponse }) {
  const signal        = Number(settings.settings['signal_min_streak']            ?? 3);
  const auto          = Number(settings.settings['auto_order_min_streak']        ?? 4);
  const limit         = Number(settings.settings['auto_order_limit_price_cents'] ?? 55);
  const tp            = Number(settings.settings['auto_order_tp_cents']          ?? 75);
  const sl            = Number(settings.settings['auto_order_sl_cents']          ?? 25);
  const dcaMax        = Number(settings.settings['dca_max_entry_cents']          ?? 40);
  const panicEntry    = Number(settings.settings['panic_entry_cents']            ?? 5);
  const panicTp       = Number(settings.settings['panic_tp_cents']               ?? 20);
  const panicWinS     = Number(settings.settings['panic_first_window_s']         ?? 180);
  return (
    <div style={S.rulesCard}>
      <div style={S.cardTitle}>Quy tắc hiện tại (derived)</div>

      <div style={{ marginTop: 8, fontSize: 12, color: '#c9d1d9' }}>
        <strong style={{ color: '#3fb950' }}>BOUNDARY (pre-position for next window)</strong>
        <br />
        Fires trong 10s cuối current window. Target: next market. Contrarian sau streak.
        <ul style={{ paddingLeft: 18, marginTop: 4, marginBottom: 10, lineHeight: 1.6, fontSize: 13 }}>
          <li>|streak| &lt; <strong>{signal}</strong> → không emit</li>
          <li><strong>{signal}</strong> ≤ |streak| &lt; <strong>{auto}</strong> → emit MANUAL (user click)</li>
          <li>|streak| ≥ <strong>{auto}</strong> + ask ≤ <strong>{limit}¢</strong> → AUTO order + TP <strong>{tp}¢</strong> / SL <strong>{sl}¢</strong></li>
        </ul>

        <strong style={{ color: '#79c0ff' }}>DCA (average down existing BOUNDARY)</strong>
        <br />
        Fires khi đã có auto BOUNDARY BUY + held ask sụt vào DCA zone.
        <ul style={{ paddingLeft: 18, marginTop: 4, marginBottom: 10, lineHeight: 1.6, fontSize: 13 }}>
          <li>Có pending auto BOUNDARY BUY cho market</li>
          <li>Ask của held direction ≤ <strong>{dcaMax}¢</strong></li>
          <li>Còn &gt; 1m30s</li>
          <li>→ Market BUY @ ask, size = base (flat), TP inherit = <strong>{tp}¢</strong>, no SL. 1 lần/market.</li>
        </ul>

        <strong style={{ color: '#ff9f43' }}>PANIC (bottom-fishing current window, momentum)</strong>
        <br />
        Fires khi streak rơi vào gap [{signal}, {auto}) — có signal nhưng BOUNDARY không auto-fire.
        <ul style={{ paddingLeft: 18, marginTop: 4, lineHeight: 1.6, fontSize: 13 }}>
          <li>Streak closed ∈ [<strong>{signal}</strong>, <strong>{auto}</strong>) (cùng hướng)</li>
          <li>Trong first <strong>{Math.round(panicWinS / 60)}m</strong> của current window</li>
          <li>Ask của streak-matching side ≤ <strong>{panicEntry}¢</strong></li>
          <li>→ Market BUY hướng đó, size = base, limit TP <strong>{panicTp}¢</strong>, no SL. 1 lần/market.</li>
        </ul>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 },
  heading:    { fontSize: 22, fontWeight: 700, color: '#c9d1d9' },
  subheading: { fontSize: 13, color: '#8b949e', marginTop: -8 },
  errorBar:   { color: '#f85149', padding: '8px 12px', background: '#21262d',
                borderRadius: 6, fontSize: 13 },

  card:       { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 20 },
  cardTitle:  { fontSize: 16, fontWeight: 600, color: '#c9d1d9', marginBottom: 4 },
  cardHint:   { fontSize: 12, color: '#8b949e', lineHeight: 1.5, marginTop: 4 },

  pill:       { padding: '6px 16px', borderRadius: 6, border: '1px solid #30363d',
                background: '#0d1117', color: '#8b949e', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  pillActiveOrange: { background: '#f0a500', color: '#0d1117', borderColor: '#f0a500' },
  pillActiveGreen:  { background: '#3fb950', color: '#0d1117', borderColor: '#3fb950' },

  field:        { marginTop: 16 },
  fieldLabel:   { fontSize: 13, fontWeight: 600, color: '#c9d1d9' },
  fieldHint:    { fontSize: 11, color: '#8b949e', marginTop: 6, lineHeight: 1.4 },
  fieldError:   { fontSize: 12, color: '#f85149', marginTop: 6 },

  qtyBtn:    { width: 28, height: 28, background: '#21262d', color: '#c9d1d9',
               border: '1px solid #30363d', borderRadius: 4, cursor: 'pointer',
               fontSize: 14, fontWeight: 600 },
  qtyInput:  { width: 60, padding: '4px 8px', background: '#0d1117', border: '1px solid #30363d',
               color: '#c9d1d9', borderRadius: 4, fontSize: 14, textAlign: 'center' },
  saveBtn:   { padding: '6px 14px', borderRadius: 4, border: 'none',
               fontSize: 12, fontWeight: 600, minWidth: 70 },

  rulesCard: { background: '#0d1117', border: '1px solid #21262d', borderRadius: 8, padding: 16 },
};
