import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { log } from '@tokenfx/shared/logger';
import { SanitizedSessionPayload } from '@tokenfx/shared/reporter/types';

/**
 * Bounded offline queue for the central reporter.
 *
 * Lives in a SEPARATE SQLite file (default `data/reporter-queue.db`) so it
 * does not pollute the dashboard DB and can be wiped on auth failure.
 *
 * Schema:
 *   id INTEGER PRIMARY KEY AUTOINCREMENT  -- monotonic; lowest id = oldest
 *   session_id TEXT NOT NULL
 *   payload_hash TEXT NOT NULL
 *   payload_json TEXT NOT NULL            -- JSON-serialised SanitizedSessionPayload
 *   created_at INTEGER NOT NULL
 *   attempt_count INTEGER NOT NULL DEFAULT 0
 *   last_error TEXT
 *
 * Bound: 10,000 entries by default. On overflow, oldest is dropped and a
 * single warn is logged via `lib/logger`.
 */

const DEFAULT_MAX_ENTRIES = 10_000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS reporter_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reporter_queue_created
    ON reporter_queue(created_at ASC);
`;

export type QueueEntry = {
  id: number;
  sessionId: string;
  payloadHash: string;
  payload: SanitizedSessionPayload;
  createdAt: number;
  attemptCount: number;
  lastError: string | null;
};

export type Queue = {
  enqueue(payload: SanitizedSessionPayload, payloadHash: string): void;
  dequeueOldest(limit: number): QueueEntry[];
  remove(ids: number[]): void;
  recordFailure(id: number, error: string): void;
  size(): number;
  /** Test-only: drop and recreate the table. */
  reset(): void;
  close(): void;
};

type Row = {
  id: number;
  session_id: string;
  payload_hash: string;
  payload_json: string;
  created_at: number;
  attempt_count: number;
  last_error: string | null;
};

const ensureDir = (dbPath: string): void => {
  if (dbPath === ':memory:') return;
  const dir = path.dirname(dbPath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const initSchema = (db: DatabaseType): void => {
  db.exec(SCHEMA_SQL);
};

const rowToEntry = (row: Row): QueueEntry => {
  // payload_json is written by enqueue() from a Zod-validated SanitizedSessionPayload,
  // so the parsed shape is trusted at the trust boundary of this module.
  const payload = JSON.parse(row.payload_json) as SanitizedSessionPayload;
  return {
    id: row.id,
    sessionId: row.session_id,
    payloadHash: row.payload_hash,
    payload,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  };
};

export const openQueue = (
  dbPath: string,
  opts?: { maxEntries?: number },
): Queue => {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  initSchema(db);

  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // Module-level prepared statements (per-instance) — created once.
  const stmts = {
    insert: db.prepare<
      [string, string, string, number],
      unknown
    >(
      `INSERT INTO reporter_queue
         (session_id, payload_hash, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
    ),
    count: db.prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM reporter_queue`,
    ),
    selectOldest: db.prepare<[number], Row>(
      `SELECT id, session_id, payload_hash, payload_json, created_at,
              attempt_count, last_error
         FROM reporter_queue
         ORDER BY id ASC
         LIMIT ?`,
    ),
    deleteOldestOne: db.prepare<[], unknown>(
      `DELETE FROM reporter_queue
         WHERE id = (SELECT id FROM reporter_queue ORDER BY id ASC LIMIT 1)`,
    ),
    deleteById: db.prepare<[number], unknown>(
      `DELETE FROM reporter_queue WHERE id = ?`,
    ),
    recordFailure: db.prepare<[string, number], unknown>(
      `UPDATE reporter_queue
         SET attempt_count = attempt_count + 1,
             last_error = ?
         WHERE id = ?`,
    ),
  } satisfies Record<string, Statement>;

  const sizeFn = (): number => {
    const row = stmts.count.get();
    // COUNT(*) always returns a row; defensively coerce.
    return row?.c ?? 0;
  };

  const enqueueFn = (
    payload: SanitizedSessionPayload,
    payloadHash: string,
  ): void => {
    const json = JSON.stringify(payload);
    const tx = db.transaction(() => {
      // Cap enforcement: drop oldest if at-or-over capacity BEFORE insert.
      // Loop in case capacity was exceeded externally (defensive — usually 1 iter).
      let dropped = 0;
      while (sizeFn() >= maxEntries) {
        stmts.deleteOldestOne.run();
        dropped += 1;
      }
      stmts.insert.run(payload.session_id, payloadHash, json, Date.now());
      return dropped;
    });
    const dropped = tx();
    if (dropped > 0) {
      // Single warn per enqueue call regardless of how many were dropped —
      // typical case is 1; multi-drop only happens after manual interference.
      log.warn(`[reporter-queue] dropped oldest entry (max ${maxEntries})`);
    }
  };

  const dequeueOldestFn = (limit: number): QueueEntry[] => {
    if (limit <= 0) return [];
    const rows = stmts.selectOldest.all(limit);
    return rows.map(rowToEntry);
  };

  const removeFn = (ids: number[]): void => {
    if (ids.length === 0) return;
    const tx = db.transaction((batch: number[]) => {
      for (const id of batch) {
        stmts.deleteById.run(id);
      }
    });
    tx(ids);
  };

  const recordFailureFn = (id: number, error: string): void => {
    stmts.recordFailure.run(error, id);
  };

  const resetFn = (): void => {
    db.exec('DROP TABLE IF EXISTS reporter_queue;');
    initSchema(db);
  };

  const closeFn = (): void => {
    db.close();
  };

  return {
    enqueue: enqueueFn,
    dequeueOldest: dequeueOldestFn,
    remove: removeFn,
    recordFailure: recordFailureFn,
    size: sizeFn,
    reset: resetFn,
    close: closeFn,
  };
};
