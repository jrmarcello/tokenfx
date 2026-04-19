import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDatabase, resetDbSingleton, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { recomputeCosts } from '@/scripts/recompute-costs';

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
