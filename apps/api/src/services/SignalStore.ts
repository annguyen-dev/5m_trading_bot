/**
 * SignalStore — persists signals to a JSONL file for production replay.
 *
 * Each line is a complete JSON object:
 *   { signal, entryPrice, entryTimestamp }
 *
 * The client dashboard reads this file to show live trading history.
 */
import fs from 'fs';
import path from 'path';
import type { Signal } from '../types/signal.js';
import { log } from '../observability/logger.js';

export interface StoredSignal {
  signal: Signal;
  entryPrice: number;
  entryTimestamp: number;
}

export class SignalStore {
  private filePath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(dataDir = './data') {
    this.filePath = path.join(dataDir, 'signals.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    // Append mode — survives restarts
    this.writeStream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.writeStream.on('error', err => {
      log('error', 'SignalStore write error', { error: String(err) });
    });
  }

  append(signal: Signal, entryPrice: number): void {
    const record: StoredSignal = {
      signal,
      entryPrice,
      entryTimestamp: signal.timestamp,
    };
    this.writeStream?.write(JSON.stringify(record) + '\n');
  }

  close(): void {
    this.writeStream?.end();
    this.writeStream = null;
  }

  // ── Static reader (used by API server) ───────────────────────────────────

  static readAll(filePath: string): StoredSignal[] {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const results: StoredSignal[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as StoredSignal);
      } catch {
        // skip malformed lines
      }
    }
    return results;
  }

  static readPage(
    filePath: string,
    page = 0,
    pageSize = 100,
  ): { records: StoredSignal[]; total: number } {
    const all = SignalStore.readAll(filePath);
    const sorted = all.sort((a, b) => b.entryTimestamp - a.entryTimestamp);
    return {
      records: sorted.slice(page * pageSize, (page + 1) * pageSize),
      total: sorted.length,
    };
  }
}
