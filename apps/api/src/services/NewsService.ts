import { EventEmitter } from 'events';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { NewsEvent } from '../types/news.js';
import { config } from '../config/index.js';
import { log } from '../observability/logger.js';
import { getApiLatencyHistogram } from '../observability/metrics.js';
import { getTracer } from '../observability/tracing.js';

// ── Default RSS feeds (no API key required) ───────────────────────────────────
const DEFAULT_RSS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://bitcoinmagazine.com/feed',
  'https://decrypt.co/feed',
];

// ── Keyword sentiment lexicon ─────────────────────────────────────────────────
const POSITIVE_KEYWORDS = [
  'bullish', 'surge', 'rally', 'adoption', 'approve', 'approved',
  'launch', 'partnership', 'etf', 'institutional', 'all-time high',
  'ath', 'upgrade', 'growth', 'positive', 'gain',
];
const NEGATIVE_KEYWORDS = [
  'crash', 'ban', 'hack', 'exploit', 'bearish', 'dump', 'sell-off',
  'regulation', 'lawsuit', 'fraud', 'sec', 'crackdown', 'collapse',
  'bankruptcy', 'scam', 'ponzi', 'fear',
];

// ── RSS item shape (common across feeds) ─────────────────────────────────────
interface RssItem {
  title: string;
  link:  string;
  pubDate?: string;
  'dc:date'?: string;
}

interface RssFeed {
  rss?: { channel?: { item?: RssItem | RssItem[] } };
  feed?: { entry?: RssItem | RssItem[] };  // Atom format fallback
}

export class NewsService extends EventEmitter {
  private seen  = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private parser = new XMLParser({ ignoreAttributes: false });
  private tracer  = getTracer('NewsService');
  private latency = getApiLatencyHistogram();

  // Feeds to poll — override via NEWS_RSS_FEEDS env var (comma-separated URLs)
  private feeds: string[] = config.newsRssFeeds.length > 0
    ? config.newsRssFeeds
    : DEFAULT_RSS_FEEDS;

  start(): void {
    log('info', 'NewsService starting', {
      feeds: this.feeds.length,
      interval: config.newsPollIntervalMs,
    });
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), config.newsPollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    log('info', 'NewsService stopped');
  }

  private async pollAll(): Promise<void> {
    await Promise.allSettled(this.feeds.map(url => this.pollFeed(url)));
  }

  private async pollFeed(url: string): Promise<void> {
    const span = this.tracer.startSpan('NewsService.pollFeed');
    const t0 = Date.now();
    try {
      const resp = await axios.get<string>(url, {
        timeout: 10_000,
        headers: { 'User-Agent': 'trading-bot/0.1 RSS reader' },
        responseType: 'text',
      });
      this.latency.record(Date.now() - t0, { endpoint: 'rss' });

      const parsed = this.parser.parse(resp.data) as RssFeed;

      // Support both RSS 2.0 and Atom formats
      const rawItems = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
      const items: RssItem[] = Array.isArray(rawItems) ? rawItems : [rawItems];

      for (const item of items) {
        if (!item.title || !item.link) continue;

        const id = item.link;
        if (this.seen.has(id)) continue;
        this.seen.add(id);

        const publishedAt = new Date(
          item.pubDate ?? item['dc:date'] ?? Date.now()
        ).getTime();

        const event: NewsEvent = {
          id,
          headline: String(item.title),
          url: String(item.link),
          source: new URL(url).hostname.replace('www.', ''),
          sentiment: scoreSentiment(String(item.title)),
          publishedAt,
        };

        log('info', 'News event received', {
          source: event.source,
          sentiment: event.sentiment.toFixed(2),
          headline: event.headline.slice(0, 80),
        });

        this.emit('newsEvent', event);
      }
    } catch (err) {
      log('warn', 'NewsService feed failed', { url, error: String(err) });
      span.recordException(err as Error);
    } finally {
      span.end();
    }
  }
}

// Exported for unit testing
export function scoreSentiment(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of POSITIVE_KEYWORDS) if (lower.includes(kw)) score += 1;
  for (const kw of NEGATIVE_KEYWORDS) if (lower.includes(kw)) score -= 1;
  const maxPossible = Math.max(POSITIVE_KEYWORDS.length, NEGATIVE_KEYWORDS.length);
  return Math.max(-1, Math.min(1, score / maxPossible));
}
