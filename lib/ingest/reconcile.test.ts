import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { reconcileSessionsByIds } from './reconcile';

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
