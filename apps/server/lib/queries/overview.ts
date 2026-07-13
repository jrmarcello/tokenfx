/**
 * Org-wide overview query for the manager dashboard (REQ-18, REQ-19, REQ-20).
 *
 * Selects raw session rows joined to users for the last 90 days, loads the
 * per-user calibration table once, then applies the cost cascade in JS via
 * the shared `effectiveCostForSession` helper from
 * `lib/analytics/cost-calibration.ts`. Aggregation (sum by window, by team,
 * distinct users for DAU/WAU/MAU) happens after JS calibration.
 *
 * Design rationale (LOCKED in spec self-review): the cost cascade has a
 * single source of truth — the pure JS helper. SQL `CASE` would diverge as
 * the cascade evolves (e.g. when MIN_RATE / MAX_RATE bounds change). Same
 * pattern as `lib/queries/effectiveness-v2.ts` (root) and the local-side
 * outcomes query.
 */
import { sql, eq } from 'drizzle-orm';
import {
  effectiveCostForSession,
  type Calibration,
  type CalibrationEntry,
  type CalibrationFamily,
  type CostSource,
} from '@tokenfx/shared/analytics/cost-calibration';
import {
  costCalibrationPerUser,
  sessionsAgg,
  teams,
  users,
} from '@/lib/db/schema';
import { extractExecRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

export type TeamRow = {
  teamId: string;
  teamName: string;
  spend30d: number;
  activeUsers7d: number;
  /** 7 daily values, oldest first; zero-padded for inactive days. */
  sparkline7d: number[];
};

export type OrgOverview = {
  /** Calibrated USD spend (cascade: otel → calibrated → list). */
  spend7d: number;
  spend30d: number;
  spend90d: number;
  /** Daily buckets across the last 30 days; only days with activity are present. */
  spendTrend30d: Array<{ date: string; spend: number }>;
  teamBreakdown: TeamRow[];
  /** Distinct users with ≥ 1 session in the last 1 / 7 / 30 day window. */
  dau: number;
  wau: number;
  mau: number;
  totalSeats: number;
  /** MAU / totalSeats. `0` when totalSeats is 0 (no NaN). */
  activationPct: number;
  /** Counts of sessions by cost source (after JS cascade). */
  sourceMix: { otel: number; calibrated: number; list: number };
};

type SessionRow = {
  userId: string;
  sessionId: string;
  startedAt: Date;
  totalCostUsd: string;
  totalCostUsdOtel: string | null;
  dominantModel: string | null;
  teamId: string | null;
  teamName: string | null;
};

const FAMILY_KEYS: ReadonlyArray<CalibrationFamily> = [
  'opus',
  'sonnet',
  'haiku',
  'global',
];

const isCalibrationFamily = (value: string): value is CalibrationFamily =>
  FAMILY_KEYS.includes(value as CalibrationFamily);

/**
 * Format a `Date` as `YYYY-MM-DD` in UTC. Used for daily trend bucket keys.
 * Centralising this keeps the test expectation (sum of trend points equals
 * the window total) trivially true regardless of the local timezone running
 * the test.
 */
const utcDateKey = (d: Date): string => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Build the seven UTC date keys, oldest-first, that compose the
 * `sparkline7d` array (today inclusive). Pre-computing this once per call
 * keeps the per-team loop O(sessions) rather than O(sessions * 7).
 */
const sparkline7dKeys = (now: Date): string[] => {
  const out: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    out.push(utcDateKey(d));
  }
  return out;
};

/**
 * Load every per-user calibration row for the org's users. We then bucket
 * them by `userId` so the per-row hot loop in `getOrgOverview` is a single
 * `Map.get` per session — no further DB round-trips.
 *
 * Drizzle's parameterized `sql` template tag binds `orgId` safely; the
 * subquery scopes the JOIN to one org so other tenants' calibration rows
 * never leave Postgres.
 */
const loadCalibrationByUser = async (
  db: Db,
  orgId: string,
): Promise<Map<string, Calibration>> => {
  const rows = await db
    .select({
      userId: costCalibrationPerUser.userId,
      family: costCalibrationPerUser.family,
      effectiveRate: costCalibrationPerUser.effectiveRate,
      sampleSessionCount: costCalibrationPerUser.sampleSessionCount,
      sumOtelCost: costCalibrationPerUser.sumOtelCost,
      sumLocalCost: costCalibrationPerUser.sumLocalCost,
      lastUpdatedAt: costCalibrationPerUser.lastUpdatedAt,
    })
    .from(costCalibrationPerUser)
    .innerJoin(users, eq(users.id, costCalibrationPerUser.userId))
    .where(eq(users.orgId, orgId));

  const out = new Map<string, Calibration>();
  for (const row of rows) {
    if (!isCalibrationFamily(row.family)) continue;
    const userMap: Calibration = out.get(row.userId) ?? new Map();
    const entry: CalibrationEntry = {
      family: row.family,
      rate: Number(row.effectiveRate),
      sampleSessionCount: row.sampleSessionCount,
      sumOtelCost: Number(row.sumOtelCost),
      sumLocalCost: Number(row.sumLocalCost),
      lastUpdatedAt: row.lastUpdatedAt.getTime(),
    };
    userMap.set(row.family, entry);
    out.set(row.userId, userMap);
  }
  return out;
};

