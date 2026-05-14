import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { reconcileAllSessions, reconcileSessionsByIds } from './reconcile';

const seedSession = (
  db: DB,
  id: string,
  turns: Array<{ id: string; cost: number; timestamp: number }>,
): void => {
  const firstTs = turns[0]?.timestamp ?? 0;
  const lastTs = turns[turns.length - 1]?.timestamp ?? firstTs;
  db.prepare(
    `INSERT INTO sessions
       (id, cwd, project, source_file, started_at, ended_at,
        ingested_at, total_cost_usd, turn_count)
     VALUES (?, '/tmp', 'test', '/tmp/source.jsonl', ?, ?, ?, 0, 0)`,
  ).run(id, firstTs, lastTs, Date.now());
  for (const t of turns) {
    db.prepare(
      `INSERT INTO turns (id, session_id, sequence, timestamp, model,
                          input_tokens, output_tokens,
                          cache_read_tokens, cache_creation_tokens, cost_usd)
       VALUES (?, ?, 0, ?, 'opus', 100, 50, 0, 0, ?)`,
    ).run(t.id, id, t.timestamp, t.cost);
  }
};

const sessionCost = (db: DB, id: string): number => {
  const row = db
    .prepare('SELECT total_cost_usd FROM sessions WHERE id = ?')
    .get(id) as { total_cost_usd: number } | undefined;
  return row?.total_cost_usd ?? -1;
};

describe('reconcileSessionsByIds', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('updates rollups only for sessions in the input list', () => {
    seedSession(db, 's1', [
      { id: 't1', cost: 1.5, timestamp: 1_000 },
      { id: 't2', cost: 2.5, timestamp: 2_000 },
    ]);
    seedSession(db, 's2', [{ id: 't3', cost: 7.0, timestamp: 3_000 }]);
    seedSession(db, 's3', [{ id: 't4', cost: 9.0, timestamp: 4_000 }]);

    // Sessions seeded with total_cost_usd = 0 (deliberate) — reconcile
    // should recompute from turns.cost_usd.
    expect(sessionCost(db, 's1')).toBe(0);
    expect(sessionCost(db, 's2')).toBe(0);
    expect(sessionCost(db, 's3')).toBe(0);

    reconcileSessionsByIds(db, ['s1', 's2']);

    expect(sessionCost(db, 's1')).toBeCloseTo(4.0, 6);
    expect(sessionCost(db, 's2')).toBeCloseTo(7.0, 6);
    // s3 NOT in list — untouched.
    expect(sessionCost(db, 's3')).toBe(0);
  });

  it('is a no-op for an empty input array (no throw, no side effects)', () => {
    seedSession(db, 'a', [{ id: 'ta', cost: 1.0, timestamp: 100 }]);
    expect(sessionCost(db, 'a')).toBe(0);

    expect(() => reconcileSessionsByIds(db, [])).not.toThrow();

    // Session untouched — empty list never enters the transaction.
    expect(sessionCost(db, 'a')).toBe(0);
  });

  it('silently skips ids that do not exist (UPDATE WHERE id = ? affects 0 rows)', () => {
    seedSession(db, 'existing', [{ id: 'tx', cost: 5.0, timestamp: 100 }]);

    expect(() =>
      reconcileSessionsByIds(db, ['nonexistent', 'existing', 'also-gone']),
    ).not.toThrow();

    // Existing session WAS reconciled.
    expect(sessionCost(db, 'existing')).toBeCloseTo(5.0, 6);
    // Nonexistent ids simply produce 0 affected rows — no error.
  });
});

