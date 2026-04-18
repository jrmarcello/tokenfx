import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

/**
 * Legacy DDL used before the UNIQUE constraint was added. Mirrors the
 * committed production schema at that revision — id autoincrement PK,
 * same columns and index, but no (metric_name, labels_json, scraped_at)
 * uniqueness guarantee.
 */
const LEGACY_OTEL_DDL = `
  CREATE TABLE otel_scrapes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scraped_at INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE INDEX idx_otel_scrape_metric_time
    ON otel_scrapes(metric_name, scraped_at);
`;

describe('migrate — backfillOtelScrapesUnique', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('adds UNIQUE(metric_name, labels_json, scraped_at) to legacy otel_scrapes', () => {
    db.exec(LEGACY_OTEL_DDL);
    const before = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='otel_scrapes'",
      )
      .get() as { sql: string };
    expect(before.sql.toUpperCase()).not.toContain('UNIQUE');

    migrate(db);

    const after = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='otel_scrapes'",
      )
      .get() as { sql: string };
    expect(after.sql.toUpperCase()).toContain('UNIQUE');
  });

  it('preserves rows and dedupes duplicates on the natural key', () => {
    db.exec(LEGACY_OTEL_DDL);
    const insert = db.prepare(
      'INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value) VALUES (?, ?, ?, ?)',
    );
    // Two distinct scrapes + one accidental duplicate of the first.
    insert.run(1000, 'claude_code_commits', '{"session_id":"s1"}', 3);
    insert.run(2000, 'claude_code_commits', '{"session_id":"s1"}', 5);
    insert.run(1000, 'claude_code_commits', '{"session_id":"s1"}', 3);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM otel_scrapes').get() as { c: number }).c,
    ).toBe(3);

    migrate(db);

    const row = db
      .prepare('SELECT COUNT(*) AS c FROM otel_scrapes')
      .get() as { c: number };
    expect(row.c).toBe(2);
  });

  it('ON CONFLICT DO NOTHING now succeeds after backfill', () => {
    db.exec(LEGACY_OTEL_DDL);
    migrate(db);
    const stmt = db.prepare(`
      INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(metric_name, labels_json, scraped_at) DO NOTHING
    `);
    stmt.run(1000, 'claude_code_commits', '{"session_id":"s1"}', 3);
    stmt.run(1000, 'claude_code_commits', '{"session_id":"s1"}', 99); // dup
    const count = (db
      .prepare('SELECT COUNT(*) AS c FROM otel_scrapes')
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('no-op on a fresh DB that already has UNIQUE', () => {
    migrate(db); // fresh install
    const before = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='otel_scrapes'")
      .get() as { sql: string }).sql;
    migrate(db); // second call should not touch the table
    const after = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='otel_scrapes'")
      .get() as { sql: string }).sql;
    expect(after).toBe(before);
  });
});
