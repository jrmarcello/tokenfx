import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getCostCalibration,
  recomputeCostCalibration,
} from '@/lib/queries/calibration';
import type { CalibrationFamily } from '@/lib/analytics/cost-calibration';

/**
 * Integration tests for `lib/queries/calibration.ts`.
 *
 * Seeds sessions + turns in an in-memory DB, calls `recomputeCostCalibration`,
 * then asserts the state of the `cost_calibration` table via
 * `getCostCalibration`.
 *
 * Family classification rule exercised here: a session's dominant model is the
 * model whose SUM(turns.cost_usd) within that session is highest. That model's
 * family determines which family bucket the session contributes to. The
 * `global` bucket aggregates across ALL sessions with OTEL regardless of
 * dominant family.
 */

let db: DB;

const seedSession = (
  sessionId: string,
  opts: {
    totalCostLocal: number;
    totalCostOtel: number | null;
  },
): void => {
  db.prepare(
    `INSERT INTO sessions (
       id, cwd, project, started_at, ended_at,
       total_cost_usd, total_cost_usd_otel, source_file, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    '/tmp/cwd',
    'proj',
    1_700_000_000_000,
    1_700_000_010_000,
    opts.totalCostLocal,
    opts.totalCostOtel,
    `/tmp/${sessionId}.jsonl`,
    1_700_000_020_000,
  );
};

const seedTurn = (args: {
  id: string;
  sessionId: string;
  sequence: number;
  model: string;
  costUsd: number;
}): void => {
  db.prepare(
    `INSERT INTO turns (
       id, session_id, sequence, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd
     ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`,
  ).run(
    args.id,
    args.sessionId,
    args.sequence,
    1_700_000_005_000,
    args.model,
    args.costUsd,
  );
};

const readCalibrationRow = (family: CalibrationFamily) =>
  db
    .prepare('SELECT * FROM cost_calibration WHERE family = ?')
    .get(family) as
    | {
        family: string;
        effective_rate: number;
        sample_session_count: number;
        sum_otel_cost: number;
        sum_local_cost: number;
        last_updated_at: number;
      }
    | undefined;

describe('calibration — getCostCalibration', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty Map on a fresh DB', () => {
    const result = getCostCalibration(db);
    expect(result.size).toBe(0);
  });
});

describe('calibration — recomputeCostCalibration', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  // TC-I-01
  it('TC-I-01: aggregates two opus OTEL sessions into opus + global rows', () => {
    seedSession('s1', { totalCostLocal: 100, totalCostOtel: 20 });
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 100,
    });
    seedSession('s2', { totalCostLocal: 200, totalCostOtel: 40 });
    seedTurn({
      id: 't2',
      sessionId: 's2',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 200,
    });

    const result = recomputeCostCalibration(db);
    expect(result.familiesWritten).toBe(2); // opus + global
    expect(result.skippedOutOfBounds).toBe(0);

    const calibration = getCostCalibration(db);
    const opus = calibration.get('opus');
    expect(opus).toBeDefined();
    expect(opus?.rate).toBeCloseTo(0.2, 6);
    expect(opus?.sampleSessionCount).toBe(2);
    expect(opus?.sumOtelCost).toBeCloseTo(60, 6);
    expect(opus?.sumLocalCost).toBeCloseTo(300, 6);

    const global = calibration.get('global');
    expect(global).toBeDefined();
    expect(global?.rate).toBeCloseTo(0.2, 6);
    expect(global?.sampleSessionCount).toBe(2);
    expect(global?.sumOtelCost).toBeCloseTo(60, 6);
    expect(global?.sumLocalCost).toBeCloseTo(300, 6);
  });

  // TC-I-02
  it('TC-I-02: opus OTEL + sonnet without OTEL → opus row only; global matches opus', () => {
    // opus session with OTEL
    seedSession('s1', { totalCostLocal: 100, totalCostOtel: 25 });
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 100,
    });
    // sonnet session WITHOUT OTEL — must not contribute.
    seedSession('s2', { totalCostLocal: 500, totalCostOtel: null });
    seedTurn({
      id: 't2',
      sessionId: 's2',
      sequence: 0,
      model: 'claude-sonnet-4-5',
      costUsd: 500,
    });

    recomputeCostCalibration(db);

    const calibration = getCostCalibration(db);
    expect(calibration.get('opus')?.rate).toBeCloseTo(0.25, 6);
    expect(calibration.get('sonnet')).toBeUndefined();
    expect(calibration.get('haiku')).toBeUndefined();
    expect(calibration.get('global')?.rate).toBeCloseTo(0.25, 6);
    expect(calibration.get('global')?.sampleSessionCount).toBe(1);
  });

  // TC-I-03
  it('TC-I-03: rejects ratio below MIN_RATE — opus not written, counted as skipped', () => {
    seedSession('s1', { totalCostLocal: 100, totalCostOtel: 0.001 }); // ratio 0.00001
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 100,
    });

    const result = recomputeCostCalibration(db);
    expect(result.skippedOutOfBounds).toBeGreaterThanOrEqual(1);

    const calibration = getCostCalibration(db);
    expect(calibration.get('opus')).toBeUndefined();
    // global shares the same data — also rejected.
    expect(calibration.get('global')).toBeUndefined();
  });

  // TC-I-04
  it('TC-I-04: rejects ratio above MAX_RATE', () => {
    seedSession('s1', { totalCostLocal: 1, totalCostOtel: 50 }); // ratio 50
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 1,
    });

    const result = recomputeCostCalibration(db);
    expect(result.skippedOutOfBounds).toBeGreaterThanOrEqual(1);

    const calibration = getCostCalibration(db);
    expect(calibration.get('opus')).toBeUndefined();
    expect(calibration.get('global')).toBeUndefined();
  });

  // TC-I-05
  it('TC-I-05: idempotent — second run with identical state does not update last_updated_at', () => {
    seedSession('s1', { totalCostLocal: 100, totalCostOtel: 20 });
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 100,
    });

    recomputeCostCalibration(db);
    const opusFirst = readCalibrationRow('opus');
    const globalFirst = readCalibrationRow('global');
    expect(opusFirst).toBeDefined();
    expect(globalFirst).toBeDefined();

    // Second pass with zero data changes.
    recomputeCostCalibration(db);
    const opusSecond = readCalibrationRow('opus');
    const globalSecond = readCalibrationRow('global');

    expect(opusSecond?.last_updated_at).toBe(opusFirst?.last_updated_at);
    expect(globalSecond?.last_updated_at).toBe(globalFirst?.last_updated_at);
    expect(opusSecond?.effective_rate).toBe(opusFirst?.effective_rate);
    expect(opusSecond?.sample_session_count).toBe(
      opusFirst?.sample_session_count,
    );
  });

  // TC-I-12
  it('TC-I-12: family with sum_local = 0 is silently skipped (no div-by-zero)', () => {
    // Session has OTEL but ALL turns have cost_usd = 0 (dominant-model
    // aggregation yields sum_local = 0). Recompute must skip without crash
    // and the session's local total is also filtered out by the query
    // precondition `total_cost_usd > 0`.
    seedSession('s1', { totalCostLocal: 0, totalCostOtel: 10 });
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 0,
    });

    expect(() => recomputeCostCalibration(db)).not.toThrow();
    const calibration = getCostCalibration(db);
    expect(calibration.get('opus')).toBeUndefined();
    expect(calibration.get('global')).toBeUndefined();
  });

  // Extra: DELETE on reject clears stale.
  it('clears a previously-calibrated family when the new ratio falls out of bounds', () => {
    seedSession('s1', { totalCostLocal: 100, totalCostOtel: 20 });
    seedTurn({
      id: 't1',
      sessionId: 's1',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 100,
    });
    recomputeCostCalibration(db);
    expect(getCostCalibration(db).get('opus')).toBeDefined();

    // Insert a 2nd opus session that blows the ratio past MAX_RATE so the
    // aggregate (20 + 500) / (100 + 1) = 520/101 ≈ 5.15 → out of bounds.
    seedSession('s2', { totalCostLocal: 1, totalCostOtel: 500 });
    seedTurn({
      id: 't2',
      sessionId: 's2',
      sequence: 0,
      model: 'claude-opus-4-7',
      costUsd: 1,
    });
    recomputeCostCalibration(db);

    const calibration = getCostCalibration(db);
    expect(calibration.get('opus')).toBeUndefined();
    expect(calibration.get('global')).toBeUndefined();
  });
});
