import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

/**
 * Legacy DDL for `turns` that predates the cache-creation split columns and
 * `service_tier`. Mirrors the production schema immediately before the
 * cost-calibration spec. Running `CREATE TABLE IF NOT EXISTS turns (...)` on
 * an existing DB is a no-op, so the ALTER TABLE backfill is the only way a
 * legacy DB acquires the new columns.
 */
const LEGACY_TURNS_DDL = `
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_uuid TEXT,
    sequence INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    stop_reason TEXT,
    user_prompt TEXT,
    assistant_text TEXT,
    tool_uses_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_turns_session ON turns(session_id, sequence);
`;

const SESSIONS_DDL = `
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
`;

type TurnsColumn = { name: string };

const getTurnsColumns = (db: DB): ReadonlyArray<TurnsColumn> =>
  db.prepare('PRAGMA table_info(turns)').all() as Array<TurnsColumn>;

const hasTurnsColumn = (db: DB, name: string): boolean =>
  getTurnsColumns(db).some((c) => c.name === name);

const hasTable = (db: DB, name: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
};

describe('migrate — backfillTurnsCacheCreationSplit', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('TC-I-08: adds cache_creation_5m_tokens, cache_creation_1h_tokens, service_tier columns and migrates legacy rows', () => {
    db.exec(SESSIONS_DDL);
    db.exec(LEGACY_TURNS_DDL);
    expect(hasTurnsColumn(db, 'cache_creation_5m_tokens')).toBe(false);
    expect(hasTurnsColumn(db, 'cache_creation_1h_tokens')).toBe(false);
    expect(hasTurnsColumn(db, 'service_tier')).toBe(false);

    // Seed a session row so FK constraints (if any) are satisfied; the legacy
    // DDL above omits the FK clause on purpose (older schemas lacked it).
    db.prepare(
      `INSERT INTO sessions (
        id, cwd, project, started_at, ended_at, source_file, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', '/tmp/cwd', 'proj', 1000, 2000, '/tmp/s1.jsonl', 3000);

    // Seed a legacy turn with non-zero cache_creation_tokens to verify the
    // data migration step (UPDATE ... SET cache_creation_5m_tokens = ...).
    db.prepare(
      `INSERT INTO turns (
        id, session_id, sequence, timestamp, model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t1', 's1', 0, 1500, 'claude-opus-4-7', 100, 50, 200, 1234, 0.01);

    migrate(db);

    expect(hasTurnsColumn(db, 'cache_creation_5m_tokens')).toBe(true);
    expect(hasTurnsColumn(db, 'cache_creation_1h_tokens')).toBe(true);
    expect(hasTurnsColumn(db, 'service_tier')).toBe(true);

    const row = db
      .prepare(
        `SELECT
          cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, service_tier
        FROM turns WHERE id = ?`,
      )
      .get('t1') as {
      cache_creation_tokens: number;
      cache_creation_5m_tokens: number;
      cache_creation_1h_tokens: number;
      service_tier: string;
    };
    expect(row.cache_creation_tokens).toBe(1234);
    expect(row.cache_creation_5m_tokens).toBe(1234);
    expect(row.cache_creation_1h_tokens).toBe(0);
    expect(row.service_tier).toBe('standard');
  });

  it('TC-I-09: migrate() is idempotent when run twice on an already-migrated DB', () => {
    migrate(db); // fresh install — columns + table created via schema.sql / backfill
    expect(hasTurnsColumn(db, 'cache_creation_5m_tokens')).toBe(true);
    expect(hasTurnsColumn(db, 'cache_creation_1h_tokens')).toBe(true);
    expect(hasTurnsColumn(db, 'service_tier')).toBe(true);
    expect(hasTable(db, 'cost_calibration')).toBe(true);

    const beforeTurns = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'",
        )
        .get() as { sql: string }
    ).sql;
    const beforeCal = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='cost_calibration'",
        )
        .get() as { sql: string }
    ).sql;

    expect(() => migrate(db)).not.toThrow();

    const afterTurns = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'",
        )
        .get() as { sql: string }
    ).sql;
    const afterCal = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='cost_calibration'",
        )
        .get() as { sql: string }
    ).sql;

    expect(afterTurns).toBe(beforeTurns);
    expect(afterCal).toBe(beforeCal);

    const cols = getTurnsColumns(db);
    expect(cols.filter((c) => c.name === 'cache_creation_5m_tokens')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'cache_creation_1h_tokens')).toHaveLength(1);
    expect(cols.filter((c) => c.name === 'service_tier')).toHaveLength(1);
  });
});
