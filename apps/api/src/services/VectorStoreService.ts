import * as lancedb from '@lancedb/lancedb';
import { config } from '../config/index.js';
import { voyageEmbed } from '../utils/voyageEmbed.js';
import { log } from '../observability/logger.js';
import { getTracer } from '../observability/tracing.js';
import { getApiLatencyHistogram } from '../observability/metrics.js';

const TABLE_NAME = 'documents';
const EMBEDDING_MODEL = 'voyage-3';
const EMBEDDING_DIM = 1024; // voyage-3 output dimension

export interface Document {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

interface TableRow {
  id: string;
  text: string;
  vector: number[];
  metadata: string; // JSON-serialised
  [key: string]: unknown;
}

export class VectorStoreService {
  private db!: lancedb.Connection;
  private table!: lancedb.Table;
  private tracer = getTracer('VectorStoreService');
  private latency = getApiLatencyHistogram();

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    log('info', 'VectorStoreService initialising', { path: this.dbPath });
    this.db = await lancedb.connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Create table with a seed row so schema is established
      const seed: TableRow = {
        id: '__seed__',
        text: 'seed',
        vector: new Array(EMBEDDING_DIM).fill(0) as number[],
        metadata: '{}',
      };
      this.table = await this.db.createTable(TABLE_NAME, [seed]);
      // Remove seed row
      await this.table.delete('id = "__seed__"');
    }
    log('info', 'VectorStoreService ready');
  }

  async addDocument(doc: Document): Promise<void> {
    const span = this.tracer.startSpan('VectorStoreService.addDocument');
    const t0 = Date.now();
    try {
      const vector = await this.embed(doc.text);
      this.latency.record(Date.now() - t0, { endpoint: 'openai_embed' });

      const row: TableRow = {
        id: doc.id,
        text: doc.text,
        vector,
        metadata: JSON.stringify(doc.metadata),
      };

      // Upsert: delete existing then insert
      await this.table.delete(`id = "${doc.id}"`);
      await this.table.add([row]);

      log('debug', 'Document added to vector store', { id: doc.id });
    } catch (err) {
      span.recordException(err as Error);
      log('error', 'VectorStoreService.addDocument failed', { error: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  async similaritySearch(
    query: string,
    k = 5,
    filter?: Record<string, unknown>,
  ): Promise<SearchResult[]> {
    const span = this.tracer.startSpan('VectorStoreService.similaritySearch');
    const t0 = Date.now();
    try {
      const vector = await this.embed(query);
      this.latency.record(Date.now() - t0, { endpoint: 'openai_embed' });

      // Fetch extra results to absorb any post-filter drops
      const fetchK = filter && Object.keys(filter).length > 0 ? k * 3 : k;
      const q = this.table.vectorSearch(vector).limit(fetchK);

      const rows = await q.toArray() as (TableRow & { _distance: number })[];

      // Post-filter on metadata (LanceDB uses DataFusion which lacks json_extract)
      const filtered = filter && Object.keys(filter).length > 0
        ? rows.filter(row => {
            try {
              const meta = JSON.parse(row.metadata) as Record<string, unknown>;
              return Object.entries(filter).every(([fk, fv]) => meta[fk] === fv);
            } catch { return true; }
          })
        : rows;

      return filtered.slice(0, k).map(row => ({
        text: row.text,
        score: 1 - (row._distance ?? 0),
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      }));
    } catch (err) {
      span.recordException(err as Error);
      log('error', 'VectorStoreService.similaritySearch failed', { error: String(err) });
      return [];
    } finally {
      span.end();
    }
  }

  private async embed(text: string): Promise<number[]> {
    const vecs = await voyageEmbed([text.slice(0, 8000)], config.voyageApiKey, EMBEDDING_MODEL);
    return vecs[0] ?? [];
  }
}
