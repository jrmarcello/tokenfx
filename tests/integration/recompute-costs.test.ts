import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { openDatabase, resetDbSingleton, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { recomputeCosts, formatSummaryMessage } from '@/scripts/recompute-costs';
import * as pricing from '@/lib/analytics/pricing';

/**
 * Integration tests for `scripts/recompute-costs.ts`.
 *
 * The script has two modes:
 *   - default: recompute `turns.cost_usd` via computeCost, then reconcile
 *     session rollups. `sessions.total_cost_usd_otel` is never touched.
 *   - `--prefer-otel`: skip turn-level recompute; fill
 *     `sessions.total_cost_usd_otel` from `otel_scrapes` via
 *     `getOtelCostBySession`. `sessions.total_cost_usd` is left alone.
 *
 * The script is exercised by calling `recomputeCosts({ preferOtel })`
 * directly — no child process. The DB is swapped per test via
 * `DASHBOARD_DB_PATH` so each case starts with a fresh file-backed DB.
 */

let dbPath = '';

const seedSession = (
  db: DB,
  id: string,
  overrides?: { total_cost_usd?: number; total_cost_usd_otel?: number | null },
): void => {
  db.prepare(
    `INSERT INTO sessions (
       id, cwd, project, started_at, ended_at,
       total_cost_usd, total_cost_usd_otel, source_file, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    '/tmp/cwd',
    'proj',
    1_700_000_000_000,
    1_700_000_010_000,
    overrides?.total_cost_usd ?? 0,
    overrides?.total_cost_usd_otel ?? null,
    `/tmp/${id}.jsonl`,
    1_700_000_020_000,
  );
};

const seedTurn = (
  db: DB,
  sessionId: string,
  turnId: string,
  costFrozen = 0,
): void => {
  db.prepare(
    `INSERT INTO turns (
       id, session_id, sequence, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turnId,
    sessionId,
    0,
    1_700_000_005_000,
    'claude-sonnet-4-5',
    1_000_000,
    500_000,
    0,
    0,
    costFrozen,
  );
};

const seedCostScrape = (
  db: DB,
  sessionId: string,
  value: number,
  scrapedAt = 1_700_000_100_000,
  metricName = 'claude_code_cost_usage_total',
): void => {
  db.prepare(
    `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
     VALUES (?, ?, ?, ?)`,
  ).run(
    scrapedAt,
    metricName,
    JSON.stringify({ session_id: sessionId, model: 'claude-sonnet-4-5' }),
    value,
  );
};

describe('recomputeCosts', () => {
  beforeEach(() => {
    dbPath = `/tmp/recompute-costs-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    process.env.DASHBOARD_DB_PATH = dbPath;
    resetDbSingleton();
    const bootstrap = openDatabase(dbPath);
    migrate(bootstrap);
    bootstrap.close();
  });

  afterEach(() => {
    resetDbSingleton();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    delete process.env.DASHBOARD_DB_PATH;
  });

  it('reprices historical zero-cost turns of a newly-priced family (claude-fable-5)', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 'sess-fable', { total_cost_usd: 0 });
    db.prepare(
      `INSERT INTO turns (
         id, session_id, sequence, timestamp, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t-fable', 'sess-fable', 0, 1_700_000_005_000, 'claude-fable-5', 1_000_000, 1_000_000, 0, 0, 0);
    db.close();

    const summary = recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false });
    expect(summary.mode === 'default' && summary.updated).toBe(1);

    const verify = openDatabase(dbPath);
    const turn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t-fable') as { cost_usd: number };
    // 1M input @ $10 + 1M output @ $50 = $60
    expect(turn.cost_usd).toBeCloseTo(60, 6);
    const session = verify
      .prepare('SELECT total_cost_usd FROM sessions WHERE id = ?')
      .get('sess-fable') as { total_cost_usd: number };
    expect(session.total_cost_usd).toBeCloseTo(60, 6);
    verify.close();
  });

  it('leaves turns of a still-unknown family at zero cost without throwing', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 'sess-unknown', { total_cost_usd: 0 });
    db.prepare(
      `INSERT INTO turns (
         id, session_id, sequence, timestamp, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t-unknown', 'sess-unknown', 0, 1_700_000_005_000, 'claude-newfamily-6', 1_000_000, 1_000_000, 0, 0, 0);
    db.close();

    expect(() =>
      recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false }),
    ).not.toThrow();

    const verify = openDatabase(dbPath);
    const turn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t-unknown') as { cost_usd: number };
    expect(turn.cost_usd).toBe(0);
    verify.close();
  });

  it('uses split cache-creation buckets (1h at 2x) instead of treating the legacy aggregate as all-5m', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 'sess-split', { total_cost_usd: 0 });
    db.prepare(
      `INSERT INTO turns (
         id, session_id, sequence, timestamp, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cache_creation_5m_tokens, cache_creation_1h_tokens, cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-split', 'sess-split', 0, 1_700_000_005_000, 'claude-fable-5',
      0, 0, 0,
      1_000_000, // legacy aggregate mirrors the split sum
      0, 1_000_000, // all of it is 1h-TTL cache creation
      0,
    );
    db.close();

    recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false });

    const verify = openDatabase(dbPath);
    const turn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t-split') as { cost_usd: number };
    // 1M 1h-cache-creation @ $20 (2x input) — NOT $12.50 (the 5m rate the
    // legacy aggregate path would apply).
    expect(turn.cost_usd).toBeCloseTo(20, 6);
    verify.close();
  });

  // TC-I-11 — happy, default (no --prefer-otel)
  it('recomputes turns.cost_usd and leaves total_cost_usd_otel untouched when flag absent', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 's1', { total_cost_usd: 0, total_cost_usd_otel: null });
    seedTurn(db, 's1', 't1', 0);
    seedCostScrape(db, 's1', 42.0);
    db.close();

    const summary = recomputeCosts({ preferOtel: false });

    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.updated).toBeGreaterThanOrEqual(1);

    const verify = openDatabase(dbPath);
    const turn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    expect(turn.cost_usd).toBeGreaterThan(0);

    const sess = verify
      .prepare(
        'SELECT total_cost_usd, total_cost_usd_otel FROM sessions WHERE id = ?',
      )
      .get('s1') as {
      total_cost_usd: number;
      total_cost_usd_otel: number | null;
    };
    expect(sess.total_cost_usd).toBeCloseTo(turn.cost_usd, 6);
    expect(sess.total_cost_usd_otel).toBeNull();
    verify.close();
  });

  // TC-I-12 — happy, --prefer-otel
  it('populates total_cost_usd_otel from scrapes and does not recompute turns when flag set', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 's1', { total_cost_usd: 9.99, total_cost_usd_otel: null });
    // Frozen stored turn cost that does NOT match computeCost for the seed
    // tokens — if prefer-otel accidentally took the default branch, this
    // value would be rewritten.
    seedTurn(db, 's1', 't1', 9.99);
    seedCostScrape(db, 's1', 42.0);
    db.close();

    const summary = recomputeCosts({ preferOtel: true });

    if (summary.mode !== 'prefer-otel') throw new Error('wrong mode');
    expect(summary.updatedOtelCosts).toBe(1);
    expect(summary.unchangedOtelCosts).toBe(0);

    const verify = openDatabase(dbPath);
    const sess = verify
      .prepare(
        'SELECT total_cost_usd_otel FROM sessions WHERE id = ?',
      )
      .get('s1') as { total_cost_usd_otel: number | null };
    expect(sess.total_cost_usd_otel).toBeCloseTo(42.0, 6);

    // Turn-level cost frozen — prefer-otel must NOT run computeCost.
    const turn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    expect(turn.cost_usd).toBeCloseTo(9.99, 6);
    verify.close();
  });

  // TC-I-13 — idempotency: second run reports 0 updates
  it('is idempotent — running --prefer-otel twice yields zero updates on the second run', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 's1');
    seedCostScrape(db, 's1', 42.0);
    db.close();

    const first = recomputeCosts({ preferOtel: true });
    if (first.mode !== 'prefer-otel') throw new Error('wrong mode');
    expect(first.updatedOtelCosts).toBe(1);
    expect(first.unchangedOtelCosts).toBe(0);

    const second = recomputeCosts({ preferOtel: true });
    if (second.mode !== 'prefer-otel') throw new Error('wrong mode');
    expect(second.updatedOtelCosts).toBe(0);
    expect(second.unchangedOtelCosts).toBe(1);
  });

  // TC-I-14 — edge: session without OTEL scrape keeps NULL
  it('leaves total_cost_usd_otel as NULL for sessions without any OTEL cost scrape', () => {
    const db = openDatabase(dbPath);
    seedSession(db, 's-with', { total_cost_usd_otel: null });
    seedSession(db, 's-without', { total_cost_usd_otel: null });
    seedCostScrape(db, 's-with', 10.0);
    db.close();

    const summary = recomputeCosts({ preferOtel: true });

    if (summary.mode !== 'prefer-otel') throw new Error('wrong mode');
    expect(summary.updatedOtelCosts).toBe(1);

    const verify = openDatabase(dbPath);
    const withRow = verify
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('s-with') as { total_cost_usd_otel: number | null };
    const withoutRow = verify
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('s-without') as { total_cost_usd_otel: number | null };
    expect(withRow.total_cost_usd_otel).toBeCloseTo(10.0, 6);
    expect(withoutRow.total_cost_usd_otel).toBeNull();
    verify.close();
  });
});

