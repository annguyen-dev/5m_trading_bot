/**
 * src/services/TelegramService.ts
 *
 * Multi-channel Telegram router: dispatches each SignalBus event to EVERY
 * channel whose filter matches (coin + info_type).
 *
 * Event → info_type mapping:
 *   T+4                    → 'signal'
 *   T+0, T-30s, T-0        → 'order'
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
  SignalBusEvent, SignalT0PlusEvent, SignalT4Event, SignalTMinus30Event,
  SignalT0Event,
} from './SignalBus.js';
import type { Signal } from '@trading-bot/shared';
import {
  getTelegramChannels, channelMatches,
  type TelegramChannel, type TelegramInfoType,
} from './telegramChannels.js';

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
    return ev.type === 'T+4' ? 'signal' : 'order';
  }

  /**
   * Fan out the event to every matching channel. If no channels are configured
   * AND a legacy fallback env channel is set, post there so the bot still
   * works out of the box.
   */
  async send(ev: SignalBusEvent): Promise<void> {
    if (!this.enabled || !this.bot) return;

    let text: string;
    try {
      switch (ev.type) {
        case 'T+0':   text = formatT0Plus(ev);    break;
        case 'T+4':   text = formatT4(ev);        break;
        case 'T-30s': text = formatTMinus30(ev);  break;
        case 'T-0':   text = formatT0(ev);        break;
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

/** Format a window time range as "HH:MM-HH:MM" (local time). */
function fmtWindow(start: number, end: number): string {
  const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${hhmm(start)}-${hhmm(end)}`;
}

function formatT4(ev: SignalT4Event): string {
  const dirIcon  = ev.direction === 'up' ? '🟢' : '🔴';
  const dirLabel = ev.direction.toUpperCase();
  const priceStr = ev.price != null ? `${(ev.price * 100).toFixed(1)}¢` : '?';
  const modeTag  = ev.mode === 'signal_and_order' ? '<i>will auto-order</i>' : '<i>signal-only</i>';
  const volStr   = ev.streakVolumeBuckets?.length
    ? `vol: ${ev.streakVolumeBuckets.join(' ')}`
    : '';
  return [
    `<b>${ev.coin}</b> · <b>T+4</b> · <code>${fmtWindow(ev.windowStart, ev.windowEnd)}</code> · streak ${fmtStreak(ev.streak)}`,
    `past: ${ev.pastStreakIcons}  current: ${ev.currentIcon}`,
    volStr,
    `signal: ${dirIcon} <b>${dirLabel}</b> @ ${priceStr} · $${ev.sizeUsdc}`,
    `limit ${ev.limitCents}¢ · ${modeTag}`,
  ].filter(Boolean).join('\n');
}

function formatTMinus30(ev: SignalTMinus30Event): string {
  const base   = `<b>${ev.coin}</b> · <b>T-30s</b> · <code>${fmtWindow(ev.windowStart, ev.windowEnd)}</code>`;
  const dcaTag = ev.signalPath === 'dca' ? ' · 🔄 <b>DCA</b>' : '';
  const lateTag = ev.lateRetry ? ' · ⏰ <i>T-0 retry</i>' : '';
  const adaptiveLine = ev.adaptive && (ev.adaptive.mode !== 'default' || ev.adaptive.threshold !== ev.adaptive.base)
    ? `\n📊 auto_min=<b>${ev.adaptive.threshold}</b> (base ${ev.adaptive.base}, <i>${ev.adaptive.mode}</i>) — ${escapeHtml(ev.adaptive.reason)}`
    : '';
  switch (ev.action) {
    case 'order_placed':
      return [
        `${base}${dcaTag}${lateTag}`,
        `✅ <b>ORDER PLACED</b>: ${(ev.direction ?? '?').toUpperCase()} @ ${ev.price != null ? (ev.price * 100).toFixed(1) + '¢' : '?'} · $${ev.sizeUsdc ?? '?'}`,
        ev.orderId ? `id: <code>${escapeHtml(ev.orderId.slice(0, 8))}…</code>` : '',
      ].filter(Boolean).join('\n') + adaptiveLine;
    case 'order_skipped':
      return `${base}${dcaTag}\n⚠ <b>skipped</b>: ${escapeHtml(ev.reason ?? '(no reason)')}${adaptiveLine}`;
    case 'signal_only_mode':
      return `${base}\nℹ signal-only mode, no order placed`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatT0Plus(ev: SignalT0PlusEvent): string {
  const o = ev.order;
  const dcaTag = o.signalPath === 'dca' ? ' · 🔄 DCA' : '';
  return [
    `<b>${ev.coin}</b> · <b>T+0</b> · <code>${fmtWindow(ev.windowStart, ev.windowEnd)}</code> · 🎯 active order${dcaTag}`,
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
    const dcaTag = o.signalPath === 'dca' ? ' · 🔄 DCA' : '';
    lines.push(
      `<b>${ev.coin}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()} · ${pnlStr}${dcaTag}`,
      `entry ${(o.entryPrice * 100).toFixed(1)}¢ → exit ${(o.exitPrice * 100).toFixed(1)}¢ · `
        + `<code>${escapeHtml(o.orderId.slice(0, 8))}…</code>`,
    );
    if (ev.dca) {
      const d = ev.dca;
      const ratio = o.sizeUsdc > 0 ? (d.sizeUsdc / o.sizeUsdc).toFixed(2) : '?';
      lines.push(
        `🔄 <b>DCA placed</b> for N+1 (<code>${nextWin}</code>): `
          + `${d.direction.toUpperCase()} @ ${(d.entryPrice * 100).toFixed(1)}¢ · `
          + `$${d.sizeUsdc.toFixed(2)} (${ratio}× of loser $${o.sizeUsdc})`,
      );
    }
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
      `<b>${ev.coin}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()}`,
      `🚫 <b>CANCELLED</b> N+1 order (<code>${nextWin}</code>, current reversed): `
        + `exit ${(c.exitPrice * 100).toFixed(1)}¢ · `
        + `PnL ${c.pnlUsdc >= 0 ? '+' : ''}$${c.pnlUsdc.toFixed(2)}`,
    );
  } else {
    lines.push(
      `<b>${ev.coin}</b> · <b>T-0</b> · <code>${winLabel}</code> · ${outIcon} ${ev.outcome.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

function fmtStreak(streak: number): string {
  return streak > 0 ? `+${streak} UP` : `${streak} DOWN`;
}
