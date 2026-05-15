import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

import { smokeSeed, SMOKE_SEED_VALUES } from './smoke-seed';

/**
 * smoke-seed tests use an in-memory SQLite via openDatabase(':memory:').
 * The schema is materialized through migrate() so all required tables exist.
 * Each test gets a fresh DB instance so assertions are isolated.
 */

let db: DB;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe('smoke-seed', () => {
  it('TC-U-05 produces 3 sessions with exact counts and SUM(total_cost_usd) = 42.50', () => {
    const result = smokeSeed(db);
    expect(result.ok).toBe(true);

    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(3);

    const sum = db
      .prepare('SELECT SUM(total_cost_usd) AS total FROM sessions')
      .get() as { total: number };
    expect(sum.total).toBeCloseTo(42.5, 6);

    // Verify the exact per-session values match the documented seed.
    const rows = db
      .prepare(
        'SELECT id, total_cost_usd, turn_count, tool_call_count FROM sessions ORDER BY id ASC',
      )
      .all() as Array<{
        id: string;
        total_cost_usd: number;
        turn_count: number;
        tool_call_count: number;
      }>;

    expect(rows).toEqual([
      { id: 'seed-smoke-1', total_cost_usd: 10.0, turn_count: 5, tool_call_count: 10 },
      { id: 'seed-smoke-2', total_cost_usd: 15.0, turn_count: 8, tool_call_count: 15 },
      { id: 'seed-smoke-3', total_cost_usd: 17.5, turn_count: 12, tool_call_count: 25 },
    ]);

    // SMOKE_SEED_VALUES is the documented contract — sanity check it stays in sync.
    expect(SMOKE_SEED_VALUES.totalCostUsdSum).toBeCloseTo(42.5, 6);
    expect(SMOKE_SEED_VALUES.sessionCount).toBe(3);
  });

  it('TC-U-06 is idempotent — running twice leaves counts unchanged', () => {
    const first = smokeSeed(db);
    expect(first.ok).toBe(true);
    const second = smokeSeed(db);
    expect(second.ok).toBe(true);

    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(3);

    const sum = db
      .prepare('SELECT SUM(total_cost_usd) AS total FROM sessions')
      .get() as { total: number };
    expect(sum.total).toBeCloseTo(42.5, 6);
  });

  it('TC-U-07 mixes OTEL-cost coverage — session-2 has non-null otel cost, sessions 1 and 3 are null', () => {
    const result = smokeSeed(db);
    expect(result.ok).toBe(true);

    const rows = db
      .prepare(
        'SELECT id, total_cost_usd_otel FROM sessions ORDER BY id ASC',
      )
      .all() as Array<{ id: string; total_cost_usd_otel: number | null }>;

    expect(rows[0]).toEqual({ id: 'seed-smoke-1', total_cost_usd_otel: null });
    expect(rows[1]).toEqual({ id: 'seed-smoke-2', total_cost_usd_otel: 0.4 });
    expect(rows[2]).toEqual({ id: 'seed-smoke-3', total_cost_usd_otel: null });

    // Both calibration-code-path branches are exercised.
    const withOtel = rows.filter((r) => r.total_cost_usd_otel !== null);
    const withoutOtel = rows.filter((r) => r.total_cost_usd_otel === null);
    expect(withOtel.length).toBeGreaterThanOrEqual(1);
    expect(withoutOtel.length).toBeGreaterThanOrEqual(1);
  });
});
