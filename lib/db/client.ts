import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from './migrate';

export type DB = DatabaseType;

export function openDatabase(dbPath?: string): DB {
  const resolved = dbPath ?? process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';

  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolved);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Wait up to 5s on SQLITE_BUSY before failing. The dev server and
  // `pnpm ingest` can run concurrently and WAL writers may briefly lock.
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * The DB singleton lives on `globalThis` (not a module-level `let`) so it
 * survives Next.js HMR reloads and the RSC / route / edge module-graph
 * duplication — a module-level binding would open a fresh handle on every
 * reload and leak the old WAL writer. Same pattern as `globalThis.__tokenfxWatcher`
 * in `lib/ingest/watcher.ts`. See `.specs/arch-followups-lowsev.md`.
 */
type DbSingleton = { db: DB; key: string };
declare global {
  var __tokenfxDb: DbSingleton | undefined;
}

export function getDb(deps: { migrate?: typeof migrate } = {}): DB {
  // Optional deps seam (default = real migrate) so a test can inject a
  // throwing migrate without a mocking framework. `getDb()` (no args) is
  // unchanged.
  const migrateFn = deps.migrate ?? migrate;
  const key = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
  const existing = globalThis.__tokenfxDb;
  if (existing && existing.key === key) {
    return existing.db;
  }
  if (existing) {
    existing.db.close(); // re-key: close the old handle before opening a new one
  }
  const db = openDatabase(key);
  try {
    migrateFn(db);
  } catch (err) {
    // Migrate failed → close the just-opened handle and clear the global so no
    // orphaned WAL writer leaks and a stale/unmigrated handle can never be
    // handed back by a later getDb() with a matching key. Then rethrow.
    db.close();
    globalThis.__tokenfxDb = undefined;
    throw err;
  }
  globalThis.__tokenfxDb = { db, key };
  return db;
}

export function resetDbSingleton(): void {
  globalThis.__tokenfxDb?.db.close();
  globalThis.__tokenfxDb = undefined;
}
