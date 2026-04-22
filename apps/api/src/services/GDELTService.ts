/**
 * GDELTService — Real-time geopolitical event monitoring via GDELT Project.
 *
 * Polls GDELT Doc 2.0 API every 15 minutes for articles mentioning
 * Bitcoin/crypto/Fed/SEC. Filters by tone severity, then uses Claude
 * to classify relevance and estimate BTC impact.
 *
 * No API key required.
 * Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { log } from '../observability/logger.js';
import { getTracer } from '../observability/tracing.js';
import { getApiLatencyHistogram } from '../observability/metrics.js';
import type { GDELTEvent } from '../types/onchain.js';

// ── GDELT API response shapes ─────────────────────────────────────────────────

interface GDELTArticle {
  url:        string;
  title:      string;
  seendate:   string;   // YYYYMMDDTHHmmssZ
  tone:       number;
  domain:     string;
}

interface GDELTDocResponse {
  articles?: GDELTArticle[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';

// Search terms — GDELT boolean query syntax
const QUERY = [
  '"bitcoin" OR "BTC" OR "cryptocurrency" OR "crypto"',
  'OR "Federal Reserve" OR "SEC" OR "CFTC"',
  'OR "interest rate" OR "inflation" OR "sanctions"',
  'OR "Binance" OR "stablecoin" OR "CBDC"',
].join(' ');

// Surface articles with moderate sentiment (|tone| > 1.5)
// GDELT tone is typically -10 to +10; threshold of 3 was too strict
const TONE_THRESHOLD = 1.5;

// Claude classification prompt
const CLASSIFY_PROMPT = (articles: { title: string; tone: number }[]) =>
  `You are a crypto market analyst. For each news article below, estimate:
1. relevance to BTC price (0.0-1.0)
2. likely BTC impact: "bullish" | "bearish" | "neutral"
3. urgency: "immediate" (hours) | "short" (1-3 days) | "long" (weeks+) | "none"

Return ONLY a JSON array, one object per article, in the same order:
[{"relevance": 0.8, "impact": "bearish", "urgency": "immediate"}, ...]

Articles:
${articles.map((a, i) => `${i + 1}. [tone: ${a.tone.toFixed(1)}] ${a.title}`).join('\n')}`;

// ── Service ───────────────────────────────────────────────────────────────────

export class GDELTService extends EventEmitter {
  private seen  = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private client = new Anthropic({ apiKey: config.anthropicApiKey });
  private tracer  = getTracer('GDELTService');
  private latency = getApiLatencyHistogram();

  /** Poll interval — 15 minutes in production, configurable for tests */
  constructor(private readonly pollIntervalMs = 15 * 60 * 1_000) {
    super();
  }

  start(): void {
    log('info', 'GDELTService starting', { intervalMs: this.pollIntervalMs });
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    log('info', 'GDELTService stopped');
  }

  private async poll(): Promise<void> {
    const span = this.tracer.startSpan('GDELTService.poll');
    const t0 = Date.now();

    try {
      // Fetch last 15 minutes of articles
      const resp = await axios.get<GDELTDocResponse>(GDELT_DOC_API, {
        timeout: 15_000,
        params: {
          query:     QUERY,
          mode:      'artlist',
          maxrecords: 50,
          format:    'json',
          timespan:  '60min',  // 15min was too narrow — GDELT indexes with ~15-20min delay
        },
      });

      this.latency.record(Date.now() - t0, { endpoint: 'gdelt' });

      const articles = (resp.data.articles ?? [])
        .filter(a => !this.seen.has(a.url) && Math.abs(a.tone) >= TONE_THRESHOLD);

      if (articles.length === 0) return;

      // Mark seen before classification (avoid re-processing on retry)
      articles.forEach(a => this.seen.add(a.url));

      // Keep seen set bounded
      if (this.seen.size > 5_000) {
        const arr = [...this.seen];
        arr.splice(0, 1_000).forEach(u => this.seen.delete(u));
      }

      // Classify relevance + impact with Claude (batch)
      const classified = await this.classify(articles);

      for (const evt of classified) {
        if (evt.relevance < 0.4) continue; // skip low-relevance

        log('info', 'GDELT event detected', {
          title:     evt.title.slice(0, 80),
          tone:      evt.tone,
          relevance: evt.relevance,
        });

        this.emit('gdeltEvent', evt);
      }
    } catch (err) {
      log('warn', 'GDELTService poll failed', { error: String(err) });
      span.recordException(err as Error);
    } finally {
      span.end();
    }
  }

  private async classify(articles: GDELTArticle[]): Promise<GDELTEvent[]> {
    // Skip Claude call if all articles have obvious tone direction
    try {
      const input = articles.map(a => ({ title: a.title, tone: a.tone }));
      const msg = await this.client.messages.create({
        model:      'claude-haiku-4-5-20251001', // cheapest — just classification
        max_tokens: 512,
        messages:   [{ role: 'user', content: CLASSIFY_PROMPT(input) }],
      });

      const text = msg.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array in response');

      const classifications = JSON.parse(jsonMatch[0]) as {
        relevance: number;
        impact:    string;
        urgency:   string;
      }[];

      return articles.map((a, i) => {
        const cls = classifications[i] ?? { relevance: 0, impact: 'neutral', urgency: 'none' };
        return {
          timestamp: parseGDELTDate(a.seendate),
          title:     a.title,
          url:       a.url,
          tone:      a.tone,
          goldstein: 0, // Doc API doesn't return GoldsteinScale — only GKG does
          eventCode: '',
          actors:    [],
          relevance: cls.relevance,
        };
      });
    } catch (err) {
      log('warn', 'GDELT classification failed, falling back to tone-only', { error: String(err) });

      // Fallback: use tone as proxy for relevance (no Claude)
      return articles.map(a => ({
        timestamp: parseGDELTDate(a.seendate),
        title:     a.title,
        url:       a.url,
        tone:      a.tone,
        goldstein: 0,
        eventCode: '',
        actors:    [],
        relevance: Math.min(Math.abs(a.tone) / 10, 1.0),
      }));
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGDELTDate(s: string): number {
  // Format: 20240113T120000Z
  try {
    return new Date(
      s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    ).getTime();
  } catch {
    return Date.now();
  }
}
