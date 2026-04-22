/**
 * src/services/TelegramService.ts
 *
 * Sends formatted Telegram messages for multi-coin trading signals emitted by
 * PriceMonitoringWorker via SignalBus.
 *
 * Phases per window:
 *   T+0    — start of window: notify if there's an active order targeting N
 *   T+4m   — signal (streak + direction + price, no order yet)
 *   T-30s  — order placement result for N+1 (placed / skipped / signal-only)
 *   T-0    — window close: PnL + maybe DCA, OR cancel of N+1 outgoing
 *
 * T+0 and T-0 are CONDITIONAL — fire only when there's something to report.
 *
 * Env:
 *   TELEGRAM_TOKEN       bot token (from @BotFather)
 *   TELEGRAM_CHANNEL_ID  channel/chat ID to post into
 */
import { Bot } from 'grammy';
import { log } from './observability/logger.js';
import type {
  SignalBusEvent, SignalT0PlusEvent, SignalT4Event, SignalTMinus30Event,
  SignalT0Event,
} from './SignalBus.js';
import type { Signal } from '@trading-bot/shared';

export class TelegramService {
  private bot: Bot | null = null;
  private readonly channelId: string;
  private readonly enabled:   boolean;

  // Constructor takes no required args. Kept an optional `viewOnly` param
  // for backward compat with the legacy AI-pipeline entry point (src/index.ts).
  constructor(_viewOnly = false) {
    const token = process.env['TELEGRAM_TOKEN'] ?? '';
    this.channelId = process.env['TELEGRAM_CHANNEL_ID'] ?? '';
    const isPlaceholder = !token
      || token.includes('placeholder')
      || token.startsWith('123456789')
      || !this.channelId
      || this.channelId === '-100123456789';
    if (isPlaceholder) {
      this.enabled = false;
      log('info', 'TelegramService: disabled (no real TELEGRAM_TOKEN/CHANNEL_ID)');
    } else {
      this.bot = new Bot(token);
      this.enabled = true;
      log('info', 'TelegramService: enabled', { channel: this.channelId });
    }
  }

  /**
   * Legacy method from the pre-Polymarket AI pipeline. Keeps compile-
   * compatibility for src/index.ts + SignalPipeline; no-ops when the new
   * worker-based flow is active.
   */
  async sendSignal(_signal: Signal): Promise<void> {
    /* legacy no-op */
  }

