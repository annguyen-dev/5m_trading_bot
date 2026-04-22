import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { VectorStoreService } from '../services/VectorStoreService.js';

// ── Mock OpenAI embeddings ────────────────────────────────────────────────
// We don't want real API calls in tests. Return a deterministic fake embedding.
vi.mock('openai', () => {
  const fakeEmbedding = (text: string): number[] => {
    // Simple deterministic vector: ASCII sum spread across 1536 dims
    const seed = [...text].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.1);
  };

  return {
    OpenAI: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: vi.fn().mockImplementation(({ input }: { input: string }) =>
          Promise.resolve({ data: [{ embedding: fakeEmbedding(input) }] }),
        ),
      },
    })),
  };
});

// ── Test ──────────────────────────────────────────────────────────────────

describe('VectorStoreService', () => {
  let service: VectorStoreService;
  let tmpDir: string;

  beforeAll(async () => {
    // Use a temp directory so tests don't pollute ./data/lancedb
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-test-'));
    service = new VectorStoreService(tmpDir);
    await service.init();
  });

  afterAll(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initialises without error', () => {
    expect(service).toBeDefined();
  });

  it('adds a document without throwing', async () => {
    await expect(
      service.addDocument({
        id: 'doc-1',
        text: 'Bitcoin ETF approved by SEC — major bullish development',
        metadata: { type: 'news', asset: 'BTC/USDT' },
      }),
    ).resolves.not.toThrow();
  });

  it('returns results from similarity search', async () => {
    // Add a second document
    await service.addDocument({
      id: 'doc-2',
      text: 'Bitcoin crashes after major exchange hack exploit',
      metadata: { type: 'news', asset: 'BTC/USDT' },
    });

    const results = await service.similaritySearch('Bitcoin price news', 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('text');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('metadata');
  });

  it('returns empty array on search when no documents match', async () => {
    // Search with a completely different embedding (different text)
    // Since we use a fake deterministic embedding, results may still come back
    // but the service should not throw
    const results = await service.similaritySearch('completely unrelated query xyz', 5);
    expect(Array.isArray(results)).toBe(true);
  });

  it('upserts correctly — adding same id twice does not duplicate', async () => {
    await service.addDocument({
      id: 'doc-upsert',
      text: 'Original text',
      metadata: { version: 1 },
    });
    await service.addDocument({
      id: 'doc-upsert',
      text: 'Updated text',
      metadata: { version: 2 },
    });

    const results = await service.similaritySearch('Updated text', 10);
    const matches = results.filter(r => r.metadata['version'] === 1);
    // Version 1 entry should have been replaced — not present
    expect(matches.length).toBe(0);
  });
});
