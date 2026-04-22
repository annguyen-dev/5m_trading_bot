/**
 * KnowledgeBaseEmbedder
 *
 * Reads unembedded rows from kb_snapshots (PostgreSQL) in batches of 128,
 * calls Voyage AI to get vectors, then upserts into LanceDB and marks
 * the rows as embedded in pg.
 *
 * Resumable: runs stopped mid-way simply continue from WHERE embedded = 0.
 *
 * Also exposes search() for real-time RAG queries from SignalPipeline.
 */

import * as lancedb from '@lancedb/lancedb';
import type pg from 'pg';
import { getPool } from '@trading-bot/db';
import { config } from '../config/index.js';
import { voyageEmbed } from '../utils/voyageEmbed.js';

const TABLE_NAME    = 'knowledge_base';
const EMBEDDING_DIM = 1024;     // voyage-3
const BATCH_SIZE    = 128;      // Voyage AI max per request
const RATE_LIMIT_MS = 200;      // ms between Voyage calls
const EMBED_CHUNK   = 500;      // rows to SELECT from pg at once

interface KBRow {
  id:          string;
  text:        string;
  vector:      number[];
  timestamp:   number;
  symbol:      string;
  exchange:    string;
  price:       number;
  direction:   string;
  streak_1m:   number;
  streak_5m:   number;
  liq_cascade: number;
  macro_tone:  number;
  metadata:    string;   // JSON
  [key: string]: unknown;
}

export interface KBSearchResult {
  id:         string;
  text:       string;
  score:      number;
  timestamp:  number;
  symbol:     string;
  direction:  string;
  streak_1m:  number;
  streak_5m:  number;
  liqCascade: boolean;
  macroTone:  number;
  metadata:   Record<string, unknown>;
}

export class KnowledgeBaseEmbedder {
  private db!:    lancedb.Connection;
  private table!: lancedb.Table;
  private pool:   pg.Pool;

  constructor(private readonly dbPath: string) {
    this.pool = getPool();
  }

  async init(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tableNames = await this.db.tableNames();

    if (tableNames.includes(TABLE_NAME)) {
      const existing = await this.db.openTable(TABLE_NAME);

      // Detect schema mismatch: old table used camelCase fields (liqCascade, macroTone)
      // while the new schema uses snake_case (liq_cascade, macro_tone, streak_1m, streak_5m).
      // If incompatible, drop and recreate.
      // LanceDB schema can be accessed via countRows query or column names via a small probe query.
      let isCompatible = false;
      try {
        // Try fetching a single row and check if streak_1m column exists
        const probe = await existing.query().select(['streak_1m']).limit(1).toArray();
        isCompatible = Array.isArray(probe); // if the SELECT didn't throw, column exists
      } catch {
        isCompatible = false;
      }

      if (!isCompatible) {
        console.log(`  [KBEmbedder] Schema mismatch — dropping old table and recreating`);
        await this.db.dropTable(TABLE_NAME);
        this.table = await this.createFreshTable();
      } else {
        this.table = existing;
      }
    } else {
      this.table = await this.createFreshTable();
    }
  }

  private async createFreshTable(): Promise<lancedb.Table> {
    const seed: KBRow = {
      id: '__seed__', text: 'seed', timestamp: 0, symbol: '', exchange: '',
      price: 0, direction: 'flat', streak_1m: 0, streak_5m: 0,
      liq_cascade: 0, macro_tone: 0, metadata: '{}',
      vector: new Array(EMBEDDING_DIM).fill(0) as number[],
    };
    const t = await this.db.createTable(TABLE_NAME, [seed]);
    await t.delete('id = "__seed__"');
    return t;
  }

