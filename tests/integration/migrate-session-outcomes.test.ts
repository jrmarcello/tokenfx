import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

/**
 * Legacy DDL for `session_outcomes` from before the `status` column was
 * introduced. Mirrors the original shape (REQ-11 minus REQ-15a). Running
 * `CREATE TABLE IF NOT EXISTS session_outcomes (...)` on an existing DB is a
 * no-op, so the only way a legacy DB acquires the new column is via the
 * `backfillSessionOutcomesStatus` ALTER.
 */
const LEGACY_SESSION_OUTCOMES_DDL = `
  CREATE TABLE session_outcomes (
    session_id TEXT PRIMARY KEY,
    commit_count INTEGER NOT NULL DEFAULT 0,
    loc_added INTEGER NOT NULL DEFAULT 0,
    loc_removed INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    reverts_within_7d INTEGER NOT NULL DEFAULT 0,
    merged_pr_count INTEGER,
    last_evaluated_at INTEGER NOT NULL
  );
`;

type Column = { name: string; notnull: number; dflt_value: string | null };

const getColumns = (db: DB, table: string): ReadonlyArray<Column> =>
  db.prepare(`PRAGMA table_info(${table})`).all() as Array<Column>;

const hasColumn = (db: DB, table: string, name: string): boolean =>
  getColumns(db, table).some((c) => c.name === name);

const hasTable = (db: DB, name: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
};

describe('migrate — session_outcomes schema + backfillSessionOutcomesStatus', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('TC-I-03: fresh DB has session_outcomes table after migrate(); second call no-ops', () => {
    expect(hasTable(db, 'session_outcomes')).toBe(false);

    migrate(db);

    expect(hasTable(db, 'session_outcomes')).toBe(true);
    const cols = getColumns(db, 'session_outcomes');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('commit_count');
    expect(colNames).toContain('loc_added');
    expect(colNames).toContain('loc_removed');
    expect(colNames).toContain('files_changed');
    expect(colNames).toContain('reverts_within_7d');
    expect(colNames).toContain('merged_pr_count');
    expect(colNames).toContain('status');
    expect(colNames).toContain('last_evaluated_at');

    // merged_pr_count is nullable (distinguishes "0 PRs" from "not evaluated").
    const mergedPrCol = cols.find((c) => c.name === 'merged_pr_count');
    expect(mergedPrCol?.notnull).toBe(0);

    // status is NOT NULL with DEFAULT 'evaluated'.
    const statusCol = cols.find((c) => c.name === 'status');
    expect(statusCol?.notnull).toBe(1);
    expect(statusCol?.dflt_value).toContain('evaluated');

    // Index on last_evaluated_at exists.
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_outcomes_evaluated_at'",
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_session_outcomes_evaluated_at');

    // Capture schema, run migrate again, confirm no DDL drift.
    const beforeSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_outcomes'",
        )
        .get() as { sql: string }
    ).sql;

    expect(() => migrate(db)).not.toThrow();

    const afterSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_outcomes'",
        )
        .get() as { sql: string }
    ).sql;
    expect(afterSql).toBe(beforeSql);

    // Column count unchanged: status appears exactly once after the second migrate.
    const afterCols = getColumns(db, 'session_outcomes');
    expect(afterCols.filter((c) => c.name === 'status')).toHaveLength(1);
  });

  it('TC-I-04: legacy DB without status column gets ALTER + existing rows default to "evaluated"', () => {
    // Build a legacy state by manually creating the older shape (no status).
    // sessions table is required because session_outcomes.session_id FKs into it
    // in the post-migration schema; building it now keeps FK enforcement happy.
    db.exec(`
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
    `);
    db.exec(LEGACY_SESSION_OUTCOMES_DDL);

    expect(hasColumn(db, 'session_outcomes', 'status')).toBe(false);

    db.prepare(
      `INSERT INTO sessions (id, cwd, project, started_at, ended_at, source_file, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', '/tmp/cwd', 'proj', 1000, 2000, '/tmp/s1.jsonl', 3000);

    db.prepare(
      `INSERT INTO session_outcomes (
        session_id, commit_count, loc_added, loc_removed, files_changed,
        reverts_within_7d, merged_pr_count, last_evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', 3, 100, 20, 5, 0, 1, 4000);

    migrate(db);

    expect(hasColumn(db, 'session_outcomes', 'status')).toBe(true);

    const row = db
      .prepare(
        `SELECT session_id, commit_count, loc_added, loc_removed, files_changed,
                reverts_within_7d, merged_pr_count, status, last_evaluated_at
         FROM session_outcomes WHERE session_id = ?`,
      )
      .get('s1') as {
      session_id: string;
      commit_count: number;
      loc_added: number;
      loc_removed: number;
      files_changed: number;
      reverts_within_7d: number;
      merged_pr_count: number;
      status: string;
      last_evaluated_at: number;
    };
    expect(row.session_id).toBe('s1');
    expect(row.commit_count).toBe(3);
    expect(row.loc_added).toBe(100);
    expect(row.loc_removed).toBe(20);
    expect(row.files_changed).toBe(5);
    expect(row.reverts_within_7d).toBe(0);
    expect(row.merged_pr_count).toBe(1);
    expect(row.last_evaluated_at).toBe(4000);
    // Pre-existing rows default to 'evaluated' via the ALTER's DEFAULT clause.
    expect(row.status).toBe('evaluated');

    // Idempotent: a second migrate() does not duplicate the column or alter rows.
    expect(() => migrate(db)).not.toThrow();
    const cols = getColumns(db, 'session_outcomes');
    expect(cols.filter((c) => c.name === 'status')).toHaveLength(1);
  });
});
