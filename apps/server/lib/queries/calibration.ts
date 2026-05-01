/**
 * Per-user cost calibration recompute (REQ-19).
 *
 * Mirrors the local-side algorithm in `lib/queries/calibration.ts` (root) but
 * partitions by `user_id` since each dev may be on a different Anthropic plan
 * (Pro vs Max5x vs Max20x) — a global org rate would mis-attribute by 4×.
 *
 * Inputs: `sessions_agg` rows for the given user where `total_cost_usd_otel`
 * is non-null. The dominant model for each session is approximated via the
 * `model_breakdown_agg` row with the largest `cost_usd` per session.
 *
 * Outputs: UPSERT into `cost_calibration_per_user` for each accepted family
 * (opus/sonnet/haiku/global). Out-of-bounds rates DELETE the family entry so
 * stale calibration is cleared rather than left lingering.
 *
 * Wrapped in the caller's transaction — invoked from inside the ingest route
 * transaction so calibration always reflects the latest aggregate atomically.
 */
import { sql, eq, and } from 'drizzle-orm';
import {
  MIN_RATE,
  MAX_RATE,
  type CalibrationFamily,
} from '@root/analytics/cost-calibration';
import { deriveModelFamily } from '@root/analytics/model';
import {
  costCalibrationPerUser,
  modelBreakdownAgg,
  sessionsAgg,
} from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const FAMILY_KEYS: ReadonlyArray<CalibrationFamily> = [
  'opus',
  'sonnet',
  'haiku',
  'global',
];

const isInBounds = (rate: number): boolean =>
  Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;

type FamilyAggregate = {
  sumOtel: number;
  sumLocal: number;
  sampleSessionCount: number;
};

type SessionRow = {
  sessionId: string;
  sumLocal: number;
  sumOtel: number;
  dominantModel: string | null;
};

/**
 * Recompute calibration rows for one user. Idempotent — re-running with the
 * same data produces the same rows. Designed to be called inside a Drizzle
 * transaction (the ingest route opens one for atomicity).
 *
 * Returns a summary the caller can log; not surfaced in the HTTP response.
 */
export const recomputePerUserCalibration = async (
  tx: DrizzleTx,
  userId: string,
): Promise<{ familiesWritten: number; skippedOutOfBounds: number }> => {
  // 1) Aggregate the dominant model per session via a CTE-style join.
  //    Drizzle's `sql` template tag stays parameterized — userId is bound,
  //    not interpolated.
  const result = await tx.execute(sql`
    WITH session_model_cost AS (
      SELECT
        mb.user_id,
        mb.session_id,
        mb.model,
        mb.cost_usd::float8 AS model_cost
      FROM ${modelBreakdownAgg} mb
      WHERE mb.user_id = ${userId}
    ),
    session_dominant AS (
      SELECT DISTINCT ON (smc.session_id)
        smc.session_id,
        smc.model AS dominant_model
      FROM session_model_cost smc
      ORDER BY smc.session_id, smc.model_cost DESC
    )
    SELECT
      s.session_id            AS "sessionId",
      s.total_cost_usd::float8 AS "sumLocal",
      s.total_cost_usd_otel::float8 AS "sumOtel",
      sd.dominant_model       AS "dominantModel"
    FROM ${sessionsAgg} s
    LEFT JOIN session_dominant sd ON sd.session_id = s.session_id
    WHERE s.user_id = ${userId}
      AND s.total_cost_usd_otel IS NOT NULL
      AND s.total_cost_usd > 0
  `);

  // Drizzle's `execute` returns the underlying pg.QueryResult on node-postgres,
  // which exposes `.rows`. Some Drizzle versions return the array directly.
  const sessionRows: SessionRow[] = Array.isArray(result)
    ? (result as unknown as SessionRow[])
    : ((result as unknown as { rows: SessionRow[] }).rows ?? []);

  const buckets = new Map<CalibrationFamily, FamilyAggregate>();
  const bump = (family: CalibrationFamily, sumLocal: number, sumOtel: number): void => {
    const existing = buckets.get(family) ?? { sumOtel: 0, sumLocal: 0, sampleSessionCount: 0 };
    existing.sumOtel += sumOtel;
    existing.sumLocal += sumLocal;
    existing.sampleSessionCount += 1;
    buckets.set(family, existing);
  };

  for (const row of sessionRows) {
    const local = Number(row.sumLocal);
    const otel = Number(row.sumOtel);
    if (!Number.isFinite(local) || !Number.isFinite(otel) || local <= 0) continue;

    const family =
      row.dominantModel != null ? deriveModelFamily(row.dominantModel) : 'other';
    if (family === 'opus' || family === 'sonnet' || family === 'haiku') {
      bump(family, local, otel);
    }
    // Always contribute to global.
    bump('global', local, otel);
  }

  let familiesWritten = 0;
  let skippedOutOfBounds = 0;
  const now = new Date();

  for (const family of FAMILY_KEYS) {
    const agg = buckets.get(family);
    const hasSamples = agg !== undefined && agg.sampleSessionCount > 0 && agg.sumLocal > 0;
    if (!hasSamples) {
      // Clear any stale row.
      await tx
        .delete(costCalibrationPerUser)
        .where(
          and(
            eq(costCalibrationPerUser.userId, userId),
            eq(costCalibrationPerUser.family, family),
          ),
        );
      continue;
    }
    const rate = agg.sumOtel / agg.sumLocal;
    if (!isInBounds(rate)) {
      skippedOutOfBounds += 1;
      await tx
        .delete(costCalibrationPerUser)
        .where(
          and(
            eq(costCalibrationPerUser.userId, userId),
            eq(costCalibrationPerUser.family, family),
          ),
        );
      continue;
    }

    await tx
      .insert(costCalibrationPerUser)
      .values({
        userId,
        family,
        effectiveRate: rate.toString(),
        sampleSessionCount: agg.sampleSessionCount,
        sumOtelCost: agg.sumOtel.toString(),
        sumLocalCost: agg.sumLocal.toString(),
        lastUpdatedAt: now,
      })
      .onConflictDoUpdate({
        target: [costCalibrationPerUser.userId, costCalibrationPerUser.family],
        set: {
          effectiveRate: rate.toString(),
          sampleSessionCount: agg.sampleSessionCount,
          sumOtelCost: agg.sumOtel.toString(),
          sumLocalCost: agg.sumLocal.toString(),
          lastUpdatedAt: now,
        },
      });
    familiesWritten += 1;
  }

  return { familiesWritten, skippedOutOfBounds };
};