  /**
   * Embed all unembedded kb_snapshots from pg into LanceDB.
   * Marks each batch embedded=1 in pg after successful insert.
   * Returns total vectors written.
   */
  async embedFromDB(
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const total = await this.countUnembedded();
    if (total === 0) {
      console.log('  All snapshots already embedded');
      return 0;
    }

    console.log(`  Embedding ${total} snapshots (batch=${BATCH_SIZE})`);
    console.log(`  ~${Math.ceil(total / BATCH_SIZE)} Voyage API calls`);
    console.log(`  Estimated cost: ~$${(total * 0.00002).toFixed(2)}\n`);

    let done = 0;

    while (true) {
      // Only select rows that have a non-empty embedding_text (guard against schema bugs)
      const rows = await this.pool.query<{
        id: string; embedding_text: string; ts: string; symbol: string;
        exchange: string; direction: string;
        streak_1m: string; streak_5m: string; liq_cascade: string;
        macro_tone: string; t1m?: string; t1h?: string; t4h?: string; t1d?: string;
        max_down_1h?: string; max_up_1h?: string; change_1h?: string;
      }>(
        `SELECT id, embedding_text, ts, symbol, exchange,
                direction, streak_1m, streak_5m, liq_cascade, macro_tone,
                t1m, t1h, t4h, t1d, max_down_1h, max_up_1h, change_1h
         FROM kb_snapshots
         WHERE embedded = 0
           AND length(embedding_text) > 20
         ORDER BY ts
         LIMIT $1`,
        [EMBED_CHUNK],
      );

      // rowCount can be null on some drivers; treat null as 0
      if (!rows.rows.length) break;

      // Process in BATCH_SIZE sub-batches for Voyage
      for (let i = 0; i < rows.rows.length; i += BATCH_SIZE) {
        const batch = rows.rows.slice(i, i + BATCH_SIZE);
        const texts  = batch.map(r => r.embedding_text.slice(0, 4000));

        const vectors = await voyageEmbed(texts, config.voyageApiKey);

        // Validate every vector has exactly EMBEDDING_DIM dimensions.
        // Wrong-dimension vectors cause Arrow buffer errors in LanceDB.
        const validPairs: { row: typeof batch[0]; vec: number[] }[] = [];
        for (let idx = 0; idx < batch.length; idx++) {
          const vec = vectors[idx];
          if (!vec || vec.length !== EMBEDDING_DIM) {
            console.warn(
              `  [KBEmbedder] Skipping ${batch[idx]!.id}: expected ${EMBEDDING_DIM}-dim vector, got ${vec?.length ?? 0}`,
            );
            // Mark as embedded=1 anyway to avoid re-attempting (bad text won't produce good vectors)
            await this.pool.query(
              `UPDATE kb_snapshots SET embedded=1, embedded_at=$1 WHERE id=$2`,
              [Date.now(), batch[idx]!.id],
            );
            continue;
          }
          validPairs.push({ row: batch[idx]!, vec });
        }

        if (validPairs.length > 0) {
          const lanceRows: KBRow[] = validPairs.map(({ row: r, vec }) => ({
            id:          r.id,
            text:        r.embedding_text,
            vector:      vec,
            timestamp:   Number(r.ts),
            symbol:      r.symbol,
            exchange:    r.exchange,
            price:       0,  // not needed for search
            direction:   r.direction ?? 'flat',
            streak_1m:   Number(r.streak_1m),
            streak_5m:   Number(r.streak_5m),
            liq_cascade: Number(r.liq_cascade),
            macro_tone:  Number(r.macro_tone),
            metadata:    JSON.stringify({
              t1m:       r.t1m       ? Number(r.t1m)       : null,
              t1h:       r.t1h       ? Number(r.t1h)       : null,
              t4h:       r.t4h       ? Number(r.t4h)       : null,
              t1d:       r.t1d       ? Number(r.t1d)       : null,
              maxDown1h: r.max_down_1h ? Number(r.max_down_1h) : null,
              maxUp1h:   r.max_up_1h   ? Number(r.max_up_1h)   : null,
              change1h:  r.change_1h   ? Number(r.change_1h)   : null,
            }),
          }));

          await this.table.add(lanceRows);

          const ids = validPairs.map(p => p.row.id);
          await this.pool.query(
            `UPDATE kb_snapshots SET embedded=1, embedded_at=$1
             WHERE id = ANY($2::text[])`,
            [Date.now(), ids],
          );
        }

        done += batch.length;
        onProgress?.(done, total);

        if (i + BATCH_SIZE < rows.rows.length) await sleep(RATE_LIMIT_MS);
      }
    }

    return done;
  }

  /**
   * Search knowledge base for snapshots similar to current market state.
   * Used at runtime by SignalPipeline.
   */
  async search(
    queryText: string,
    k = 10,
    filters?: { streak1m?: number; direction?: string },
  ): Promise<KBSearchResult[]> {
    const vectors = await voyageEmbed([queryText.slice(0, 4000)], config.voyageApiKey);
    if (!vectors[0]) return [];

    const rows = await this.table.vectorSearch(vectors[0]).limit(k * 2).toArray() as (KBRow & { _distance: number })[];

    return rows
      .filter(r => {
        if (filters?.streak1m  !== undefined && r.streak_1m !== filters.streak1m)  return false;
        if (filters?.direction !== undefined && r.direction !== filters.direction)  return false;
        return true;
      })
      .slice(0, k)
      .map(r => ({
        id:         r.id,
        text:       r.text,
        score:      1 - (r._distance ?? 0),
        timestamp:  r.timestamp,
        symbol:     r.symbol,
        direction:  r.direction,
        streak_1m:  r.streak_1m,
        streak_5m:  r.streak_5m,
        liqCascade: r.liq_cascade === 1,
        macroTone:  r.macro_tone,
        metadata:   JSON.parse(r.metadata) as Record<string, unknown>,
      }));
  }

  async count(): Promise<number> {
    return this.table.countRows();
  }

  private async countUnembedded(): Promise<number> {
    const res = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM kb_snapshots WHERE embedded = 0`,
    );
    return Number(res.rows[0]?.cnt ?? 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
