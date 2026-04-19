import type { DB } from '@/lib/db/client';
import {
  MIN_RATE,
  MAX_RATE,
  type Calibration,
  type CalibrationEntry,
  type CalibrationFamily,
} from '@/lib/analytics/cost-calibration';

/**
 * Read the current calibration table into an in-memory Map keyed by family.
 * Rows whose `family` column is not a recognised `CalibrationFamily` value
 * are ignored — defense-in-depth against a future, unrelated schema change.
 */
export const getCostCalibration = (db: DB): Calibration => {
  const rows = db
    .prepare(
      `SELECT family,
              effective_rate       AS rate,
              sample_session_count AS sampleSessionCount,
              sum_otel_cost        AS sumOtelCost,
              sum_local_cost       AS sumLocalCost,
              last_updated_at      AS lastUpdatedAt
       FROM cost_calibration`,
    )
    .all() as ReadonlyArray<{
    family: string;
    rate: number;
    sampleSessionCount: number;
    sumOtelCost: number;
    sumLocalCost: number;
    lastUpdatedAt: number;
  }>;

  const result: Calibration = new Map();
  for (const row of rows) {
    if (!isCalibrationFamily(row.family)) continue;
    const entry: CalibrationEntry = {
      family: row.family,
      rate: row.rate,
      sampleSessionCount: row.sampleSessionCount,
      sumOtelCost: row.sumOtelCost,
      sumLocalCost: row.sumLocalCost,
      lastUpdatedAt: row.lastUpdatedAt,
    };
    result.set(row.family, entry);
  }
  return result;
};

const isCalibrationFamily = (value: string): value is CalibrationFamily =>
  value === 'opus' ||
  value === 'sonnet' ||
  value === 'haiku' ||
  value === 'global';

type FamilyAggregate = {
  sumOtel: number;
  sumLocal: number;
  sampleSessionCount: number;
};

type RecomputeSummary = {
  familiesWritten: number;
  skippedOutOfBounds: number;
};

/**
 * Per-session aggregation CTE: for each session that has OTEL reporting AND
 * a positive local cost, derive the dominant model (highest SUM(cost_usd)
 * across that session's turns) and its family. Sessions with no turns or
 * with all-zero turn costs are excluded by the HAVING clause — their
 * `sum_local` would be zero, which would produce a division-by-zero if it
 * reached the ratio step.
 *
 * `dominant_family` is derived from the turn model string via LOWER()/LIKE
 * so SQL-side filtering stays self-contained. Unrecognised models map to
 * `other` and contribute only to the global row.
 *
 * The outer SELECT joins back to `sessions` to take the authoritative
 * `total_cost_usd` and `total_cost_usd_otel` for the aggregation — turn
 * sums drive family classification, not the ratio numerator/denominator.
 */
const PER_SESSION_SQL = `
  WITH session_model_cost AS (
    SELECT
      t.session_id,
      t.model,
      SUM(t.cost_usd) AS model_cost
    FROM turns t
    GROUP BY t.session_id, t.model
  ),
  session_dominant AS (
    SELECT
      smc.session_id,
      smc.model AS dominant_model
    FROM session_model_cost smc
    WHERE smc.model_cost = (
      SELECT MAX(inner_smc.model_cost)
      FROM session_model_cost inner_smc
      WHERE inner_smc.session_id = smc.session_id
    )
    GROUP BY smc.session_id
  )
  SELECT
    s.id,
    s.total_cost_usd        AS sum_local,
    s.total_cost_usd_otel   AS sum_otel,
    CASE
      WHEN LOWER(sd.dominant_model) LIKE 'claude-opus%'   THEN 'opus'
      WHEN LOWER(sd.dominant_model) LIKE 'claude-sonnet%' THEN 'sonnet'
      WHEN LOWER(sd.dominant_model) LIKE 'claude-haiku%'  THEN 'haiku'
      ELSE 'other'
    END AS dominant_family
  FROM sessions s
  LEFT JOIN session_dominant sd ON sd.session_id = s.id
  WHERE s.total_cost_usd_otel IS NOT NULL
    AND s.total_cost_usd > 0
`;

type SessionRow = {
  id: string;
  sum_local: number;
  sum_otel: number;
  dominant_family: 'opus' | 'sonnet' | 'haiku' | 'other' | null;
};

const FAMILY_KEYS: ReadonlyArray<CalibrationFamily> = [
  'opus',
  'sonnet',
  'haiku',
  'global',
];

const isInBounds = (rate: number): boolean =>
  Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;