/**
 * Org-global calibration is the union of all per-user rows, summed and
 * re-divided. This is the fallback used by `effectiveCostForSession` for
 * users who themselves have no calibration row (REQ-19). Computed in JS so
 * the rate aligns with the bounds-check in the helper (rather than letting
 * Postgres return a value the helper would then reject).
 */
const buildOrgGlobalCalibration = (
  byUser: Map<string, Calibration>,
): Calibration => {
  type Acc = { sumOtel: number; sumLocal: number; sample: number };
  const acc: Map<CalibrationFamily, Acc> = new Map();

  for (const userMap of byUser.values()) {
    for (const [family, entry] of userMap) {
      const a = acc.get(family) ?? { sumOtel: 0, sumLocal: 0, sample: 0 };
      a.sumOtel += entry.sumOtelCost;
      a.sumLocal += entry.sumLocalCost;
      a.sample += entry.sampleSessionCount;
      acc.set(family, a);
    }
  }

  const out: Calibration = new Map();
  const now = Date.now();
  for (const [family, a] of acc) {
    if (a.sumLocal <= 0) continue;
    const rate = a.sumOtel / a.sumLocal;
    out.set(family, {
      family,
      rate,
      sampleSessionCount: a.sample,
      sumOtelCost: a.sumOtel,
      sumLocalCost: a.sumLocal,
      lastUpdatedAt: now,
    });
  }
  return out;
};

/**
 * Aggregate the dominant model per session via a CTE and join the result to
 * the session row + the user's team. The dominant model is the row in
 * `model_breakdown_agg` with the largest `cost_usd` for that session — same
 * heuristic as the per-user calibration recompute (REQ-19).
 *
 * Drizzle's `sql` template binds `orgId` and the cutoff timestamp without
 * interpolating values into the SQL string.
 */
const loadSessionsForOrg = async (
  db: Db,
  orgId: string,
  cutoff: Date,
): Promise<SessionRow[]> => {
  const result = await db.execute(sql`
    WITH session_model_cost AS (
      SELECT
        mb.user_id,
        mb.session_id,
        mb.model,
        mb.cost_usd::float8 AS model_cost
      FROM model_breakdown_agg mb
    ),
    session_dominant AS (
      SELECT DISTINCT ON (smc.user_id, smc.session_id)
        smc.user_id,
        smc.session_id,
        smc.model AS dominant_model
      FROM session_model_cost smc
      ORDER BY smc.user_id, smc.session_id, smc.model_cost DESC
    )
    SELECT
      s.user_id                       AS "userId",
      s.session_id                    AS "sessionId",
      s.started_at                    AS "startedAt",
      s.total_cost_usd::text          AS "totalCostUsd",
      s.total_cost_usd_otel::text     AS "totalCostUsdOtel",
      sd.dominant_model               AS "dominantModel",
      u.team_id                       AS "teamId",
      t.name                          AS "teamName"
    FROM ${sessionsAgg} s
    INNER JOIN ${users} u ON u.id = s.user_id
    LEFT JOIN ${teams} t ON t.id = u.team_id
    LEFT JOIN session_dominant sd
           ON sd.user_id = s.user_id AND sd.session_id = s.session_id
    WHERE u.org_id = ${orgId}
      AND s.started_at >= ${cutoff}
  `);

  // Driver-shape unwrap is centralized in `extractExecRows` (TASK-C4).
  const raw = extractExecRows<Record<string, unknown>>(result);

  return raw.map((r) => ({
    userId: String(r.userId),
    sessionId: String(r.sessionId),
    startedAt: r.startedAt instanceof Date ? r.startedAt : new Date(String(r.startedAt)),
    totalCostUsd: r.totalCostUsd === null ? '0' : String(r.totalCostUsd),
    totalCostUsdOtel:
      r.totalCostUsdOtel === null || r.totalCostUsdOtel === undefined
        ? null
        : String(r.totalCostUsdOtel),
    dominantModel: r.dominantModel === null || r.dominantModel === undefined
      ? null
      : String(r.dominantModel),
    teamId: r.teamId === null || r.teamId === undefined ? null : String(r.teamId),
    teamName: r.teamName === null || r.teamName === undefined ? null : String(r.teamName),
  }));
};

/**
 * Org overview for the `/manager` dashboard.
 *
 *  1. SELECT raw session rows for the org over the last 90 days.
 *  2. Load `cost_calibration_per_user` for the org's users (one query).
 *  3. Apply `effectiveCostForSession` per row in JS (REQ-19 LOCKED).
 *  4. Aggregate windowed spend, daily trend, team breakdown, DAU/WAU/MAU,
 *     source mix.
 *  5. Total seats = `count(users)` for the org.
 */
