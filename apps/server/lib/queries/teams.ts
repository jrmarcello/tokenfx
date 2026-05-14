/**
 * Team queries — REQ-21 (team detail) + REQ-26 anti-leaderboard rule.
 *
 * REQ-26 anti-leaderboard rule — members ALWAYS sorted alphabetically by
 * email; no spend-descending sort allowed on per-user data. The ORDER BY
 * `users.email ASC` clause is the code-level enforcement point, asserted
 * by the colocated test (TC-I-38) at the SQL source level. Any future
 * refactor that swaps it for a spend-ranked sort breaks the test loudly.
 *
 * Top-N project rankings (`topProjects`) ARE sorted by spend DESC — this
 * is allowed because a `project_slug` is a non-reversible HMAC-derived
 * token (see `lib/reporter/sanitizer.ts`), so a ranking exposes nothing
 * about the developer or the codebase content.
 *
 * Costs flow through the shared `effectiveCostForSession` cascade with
 * the per-user calibration map loaded once per query call (REQ-19). When
 * OTEL data is present on a session it wins; otherwise the user's family
 * rate is applied; otherwise the user's global rate; otherwise list price.
 *
 * NO drill-down: there is intentionally no `getSessionDetail` (or similar)
 * export — the central server stores aggregates only and the manager UI
 * has no per-session route. This is asserted in `teams.test.ts`.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  effectiveCostForSession,
  type Calibration,
  type CalibrationFamily,
} from '@root/analytics/cost-calibration';
import { hashEmail } from '@/lib/auth/email-hash';
import {
  costCalibrationPerUser,
  modelBreakdownAgg,
  sessionsAgg,
  teams,
  users,
} from '@/lib/db/schema';
import { extractExecRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

/**
 * `provisioned_via` is the schema-level CHECK enum on `user_machines`.
 * 'pre-v2-unknown' is the default for rows seeded before SSO auto-provision
 * landed (REQ-18). Members with NO `user_machines` row are surfaced under
 * this same value via COALESCE in the query — the manager UI cannot
 * distinguish "no creds yet" from "pre-v2 backfill" at this layer (the
 * spec considers both states "legacy / unknown").
 */
export type ProvisionedVia = 'manual-token' | 'sso-auto' | 'pre-v2-unknown';

/**
 * Filter accepted by `getTeamDetail()`. The caller (page-level Zod) is
 * expected to coerce invalid query-string values to `'all'` BEFORE
 * invoking this function — REQ-9 + Decisão #18. `'token'` maps to the
 * schema value `'manual-token'`; `'sso-auto'` matches the schema literal;
 * `'all'` skips the filter (surfaces `pre-v2-unknown` rows too).
 */
export type TeamMemberProvisionedViaFilter = 'all' | 'token' | 'sso-auto';

export type TeamMember = {
  userId: string;
  email: string;
  sessions30d: number;
  spend30d: number;
  /** Most-recent `user_machines.provisioned_via`; COALESCE to 'pre-v2-unknown'. */
  provisionedVia: ProvisionedVia;
  /** MAX(auth_event_log.occurred_at) for outcome='accepted-sso-auto'; null when never. */
  lastLoginAt: Date | null;
  /** `users.created_at` — exposed for REQ-10 roster CSV export (TASK-21). */
  createdAt: Date;
};

export type TeamSpendPoint = {
  date: string;
  spend: number;
};

export type TeamDauPoint = {
  date: string;
  activeUsers: number;
};

export type TeamTopProject = {
  projectSlug: string;
  spend30d: number;
};

export type TeamDetail = {
  teamId: string;
  teamName: string;
  spendTrend30d: TeamSpendPoint[];
  dau30d: TeamDauPoint[];
  /** ALWAYS sorted by email ASC (alphabetical) — REQ-26. */
  members: TeamMember[];
  /** Top 10, sorted by spend DESC. Slugs are non-reversible — REQ-21. */
  topProjects: TeamTopProject[];
};

type SessionRow = {
  userId: string;
  sessionId: string;
  startedAt: Date;
  totalCostUsd: string;
  totalCostUsdOtel: string | null;
  projectSlug: string;
  dominantModel: string | null;
};