// ---------------------------------------------------------------------------
// New scope/dry-run/regression TCs from .specs/recompute-cost-cli.md
// ---------------------------------------------------------------------------

describe('recomputeCosts — scope filters', () => {
  beforeEach(() => {
    dbPath = `/tmp/recompute-scope-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    process.env.DASHBOARD_DB_PATH = dbPath;
    resetDbSingleton();
    const bootstrap = openDatabase(dbPath);
    migrate(bootstrap);
    bootstrap.close();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDbSingleton();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    delete process.env.DASHBOARD_DB_PATH;
  });

  const seedSessionWithDate = (
    db: DB,
    id: string,
    startedAt: number,
    otelCost: number | null = null,
  ): void => {
    db.prepare(
      `INSERT INTO sessions (
         id, cwd, project, started_at, ended_at,
         total_cost_usd, total_cost_usd_otel, source_file, ingested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      '/tmp/cwd',
      'proj',
      startedAt,
      startedAt + 10_000,
      0,
      otelCost,
      `/tmp/${id}.jsonl`,
      startedAt + 20_000,
    );
  };

  /**
   * Insert a turn whose `timestamp` matches the session's `started_at`
   * (or a passed override). Important: `migrate()` runs
   * `reconcileAllSessions` at startup, which UPDATEs each session's
   * `started_at = MIN(turns.timestamp)`. If the turn's timestamp is
   * before the session's seeded started_at, reconcile shifts the session
   * back in time and breaks `--since` scope filtering in tests.
   */
  const seedTurnSimple = (
    db: DB,
    sessionId: string,
    turnId: string,
    timestamp?: number,
  ): void => {
    const ts = timestamp ?? (db
      .prepare('SELECT started_at FROM sessions WHERE id = ?')
      .get(sessionId) as { started_at: number }).started_at;
    db.prepare(
      `INSERT INTO turns (
         id, session_id, sequence, timestamp, model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(turnId, sessionId, 0, ts, 'claude-sonnet-4-5',
      1_000_000, 500_000, 0, 0, 0);
  };

  it('--all recomputes every turn and reconciles every session', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedSessionWithDate(db, 's2', 1_700_000_100_000);
    seedSessionWithDate(db, 's3', 1_700_000_200_000);
    seedTurnSimple(db, 's1', 't1a');
    seedTurnSimple(db, 's1', 't1b');
    seedTurnSimple(db, 's2', 't2');
    seedTurnSimple(db, 's3', 't3a');
    seedTurnSimple(db, 's3', 't3b');
    seedTurnSimple(db, 's3', 't3c');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: false,
    });

    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(6);
    expect(summary.updated).toBe(6);
    expect(summary.unchanged).toBe(0);

    const verify = openDatabase(dbPath);
    const sessions = verify
      .prepare(
        'SELECT id, total_cost_usd FROM sessions ORDER BY started_at',
      )
      .all() as Array<{ id: string; total_cost_usd: number }>;
    expect(sessions.every((s) => s.total_cost_usd > 0)).toBe(true);
    verify.close();
  });

  it('--all is idempotent on second run', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedTurnSimple(db, 's1', 't1');
    db.close();

    recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false });
    const second = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: false,
    });
    if (second.mode !== 'default') throw new Error('wrong mode');
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it('--since filters by sessions.started_at >= sinceMs', () => {
    const db = openDatabase(dbPath);
    // A is BEFORE since; B and C are AT or AFTER.
    seedSessionWithDate(db, 'A', Date.UTC(2026, 2, 15));
    seedSessionWithDate(db, 'B', Date.UTC(2026, 3, 1));
    seedSessionWithDate(db, 'C', Date.UTC(2026, 3, 15));
    seedTurnSimple(db, 'A', 'tA');
    seedTurnSimple(db, 'B', 'tB');
    seedTurnSimple(db, 'C', 'tC');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'since', sinceMs: Date.UTC(2026, 3, 1) },
      dryRun: false,
    });

    if (summary.mode !== 'default') throw new Error('wrong mode');
    // Only B + C turns inspected (A excluded by the JOIN filter).
    expect(summary.total).toBe(2);
    expect(summary.updated).toBe(2);

    const verify = openDatabase(dbPath);
    const a = verify
      .prepare('SELECT total_cost_usd FROM sessions WHERE id = ?')
      .get('A') as { total_cost_usd: number };
    const b = verify
      .prepare('SELECT total_cost_usd FROM sessions WHERE id = ?')
      .get('B') as { total_cost_usd: number };
    // A NOT touched — total_cost_usd still 0 from the seed.
    expect(a.total_cost_usd).toBe(0);
    // B WAS recomputed and rolled up.
    expect(b.total_cost_usd).toBeGreaterThan(0);
    verify.close();
  });

  it('--since far in the future yields zero affected, no crash', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 'X', 1_700_000_000_000);
    seedTurnSimple(db, 'X', 'tX');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'since', sinceMs: Date.UTC(2099, 11, 31) },
      dryRun: false,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(0);
    expect(summary.updated).toBe(0);
  });

  it('--session ID limits work to one session', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedSessionWithDate(db, 's2', 1_700_000_100_000);
    seedTurnSimple(db, 's1', 't1a');
    seedTurnSimple(db, 's1', 't1b');
    seedTurnSimple(db, 's2', 't2');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'session', id: 's1' },
      dryRun: false,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(2);
    expect(summary.updated).toBe(2);

    const verify = openDatabase(dbPath);
    const s2 = verify
      .prepare('SELECT total_cost_usd FROM sessions WHERE id = ?')
      .get('s2') as { total_cost_usd: number };
    expect(s2.total_cost_usd).toBe(0); // untouched
    verify.close();
  });

  it('--session for an unknown ID is a soft fail (zero affected, no throw)', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 'exists', 1_700_000_000_000);
    seedTurnSimple(db, 'exists', 'tx');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'session', id: 'does-not-exist' },
      dryRun: false,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(0);
    expect(summary.updated).toBe(0);
  });

  it('--dry-run with 2x pricing leaves turns.cost_usd untouched', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedTurnSimple(db, 's1', 't1');
    db.close();

    // First run actually applies the current pricing so we have a non-zero baseline.
    recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false });

    const before = openDatabase(dbPath);
    const beforeTurn = before
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    before.close();

    // Force a delta: stub computeCost to return 2x for the next run.
    vi.spyOn(pricing, 'computeCost').mockImplementation(() =>
      beforeTurn.cost_usd * 2,
    );

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: true,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.dryRun).toBe(true);
    expect(summary.updated).toBe(1); // would update

    const verify = openDatabase(dbPath);
    const after = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    // Dry-run rolled back the UPDATE.
    expect(after.cost_usd).toBeCloseTo(beforeTurn.cost_usd, 6);
    verify.close();
  });

  it('--dry-run rollback survives a second dry-run pass (idempotent rollback under pricing delta)', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedTurnSimple(db, 's1', 't1');
    db.close();

    // Baseline run with REAL pricing to populate turns.cost_usd > 0.
    recomputeCosts({ mode: 'default', scope: { kind: 'all' }, dryRun: false });

    const baseline = openDatabase(dbPath);
    const beforeTurn = baseline
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    baseline.close();
    expect(beforeTurn.cost_usd).toBeGreaterThan(0);

    // Force a pricing delta so dry-run would WRITE something if rollback
    // were broken. Two consecutive dry-runs must both report `updated: 1`
    // (would-update) AND leave turns.cost_usd at the baseline value.
    vi.spyOn(pricing, 'computeCost').mockImplementation(
      () => beforeTurn.cost_usd * 2,
    );

    const first = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: true,
    });
    const second = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: true,
    });
    if (first.mode !== 'default' || second.mode !== 'default') {
      throw new Error('wrong mode');
    }
    expect(first.updated).toBe(1);
    expect(second.updated).toBe(1);

    const verify = openDatabase(dbPath);
    const afterTurn = verify
      .prepare('SELECT cost_usd FROM turns WHERE id = ?')
      .get('t1') as { cost_usd: number };
    verify.close();
    expect(afterTurn.cost_usd).toBeCloseTo(beforeTurn.cost_usd, 6);
  });

  it.each([
    ['TC-I-09', false],
    ['TC-I-10', true],
  ])(
    '%s — --all (dryRun=%s) does not touch total_cost_usd_otel',
    (_label, dryRun) => {
      const db = openDatabase(dbPath);
      seedSessionWithDate(db, 's1', 1_700_000_000_000, 42.0);
      seedTurnSimple(db, 's1', 't1');
      db.close();

      recomputeCosts({
        mode: 'default',
        scope: { kind: 'all' },
        dryRun,
      });

      const verify = openDatabase(dbPath);
      const sess = verify
        .prepare(
          'SELECT total_cost_usd_otel FROM sessions WHERE id = ?',
        )
        .get('s1') as { total_cost_usd_otel: number | null };
      expect(sess.total_cost_usd_otel).toBeCloseTo(42.0, 6);
      verify.close();
    },
  );

  it('--since preserves total_cost_usd_otel on in-scope sessions', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 'in-scope', Date.UTC(2026, 3, 15), 99.0);
    seedTurnSimple(db, 'in-scope', 't1');
    db.close();

    recomputeCosts({
      mode: 'default',
      scope: { kind: 'since', sinceMs: Date.UTC(2026, 3, 1) },
      dryRun: false,
    });

    const verify = openDatabase(dbPath);
    const sess = verify
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('in-scope') as { total_cost_usd_otel: number | null };
    expect(sess.total_cost_usd_otel).toBeCloseTo(99.0, 6);
    verify.close();
  });

  it('--session preserves total_cost_usd_otel', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 'sX', 1_700_000_000_000, 77.0);
    seedTurnSimple(db, 'sX', 't1');
    db.close();

    recomputeCosts({
      mode: 'default',
      scope: { kind: 'session', id: 'sX' },
      dryRun: false,
    });

    const verify = openDatabase(dbPath);
    const sess = verify
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('sX') as { total_cost_usd_otel: number | null };
    expect(sess.total_cost_usd_otel).toBeCloseTo(77.0, 6);
    verify.close();
  });

  it('formatSummaryMessage emits the [dry-run] prefix when summary.dryRun is true (REQ-9 production path)', () => {
    // Tests the SAME helper that main() uses. Earlier reviewer flagged
    // that asserting on manually-assembled strings tests the test's own
    // code, not production. This variant asserts the exported helper
    // directly.
    expect(
      formatSummaryMessage({
        mode: 'default',
        scope: { kind: 'all' },
        dryRun: true,
        total: 0,
        updated: 0,
        unchanged: 0,
        zeroedBefore: 0,
        zeroedAfter: 0,
      }),
    ).toBe('[dry-run] recompute-costs');

    expect(
      formatSummaryMessage({
        mode: 'default',
        scope: { kind: 'all' },
        dryRun: false,
        total: 0,
        updated: 0,
        unchanged: 0,
        zeroedBefore: 0,
        zeroedAfter: 0,
      }),
    ).toBe('recompute-costs');
  });

  it('PRAGMA integrity_check returns ok after dry-run rollback', () => {
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 's1', 1_700_000_000_000);
    seedTurnSimple(db, 's1', 't1');
    db.close();

    recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: true,
    });

    const verify = openDatabase(dbPath);
    const integrity = verify.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string;
    };
    expect(integrity.integrity_check).toBe('ok');
    verify.close();
  });

  it('empty DB returns total=0, no crash', () => {
    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: false,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(0);
    expect(summary.updated).toBe(0);
  });

  it('--since boundary: session.started_at === sinceMs is INCLUDED', () => {
    const exactBoundary = Date.UTC(2026, 3, 1);
    const db = openDatabase(dbPath);
    seedSessionWithDate(db, 'on-boundary', exactBoundary);
    seedTurnSimple(db, 'on-boundary', 't1');
    db.close();

    const summary = recomputeCosts({
      mode: 'default',
      scope: { kind: 'since', sinceMs: exactBoundary },
      dryRun: false,
    });
    if (summary.mode !== 'default') throw new Error('wrong mode');
    expect(summary.total).toBe(1);
    expect(summary.updated).toBe(1);
  });
});

describe('recompute-cost CLI (subprocess + package.json)', () => {
  it('`tsx scripts/recompute-costs.ts` (no flags) exits 1 with usage', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const tsxBin = path.resolve(repoRoot, 'node_modules', '.bin', 'tsx');
    // Fail loudly if pnpm workspace hoisting moved tsx elsewhere — vacuous
    // pass on `!== 0` is the failure mode the earlier reviewer warned about.
    if (!fs.existsSync(tsxBin)) {
      throw new Error(
        `tsx binary missing at ${tsxBin} — pnpm hoisting may have moved it`,
      );
    }
    const scriptPath = path.resolve(repoRoot, 'scripts', 'recompute-costs.ts');
    const result = spawnSync(tsxBin, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
    });
    if (result.status === null) {
      throw new Error(
        `spawn failed for tsx at ${tsxBin}: ${result.error ?? '(no error)'}`,
      );
    }
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage/i);
  });

  it('package.json declares `recompute-cost` script entry', () => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    let parsed: { scripts?: Record<string, string> };
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();
    expect(parsed!.scripts?.['recompute-cost']).toBe(
      'tsx scripts/recompute-costs.ts',
    );
    // Suppress unused-var warning for execFileSync (kept as a useful util
    // import in case future TCs need it to invoke `pnpm` directly).
    void execFileSync;
  });
});