export const getOrgOverview = async (
  db: Db,
  orgId: string,
): Promise<OrgOverview> => {
  const now = new Date();
  const day = 86_400_000;
  const cutoff90 = new Date(now.getTime() - 90 * day);
  const cutoff30 = new Date(now.getTime() - 30 * day);
  const cutoff7 = new Date(now.getTime() - 7 * day);
  const cutoff1 = new Date(now.getTime() - 1 * day);

  const [calibrationByUser, sessionRows, totalSeatsRes] = await Promise.all([
    loadCalibrationByUser(db, orgId),
    loadSessionsForOrg(db, orgId, cutoff90),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.orgId, orgId)),
  ]);
  const totalSeats = Number(totalSeatsRes[0]?.count ?? 0);
  const orgGlobalCal = buildOrgGlobalCalibration(calibrationByUser);

  // Aggregation accumulators.
  let spend7d = 0;
  let spend30d = 0;
  let spend90d = 0;
  const trendBuckets: Map<string, number> = new Map();
  type TeamAcc = {
    teamId: string;
    teamName: string;
    spend30d: number;
    activeUsers7d: Set<string>;
    sparklineByDay: Map<string, number>;
  };
  const teamAcc: Map<string, TeamAcc> = new Map();
  const sparkKeys = sparkline7dKeys(now);
  const sparkKeySet = new Set(sparkKeys);
  const dauSet = new Set<string>();
  const wauSet = new Set<string>();
  const mauSet = new Set<string>();
  const sourceMix: { otel: number; calibrated: number; list: number } = {
    otel: 0,
    calibrated: 0,
    list: 0,
  };

  for (const row of sessionRows) {
    const localCost = Number(row.totalCostUsd);
    const otelCost = row.totalCostUsdOtel === null ? null : Number(row.totalCostUsdOtel);
    if (!Number.isFinite(localCost)) continue;

    const userCal: Calibration =
      calibrationByUser.get(row.userId) ?? orgGlobalCal;
    const result = effectiveCostForSession({
      localCost,
      otelCost,
      model: row.dominantModel ?? 'unknown',
      calibration: userCal,
    });
    const cost = result.value;
    bumpSourceMix(sourceMix, result.source);

    // Window aggregations (cumulative — 90 includes 30 includes 7).
    spend90d += cost;
    if (row.startedAt >= cutoff30) {
      spend30d += cost;
      const key = utcDateKey(row.startedAt);
      trendBuckets.set(key, (trendBuckets.get(key) ?? 0) + cost);
    }
    if (row.startedAt >= cutoff7) spend7d += cost;
    if (row.startedAt >= cutoff30) mauSet.add(row.userId);
    if (row.startedAt >= cutoff7) wauSet.add(row.userId);
    if (row.startedAt >= cutoff1) dauSet.add(row.userId);

    // Team aggregation (only when the user has a team — null teamId means
    // "no team yet"; sessions still count toward org-wide totals but not the
    // breakdown row).
    if (row.teamId && row.teamName !== null) {
      const acc = teamAcc.get(row.teamId) ?? {
        teamId: row.teamId,
        teamName: row.teamName,
        spend30d: 0,
        activeUsers7d: new Set<string>(),
        sparklineByDay: new Map<string, number>(),
      };
      if (row.startedAt >= cutoff30) acc.spend30d += cost;
      if (row.startedAt >= cutoff7) acc.activeUsers7d.add(row.userId);
      const dayKey = utcDateKey(row.startedAt);
      if (sparkKeySet.has(dayKey)) {
        acc.sparklineByDay.set(dayKey, (acc.sparklineByDay.get(dayKey) ?? 0) + cost);
      }
      teamAcc.set(row.teamId, acc);
    }
  }

  // Trend: emit days in chronological order (only days with activity).
  const spendTrend30d = Array.from(trendBuckets.entries())
    .map(([date, spend]) => ({ date, spend }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Team breakdown: alphabetical by team name (REQ-18 doesn't mandate
  // ranking; spec REQ-21 explicitly forbids ranking by spend on the team
  // page, so apply the same convention here).
  const teamBreakdown: TeamRow[] = Array.from(teamAcc.values())
    .map((acc) => ({
      teamId: acc.teamId,
      teamName: acc.teamName,
      spend30d: acc.spend30d,
      activeUsers7d: acc.activeUsers7d.size,
      sparkline7d: sparkKeys.map((k) => acc.sparklineByDay.get(k) ?? 0),
    }))
    .sort((a, b) => a.teamName.localeCompare(b.teamName));

  const activationPct = totalSeats > 0 ? mauSet.size / totalSeats : 0;

  return {
    spend7d,
    spend30d,
    spend90d,
    spendTrend30d,
    teamBreakdown,
    dau: dauSet.size,
    wau: wauSet.size,
    mau: mauSet.size,
    totalSeats,
    activationPct,
    sourceMix,
  };
};

const bumpSourceMix = (
  mix: { otel: number; calibrated: number; list: number },
  source: CostSource,
): void => {
  if (source === 'otel') mix.otel += 1;
  else if (source === 'calibrated') mix.calibrated += 1;
  else mix.list += 1;
};
