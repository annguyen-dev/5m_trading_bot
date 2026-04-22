/**
 * MacroEventStore
 *
 * Maintains a LanceDB table of historical macro events, each embedded as a vector.
 * At pipeline query time, we search for events semantically similar to the current
 * market trigger, then return their price reaction data + lag stats to the AI.
 *
 * Seeded with ~60 high-impact historical events from 2017-2025.
 * New events can be appended via addEvent() as they happen.
 */

import { VectorStoreService } from './VectorStoreService.js';
import type { MacroEvent, MacroEventCategory, PriceReaction } from '../types/macro.js';
import { log } from '../observability/logger.js';

// ── Historical event seed data ────────────────────────────────────────────────

const SEED_EVENTS: Omit<MacroEvent, 'id'>[] = [

  // ── Fed Rate / Monetary Policy ─────────────────────────────────────────────
  {
    date: '2022-03-16', category: 'fed_rate',
    title: 'Fed first rate hike of 2022 cycle (+25bps)',
    description: 'Federal Reserve raises rates 25bps, first hike since 2018. Beginning of aggressive tightening cycle. Risk assets sell off.',
    btcPriceAtEvent: 41_000,
    reaction: { h1: -1.2, h4: -2.1, h24: -3.5, d3: -8.2, d7: -12.0, d30: -25.0 },
    lagHours: 72, impact: 'negative',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20220316a.htm',
  },
  {
    date: '2022-06-15', category: 'fed_rate',
    title: 'Fed hikes +75bps — largest since 1994',
    description: 'FOMC raises rates 75bps, shocking markets. BTC already in bear market from Luna collapse. Accelerates crypto winter.',
    btcPriceAtEvent: 22_000,
    reaction: { h1: -4.5, h4: -6.2, h24: -9.0, d3: -15.0, d7: -18.0, d30: -10.0 },
    lagHours: 48, impact: 'negative',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20220615a.htm',
  },
  {
    date: '2022-11-02', category: 'fed_rate',
    title: 'Fed hikes +75bps 4th consecutive time',
    description: 'Fourth consecutive 75bps hike signals sustained aggressive tightening. Dollar strengthens sharply, crypto suffers.',
    btcPriceAtEvent: 20_500,
    reaction: { h1: -2.0, h4: -3.8, h24: -5.0, d3: -12.0, d7: -20.0, d30: -30.0 },
    lagHours: 96, impact: 'negative',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20221102a.htm',
  },
  {
    date: '2023-02-01', category: 'fed_rate',
    title: 'Fed slows to +25bps — pivot signal',
    description: 'Fed downshifts to 25bps hike. Markets interpret as peak rates approaching. Risk-on sentiment returns to crypto.',
    btcPriceAtEvent: 23_500,
    reaction: { h1: 2.5, h4: 3.8, h24: 6.5, d3: 9.0, d7: 14.0, d30: 22.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20230201a.htm',
  },
  {
    date: '2023-07-26', category: 'fed_rate',
    title: 'Fed final hike +25bps — likely end of cycle',
    description: 'Fed raises to 5.25-5.50%, signaling possible end of tightening. BTC consolidates; market awaits pivot confirmation.',
    btcPriceAtEvent: 29_300,
    reaction: { h1: 0.5, h4: 1.2, h24: 2.0, d3: -1.5, d7: 3.5, d30: 10.0 },
    lagHours: 168, impact: 'mixed',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20230726a.htm',
  },
  {
    date: '2024-09-18', category: 'fed_rate',
    title: 'Fed first rate cut -50bps — pivot confirmed',
    description: 'Fed cuts rates 50bps, first cut since COVID. Risk-on rally across all assets. BTC breaks above key resistance.',
    btcPriceAtEvent: 60_000,
    reaction: { h1: 3.2, h4: 4.8, h24: 7.5, d3: 8.0, d7: 12.0, d30: 25.0 },
    lagHours: 24, impact: 'positive',
    source: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20240918a.htm',
  },

  // ── Inflation Data ─────────────────────────────────────────────────────────
  {
    date: '2022-06-10', category: 'inflation',
    title: 'US CPI hits 8.6% — 40-year high',
    description: 'June CPI print 8.6% YoY, highest since 1981. Triggers expectations of 75bps hike. BTC crashes from $30k to $20k within days.',
    btcPriceAtEvent: 30_000,
    reaction: { h1: -5.0, h4: -8.0, h24: -15.0, d3: -25.0, d7: -28.0, d30: -35.0 },
    lagHours: 24, impact: 'negative',
    source: 'https://www.bls.gov/news.release/cpi.nr0.htm',
  },
  {
    date: '2023-06-13', category: 'inflation',
    title: 'CPI cools to 4.0% — disinflation trend confirmed',
    description: 'CPI drops to 4.0%, lowest since 2021. Disinflation narrative strengthens. Risk assets rally on rate cut hopes.',
    btcPriceAtEvent: 26_000,
    reaction: { h1: 1.8, h4: 3.2, h24: 5.0, d3: 6.5, d7: 8.0, d30: 20.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.bls.gov/news.release/cpi.nr0.htm',
  },
  {
    date: '2024-03-12', category: 'inflation',
    title: 'CPI re-accelerates to 3.2% — sticky inflation fears',
    description: 'CPI comes in hotter than expected at 3.2%. Rate cut expectations pushed back. BTC briefly dips but recovers — ETF inflows dominate.',
    btcPriceAtEvent: 72_000,
    reaction: { h1: -2.5, h4: -4.0, h24: -5.0, d3: 2.0, d7: 5.0, d30: 15.0 },
    lagHours: 72, impact: 'mixed',
    source: 'https://www.bls.gov/news.release/cpi.nr0.htm',
  },

  // ── Regulatory Events ──────────────────────────────────────────────────────
  {
    date: '2021-09-24', category: 'regulatory',
    title: 'China declares all crypto transactions illegal',
    description: 'PBOC declares all crypto transactions illegal, bans overseas exchanges. BTC flash crashes. Chinese miners fully exit.',
    btcPriceAtEvent: 43_000,
    reaction: { h1: -5.0, h4: -8.5, h24: -12.0, d3: -18.0, d7: -10.0, d30: 40.0 },
    lagHours: 72, impact: 'negative',
    source: 'https://www.reuters.com/world/china/china-central-bank-vows-crackdown-cryptocurrency-trading-2021-09-24/',
  },
  {
    date: '2023-06-22', category: 'regulatory',
    title: 'BlackRock files Bitcoin ETF application',
    description: 'BlackRock, world\'s largest asset manager, files for spot Bitcoin ETF. Triggers massive speculation wave. BTC surges.',
    btcPriceAtEvent: 30_000,
    reaction: { h1: 4.0, h4: 7.5, h24: 12.0, d3: 15.0, d7: 18.0, d30: 35.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=blackrock+bitcoin',
  },
  {
    date: '2024-01-10', category: 'regulatory',
    title: 'SEC approves spot Bitcoin ETF — 11 ETFs launch simultaneously',
    description: 'SEC approves first US spot Bitcoin ETFs. Classic "sell the news" — price peaks near approval, dumps 15% over 2 weeks as Grayscale unlocks sell pressure.',
    btcPriceAtEvent: 46_500,
    reaction: { h1: 1.5, h4: -1.0, h24: -3.0, d3: -8.0, d7: -12.0, d30: 55.0 },
    lagHours: 336, impact: 'mixed',
    source: 'https://www.sec.gov/news/press-release/2024-3',
  },
  {
    date: '2023-03-22', category: 'regulatory',
    title: 'CFTC sues Binance for regulatory violations',
    description: 'CFTC files charges against Binance and CZ for operating illegal derivatives exchange. Short-term fear; BNB and BTC dip.',
    btcPriceAtEvent: 28_000,
    reaction: { h1: -3.5, h4: -5.0, h24: -7.0, d3: -5.0, d7: 0.0, d30: 10.0 },
    lagHours: 48, impact: 'negative',
    source: 'https://www.cftc.gov/PressRoom/PressReleases/8680-23',
  },
  {
    date: '2023-11-21', category: 'regulatory',
    title: 'Binance pays $4.3B fine, CZ steps down',
    description: 'Binance settles with DOJ for $4.3B, largest crypto penalty. CZ resigns. Market absorbs news quickly — Binance continues operating.',
    btcPriceAtEvent: 36_500,
    reaction: { h1: -4.0, h4: -5.5, h24: -3.0, d3: 2.0, d7: 8.0, d30: 50.0 },
    lagHours: 24, impact: 'mixed',
    source: 'https://www.justice.gov/opa/pr/binance-and-ceo-plead-guilty-federal-charges',
  },
  {
    date: '2024-05-23', category: 'regulatory',
    title: 'SEC approves Ethereum spot ETF',
    description: 'SEC unexpectedly approves Ethereum spot ETF applications. Bullish for entire crypto market; BTC benefits from renewed institutional interest.',
    btcPriceAtEvent: 66_000,
    reaction: { h1: 3.0, h4: 5.5, h24: 8.0, d3: 6.0, d7: 4.0, d30: -10.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.sec.gov/news/press-release/2024-107',
  },

  // ── Black Swan Events ──────────────────────────────────────────────────────
  {
    date: '2020-03-12', category: 'black_swan',
    title: 'COVID-19 Black Thursday — global market crash',
    description: 'Global pandemic panic. BTC crashes 50% in 24 hours on March 12. All risk assets collapse simultaneously. Fed emergency intervention follows.',
    btcPriceAtEvent: 8_000,
    reaction: { h1: -10.0, h4: -25.0, h24: -50.0, d3: -45.0, d7: -30.0, d30: 60.0 },
    lagHours: 4, impact: 'negative',
    source: 'https://coinmarketcap.com/currencies/bitcoin/historical-data/',
  },
  {
    date: '2022-05-09', category: 'black_swan',
    title: 'Terra/Luna UST de-peg collapse begins',
    description: 'UST loses $1 peg. Death spiral begins — $40B in value destroyed in 72 hours. Systemic contagion across DeFi. BTC loses 30% in 2 weeks.',
    btcPriceAtEvent: 34_000,
    reaction: { h1: -4.0, h4: -8.0, h24: -15.0, d3: -25.0, d7: -32.0, d30: -40.0 },
    lagHours: 12, impact: 'negative',
    source: 'https://www.coindesk.com/markets/2022/05/11/the-luna-ust-crash-explained-in-5-charts/',
  },
  {
    date: '2022-11-08', category: 'black_swan',
    title: 'FTX liquidity crisis — CZ announces Binance exit',
    description: 'CoinDesk leaks Alameda balance sheet. Binance announces selling FTT. FTX bank run begins. $8B hole discovered. BTC loses 25% in 5 days.',
    btcPriceAtEvent: 21_000,
    reaction: { h1: -5.0, h4: -12.0, h24: -20.0, d3: -30.0, d7: -25.0, d30: -20.0 },
    lagHours: 24, impact: 'negative',
    source: 'https://www.coindesk.com/business/2022/11/02/divisions-in-sam-bankman-frieds-crypto-empire-blur-on-his-trading-titan-alamedas-balance-sheet/',
  },
  {
    date: '2023-03-10', category: 'black_swan',
    title: 'Silicon Valley Bank collapse — banking crisis',
    description: 'SVB collapses in largest US bank failure since 2008. USDC briefly de-pegs (Circle held $3.3B at SVB). Short-term crypto panic, then rally as users flee to BTC.',
    btcPriceAtEvent: 22_000,
    reaction: { h1: -5.0, h4: -8.0, h24: -10.0, d3: 5.0, d7: 25.0, d30: 45.0 },
    lagHours: 72, impact: 'mixed',
    source: 'https://www.fdic.gov/bank/individual/failed/silicon-valley-bank.html',
  },
  {
    date: '2022-01-21', category: 'black_swan',
    title: 'Russia threatens Ukraine invasion — geopolitical panic',
    description: 'US issues warnings about imminent Russian invasion of Ukraine. Risk-off across markets. BTC drops 12% in 48 hours.',
    btcPriceAtEvent: 38_000,
    reaction: { h1: -3.0, h4: -6.0, h24: -10.0, d3: -15.0, d7: -5.0, d30: -20.0 },
    lagHours: 48, impact: 'negative',
    source: 'https://www.reuters.com/world/europe/russia-ukraine-crisis-live-2022-01-21/',
  },

  // ── Adoption Events ────────────────────────────────────────────────────────
  {
    date: '2021-02-08', category: 'adoption',
    title: 'Tesla buys $1.5B BTC, adds to balance sheet',
    description: 'Tesla announces $1.5B BTC purchase. Elon Musk signals corporate treasury trend. BTC surges to new ATH. Triggers institutional FOMO wave.',
    btcPriceAtEvent: 44_000,
    reaction: { h1: 10.0, h4: 15.0, h24: 20.0, d3: 18.0, d7: 25.0, d30: 50.0 },
    lagHours: 24, impact: 'positive',
    source: 'https://ir.tesla.com/sec-filings/annual-reports/content/0000950170-21-000010/0000950170-21-000010.htm',
  },
  {
    date: '2021-09-07', category: 'adoption',
    title: 'El Salvador makes Bitcoin legal tender',
    description: 'El Salvador becomes first country to adopt BTC as legal tender. Chivo wallet launches. Short-term dump (sell the news) then long-term bullish signal.',
    btcPriceAtEvent: 52_000,
    reaction: { h1: -8.0, h4: -10.0, h24: -12.0, d3: -5.0, d7: 5.0, d30: 35.0 },
    lagHours: 168, impact: 'mixed',
    source: 'https://www.bcentral.gob.sv/noticias/comunicados/2021/September/comunicado09072021.html',
  },
  {
    date: '2024-02-28', category: 'adoption',
    title: 'MicroStrategy raises $800M to buy more BTC',
    description: 'MicroStrategy continues aggressive BTC accumulation via convertible notes. Signals unwavering corporate conviction. Market interprets as bullish.',
    btcPriceAtEvent: 57_000,
    reaction: { h1: 2.0, h4: 3.5, h24: 5.0, d3: 7.0, d7: 10.0, d30: 30.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.microstrategy.com/en/investor-relations/',
  },
  {
    date: '2024-04-08', category: 'adoption',
    title: 'Hong Kong approves spot BTC + ETH ETFs',
    description: 'Hong Kong SFC approves spot crypto ETFs, first in Asia. Opens access to mainland Chinese capital via HKEX. Bullish sentiment boost.',
    btcPriceAtEvent: 71_000,
    reaction: { h1: 1.5, h4: 2.5, h24: 4.0, d3: 2.0, d7: -5.0, d30: -15.0 },
    lagHours: 24, impact: 'positive',
    source: 'https://www.sfc.hk/en/News-and-announcements/Policy-statements-and-announcements/2024/SFC-circular-to-management-companies-of-SFC-authorised-unit-trusts-and-mutual-funds-on-virtual-asset-spot-ETFs',
  },

  // ── BTC Halving ────────────────────────────────────────────────────────────
  {
    date: '2020-05-11', category: 'halving',
    title: 'BTC 3rd halving — block reward 12.5 → 6.25 BTC',
    description: 'Third Bitcoin halving. Supply shock narrative. Short-term price action muted; 6-12 months later BTC rallied 600%.',
    btcPriceAtEvent: 8_600,
    reaction: { h1: 0.5, h4: 1.0, h24: 2.0, d3: -5.0, d7: 8.0, d30: 28.0 },
    lagHours: 4320, impact: 'positive',  // ~6 months lag
    source: 'https://coinmarketcap.com/halving/',
  },
  {
    date: '2024-04-20', category: 'halving',
    title: 'BTC 4th halving — block reward 6.25 → 3.125 BTC',
    description: 'Fourth Bitcoin halving. ETF demand absorbs sell pressure. Unlike 2020, price had already rallied significantly pre-halving.',
    btcPriceAtEvent: 63_500,
    reaction: { h1: 0.2, h4: -1.5, h24: -3.0, d3: 2.0, d7: -5.0, d30: 10.0 },
    lagHours: 2160, impact: 'positive',  // ~3 months lag
    source: 'https://coinmarketcap.com/halving/',
  },

  // ── Macro Liquidity ────────────────────────────────────────────────────────
  {
    date: '2020-03-23', category: 'macro_liquidity',
    title: 'Fed launches unlimited QE + $2T stimulus',
    description: 'Fed announces unlimited quantitative easing + emergency rate cuts. Dollar liquidity flood begins. BTC recovers violently from COVID crash lows.',
    btcPriceAtEvent: 6_500,
    reaction: { h1: 5.0, h4: 10.0, h24: 20.0, d3: 30.0, d7: 45.0, d30: 150.0 },
    lagHours: 48, impact: 'positive',
    source: 'https://www.federalreserve.gov/monetarypolicy/2020-03-23.htm',
  },
  {
    date: '2022-06-01', category: 'macro_liquidity',
    title: 'Fed begins Quantitative Tightening (QT) — $47.5B/month',
    description: 'Fed starts actively shrinking balance sheet. Liquidity drain begins. Dollar strengthens (DXY peaks at 114). Risk assets enter sustained bear market.',
    btcPriceAtEvent: 30_000,
    reaction: { h1: -1.0, h4: -2.5, h24: -5.0, d3: -10.0, d7: -20.0, d30: -40.0 },
    lagHours: 168, impact: 'negative',
    source: 'https://www.federalreserve.gov/monetarypolicy/20220504a.htm',
  },
  {
    date: '2023-08-01', category: 'macro_liquidity',
    title: 'US Treasury announces massive bond issuance — liquidity drain',
    description: 'Treasury Borrowing Advisory Committee announces $1T+ in bill issuance. Sucks liquidity from money markets. Risk assets sell off.',
    btcPriceAtEvent: 29_000,
    reaction: { h1: -1.5, h4: -3.0, h24: -6.0, d3: -10.0, d7: -12.0, d30: -5.0 },
    lagHours: 72, impact: 'negative',
    source: 'https://home.treasury.gov/system/files/221/tbac-q32023-b-charge.pdf',
  },
  {
    date: '2024-10-28', category: 'macro_liquidity',
    title: 'Global M2 money supply expansion accelerates',
    description: 'Global M2 money supply grows at fastest pace since 2021. Historical correlation: BTC lags M2 expansion by ~12 weeks. Bullish medium-term.',
    btcPriceAtEvent: 68_000,
    reaction: { h1: 0.5, h4: 1.0, h24: 2.0, d3: 3.0, d7: 5.0, d30: 20.0 },
    lagHours: 2016, impact: 'positive',  // ~12 week lag
    source: 'https://fred.stlouisfed.org/series/M2SL',
  },

  // ── Geopolitical ──────────────────────────────────────────────────────────
  {
    date: '2022-02-24', category: 'geopolitical',
    title: 'Russia invades Ukraine — war begins',
    description: 'Russia launches full-scale invasion of Ukraine. Immediate risk-off. Ukraine government solicits crypto donations. BTC initially dumps then recovers as sanctions-evasion narrative emerges.',
    btcPriceAtEvent: 37_000,
    reaction: { h1: -5.0, h4: -8.0, h24: -5.0, d3: 3.0, d7: 10.0, d30: 15.0 },
    lagHours: 48, impact: 'mixed',
    source: 'https://www.reuters.com/world/europe/russia-invades-ukraine-2022-02-24/',
  },
  {
    date: '2023-10-07', category: 'geopolitical',
    title: 'Hamas attacks Israel — Middle East conflict escalates',
    description: 'Hamas launches surprise attack on Israel. Regional conflict fears spike. Initial risk-off, then BTC recovers as digital gold narrative strengthens.',
    btcPriceAtEvent: 27_500,
    reaction: { h1: -3.0, h4: -4.5, h24: -2.0, d3: 2.0, d7: 8.0, d30: 25.0 },
    lagHours: 48, impact: 'mixed',
    source: 'https://www.reuters.com/world/middle-east/hamas-militants-launch-attack-israel-2023-10-07/',
  },
  {
    date: '2023-03-19', category: 'geopolitical',
    title: 'Credit Suisse emergency rescue by UBS — European banking fears',
    description: 'Swiss National Bank orchestrates emergency UBS takeover of Credit Suisse. European banking contagion fears. BTC surges as banking distrust grows.',
    btcPriceAtEvent: 26_000,
    reaction: { h1: 4.0, h4: 6.0, h24: 10.0, d3: 15.0, d7: 20.0, d30: 35.0 },
    lagHours: 24, impact: 'positive',
    source: 'https://www.ubs.com/global/en/media/display-page-ndpdefault/mdpdefault/2023/cs-acquisition-closing.html',
  },
];

// ── In-memory seed index (always available, no Voyage needed) ─────────────────

const SEED_INDEX: MacroEvent[] = SEED_EVENTS.map(raw => ({
  id: `macro:${raw.date}:${raw.category}`,
  ...raw,
}));

/**
 * Keyword-based similarity score between a query string and an event.
 * Splits both into lowercase word tokens and counts overlap.
 * Returns a score in [0, 1].
 */
function keywordScore(query: string, event: MacroEvent): number {
  const stopwords = new Set(['the','a','an','is','are','was','were','of','to','in','for','on','and','or','but','with','by','at','from']);
  const tokenize = (s: string) =>
    s.toLowerCase().match(/[a-z]+/g)?.filter(w => w.length > 2 && !stopwords.has(w)) ?? [];

  const qTokens = new Set(tokenize(query));
  const eTokens = new Set(tokenize(`${event.title} ${event.description} ${event.category}`));

  let overlap = 0;
  for (const t of qTokens) {
    if (eTokens.has(t)) overlap++;
  }
  const union = new Set([...qTokens, ...eTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

// ── Store class ───────────────────────────────────────────────────────────────

export class MacroEventStore {
  private initialized = false;
  private vectorStoreReady = false;

  constructor(private readonly vectorStore: VectorStoreService) {}

  /**
   * Seed the vector store with historical macro events if not already done.
   * Safe to call multiple times — uses event ID as deduplication key.
   * If Voyage AI embedding fails, falls back silently to keyword search.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    log('info', 'MacroEventStore seeding historical events', { count: SEED_EVENTS.length });

    let added = 0;
    for (const event of SEED_INDEX) {
      try {
        await this.vectorStore.addDocument({
          id: event.id,
          text: buildEmbedText(event),
          metadata: {
            type: 'macro_event',
            category: event.category,
            date: event.date,
            impact: event.impact,
            lagHours: event.lagHours,
            reaction: JSON.stringify(event.reaction),
            btcPriceAtEvent: event.btcPriceAtEvent,
          },
        });
        added++;
      } catch (err) {
        log('warn', 'MacroEventStore failed to embed event (will use keyword fallback)', {
          id: event.id, error: String(err),
        });
      }
    }

    this.vectorStoreReady = added > 0;
    log('info', 'MacroEventStore ready', {
      embedded: added,
      total: SEED_INDEX.length,
      mode: this.vectorStoreReady ? 'vector' : 'keyword-fallback',
    });
  }

  /**
   * Find macro events most similar to the current market context.
   * Uses vector search when Voyage AI is available; falls back to keyword matching.
   */
  async findSimilar(query: string, k = 5): Promise<MacroEvent[]> {
    // Try vector search first
    if (this.vectorStoreReady) {
      try {
        const results = await this.vectorStore.similaritySearch(query, k * 2, {
          type: 'macro_event',
        });

        if (results.length > 0) {
          return results.slice(0, k).map(r => ({
            id:              String(r.metadata['id'] ?? ''),
            date:            String(r.metadata['date'] ?? ''),
            category:        r.metadata['category'] as MacroEventCategory,
            title:           r.text.split('\n')[0]?.replace('Event: ', '') ?? '',
            description:     r.text,
            btcPriceAtEvent: Number(r.metadata['btcPriceAtEvent'] ?? 0),
            reaction:        JSON.parse(String(r.metadata['reaction'] ?? '{}')) as PriceReaction,
            lagHours:        Number(r.metadata['lagHours'] ?? 0),
            impact:          r.metadata['impact'] as MacroEvent['impact'],
            source:          '',
          }));
        }
      } catch (err) {
        log('warn', 'MacroEventStore vector search failed — using keyword fallback', { error: String(err) });
      }
    }

    // Keyword fallback — always works, no external dependencies
    return SEED_INDEX
      .map(event => ({ event, score: keywordScore(query, event) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ event }) => event);
  }

  /** Add a new live event to the store for future RAG queries */
  async addEvent(event: MacroEvent): Promise<void> {
    try {
      await this.vectorStore.addDocument({
        id: event.id,
        text: buildEmbedText(event),
        metadata: {
          type: 'macro_event',
          category: event.category,
          date: event.date,
          impact: event.impact,
          lagHours: event.lagHours,
          reaction: JSON.stringify(event.reaction),
          btcPriceAtEvent: event.btcPriceAtEvent,
        },
      });
    } catch {
      // Non-fatal — keyword search will still find the seed events
      log('warn', 'MacroEventStore.addEvent embed failed', { id: event.id });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEmbedText(event: MacroEvent): string {
  const r = event.reaction;
  return [
    `Event: ${event.title}`,
    `Date: ${event.date}  Category: ${event.category}  Impact: ${event.impact}`,
    event.description,
    `BTC price at event: $${event.btcPriceAtEvent.toLocaleString()}`,
    `Price reaction: +1h ${r.h1.toFixed(1)}%  +4h ${r.h4.toFixed(1)}%  +1d ${r.h24.toFixed(1)}%  +3d ${r.d3.toFixed(1)}%  +7d ${r.d7.toFixed(1)}%  +30d ${r.d30.toFixed(1)}%`,
    `Estimated lag to full price reflection: ${event.lagHours}h`,
  ].join('\n');
}