  /** Dispatcher — routes a SignalBusEvent to the right formatter. */
  async send(ev: SignalBusEvent): Promise<void> {
    if (!this.enabled || !this.bot) return;
    let text: string;
    try {
      switch (ev.type) {
        case 'T+0':   text = formatT0Plus(ev); break;
        case 'T+4':   text = formatT4(ev); break;
        case 'T-30s': text = formatTMinus30(ev); break;
        case 'T-0':   text = formatT0(ev); break;
      }
    } catch (err) {
      log('warn', 'TelegramService formatter failed', {
        type: ev.type, error: String(err),
      });
      return;
    }
    try {
      await this.bot.api.sendMessage(this.channelId, text, { parse_mode: 'HTML' });
    } catch (err) {
      log('warn', 'TelegramService sendMessage failed', {
        type: ev.type, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Formatters (HTML parse mode — simpler than MarkdownV2 escaping) ────────

function formatT4(ev: SignalT4Event): string {
  const dirIcon  = ev.direction === 'up' ? '🟢' : '🔴';
  const dirLabel = ev.direction.toUpperCase();
  const priceStr = ev.price != null ? `${(ev.price * 100).toFixed(1)}¢` : '?';
  const modeTag  = ev.mode === 'signal_and_order' ? '<i>will auto-order</i>' : '<i>signal-only</i>';
  const volStr   = ev.streakVolumeBuckets?.length
    ? `vol: ${ev.streakVolumeBuckets.join(' ')}`
    : '';
  return [
    `<b>${ev.coin}</b> · <b>T+4</b> · streak ${fmtStreak(ev.streak)}`,
    `past: ${ev.pastStreakIcons}  current: ${ev.currentIcon}`,
    volStr,
    `signal: ${dirIcon} <b>${dirLabel}</b> @ ${priceStr} · $${ev.sizeUsdc}`,
    `limit ${ev.limitCents}¢ · ${modeTag}`,
  ].filter(Boolean).join('\n');
}

function formatTMinus30(ev: SignalTMinus30Event): string {
  const base = `<b>${ev.coin}</b> · <b>T-30s</b>`;
  const dcaTag = ev.signalPath === 'dca' ? ' · 🔄 <b>DCA</b>' : '';
  switch (ev.action) {
    case 'order_placed':
      return [
        `${base}${dcaTag}`,
        `✅ <b>ORDER PLACED</b>: ${(ev.direction ?? '?').toUpperCase()} @ ${ev.price != null ? (ev.price * 100).toFixed(1) + '¢' : '?'} · $${ev.sizeUsdc ?? '?'}`,
        ev.orderId ? `id: <code>${escapeHtml(ev.orderId.slice(0, 8))}…</code>` : '',
      ].filter(Boolean).join('\n');
    case 'order_skipped':
      return `${base}${dcaTag}\n⚠ <b>skipped</b>: ${escapeHtml(ev.reason ?? '(no reason)')}`;
    case 'signal_only_mode':
      return `${base}\nℹ signal-only mode, no order placed`;
  }
}

/** Telegram HTML parse_mode supports a limited tag set. User-controlled
 *  strings (e.g. skip reasons that contain "<" or ">") must be escaped or
 *  Telegram returns 400 "can't parse entities". */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatT0Plus(ev: SignalT0PlusEvent): string {
  const o = ev.order;
  const dcaTag = o.signalPath === 'dca' ? ' · 🔄 DCA' : '';
  return [
    `<b>${ev.coin}</b> · <b>T+0</b> · 🎯 active order${dcaTag}`,
    `${o.direction.toUpperCase()} @ ${(o.entryPrice * 100).toFixed(1)}¢ · $${o.sizeUsdc} · `
      + `id <code>${escapeHtml(o.orderId.slice(0, 8))}…</code>`,
  ].join('\n');
}

function formatT0(ev: SignalT0Event): string {
  const outIcon = ev.outcome === 'up'   ? '🟢'
                : ev.outcome === 'down' ? '🔴'
                :                          '⚪';
  const lines: string[] = [];

  if (ev.order) {
    const o = ev.order;
    const pnlStr = `PnL ${o.pnlUsdc >= 0 ? '+' : ''}$${o.pnlUsdc.toFixed(2)}`;
    const dcaTag = o.signalPath === 'dca' ? ' · 🔄 DCA' : '';
    lines.push(
      `<b>${ev.coin}</b> · <b>T-0</b> · ${outIcon} ${ev.outcome.toUpperCase()} · ${pnlStr}${dcaTag}`,
      `entry ${(o.entryPrice * 100).toFixed(1)}¢ → exit ${(o.exitPrice * 100).toFixed(1)}¢ · `
        + `<code>${escapeHtml(o.orderId.slice(0, 8))}…</code>`,
    );
    if (ev.dca) {
      const d = ev.dca;
      lines.push(
        `🔄 <b>DCA placed</b> for N+1: ${d.direction.toUpperCase()} @ ${(d.entryPrice * 100).toFixed(1)}¢ · $${d.sizeUsdc}`,
      );
    }
  } else if (ev.cancelled) {
    const c = ev.cancelled;
    lines.push(
      `<b>${ev.coin}</b> · <b>T-0</b> · ${outIcon} ${ev.outcome.toUpperCase()}`,
      `🚫 <b>CANCELLED</b> N+1 order (current reversed): `
        + `exit ${(c.exitPrice * 100).toFixed(1)}¢ · `
        + `PnL ${c.pnlUsdc >= 0 ? '+' : ''}$${c.pnlUsdc.toFixed(2)}`,
    );
  } else {
    // Shouldn't happen — worker only emits T-0 when something actionable
    // exists (active order or cancellation). Defensive fallback.
    lines.push(
      `<b>${ev.coin}</b> · <b>T-0</b> · ${outIcon} ${ev.outcome.toUpperCase()}`,
    );
  }
  return lines.join('\n');
}

function fmtStreak(streak: number): string {
  return streak > 0 ? `+${streak} UP` : `${streak} DOWN`;
}