// TC-I-12 — Parity between reconcileAllSessions and reconcileSessionsByIds
// for tool_call_count after the ROLLUP_ALL_SQL LEFT JOIN refactor.
//
// Critical edge: sessions with ZERO tool_calls must yield tool_call_count = 0
// (not NULL). The LEFT JOIN must COALESCE to 0 and not drop session rows.
//
// Also asserts EXPLAIN QUERY PLAN no longer contains a CORRELATED SCALAR
// SUBQUERY for the tool_call aggregate — proving the perf refactor stuck.
describe('reconcileAllSessions — tool_call_count LEFT JOIN parity', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  const seedToolCalls = (
    db: DB,
    turnId: string,
    count: number,
    namePrefix: string,
  ): void => {
    const stmt = db.prepare(
      `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
       VALUES (?, ?, ?, '{}', '{}', 0)`,
    );
    for (let i = 0; i < count; i++) {
      stmt.run(`${namePrefix}-tc-${i}`, turnId, 'Bash');
    }
  };

  it('produces identical per-session tool_call_count vs the per-session path, including sessions with zero tools', () => {
    // s-zero-tools: 2 turns, 0 tool_calls — the LEFT JOIN edge case.
    seedSession(db, 's-zero-tools', [
      { id: 'sz-t1', cost: 1.0, timestamp: 1_000 },
      { id: 'sz-t2', cost: 1.0, timestamp: 2_000 },
    ]);

    // s-one-tool: 1 turn, 1 tool_call.
    seedSession(db, 's-one-tool', [
      { id: 'so-t1', cost: 2.0, timestamp: 1_500 },
    ]);
    seedToolCalls(db, 'so-t1', 1, 'so');

    // s-many-tools-uneven: 3 turns with 0, 2, and 5 tool_calls respectively.
    // Exercises join expansion: with a naive LEFT JOIN, SUM(input_tokens) and
    // COUNT(turn.id) would inflate. The pre-aggregated subquery prevents that.
    seedSession(db, 's-many-tools-uneven', [
      { id: 'mu-t1', cost: 1.0, timestamp: 1_000 },
      { id: 'mu-t2', cost: 1.0, timestamp: 2_000 },
      { id: 'mu-t3', cost: 1.0, timestamp: 3_000 },
    ]);
    seedToolCalls(db, 'mu-t2', 2, 'mu-t2');
    seedToolCalls(db, 'mu-t3', 5, 'mu-t3');

    // s-tools-on-single-turn: 1 turn, 7 tool_calls.
    seedSession(db, 's-tools-on-single-turn', [
      { id: 'sst-t1', cost: 3.0, timestamp: 5_000 },
    ]);
    seedToolCalls(db, 'sst-t1', 7, 'sst');

    // === Baseline: use the per-session path (correlated subquery in
    // ROLLUP_ONE_SQL). Capture per-session tool_call_count + turn_count +
    // token sums + cost.
    const sessionIds = [
      's-zero-tools',
      's-one-tool',
      's-many-tools-uneven',
      's-tools-on-single-turn',
    ] as const;

    reconcileSessionsByIds(db, [...sessionIds]);

    type Rollup = {
      id: string;
      turn_count: number;
      tool_call_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
    };
    const readRollups = (): Rollup[] =>
      db
        .prepare(
          `SELECT id, turn_count, tool_call_count,
                  total_input_tokens, total_output_tokens, total_cost_usd
           FROM sessions
           WHERE id IN (?, ?, ?, ?)
           ORDER BY id`,
        )
        .all(...sessionIds) as Rollup[];

    const baseline = readRollups();

    // Sanity: zero-tools session has tool_call_count = 0 (not NULL).
    const zero = baseline.find((r) => r.id === 's-zero-tools');
    expect(zero?.tool_call_count).toBe(0);

    // Sanity: explicit per-session expected values.
    const byId = new Map(baseline.map((r) => [r.id, r]));
    expect(byId.get('s-zero-tools')?.tool_call_count).toBe(0);
    expect(byId.get('s-one-tool')?.tool_call_count).toBe(1);
    expect(byId.get('s-many-tools-uneven')?.tool_call_count).toBe(7);
    expect(byId.get('s-tools-on-single-turn')?.tool_call_count).toBe(7);

    // Per-session sanity for sums (catches join-expansion bugs):
    // s-many-tools-uneven: 3 turns × 100 input_tokens = 300.
    expect(byId.get('s-many-tools-uneven')?.total_input_tokens).toBe(300);
    expect(byId.get('s-many-tools-uneven')?.total_cost_usd).toBeCloseTo(3.0, 6);

    // === Now re-run the all-sessions path (ROLLUP_ALL_SQL) and assert
    // byte-identical rollups. Reset the rollup columns first so we know the
    // second run actually wrote them.
    db.prepare(
      `UPDATE sessions
       SET turn_count = 0, tool_call_count = 0,
           total_input_tokens = 0, total_output_tokens = 0,
           total_cache_read_tokens = 0, total_cache_creation_tokens = 0,
           total_cost_usd = 0`,
    ).run();

    reconcileAllSessions(db);

    const afterAll = readRollups();
    expect(afterAll).toEqual(baseline);
  });

  it('ROLLUP_ALL_SQL no longer uses a CORRELATED SCALAR SUBQUERY for tool_call_count', () => {
    // Seed at least one session so the planner has data to plan against.
    seedSession(db, 's-plan', [
      { id: 'sp-t1', cost: 1.0, timestamp: 1_000 },
    ]);
    seedToolCalls(db, 'sp-t1', 1, 'sp');

    // Pull ROLLUP_ALL_SQL out of the module and EXPLAIN it. The statement is
    // not exported, so we rely on the public reconcileAllSessions exec path:
    // we can EXPLAIN any UPDATE statement we craft that mirrors the shape.
    // Instead, run EXPLAIN QUERY PLAN on the live shape via sqlite_master is
    // not possible (DML isn't stored). Use sqlite_stmt? Not available in
    // better-sqlite3. Simplest: re-prepare the same SQL by reading the module.
    //
    // We instead assert the negative property directly against the SQL text
    // exposed by sqlite's `EXPLAIN QUERY PLAN` for the rollup UPDATE. To do
    // that without exporting the SQL, we run EXPLAIN on a representative
    // UPDATE that joins via the pre-aggregated subquery. If the production
    // code regresses to a correlated subquery, the parity test above will
    // detect divergent counts under load — this test is a belt-and-braces
    // structural check.
    //
    // Approach: read the source file at runtime and EXPLAIN the SQL.
    // (Vitest runs in Node; fs is available.)
    // We keep this lightweight and tolerant: if the constant cannot be
    // located, we skip the structural assertion (the parity test above is
    // the primary guarantee).
    //
    // Use fs.readFileSync on the colocated source.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const src = fs.readFileSync(
      path.join(__dirname, 'reconcile.ts'),
      'utf8',
    );
    const match = src.match(/const ROLLUP_ALL_SQL = `([\s\S]*?)`;/);
    expect(match, 'ROLLUP_ALL_SQL constant must exist').toBeTruthy();
    const sql = match![1];

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
      detail: string;
    }>;
    const planText = plan.map((row) => row.detail).join('\n');
    expect(planText).not.toMatch(/CORRELATED SCALAR SUBQUERY/i);
  });
});
