import { describe, it, expect, beforeEach } from 'vitest';
import { MMDetectorService } from '../services/MMDetectorService.js';
import type { Trade, CVDState, OrderBookSnapshot } from '../types/market.js';

// ── helpers ───────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: String(Math.random()),
    timestamp: Date.now(),
    price: 60_000,
    amount: 0.1,
    side: 'buy',
    ...overrides,
  };
}

function makeCVDState(overrides: Partial<CVDState> = {}): CVDState {
  return {
    cvd: 0,
    price: 60_000,
    divergence: 0,
    windowTrades: [],
    ...overrides,
  };
}

// ── CVD Divergence ────────────────────────────────────────────────────────

describe('MMDetectorService — CVD divergence', () => {
  let detector: MMDetectorService;

  beforeEach(() => {
    detector = new MMDetectorService();
  });

  it('returns NONE when fewer than 20 snapshots have been received', () => {
    for (let i = 0; i < 19; i++) {
      const result = detector.analyzeCVD(makeCVDState({ cvd: i, price: 60_000 + i }));
      expect(result.detected).toBe(false);
      expect(result.type).toBe('NONE');
    }
  });

  it('detects BULL_TRAP when price rises but CVD falls sharply', () => {
    // Fill 19 baseline snapshots: price and CVD both stable
    for (let i = 0; i < 19; i++) {
      detector.analyzeCVD(makeCVDState({ cvd: 100, price: 60_000 }));
    }
    // Step 20: price jumped >30% but CVD crashed — classic bull trap
    // first.price = 60_000, last.price = 80_000 → priceChangePct = 33%
    // first.cvd  = 100,  last.cvd  = -50_000 → cvdChangePct >> 30%
    const result = detector.analyzeCVD(
      makeCVDState({ cvd: -50_000, price: 80_000 }),
    );
    expect(result.detected).toBe(true);
    expect(result.type).toBe('BULL_TRAP');
  });

  it('detects BEAR_TRAP when price falls but CVD rises sharply', () => {
    for (let i = 0; i < 19; i++) {
      detector.analyzeCVD(makeCVDState({ cvd: -100, price: 60_000 }));
    }
    // price dropped >30%, CVD surged — bear trap
    const result = detector.analyzeCVD(
      makeCVDState({ cvd: 50_000, price: 40_000 }),
    );
    expect(result.detected).toBe(true);
    expect(result.type).toBe('BEAR_TRAP');
  });

  it('does NOT flag when price and CVD move in the same direction', () => {
    for (let i = 0; i < 19; i++) {
      detector.analyzeCVD(makeCVDState({ cvd: i * 50, price: 60_000 + i * 50 }));
    }
    // Price up, CVD up — confirmation, not divergence
    const result = detector.analyzeCVD(makeCVDState({ cvd: 2000, price: 63_000 }));
    expect(result.detected).toBe(false);
  });
});

// ── Mechanical Pattern (Frequency) ───────────────────────────────────────

describe('MMDetectorService — mechanical pattern detection', () => {
  let detector: MMDetectorService;

  beforeEach(() => {
    detector = new MMDetectorService();
  });

  it('returns NONE when fewer than 50 trades have been seen', () => {
    for (let i = 0; i < 49; i++) {
      const result = detector.analyzeTrade(
        makeTrade({ timestamp: Date.now() + i * 100 }),
      );
      expect(result.detected).toBe(false);
    }
  });

  it('detects MM_BOT when all trades have identical size and interval', () => {
    const BASE_TS = 1_700_000_000_000;
    const INTERVAL = 200; // ms — perfectly regular
    const AMOUNT = 0.5;   // BTC — perfectly identical

    for (let i = 0; i < 50; i++) {
      detector.analyzeTrade(
        makeTrade({ timestamp: BASE_TS + i * INTERVAL, amount: AMOUNT }),
      );
    }
    // 51st trade — window is now full with the 50 identical ones
    const result = detector.analyzeTrade(
      makeTrade({ timestamp: BASE_TS + 50 * INTERVAL, amount: AMOUNT }),
    );
    expect(result.detected).toBe(true);
    expect(result.type).toBe('MM_BOT');
    expect(result.detail.toLowerCase()).toContain('mechanical pattern');
  });

  it('does NOT flag when trades have natural size/interval variation', () => {
    const BASE_TS = 1_700_000_000_000;

    for (let i = 0; i < 51; i++) {
      // Random-ish amounts and intervals — high CV
      detector.analyzeTrade(
        makeTrade({
          timestamp: BASE_TS + i * (100 + Math.random() * 500),
          amount: 0.1 + Math.random() * 2,
        }),
      );
    }
    const result = detector.analyzeTrade(
      makeTrade({ timestamp: BASE_TS + 52 * 300, amount: 0.5 }),
    );
    expect(result.detected).toBe(false);
  });
});

// ── Spoofing ──────────────────────────────────────────────────────────────

describe('MMDetectorService — spoofing detection', () => {
  let detector: MMDetectorService;

  beforeEach(() => {
    detector = new MMDetectorService();
  });

  function makeOB(
    bids: [number, number][],
    asks: [number, number][],
    timestamp?: number,
  ): OrderBookSnapshot {
    return { timestamp: timestamp ?? Date.now(), bids, asks };
  }

  it('returns NONE on the first snapshot (no previous to diff)', () => {
    const result = detector.analyzeOrderBook(
      makeOB([[60_000, 10]], [[60_100, 10]]),
      [],
    );
    expect(result.detected).toBe(false);
  });

  it('detects SPOOF when a large bid vanishes quickly without a fill', () => {
    const ts = 1_700_000_000_000;

    // Snap 1 → 2: bid present in both (no action)
    detector.analyzeOrderBook(makeOB([[59_900, 10]], [[60_100, 1]], ts), []);
    detector.analyzeOrderBook(makeOB([[59_900, 10]], [[60_100, 1]], ts + 50), []);
    // Snap 2 → 3: bid disappears → adds to pendingLargeOrders(firstSeen=ts+100)
    detector.analyzeOrderBook(makeOB([[59_800, 1]], [[60_100, 1]], ts + 100), []);
    // Snap 3 → 4: bid reappears (prev has no large bid — no action)
    detector.analyzeOrderBook(makeOB([[59_900, 10]], [[60_100, 1]], ts + 150), []);
    // Snap 4 → 5: bid disappears again within 500ms → SPOOF fires
    const result = detector.analyzeOrderBook(makeOB([[59_800, 1]], [[60_100, 1]], ts + 200), []);

    expect(result.detected).toBe(true);
    expect(result.type).toBe('SPOOF');
    expect(result.detail).toContain('bid');
  });

  it('does NOT flag when large bid disappears because it was filled', () => {
    const ts = 1_700_000_000_000;

    detector.analyzeOrderBook(makeOB([[59_900, 10]], [[60_100, 1]], ts), []);

    const fillTrade: Trade = makeTrade({ side: 'sell', price: 59_900, amount: 8 });

    const result = detector.analyzeOrderBook(
      makeOB([[59_800, 1]], [[60_100, 1]], ts + 300),
      [fillTrade],
    );
    expect(result.detected).toBe(false);
  });

  it('does NOT flag small orders below the SPOOF_SIZE_BTC threshold', () => {
    const ts = 1_700_000_000_000;

    detector.analyzeOrderBook(makeOB([[59_900, 1]], [[60_100, 1]], ts), []);

    const result = detector.analyzeOrderBook(
      makeOB([[59_800, 1]], [[60_100, 1]], ts + 300),
      [],
    );
    expect(result.detected).toBe(false);
  });
});