const ROW_LIMIT_TOP_PROJECTS = 10;

/**
 * Build the per-user calibration map for the union of users in the team.
 * Returns one `Calibration` map per `user_id`. Empty map for users with
 * no calibration rows (cascade falls through to list price).
 */
const loadCalibrationsForUsers = async (
  db: Db,
  userIds: ReadonlyArray<string>,
): Promise<Map<string, Calibration>> => {
  const out = new Map<string, Calibration>();
  for (const id of userIds) out.set(id, new Map());

  if (userIds.length === 0) return out;

  const rows = await db
    .select()
    .from(costCalibrationPerUser)
    .where(inArray(costCalibrationPerUser.userId, userIds as string[]));

  for (const row of rows) {
    const cal = out.get(row.userId);
    if (!cal) continue;
    const family = row.family as CalibrationFamily;
    cal.set(family, {
      family,
      rate: Number(row.effectiveRate),
      sampleSessionCount: row.sampleSessionCount,
      sumOtelCost: Number(row.sumOtelCost),
      sumLocalCost: Number(row.sumLocalCost),
      lastUpdatedAt: row.lastUpdatedAt.getTime(),
    });
  }
  return out;
};

const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Team detail (REQ-21). Returns `null` when the team does not exist OR
 * belongs to a different org (tenant scoping — defense-in-depth even
 * though the route also guards by org).
 *
 * REQ-9: `options.provisionedVia` filters the member list by the
 * most-recent (by `user_machines.created_at`) `provisioned_via` value
 * per user. 'all' (default) surfaces every kind including
 * 'pre-v2-unknown' (the COALESCE fallback for users with no machine
 * row). 'token' maps to the schema literal 'manual-token'. The function
 * trusts its typed input — invalid query-string values must be coerced
 * by the page-level Zod schema before calling.
 *
 * `lastLoginAt` is derived via a single LATERAL JOIN against
 * `auth_event_log` keyed on peppered `email_hash` + outcome
 * 'accepted-sso-auto'. The pepper lives only in JS env, so we compute
 * each user's hash in-process and pass `(user_id, email_hash)` pairs
 * as a parameterized VALUES table — never inline SQL — preserving
 * prepared-statement discipline.
 */
