import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

/**
 * Legacy DDL for `sessions` that predates the `total_cost_usd_otel` column.
 * Mirrors the committed production schema prior to the pricing-otel-source-of-truth
 * spec. Running `CREATE TABLE IF NOT EXISTS sessions (...)` on an existing DB is
 * a no-op, so the ALTER TABLE backfill is the only way a legacy DB acquires
 * the column.
 */
const LEGACY_SESSIONS_DDL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    slug TEXT,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    git_branch TEXT,
    cc_version TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    source_file TEXT NOT NULL,
    ingested_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_started_at ON sessions(started_at);
`;

const hasOtelCostColumn = (db: DB): boolean => {
  const cols = db
    .prepare('PRAGMA table_info(sessions)')
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'total_cost_usd_otel');
};

describe('migrate — backfillSessionsOtelCost', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('TC-I-09: adds total_cost_usd_otel column to legacy sessions table with NULL for existing rows', () => {
    db.exec(LEGACY_SESSIONS_DDL);
    expect(hasOtelCostColumn(db)).toBe(false);

    // Seed an existing row under the legacy schema so we can verify its
    // post-migrate value for the new column is NULL.
    db.prepare(
      `INSERT INTO sessions (
        id, cwd, project, started_at, ended_at, source_file, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('s1', '/tmp/cwd', 'proj', 1000, 2000, '/tmp/s1.jsonl', 3000);

    migrate(db);

    expect(hasOtelCostColumn(db)).toBe(true);
    const row = db
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('s1') as { total_cost_usd_otel: number | null };
    expect(row.total_cost_usd_otel).toBeNull();
  });

  it('TC-I-10: migrate() is idempotent when run twice on an already-migrated DB', () => {
    migrate(db); // fresh install — column created via schema.sql
    expect(hasOtelCostColumn(db)).toBe(true);

    const before = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { sql: string }).sql;

    expect(() => migrate(db)).not.toThrow();

    const after = (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get() as { sql: string }).sql;

    // Schema string is stable (no duplicate column ALTER).
    expect(after).toBe(before);
    // Column still exists exactly once.
    const cols = db
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    const otelCols = cols.filter((c) => c.name === 'total_cost_usd_otel');
    expect(otelCols).toHaveLength(1);
  });
});