/**
 * Recompute the `cost_calibration` table from scratch.
 *
 * Wrapped in a single transaction so readers never observe a half-updated
 * table. Strategy:
 *
 *   1. Aggregate eligible sessions (OTEL present AND local > 0) per
 *      `family` bucket plus a `global` bucket.
 *   2. For each family compute `rate = sum_otel / sum_local`. If the rate
 *      is out-of-bounds OR `sum_local <= 0` OR there are zero samples, the
 *      family is "rejected": any existing row is DELETEd (clears stale
 *      calibration) and it does not count toward `familiesWritten`.
 *   3. For each accepted family UPSERT the row. The UPDATE branch only
 *      bumps `last_updated_at` when one of the material columns actually
 *      changed — idempotent reruns with zero data movement leave
 *      `last_updated_at` untouched.
 */
export const recomputeCostCalibration = (db: DB): RecomputeSummary => {
  let familiesWritten = 0;
  let skippedOutOfBounds = 0;

  const now = Date.now();

  const tx = db.transaction(() => {
    const sessionRows = db.prepare(PER_SESSION_SQL).all() as SessionRow[];

    // Per-family buckets (opus/sonnet/haiku). `other` is intentionally
    // excluded — the spec only maintains calibration for the three claude
    // families plus a `global` aggregate.
    const buckets = new Map<CalibrationFamily, FamilyAggregate>();
    const bump = (
      family: CalibrationFamily,
      sumLocal: number,
      sumOtel: number,
    ): void => {
      const existing = buckets.get(family) ?? {
        sumOtel: 0,
        sumLocal: 0,
        sampleSessionCount: 0,
      };
      existing.sumOtel += sumOtel;
      existing.sumLocal += sumLocal;
      existing.sampleSessionCount += 1;
      buckets.set(family, existing);
    };

    for (const row of sessionRows) {
      // Guard: row.sum_otel is declared NOT NULL by the WHERE clause above,
      // but better-sqlite3's static typing doesn't know that.
      const otel = row.sum_otel;
      const local = row.sum_local;
      if (otel === null || local <= 0) continue;

      if (
        row.dominant_family === 'opus' ||
        row.dominant_family === 'sonnet' ||
        row.dominant_family === 'haiku'
      ) {
        bump(row.dominant_family, local, otel);
      }
      // Always contribute to global, regardless of (or absent) family.
      bump('global', local, otel);
    }

    const selectStmt = db.prepare(
      `SELECT effective_rate       AS rate,
              sample_session_count AS sampleSessionCount,
              sum_otel_cost        AS sumOtelCost,
              sum_local_cost       AS sumLocalCost
       FROM cost_calibration WHERE family = ?`,
    );
    const upsertStmt = db.prepare(
      `INSERT INTO cost_calibration (
         family, effective_rate, sample_session_count,
         sum_otel_cost, sum_local_cost, last_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(family) DO UPDATE SET
         effective_rate       = excluded.effective_rate,
         sample_session_count = excluded.sample_session_count,
         sum_otel_cost        = excluded.sum_otel_cost,
         sum_local_cost       = excluded.sum_local_cost,
         last_updated_at      = excluded.last_updated_at`,
    );
    const deleteStmt = db.prepare(
      `DELETE FROM cost_calibration WHERE family = ?`,
    );

    for (const family of FAMILY_KEYS) {
      const agg = buckets.get(family);
      const hasSamples =
        agg !== undefined && agg.sampleSessionCount > 0 && agg.sumLocal > 0;
      if (!hasSamples) {
        // Either zero samples or sum_local === 0 (division protection):
        // clear any stale row for this family.
        deleteStmt.run(family);
        continue;
      }
      const rate = agg.sumOtel / agg.sumLocal;
      if (!isInBounds(rate)) {
        skippedOutOfBounds += 1;
        deleteStmt.run(family);
        continue;
      }

      // Idempotency: only bump last_updated_at when something material
      // changed. Compare against the existing row (if any).
      const existing = selectStmt.get(family) as
        | {
            rate: number;
            sampleSessionCount: number;
            sumOtelCost: number;
            sumLocalCost: number;
          }
        | undefined;

      const unchanged =
        existing !== undefined &&
        existing.rate === rate &&
        existing.sampleSessionCount === agg.sampleSessionCount &&
        existing.sumOtelCost === agg.sumOtel &&
        existing.sumLocalCost === agg.sumLocal;

      if (unchanged) {
        // No-op: row already reflects the current aggregation exactly.
        familiesWritten += 1;
        continue;
      }

      upsertStmt.run(
        family,
        rate,
        agg.sampleSessionCount,
        agg.sumOtel,
        agg.sumLocal,
        now,
      );
      familiesWritten += 1;
    }
  });
  tx();

  return { familiesWritten, skippedOutOfBounds };
};
