import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './client';
import { reconcileAllSessions } from '@/lib/ingest/reconcile';

function resolveSchemaPath(): string {
  // Support both CJS (__dirname) and ESM (import.meta.url) environments.
  // Vitest runs TS via ESM by default.
  try {
    // ESM: import.meta.url exists; CJS: it doesn't — the double cast avoids
    // tsconfig lib differences between the Next.js build and the tsx script.
    const metaUrl: string | undefined = (import.meta as unknown as { url?: string }).url;
    if (metaUrl) {
      const here = path.dirname(fileURLToPath(metaUrl));
      return path.resolve(here, 'schema.sql');
    }
  } catch {
    // fall through
  }
  // Fallback: relative to cwd/lib/db
  return path.resolve(process.cwd(), 'lib/db/schema.sql');
}

export function migrate(db: DB): void {
  const schemaPath = resolveSchemaPath();
  const sql = fs.readFileSync(schemaPath, 'utf8');
  // Atomic migration: schema creation + reconciliation run in a single
  // transaction so a crash mid-migrate leaves no partial state.
  const tx = db.transaction(() => {
    db.exec(sql);
    // Backfill constraints that `CREATE TABLE IF NOT EXISTS` can't add to
    // pre-existing tables created under older schema revisions.
    backfillOtelScrapesUnique(db);
    const hasData = db
      .prepare('SELECT 1 FROM sessions LIMIT 1')
      .get() !== undefined;
    if (hasData) {
      reconcileAllSessions(db);
    }
  });
  tx();
}

/**
 * Older DB files were created before `otel_scrapes` had a UNIQUE
 * `(metric_name, labels_json, scraped_at)` constraint. The writer's
 * `INSERT ... ON CONFLICT(...)` statement requires the constraint — without
 * it every ingest raises `SQLITE_ERROR: ON CONFLICT clause does not match
 * any PRIMARY KEY or UNIQUE constraint`, silently swallowed by auto-ingest.
 *
 * SQLite can't add a constraint via ALTER TABLE, so we rebuild the table:
 * copy rows with INSERT OR IGNORE (dedupes historic duplicates), drop the
 * old, rename the new. Runs only when needed, inside the outer migrate tx.
 */
function backfillOtelScrapesUnique(db: DB): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='otel_scrapes'",
    )
    .get() as { sql: string } | undefined;
  if (!row) return;
  if (row.sql.toUpperCase().includes('UNIQUE')) return;
  db.exec(`
    CREATE TABLE otel_scrapes_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scraped_at INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      value REAL NOT NULL,
      UNIQUE(metric_name, labels_json, scraped_at)
    );
    INSERT OR IGNORE INTO otel_scrapes_new (scraped_at, metric_name, labels_json, value)
      SELECT scraped_at, metric_name, labels_json, value FROM otel_scrapes;
    DROP TABLE otel_scrapes;
    ALTER TABLE otel_scrapes_new RENAME TO otel_scrapes;
    CREATE INDEX IF NOT EXISTS idx_otel_scrape_metric_time
      ON otel_scrapes(metric_name, scraped_at);
  `);
}

export function ensureMigrated(db: DB): void {
  migrate(db);
}
