import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { NewsEvent } from '../types/news.js';
import type { Signal } from '../types/signal.js';

// ── Mock all external services ────────────────────────────────────────────

// 1. OpenAI (embeddings + chat)
vi.mock('openai', () => ({
  OpenAI: vi.fn().mockImplementation(() => ({
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    },
  })),
}));

// 2. LangChain OpenAI chat (AIService uses @langchain/openai)
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    withStructuredOutput: vi.fn().mockReturnValue({
      // Simulate a chain: pipe() returns self, invoke() returns signal
      pipe: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue({
        direction: 'BUY',
        confidence: 0.75,
        priceTarget: 65_000,
        stopLoss: 58_000,
        rationale: 'Strong bullish momentum detected with high institutional demand.',
      }),
    }),
  })),
}));

vi.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockResolvedValue({
          direction: 'BUY',
          confidence: 0.75,
          priceTarget: 65_000,
          stopLoss: 58_000,
          rationale: 'Strong bullish momentum detected.',
        }),
      }),
    }),
  },
}));

// 3. grammy (TelegramService)
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
  })),
}));

// 4. Env vars needed by config/index.ts
process.env.OPENAI_API_KEY = 'test-key';
process.env.TELEGRAM_TOKEN = '123:test';
process.env.TELEGRAM_CHANNEL_ID = '-100123';

// ── Imports after mocks ───────────────────────────────────────────────────

// Dynamic imports so mocks are in place first
let SignalPipeline: typeof import('../pipeline/SignalPipeline.js').SignalPipeline;
let AIService: typeof import('../services/AIService.js').AIService;
let TelegramService: typeof import('../services/TelegramService.js').TelegramService;
let MMDetectorService: typeof import('../services/MMDetectorService.js').MMDetectorService;
let VectorStoreService: typeof import('../services/VectorStoreService.js').VectorStoreService;

describe('SignalPipeline — full integration', () => {
  let pipeline: InstanceType<typeof SignalPipeline>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let telegramSendSpy: any;
  let tmpDir: string;

  beforeAll(async () => {
    // Dynamic imports after all mocks are registered
    const pipelineModule = await import('../pipeline/SignalPipeline.js');
    SignalPipeline = pipelineModule.SignalPipeline;
    const aiModule = await import('../services/AIService.js');
    AIService = aiModule.AIService;
    const telegramModule = await import('../services/TelegramService.js');
    TelegramService = telegramModule.TelegramService;
    const mmModule = await import('../services/MMDetectorService.js');
    MMDetectorService = mmModule.MMDetectorService;
    const vsModule = await import('../services/VectorStoreService.js');
    VectorStoreService = vsModule.VectorStoreService;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
    const vectorStore = new VectorStoreService(tmpDir);
    await vectorStore.init();

    const telegram = new TelegramService();
    // Capture the sendSignal spy
    telegramSendSpy = vi.spyOn(telegram, 'sendSignal').mockResolvedValue(undefined);

    pipeline = new SignalPipeline(
      new AIService(),
      vectorStore,
      new MMDetectorService(),
      telegram,
    );

    // Prime pipeline with a realistic price
    pipeline.onTrade({
      id: 'seed',
      timestamp: Date.now(),
      price: 62_000,
      amount: 0.5,
      side: 'buy',
    });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    telegramSendSpy.mockClear();
  });

  it('emits a signal and sends a Telegram alert on a high-sentiment news event', async () => {
    const signals: Signal[] = [];
    pipeline.on('signal', (s: Signal) => signals.push(s));

    const event: NewsEvent = {
      id: 'test-news-1',
      headline: 'Bitcoin ETF approved — massive institutional surge expected',
      url: 'https://example.com/news/1',
      source: 'CryptoPanic',
      sentiment: 0.8,   // ≥ 0.6 → triggers short + mid + long
      publishedAt: Date.now(),
    };

    await pipeline.onNewsEvent(event);

    // 3 horizons → 3 signals, 3 Telegram messages
    expect(signals.length).toBe(3);
    expect(telegramSendSpy).toHaveBeenCalledTimes(3);

    const horizons = signals.map(s => s.horizon).sort();
    expect(horizons).toEqual(['long', 'mid', 'short']);
  });

  it('emits only 2 signals for moderate-sentiment news (mid + long)', async () => {
    const signals: Signal[] = [];
    const handler = (s: Signal) => signals.push(s);
    pipeline.on('signal', handler);

    const event: NewsEvent = {
      id: 'test-news-2',
      headline: 'Bitcoin adoption grows in emerging markets',
      url: 'https://example.com/news/2',
      source: 'CryptoPanic',
      sentiment: 0.4,   // 0.3–0.59 → mid + long only
      publishedAt: Date.now(),
    };

    await pipeline.onNewsEvent(event);
    pipeline.off('signal', handler);

    expect(signals.length).toBe(2);
    const horizons = signals.map(s => s.horizon).sort();
    expect(horizons).toEqual(['long', 'mid']);
  });

  it('emits only 1 signal for low-sentiment news (long only)', async () => {
    const signals: Signal[] = [];
    const handler = (s: Signal) => signals.push(s);
    pipeline.on('signal', handler);

    const event: NewsEvent = {
      id: 'test-news-3',
      headline: 'Bitcoin price trades sideways on weekend',
      url: 'https://example.com/news/3',
      source: 'CryptoPanic',
      sentiment: 0.1,   // < 0.3 → long only
      publishedAt: Date.now(),
    };

    await pipeline.onNewsEvent(event);
    pipeline.off('signal', handler);

    expect(signals.length).toBe(1);
    expect(signals[0].horizon).toBe('long');
  });

  it('signal has correct shape and valid field values', async () => {
    const signals: Signal[] = [];
    const handler = (s: Signal) => signals.push(s);
    pipeline.on('signal', handler);

    await pipeline.onNewsEvent({
      id: 'shape-test',
      headline: 'Test event for shape validation',
      url: 'https://example.com',
      source: 'test',
      sentiment: 0.7,
      publishedAt: Date.now(),
    });
    pipeline.off('signal', handler);

    for (const signal of signals) {
      expect(signal.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ); // UUID v4
      expect(['BUY', 'SELL', 'HOLD']).toContain(signal.direction);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(typeof signal.rationale).toBe('string');
      expect(signal.rationale.length).toBeGreaterThan(0);
      expect(signal.asset).toBe('BTC/USDT');
      expect(typeof signal.mmTrapFlag).toBe('boolean');
    }
  });

  it('emits a mid-term signal on price anomaly', async () => {
    const signals: Signal[] = [];
    const handler = (s: Signal) => signals.push(s);
    pipeline.on('signal', handler);

    await pipeline.onPriceAnomaly(0.035); // 3.5% deviation
    pipeline.off('signal', handler);

    expect(signals.length).toBe(1);
    expect(signals[0].horizon).toBe('mid');
  });
});