export const getTeamDetail = async (
  db: Db,
  teamId: string,
  orgId: string,
  options?: { provisionedVia?: TeamMemberProvisionedViaFilter },
): Promise<TeamDetail | null> => {
  const filter: TeamMemberProvisionedViaFilter = options?.provisionedVia ?? 'all';

  // 1. Verify team belongs to org.
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)))
    .limit(1);
  if (teamRows.length === 0) return null;
  const team = teamRows[0];

  // 2. Members of the team — ALPHABETICAL by email (REQ-26 anti-leaderboard).
  //    DO NOT change this ORDER BY to anything spend-related.
  //    `createdAt` is selected for the REQ-10 roster CSV export (TASK-21).
  const memberRows = await db
    .select({ id: users.id, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.teamId, teamId))
    .orderBy(asc(users.email));

  if (memberRows.length === 0) {
    return {
      teamId: team.id,
      teamName: team.name,
      spendTrend30d: [],
      dau30d: [],
      members: [],
      topProjects: [],
    };
  }

  // 3. Per-user `provisioned_via` + `lastLoginAt`. Single query with:
  //      * `latest_machine` = DISTINCT ON (user_id) by created_at DESC.
  //      * LATERAL subquery against `auth_event_log` keyed by peppered
  //        email_hash — index `idx_auth_event_log_email_occurred` makes
  //        this an O(log n) seek per row, not a per-row scan.
  //    Output ordering is the alphabetical `user_hashes` driver, so the
  //    REQ-26 invariant is preserved. The filter is applied here
  //    (NOT post-hoc in JS) so the filtered-out users don't carry their
  //    sessions into the cost-aggregation loop below.
  const userHashRows = memberRows.map((m) => ({ id: m.id, hash: hashEmail(m.email) }));
  const valuesList = sql.join(
    userHashRows.map((r) => sql`(${r.id}::uuid, ${r.hash})`),
    sql`, `,
  );
  const filterClause =
    filter === 'sso-auto'
      ? sql`WHERE COALESCE(lm.provisioned_via, 'pre-v2-unknown') = 'sso-auto'`
      : filter === 'token'
        ? sql`WHERE COALESCE(lm.provisioned_via, 'pre-v2-unknown') = 'manual-token'`
        : sql``;

  const provisionResult = await db.execute<{
    userId: string;
    provisionedVia: ProvisionedVia;
    lastLoginAt: Date | null;
  }>(sql`
    WITH user_hashes(user_id, email_hash) AS (
      VALUES ${valuesList}
    ),
    latest_machine AS (
      SELECT DISTINCT ON (user_id) user_id, provisioned_via
      FROM user_machines
      WHERE user_id IN (
        SELECT user_id FROM user_hashes
      )
      ORDER BY user_id, created_at DESC
    )
    SELECT
      uh.user_id                                            AS "userId",
      COALESCE(lm.provisioned_via, 'pre-v2-unknown')        AS "provisionedVia",
      ll.last_at                                            AS "lastLoginAt"
    FROM user_hashes uh
    LEFT JOIN latest_machine lm ON lm.user_id = uh.user_id
    LEFT JOIN LATERAL (
      SELECT MAX(occurred_at) AS last_at
      FROM auth_event_log
      WHERE email_hash = uh.email_hash
        AND outcome = 'accepted-sso-auto'
    ) ll ON true
    ${filterClause}
  `);
  const provisionRows: ReadonlyArray<{
    userId: string;
    provisionedVia: ProvisionedVia;
    lastLoginAt: Date | null;
  }> = extractExecRows<{
    userId: string;
    provisionedVia: ProvisionedVia;
    lastLoginAt: Date | null;
  }>(provisionResult);

  // Index by userId for O(1) lookup when materializing the alphabetical
  // member list below. Users excluded by `filter` are simply absent from
  // this map and dropped from the final `members` array.
  const provisionByUserId = new Map<
    string,
    { provisionedVia: ProvisionedVia; lastLoginAt: Date | null }
  >();
  for (const row of provisionRows) {
    provisionByUserId.set(row.userId, {
      provisionedVia: row.provisionedVia,
      lastLoginAt:
        row.lastLoginAt == null
          ? null
          : row.lastLoginAt instanceof Date
            ? row.lastLoginAt
            : new Date(row.lastLoginAt),
    });
  }

  // Filtered member list (alphabetical preserved — REQ-26).
  const filteredMemberRows = memberRows.filter((m) => provisionByUserId.has(m.id));
  const memberIds = filteredMemberRows.map((m) => m.id);
  const calibrations = await loadCalibrationsForUsers(db, memberIds);

  if (memberIds.length === 0) {
    return {
      teamId: team.id,
      teamName: team.name,
      spendTrend30d: [],
      dau30d: [],
      members: [],
      topProjects: [],
    };
  }

  // 3. Pull last-30d sessions for these users with their dominant model
  //    (highest cost_usd row in model_breakdown_agg). Single CTE keeps the
  //    query plan tight — no N+1.
  //
  //    `idList` expands a JS array into a parenthesised list of bind
  //    placeholders for `IN (...)` — Drizzle binds JS arrays as records
  //    when interpolated directly, so `ANY($1::uuid[])` does not work.
  const idList = sql.join(
    memberIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<SessionRow>(sql`
    WITH session_dominant AS (
      SELECT DISTINCT ON (mb.user_id, mb.session_id)
        mb.user_id,
        mb.session_id,
        mb.model AS "dominantModel"
      FROM ${modelBreakdownAgg} mb
      WHERE mb.user_id IN (${idList})
      ORDER BY mb.user_id, mb.session_id, mb.cost_usd DESC
    )
    SELECT
      s.user_id           AS "userId",
      s.session_id        AS "sessionId",
      s.started_at        AS "startedAt",
      s.total_cost_usd    AS "totalCostUsd",
      s.total_cost_usd_otel AS "totalCostUsdOtel",
      s.project_slug      AS "projectSlug",
      sd."dominantModel"  AS "dominantModel"
    FROM ${sessionsAgg} s
    LEFT JOIN session_dominant sd
      ON sd.user_id = s.user_id AND sd.session_id = s.session_id
    WHERE s.user_id IN (${idList})
      AND s.started_at >= NOW() - INTERVAL '30 days'
  `);
  const sessionRows = extractExecRows<SessionRow>(result);

  // 4. Aggregate.
  const memberAgg = new Map<string, { sessions30d: number; spend30d: number }>();
  for (const id of memberIds) memberAgg.set(id, { sessions30d: 0, spend30d: 0 });

  const trendByDate = new Map<string, number>();
  const dauByDate = new Map<string, Set<string>>();
  const topProjectAgg = new Map<string, number>();

  for (const row of sessionRows) {
    const localCost = Number(row.totalCostUsd);
    const otelCost = row.totalCostUsdOtel == null ? null : Number(row.totalCostUsdOtel);
    if (!Number.isFinite(localCost) || localCost < 0) continue;

    const cal = calibrations.get(row.userId) ?? new Map();
    const eff = effectiveCostForSession({
      localCost,
      otelCost,
      model: row.dominantModel ?? '',
      calibration: cal,
    });
    const cost = eff.value;

    const m = memberAgg.get(row.userId);
    if (m) {
      m.sessions30d += 1;
      m.spend30d += cost;
    }

    const startedAt =
      row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt);
    const day = toIsoDate(startedAt);
    trendByDate.set(day, (trendByDate.get(day) ?? 0) + cost);

    const dauSet = dauByDate.get(day) ?? new Set<string>();
    dauSet.add(row.userId);
    dauByDate.set(day, dauSet);

    topProjectAgg.set(
      row.projectSlug,
      (topProjectAgg.get(row.projectSlug) ?? 0) + cost,
    );
  }

  // 5. Materialize in REQ-mandated orderings. The driver is
  //    `filteredMemberRows` (alphabetical, filter already applied — REQ-9
  //    + REQ-26). Each row's `provisionedVia` / `lastLoginAt` is looked
  //    up from the LATERAL-join map built in step 3 — guaranteed to be
  //    present because `provisionByUserId.has(m.id)` is the filter
  //    predicate.
  const members: TeamMember[] = filteredMemberRows.map((m) => {
    const agg = memberAgg.get(m.id) ?? { sessions30d: 0, spend30d: 0 };
    const prov = provisionByUserId.get(m.id);
    // Invariant: every `filteredMemberRows` entry has a `provisionByUserId`
    // mapping (the filter predicate ensures it). Falling back to
    // 'pre-v2-unknown' / null here defends against drift if the predicate
    // is ever weakened — and keeps `TeamMember` non-optional.
    return {
      userId: m.id,
      email: m.email,
      sessions30d: agg.sessions30d,
      spend30d: agg.spend30d,
      provisionedVia: prov?.provisionedVia ?? 'pre-v2-unknown',
      lastLoginAt: prov?.lastLoginAt ?? null,
      createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt),
    };
  });
  // filteredMemberRows preserves the alphabetical order of `memberRows`
  // (which is `ORDER BY users.email ASC`); `Array.filter` is order-stable.

  const spendTrend30d: TeamSpendPoint[] = Array.from(trendByDate.entries())
    .map(([date, spend]) => ({ date, spend }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const dau30d: TeamDauPoint[] = Array.from(dauByDate.entries())
    .map(([date, set]) => ({ date, activeUsers: set.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Project ranking allowed — slugs are non-reversible (REQ-21).
  const topProjects: TeamTopProject[] = Array.from(topProjectAgg.entries())
    .map(([projectSlug, spend30d]) => ({ projectSlug, spend30d }))
    .sort((a, b) => b.spend30d - a.spend30d)
    .slice(0, ROW_LIMIT_TOP_PROJECTS);

  return {
    teamId: team.id,
    teamName: team.name,
    spendTrend30d,
    dau30d,
    members,
    topProjects,
  };
};
