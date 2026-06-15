/**
 * src/services/TelegramService.ts
 *
 * Multi-channel Telegram router: dispatches each SignalBus event to EVERY
 * channel whose filter matches (coin + info_type).
 *
 * Event → info_type mapping:
 *   T+4                    → 'signal'
 *   T+0, T-3s, T-0        → 'order'
 *
 * Channel config lives in `settings.telegram_channels` (managed via the
 * dashboard Settings page). We cache it in memory for 30s — edits in the UI
 * take effect without a restart.
 *
 * Env:
 *   TELEGRAM_TOKEN       bot token (from @BotFather) — single bot, many channels
 *   TELEGRAM_CHANNEL_ID  optional legacy fallback — if no channels are
 *                        configured, we post everything here so bots wired up
 *                        the old way keep working.
 */
import { Bot } from 'grammy';
import { log } from './observability/logger.js';
import type {
  SignalBusEvent, SignalT0PlusEvent, SignalT4Event, SignalTMinus3Event,
  SignalT0Event, SignalStreakDataMismatchEvent,
} from './SignalBus.js';
import type { Signal } from '@trading-bot/shared';
import {
  getTelegramChannels, channelMatches,
  type TelegramChannel, type TelegramInfoType,
} from './telegramChannels.js';
import { COIN_META, type CoinSymbol } from './CoinConfig.js';

const CACHE_TTL_MS = 30_000;

export class TelegramService {
  private bot: Bot | null = null;
  private readonly enabled:     boolean;
  private readonly fallbackId:  string;      // legacy TELEGRAM_CHANNEL_ID
  private channelsCache:        TelegramChannel[] = [];
  private cacheLoadedAt:        number = 0;

  constructor(_viewOnly = false) {
    const token = process.env['TELEGRAM_TOKEN'] ?? '';
    this.fallbackId = process.env['TELEGRAM_CHANNEL_ID'] ?? '';
    const isPlaceholder = !token
      || token.includes('placeholder')
      || token.startsWith('123456789');
    if (isPlaceholder) {
      this.enabled = false;
      log('info', 'TelegramService: disabled (no real TELEGRAM_TOKEN)');
    } else {
      this.bot = new Bot(token);
      this.enabled = true;
      log('info', 'TelegramService: enabled', {
        fallbackChannel: this.fallbackId || '(none)',
      });
    }
  }

  /** Legacy no-op — kept for backward compat with the pre-Polymarket pipeline. */
  async sendSignal(_signal: Signal): Promise<void> { /* legacy */ }

