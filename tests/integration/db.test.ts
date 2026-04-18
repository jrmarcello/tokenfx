import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

const INSERT_SESSION = `
  INSERT OR IGNORE INTO sessions (
    id, slug, cwd, project, git_branch, cc_version,
    started_at, ended_at,
    total_input_tokens, total_output_tokens,
    total_cache_read_tokens, total_cache_creation_tokens,
    total_cost_usd, turn_count, tool_call_count,
    source_file, ingested_at
  ) VALUES (
    @id, @slug, @cwd, @project, @git_branch, @cc_version,
    @started_at, @ended_at,
    @total_input_tokens, @total_output_tokens,
    @total_cache_read_tokens, @total_cache_creation_tokens,
    @total_cost_usd, @turn_count, @tool_call_count,
    @source_file, @ingested_at
  )
`;

const UPSERT_SESSION = `
  INSERT INTO sessions (
    id, slug, cwd, project, git_branch, cc_version,
    started_at, ended_at,
    total_input_tokens, total_output_tokens,
    total_cache_read_tokens, total_cache_creation_tokens,
    total_cost_usd, turn_count, tool_call_count,
    source_file, ingested_at
  ) VALUES (
    @id, @slug, @cwd, @project, @git_branch, @cc_version,
    @started_at, @ended_at,
    @total_input_tokens, @total_output_tokens,
    @total_cache_read_tokens, @total_cache_creation_tokens,
    @total_cost_usd, @turn_count, @tool_call_count,
    @source_file, @ingested_at
  )
  ON CONFLICT(id) DO UPDATE SET
    source_file = excluded.source_file,
    ingested_at = excluded.ingested_at
`;

const INSERT_TURN = `
  INSERT OR IGNORE INTO turns (
    id, session_id, parent_uuid, sequence, timestamp, model,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
  ) VALUES (
    @id, @session_id, @parent_uuid, @sequence, @timestamp, @model,
    @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
    @cost_usd, @stop_reason, @user_prompt, @assistant_text, @tool_uses_json
  )
`;

function makeSession(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'sess-1',
    slug: null,
    cwd: '/tmp/proj',
    project: 'proj',
    git_branch: 'main',
    cc_version: '2.0.0',
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_060_000,
    total_input_tokens: 200,
    total_output_tokens: 50,
    total_cache_read_tokens: 300,
    total_cache_creation_tokens: 0,
    total_cost_usd: 0.0123,
    turn_count: 2,
    tool_call_count: 1,
    source_file: '/a.jsonl',
    ingested_at: 1_700_000_100_000,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 't1',
    session_id: 'sess-1',
    parent_uuid: null,
    sequence: 0,
    timestamp: 1_700_000_010_000,
    model: 'claude-sonnet-4-5',
    input_tokens: 100,
    output_tokens: 25,
    cache_read_tokens: 150,
    cache_creation_tokens: 0,
    cost_usd: 0.006,
    stop_reason: 'end_turn',
    user_prompt: 'hello',
    assistant_text: 'hi',
    tool_uses_json: '[]',
    ...overrides,
  };
}

describe('db schema + migration', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  it('migrate is idempotent (runs twice without error)', () => {
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('turns');
    expect(names).toContain('tool_calls');
    expect(names).toContain('ratings');
    expect(names).toContain('otel_scrapes');
  });

  it('TC-I-01: re-running identical INSERT OR IGNORE yields 1 session and 2 turns, not 2/4', () => {
    const insertSession = db.prepare(INSERT_SESSION);
    const insertTurn = db.prepare(INSERT_TURN);

    const session = makeSession();
    const turn1 = makeTurn({ id: 't1', sequence: 0 });
    const turn2 = makeTurn({ id: 't2', sequence: 1 });

    const runAll = (): void => {
      insertSession.run(session);
      insertTurn.run(turn1);
      insertTurn.run(turn2);
    };

    runAll();
    runAll();

    const sessionCount = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
    const turnCount = db.prepare('SELECT COUNT(*) AS c FROM turns').get() as { c: number };

    expect(sessionCount.c).toBe(1);
    expect(turnCount.c).toBe(2);
  });

  it('TC-I-02: upsert by id across different source_file values updates, not duplicates', () => {
    const upsert = db.prepare(UPSERT_SESSION);

    upsert.run(makeSession({ source_file: '/a.jsonl', ingested_at: 1_700_000_100_000 }));
    upsert.run(
      makeSession({ source_file: '/b.jsonl', ingested_at: 1_700_000_200_000 })
    );

    const rows = db
      .prepare(
        'SELECT id, source_file, ingested_at, total_input_tokens, total_output_tokens, total_cache_read_tokens FROM sessions'
      )
      .all() as Array<{
      id: string;
      source_file: string;
      ingested_at: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sess-1');
    expect(rows[0].source_file).toBe('/b.jsonl');
    expect(rows[0].ingested_at).toBe(1_700_000_200_000);
    // Token counts preserved from original insert values (same in both calls here).
    expect(rows[0].total_input_tokens).toBe(200);
    expect(rows[0].total_output_tokens).toBe(50);
    expect(rows[0].total_cache_read_tokens).toBe(300);
  });

  it('session_effectiveness view computes cache_hit_ratio and cost_per_turn', () => {
    db.prepare(INSERT_SESSION).run(makeSession());
    const row = db
      .prepare('SELECT cache_hit_ratio, cost_per_turn, output_input_ratio FROM session_effectiveness WHERE id = ?')
      .get('sess-1') as { cache_hit_ratio: number; cost_per_turn: number; output_input_ratio: number };
    // 300 / (200 + 300) = 0.6
    expect(row.cache_hit_ratio).toBeCloseTo(0.6, 5);
    // 0.0123 / 2
    expect(row.cost_per_turn).toBeCloseTo(0.00615, 5);
    // 50 / 200
    expect(row.output_input_ratio).toBeCloseTo(0.25, 5);
  });
});