  /**
   * Refresh the channels cache if it's stale. Queries the DB; safe to fail —
   * falls back to whatever was last cached (or empty).
   */
  private async refreshChannels(): Promise<void> {
    const now = Date.now();
    if (now - this.cacheLoadedAt < CACHE_TTL_MS) return;
    try {
      this.channelsCache = await getTelegramChannels();
      this.cacheLoadedAt = now;
    } catch (err) {
      log('warn', 'TelegramService: failed to load channels (using cached)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private infoTypeFor(ev: SignalBusEvent): TelegramInfoType {
    // T+4 + data alerts both fan to 'signal' channels; trade-life events
    // (T+0 / T-3s / T-0) go to 'order' channels.
    if (ev.type === 'T+4' || ev.type === 'streak_data_mismatch') return 'signal';
    return 'order';
  }

  /**
   * Fan out the event to every matching channel. If no channels are configured
   * AND a legacy fallback env channel is set, post there so the bot still
   * works out of the box.
   */
  async send(ev: SignalBusEvent): Promise<void> {
    // echo_state events are FE-only (drive the Live page panel via SSE);
    // they have no human-readable formatter and must NEVER hit Telegram.
    // Without this gate, the heartbeat republish (every 60s per coin) would
    // spam Telegram with 400 "message text is empty" errors because the
    // switch below has no case for it → text stays undefined → grammy
    // sends empty string → Telegram rejects.
    if (ev.type === 'echo_state') return;

    // Hard safety gate: never post to real Telegram chats outside production.
    // Cheaper than the simulate-mode trick — short-circuits before formatting,
    // DB lookups, and the grammy API call.
    if (process.env['NODE_ENV'] !== 'production') {
      log('debug', 'TelegramService.send skipped (NODE_ENV != production)', {
        type: ev.type, coin: 'coin' in ev ? ev.coin : undefined,
      });
      return;
    }
    if (!this.enabled || !this.bot) return;

    let text: string;
    try {
      switch (ev.type) {
        case 'T+0':   text = formatT0Plus(ev);    break;
        case 'T+4':   text = formatT4(ev);        break;
        case 'T-3s': text = formatTMinus3(ev);  break;
        case 'T-0':   text = formatT0(ev);        break;
        case 'streak_data_mismatch': text = formatStreakMismatch(ev); break;
      }
    } catch (err) {
      log('warn', 'TelegramService formatter failed', {
        type: ev.type, error: String(err),
      });
      return;
    }

    await this.refreshChannels();
    const info = this.infoTypeFor(ev);

    const targets: string[] = [];
    if (this.channelsCache.length === 0) {
      // No channels configured — use legacy fallback if present.
      if (this.fallbackId) targets.push(this.fallbackId);
    } else {
      for (const ch of this.channelsCache) {
        if (channelMatches(ch, ev.coin, info)) targets.push(ch.channel_id);
      }
    }

    if (targets.length === 0) return;

    // Dedupe (a coin might accidentally appear in two channels pointing at
    // the same chat) to avoid double-posting.
    const unique = Array.from(new Set(targets));

    await Promise.all(unique.map(async chatId => {
      try {
        await this.bot!.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        log('warn', 'TelegramService sendMessage failed', {
          type: ev.type, chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }
}

// ── Formatters (HTML parse mode — simpler than MarkdownV2 escaping) ────────

const WINDOW_MS = 5 * 60_000;
const VN_OFFSET_MS = 7 * 60 * 60_000;   // UTC+7 (Vietnam) for display

/** Format a window time range as "HH:MM-HH:MM" in UTC+7 (Vietnam). */
function fmtWindow(start: number, end: number): string {
  const hhmm = (ms: number) => {
    const d = new Date(ms + VN_OFFSET_MS);   // shift then read UTC parts (tz-agnostic)
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  return `${hhmm(start)}-${hhmm(end)}`;
}

/** Display label per coin: "BTC_5m", "ETH_5m", "BTC_1h" (timeframe from COIN_META). */
function coinLabel(coin: CoinSymbol | string): string {
  const meta = COIN_META[coin as CoinSymbol];
  const tf = meta ? meta.binanceInterval : '5m';
  const base = String(coin).replace(/_(1H|15M)$/i, '');
  return `${base}_${tf}`;
}

/** Streak chain string: past icons + a separator + current in-progress icon. */
function streakChain(pastIcons: string, currentIcon: string): string {
  return `${pastIcons}${currentIcon ? ` ${currentIcon}` : ''}`;
}

function formatT4(ev: SignalT4Event): string {
  const dirIcon  = ev.direction === 'up' ? '🟢' : '🔴';
  const dirLabel = ev.direction.toUpperCase();
  const priceStr = ev.price != null ? `${(ev.price * 100).toFixed(1)}¢` : '?';
  const modeTag  = ev.mode === 'signal_and_order' ? 'will auto-order' : 'signal-only';
  // Layout (streak chain first), per user request:
  //   BTC_5m: 🔴🔴🔴 🔴   ← T+4 PREVIEW
  //   window: 04:55-05:00, streak: -3
  //   body3 $502 · avg $140 · ratio 1.20×
  //   signal: 🟢 UP @ 30¢ · $6 · will auto-order
  return [
    `<b>${coinLabel(ev.coin)}</b>: ${streakChain(ev.pastStreakIcons, ev.currentIcon)}   <i>T+4 preview</i>`,
    `window: <code>${fmtWindow(ev.windowStart, ev.windowEnd)}</code>, streak: <b>${ev.streak}</b>`,
    body3Line(ev.body3Sum, ev.avgBody),
    `signal: ${dirIcon} <b>${dirLabel}</b> @ ${priceStr} · $${ev.sizeUsdc} · <i>${modeTag}</i>`,
  ].join('\n');
}

/** body3 + avgBody + regime-relative ratio line. ratio = body3 / (avgBody×3) —
 *  the gate the bot fades on. Shows '?' when data missing. */
function body3Line(body3Sum: number | undefined, avgBody: number | undefined, er?: number): string {
  // ER = Kaufman efficiency-ratio (chop detector). <0.25 = choppy (fade loses).
  const erStr = er != null ? ` · ER <b>${er.toFixed(2)}</b>` : '';
  if (body3Sum == null) return `body3: ?${erStr}`;
  const b3 = `$${body3Sum.toFixed(0)}`;
  if (avgBody != null && avgBody > 0) {
    const ratio = body3Sum / (avgBody * 3);
    return `body3 ${b3} · avg $${avgBody.toFixed(0)} · ratio <b>${ratio.toFixed(2)}×</b>${erStr}`;
  }
  return `body3 ${b3}${erStr}`;
}

function formatTMinus3(ev: SignalTMinus3Event): string {
  const win      = fmtWindow(ev.windowStart, ev.windowEnd);
  const lateTag  = ev.lateRetry ? ' · ⏰ <i>T-0 retry</i>' : '';
  const matchCase = ev.matchCase ?? '?';

  switch (ev.action) {
    case 'order_placed': {
      const dirIcon = ev.direction === 'up' ? '🟢' : ev.direction === 'down' ? '🔴' : '⚪';
      const priceStr = ev.price != null ? `${(ev.price * 100).toFixed(1)}¢` : '?';
      // Layout per user request — streak chain first, then context lines.
      //   BTC_5m: 🔴🔴🔴 🔴   ✅ FIRE
      //   window: 04:55-05:00, streak: -4
      //   body3 $502 · avg $140 · ratio 1.20×
      //   📋 edge: streak4
      //   ✅ 🟢 UP @ 30¢ · $6 · id ab12cd…
      const lines = [
        `<b>${coinLabel(ev.coin)}</b>: ${streakChain(ev.pastStreakIcons ?? '', ev.currentIcon ?? '')}   ✅ <b>FIRE</b>${lateTag}`,
        `window: <code>${win}</code>, streak: <b>${ev.streak ?? '?'}</b>`,
        body3Line(ev.body3Sum, ev.avgBody, ev.efficiencyRatio),
        `📋 edge: <b>${escapeHtml(matchCase)}</b>`,
        `${dirIcon} <b>${(ev.direction ?? '?').toUpperCase()}</b> @ ${priceStr} · $${ev.sizeUsdc ?? '?'}`
          + (ev.orderId ? ` · id <code>${escapeHtml(ev.orderId.slice(0, 8))}…</code>` : ''),
      ];
      return lines.join('\n');
    }
    case 'order_skipped':
      return [
        `<b>${coinLabel(ev.coin)}</b>: ${streakChain(ev.pastStreakIcons ?? '', ev.currentIcon ?? '')}   ⚠ <b>SKIP</b>`,
        `window: <code>${win}</code>, streak: <b>${ev.streak ?? '?'}</b>`,
        body3Line(ev.body3Sum, ev.avgBody, ev.efficiencyRatio),
        `reason: ${escapeHtml(ev.reason ?? '(no reason)')}`,
      ].join('\n');
    case 'signal_only_mode':
      return `<b>${coinLabel(ev.coin)}</b> · <code>${win}</code>\nℹ signal-only mode, no order placed`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatT0Plus(ev: SignalT0PlusEvent): string {
  const o = ev.order;
  return [
    `<b>${coinLabel(ev.coin)}</b> · <b>T+0</b> · <code>${fmtWindow(ev.windowStart, ev.windowEnd)}</code> · 🎯 active order`,
    `${o.direction.toUpperCase()} @ ${(o.entryPrice * 100).toFixed(1)}¢ · $${o.sizeUsdc} · `
      + `id <code>${escapeHtml(o.orderId.slice(0, 8))}…</code>`,
  ].join('\n');
}

function formatT0(ev: SignalT0Event): string {
  const outIcon = ev.outcome === 'up'   ? '🟢'
                : ev.outcome === 'down' ? '🔴'
                :                          '⚪';
  const winLabel = fmtWindow(ev.windowStart, ev.windowEnd);
  const nextWin  = fmtWindow(ev.windowEnd,   ev.windowEnd + WINDOW_MS);
  const lines: string[] = [];

  if (ev.order) {
    const o = ev.order;
    const pnlStr = `PnL ${o.pnlUsdc >= 0 ? '+' : ''}$${o.pnlUsdc.toFixed(2)}`;
    lines.push(
      `<b>${coinLabel(ev.coin)}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()} · ${pnlStr}`,
      `entry ${(o.entryPrice * 100).toFixed(1)}¢ → exit ${(o.exitPrice * 100).toFixed(1)}¢ · `
        + `<code>${escapeHtml(o.orderId.slice(0, 8))}…</code>`,
    );
    if (ev.cancelled) {
      const c = ev.cancelled;
      lines.push(
        `🚫 <b>CANCELLED</b> N+1 (<code>${nextWin}</code>): `
          + `exit ${(c.exitPrice * 100).toFixed(1)}¢ · `
          + `PnL ${c.pnlUsdc >= 0 ? '+' : ''}$${c.pnlUsdc.toFixed(2)}`,
      );
    }
  } else if (ev.cancelled) {
    const c = ev.cancelled;
    lines.push(
      `<b>${coinLabel(ev.coin)}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()}`,
      `🚫 <b>CANCELLED</b> N+1 order (<code>${nextWin}</code>, current reversed): `
        + `exit ${(c.exitPrice * 100).toFixed(1)}¢ · `
        + `PnL ${c.pnlUsdc >= 0 ? '+' : ''}$${c.pnlUsdc.toFixed(2)}`,
    );
  } else {
    lines.push(
      `<b>${coinLabel(ev.coin)}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

function fmtStreak(streak: number): string {
  return streak > 0 ? `+${streak} UP` : `${streak} DOWN`;
}

function formatStreakMismatch(ev: SignalStreakDataMismatchEvent): string {
  const winLabel = fmtWindow(ev.windowStart, ev.windowEnd);
  const moveSign = ev.binanceMovePct >= 0 ? '+' : '';
  const tinyMove = Math.abs(ev.binanceMovePct) < 0.05;
  const binIcon  = ev.binanceDirection === 'up' ? '🟢' : '🔴';
  const polyIcon = ev.polyDirection    === 'up' ? '🟢' : '🔴';
  return [
    `⚠ <b>${coinLabel(ev.coin)}</b> · Binance/Poly mismatch · <code>${winLabel}</code>`,
    `Binance: ${binIcon} ${ev.binanceDirection.toUpperCase()} (close-open ${moveSign}${ev.binanceMovePct.toFixed(3)}%)`
      + (tinyMove ? ' <i>tiny move</i>' : ''),
    `Polymarket: ${polyIcon} ${ev.polyDirection.toUpperCase()}`,
    `<i>Bot uses Binance for streak/arm (chart visual). Poly resolved this bar opposite</i>`,
    `<i>→ if a contrarian bet was placed on this bar's direction, T-0 outcome may go against us.</i>`,
  ].join('\n');
}
