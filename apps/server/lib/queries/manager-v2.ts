/**
 * Team-aggregated queries for the manager-dashboard-v2 spec.
 *
 * Surface area:
 *  - REQ-1  → `getTeamCacheHitTrend`
 *  - REQ-2  → `getTeamGoodSessionPct`
 *  - REQ-3  → `getTeamToolMix30d` (live aggregation from `tool_count_agg`)
 *  - REQ-4  → `getTeamSubagentAdoption` (sessions where `subagent_usage_ratio > 0`)
 *  - REQ-6  → `getRadarComparison` (5 normalized axes; null when < 2 teams)
 *  - REQ-10 → `getCheckInOpportunities` (spike OR WoW; dismissed-aware)
 *  - REQ-12 → `getDropOffCandidates` (>50% WoW drop, prior-week active)
 *  - REQ-13 → `getKnowledgeSharingOpportunities` (top vs median + bottom)
 *  - REQ-18 → `getTeamMembersForManager` (alphabetical via COALESCE)
 *
 * Every query is **org-scoped** (defense-in-depth — the route layer also
 * checks). Every value is **parameter-bound** through Drizzle's `sql` template
 * tag or the `db.select()` query builder — REQ-19 forbids string-interpolated
 * SQL containing `org_id`, `team_id`, or `user_id`.
 *
 * REQ-18 anti-leaderboard rule: per-user lists are ALWAYS ordered by
 * `COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC`.
 * Spend / tokens / sessions sort orders are intentionally absent and will
 * fail TC-I-33's source-level grep if reintroduced.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  managerDismissedAnomalies,
  sessionsAgg,
  teamMetricsDaily,
  teams,
  toolCountAgg,
  users,
} from '@/lib/db/schema';
import {
  bucketizeToolMix,
  TOOL_BUCKETS,
  type ToolBucket,
} from '@/lib/analytics/tool-mix';
import {
  detectDropOff,
  detectKnowledgeSharingOpportunity,
  detectSpike,
  detectWowSpike,
} from '@/lib/analytics/anomaly-detection';
import {
  normalizeRadarMetrics,
  type NormalizedRadarTeam,
} from '@/lib/analytics/radar-normalize';
import { displayLabelFor } from '@/lib/util/user-display';
import { extractExecRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// REQ-1 — getTeamCacheHitTrend
// ---------------------------------------------------------------------------

export type TeamCacheHitTrendPoint = {
  day: string;
  cacheHitRatio: number | null;
};

/**
 * Daily team-average `cache_hit_ratio_avg` across the last `days` days.
 * Reads from the rollup table populated by `cron/manager-v2/aggregate-team-metrics`.
 * Returns up to `days` rows ordered by day ASC. Days with no rollup are absent
 * (caller is expected to zero-pad if a fixed-length series is required).
 */
export const getTeamCacheHitTrend = async (
  db: Db,
  params: { orgId: string; teamId: string; days: number },
): Promise<TeamCacheHitTrendPoint[]> => {
  const { orgId, teamId, days } = params;
  const rows = await db
    .select({
      day: teamMetricsDaily.day,
      cacheHitRatioAvg: teamMetricsDaily.cacheHitRatioAvg,
    })
    .from(teamMetricsDaily)
    .where(
      and(
        eq(teamMetricsDaily.orgId, orgId),
        eq(teamMetricsDaily.teamId, teamId),
        sql`${teamMetricsDaily.day} >= (CURRENT_DATE - (${days}::int - 1))`,
      ),
    )
    .orderBy(sql`${teamMetricsDaily.day} ASC`);

  return rows.map((r) => ({
    day: r.day,
    cacheHitRatio: r.cacheHitRatioAvg === null ? null : Number(r.cacheHitRatioAvg),
  }));
};

// ---------------------------------------------------------------------------
// REQ-2 — getTeamGoodSessionPct
// ---------------------------------------------------------------------------

export type TeamGoodSessionPct = {
  pct: number;
  trend: { day: string; pct: number | null }[];
};

/**
 * Team-level `% good sessions` over the last `days` days.
 *
 * `good_session_pct` is precomputed by the 15-min cron (it embeds the
 * threshold + manual-rating override gates from REQ-2). The single-number
 * aggregate is a session-weighted mean of the daily rollup rows so it stays
 * mathematically equal to (#good sessions / #total sessions) * 100 even if
 * daily session counts are wildly uneven.
 */
export const getTeamGoodSessionPct = async (
  db: Db,
  params: { orgId: string; teamId: string; days: number },
): Promise<TeamGoodSessionPct> => {
  const { orgId, teamId, days } = params;
  const rows = await db
    .select({
      day: teamMetricsDaily.day,
      goodSessionPct: teamMetricsDaily.goodSessionPct,
      totalSessions: teamMetricsDaily.totalSessions,
    })
    .from(teamMetricsDaily)
    .where(
      and(
        eq(teamMetricsDaily.orgId, orgId),
        eq(teamMetricsDaily.teamId, teamId),
        sql`${teamMetricsDaily.day} >= (CURRENT_DATE - (${days}::int - 1))`,
      ),
    )
    .orderBy(sql`${teamMetricsDaily.day} ASC`);

  let weighted = 0;
  let totalSessions = 0;
  const trend: { day: string; pct: number | null }[] = [];
  for (const r of rows) {
    const pct = r.goodSessionPct === null ? null : Number(r.goodSessionPct);
    trend.push({ day: r.day, pct });
    if (pct === null) continue;
    weighted += pct * r.totalSessions;
    totalSessions += r.totalSessions;
  }
  const pct = totalSessions === 0 ? 0 : weighted / totalSessions;
  return { pct, trend };
};

// ---------------------------------------------------------------------------
// REQ-2 (composite KPI) — getTeamCompositeTrend
// ---------------------------------------------------------------------------

export type TeamCompositePoint = {
  day: string;
  compositeAvg: number | null;
};

/**
 * Composite-score average trend for a single team over the last `days` days.
 * Reads `team_metrics_daily.composite_avg` (populated by the 15-min cron).
 *
 * The org-level effectiveness page fans this out across all teams in the
 * org and takes the simple mean for the org-wide composite KPI; the
 * team-effectiveness deep-dive uses the same query for the per-team value.
 */
export const getTeamCompositeTrend = async (
  db: Db,
  params: { orgId: string; teamId: string; days: number },
): Promise<TeamCompositePoint[]> => {
  const { orgId, teamId, days } = params;
  const rows = await db
    .select({
      day: teamMetricsDaily.day,
      compositeAvg: teamMetricsDaily.compositeAvg,
    })
    .from(teamMetricsDaily)
    .where(
      and(
        eq(teamMetricsDaily.orgId, orgId),
        eq(teamMetricsDaily.teamId, teamId),
        sql`${teamMetricsDaily.day} >= (CURRENT_DATE - (${days}::int - 1))`,
      ),
    )
    .orderBy(sql`${teamMetricsDaily.day} ASC`);
  return rows.map((r) => ({
    day: r.day,
    compositeAvg: r.compositeAvg === null ? null : Number(r.compositeAvg),
  }));
};

// ---------------------------------------------------------------------------
// REQ-3 — getTeamToolMix30d
// ---------------------------------------------------------------------------

export type TeamToolMixPoint = {
  day: string;
  Edit: number;
  Read: number;
  Bash: number;
  Agent: number;
  Other: number;
};

/**
 * Live tool-mix aggregation over the last 30 days for a single team.
 *
 * Joins:
 *   tool_count_agg   — per-(user, session, tool_name) counts
 *   sessions_agg     — per-session metadata (started_at)
 *   users            — for `team_id` + `org_id` filtering
 *
 * Buckets per-day per-tool counts via `bucketizeToolMix` so legacy `Task` and
 * current `Agent` collapse to the same `Agent` bucket (REQ-3).
 *
 * Days with zero sessions for the team produce no row.
 */
export const getTeamToolMix30d = async (
  db: Db,
  params: { orgId: string; teamId: string },
): Promise<TeamToolMixPoint[]> => {
  const { orgId, teamId } = params;

  type Row = {
    day: string;
    toolName: string;
    cnt: number;
  };

  const result = await db.execute<Row>(sql`
    SELECT
      to_char(date_trunc('day', s.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
      tc.tool_name AS "toolName",
      SUM(tc.count)::int AS "cnt"
    FROM ${toolCountAgg} tc
    INNER JOIN ${sessionsAgg} s
       ON s.user_id = tc.user_id
      AND s.session_id = tc.session_id
    INNER JOIN ${users} u
       ON u.id = tc.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id = ${teamId}
      AND s.started_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1, 2
    ORDER BY 1 ASC
  `);

  const raw = extractExecRows<Row>(result);

  // Bucket per-day. Each day's accumulator starts as all-zero (the 5 closed
  // enum keys) so the chart layer never sees a missing key.
  const byDay = new Map<string, Record<ToolBucket, number>>();
  for (const r of raw) {
    const acc = byDay.get(r.day) ?? {
      Edit: 0,
      Read: 0,
      Bash: 0,
      Agent: 0,
      Other: 0,
    };
    // bucketizeToolMix takes a list of names; we already have a per-name count
    // so we expand the name `cnt` times — semantically equivalent and keeps the
    // bucket mapping centralized in one helper.
    const bucketed = bucketizeToolMix(
      Array.from({ length: r.cnt }, () => r.toolName),
    );
    for (const b of TOOL_BUCKETS) acc[b] += bucketed[b];
    byDay.set(r.day, acc);
  }

  return Array.from(byDay.entries())
    .map(([day, acc]) => ({ day, ...acc }))
    .sort((a, b) => a.day.localeCompare(b.day));
};

// ---------------------------------------------------------------------------
// REQ-4 — getTeamSubagentAdoption
// ---------------------------------------------------------------------------

export type TeamSubagentAdoption = {
  pct: number;
  trend: { day: string; pct: number | null }[];
};

/**
 * `% sessions with subagent_usage_ratio > 0` for the team across the window.
 *
 * Schema note: `sessions_agg.subagent_usage_ratio` is a NUMERIC(4,3) 0..1
 * **ratio** computed by the reporter — NOT a count. The metric is therefore
 * `COUNT(*) FILTER (WHERE subagent_usage_ratio > 0) / COUNT(*) * 100`. The
 * comparison is **strict `> 0`** so that `0.000` does NOT count and `0.001`
 * does (TC-I-12b boundary lock).
 */
export const getTeamSubagentAdoption = async (
  db: Db,
  params: { orgId: string; teamId: string; days: number },
): Promise<TeamSubagentAdoption> => {
  const { orgId, teamId, days } = params;

  type Row = { day: string; pct: number | null };

  const result = await db.execute<Row>(sql`
    SELECT
      to_char(date_trunc('day', s.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "day",
      CASE WHEN COUNT(*) = 0 THEN NULL
           ELSE (
             COUNT(*) FILTER (WHERE s.subagent_usage_ratio > 0)::float8
             / COUNT(*)::float8
           ) * 100
      END AS "pct"
    FROM ${sessionsAgg} s
    INNER JOIN ${users} u ON u.id = s.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id = ${teamId}
      AND s.started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  const raw = extractExecRows<Row>(result);

  // Aggregate single-number from the underlying sessions, NOT from the daily
  // rollup, to avoid Simpson's-paradox-style mis-weighting on uneven days.
  const totalsResult = await db.execute<{ total: number; withSubagent: number }>(sql`
    SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE s.subagent_usage_ratio > 0)::int AS "withSubagent"
    FROM ${sessionsAgg} s
    INNER JOIN ${users} u ON u.id = s.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id = ${teamId}
      AND s.started_at >= NOW() - (${days}::int * INTERVAL '1 day')
  `);
  const totalsRows = extractExecRows<{ total: number; withSubagent: number }>(
    totalsResult,
  );
  const totalsRow = totalsRows[0] ?? { total: 0, withSubagent: 0 };
  const total = Number(totalsRow.total ?? 0);
  const withSubagent = Number(totalsRow.withSubagent ?? 0);
  const pct = total === 0 ? 0 : (withSubagent / total) * 100;

  return {
    pct,
    trend: raw.map((r) => ({
      day: r.day,
      pct: r.pct === null || r.pct === undefined ? null : Number(r.pct),
    })),
  };
};

// ---------------------------------------------------------------------------
// REQ-6 — getRadarComparison
// ---------------------------------------------------------------------------

/**
 * Five-axis radar comparison across the manager's teams. Returns null when
 * fewer than 2 teams are passed in (Q13 lock — the radar is hidden for a
 * single-team manager). For each axis the values are min-max normalized
 * across the input team set so the polygon shows **relative** standing —
 * the absolute scale is intentionally hidden in the surveillance trade-off.
 *
 * Axes (REQ-6):
 *   - cacheHit            — `cache_hit_ratio_avg` 30d mean from team_metrics_daily
 *   - goodSessionPct      — session-weighted mean of `good_session_pct`
 *   - subagentAdoptionPct — % sessions with `subagent_usage_ratio > 0` 30d
 *   - editToolShare       — Edit count / total tool count 30d
 *   - readToolShare       — Read count / total tool count 30d
 */
export const getRadarComparison = async (
  db: Db,
  params: { orgId: string; teamIds: string[] },
): Promise<NormalizedRadarTeam[] | null> => {
  const { orgId, teamIds } = params;

  // Q13 lock: radar hidden when < 2 teams. Returning null short-circuits the
  // UI; we also guard the SQL so empty arrays don't generate `IN ()`.
  if (teamIds.length < 2) return null;

  // 30-day window; align with REQ-6 (no `days` knob — radar is fixed window).
  const days = 30;

  type RollupRow = {
    teamId: string;
    cacheHitMean: number | null;
    goodSessionMean: number | null;
    totalSessions: number;
  };
  const rollupResult = await db.execute<RollupRow>(sql`
    SELECT
      tmd.team_id::text AS "teamId",
      AVG(tmd.cache_hit_ratio_avg)::float8 AS "cacheHitMean",
      CASE WHEN SUM(tmd.total_sessions) = 0 THEN NULL
           ELSE (
             SUM(tmd.good_session_pct * tmd.total_sessions)::float8
             / NULLIF(SUM(tmd.total_sessions), 0)::float8
           )
      END AS "goodSessionMean",
      COALESCE(SUM(tmd.total_sessions), 0)::int AS "totalSessions"
    FROM ${teamMetricsDaily} tmd
    WHERE tmd.org_id = ${orgId}
      AND tmd.team_id IN (${sql.join(
        teamIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND tmd.day >= (CURRENT_DATE - (${days}::int - 1))
    GROUP BY tmd.team_id
  `);
  const rollupRows = extractExecRows<RollupRow>(rollupResult);

  type SubagentRow = {
    teamId: string;
    pct: number | null;
  };
  const subagentResult = await db.execute<SubagentRow>(sql`
    SELECT
      u.team_id::text AS "teamId",
      CASE WHEN COUNT(*) = 0 THEN NULL
           ELSE (
             COUNT(*) FILTER (WHERE s.subagent_usage_ratio > 0)::float8
             / COUNT(*)::float8
           ) * 100
      END AS "pct"
    FROM ${sessionsAgg} s
    INNER JOIN ${users} u ON u.id = s.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id IN (${sql.join(
        teamIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND s.started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY u.team_id
  `);
  const subagentRows = extractExecRows<SubagentRow>(subagentResult);

  type ToolShareRow = {
    teamId: string;
    editCount: number;
    readCount: number;
    totalCount: number;
  };
  const toolShareResult = await db.execute<ToolShareRow>(sql`
    SELECT
      u.team_id::text AS "teamId",
      COALESCE(SUM(CASE WHEN tc.tool_name = 'Edit' THEN tc.count ELSE 0 END), 0)::int AS "editCount",
      COALESCE(SUM(CASE WHEN tc.tool_name = 'Read' THEN tc.count ELSE 0 END), 0)::int AS "readCount",
      COALESCE(SUM(tc.count), 0)::int AS "totalCount"
    FROM ${toolCountAgg} tc
    INNER JOIN ${sessionsAgg} s
       ON s.user_id = tc.user_id AND s.session_id = tc.session_id
    INNER JOIN ${users} u ON u.id = tc.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id IN (${sql.join(
        teamIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND s.started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY u.team_id
  `);
  const toolShareRows = extractExecRows<ToolShareRow>(toolShareResult);

  const rollupByTeam = new Map(rollupRows.map((r) => [r.teamId, r]));
  const subagentByTeam = new Map(subagentRows.map((r) => [r.teamId, r]));
  const toolShareByTeam = new Map(toolShareRows.map((r) => [r.teamId, r]));

  // Build the absolute-value rows in the order of the input teamIds (the
  // caller controls polygon order; preserving it keeps the chart legend
  // matching the manager's selection).
  const teamsForRadar = teamIds.map((teamId) => {
    const rollup = rollupByTeam.get(teamId);
    const sub = subagentByTeam.get(teamId);
    const ts = toolShareByTeam.get(teamId);
    const total = ts?.totalCount ?? 0;
    return {
      teamId,
      cacheHit: rollup?.cacheHitMean === null || rollup?.cacheHitMean === undefined
        ? 0
        : Number(rollup.cacheHitMean),
      goodSessionPct:
        rollup?.goodSessionMean === null || rollup?.goodSessionMean === undefined
          ? 0
          : Number(rollup.goodSessionMean),
      subagentAdoptionPct:
        sub?.pct === null || sub?.pct === undefined ? 0 : Number(sub.pct),
      editToolShare: total === 0 ? 0 : Number(ts?.editCount ?? 0) / total,
      readToolShare: total === 0 ? 0 : Number(ts?.readCount ?? 0) / total,
    };
  });

  return normalizeRadarMetrics({ teams: teamsForRadar });
};

// ---------------------------------------------------------------------------
// REQ-10 — getCheckInOpportunities
// REQ-12 — getDropOffCandidates
// ---------------------------------------------------------------------------

export type CheckInOpportunity = {
  targetUserId: string;
  displayLabel: string;
  email: string;
  teamId: string;
  teamName: string;
  trigger: 'spend-spike-30d' | 'spend-spike-wow';
  triggerDescription: string;
};

export type DropOffCandidate = {
  targetUserId: string;
  displayLabel: string;
  email: string;
  teamId: string;
  teamName: string;
  dropPct: number;
  triggerDescription: string;
};

type ManagerTeamRow = { teamId: string; teamName: string; orgId: string };

/**
 * Fetch every team in the manager's org.
 *
 * Spec lock (line 14): a `manager`-role user manages their **entire org** —
 * every team in their `org_id`. The earlier MVP that scoped a manager to
 * their own `team_id` was reverted in Pause-2 self-review (security M3) —
 * it caused `/manager/health` to silently miss devs on sister teams while
 * `/manager/effectiveness` correctly fanned out org-wide, producing an
 * inconsistent surface.
 *
 * The `managerId` argument is retained for forward-compat (e.g. eventual
 * per-manager scoping or audit logs) but does not currently influence the
 * result — gating happens at the layout role check.
 */
const loadManagerTeams = async (
  db: Db,
  _managerId: string,
  orgId: string,
): Promise<ManagerTeamRow[]> => {
  const rows = await db
    .select({
      teamId: teams.id,
      teamName: teams.name,
      orgId: teams.orgId,
    })
    .from(teams)
    .where(eq(teams.orgId, orgId));
  return rows.map((r) => ({ teamId: r.teamId, teamName: r.teamName, orgId: r.orgId }));
};

const loadActiveDismissals = async (
  db: Db,
  managerId: string,
  orgId: string,
): Promise<Set<string>> => {
  const rows = await db
    .select({
      targetUserId: managerDismissedAnomalies.targetUserId,
      kind: managerDismissedAnomalies.kind,
    })
    .from(managerDismissedAnomalies)
    .where(
      and(
        eq(managerDismissedAnomalies.orgId, orgId),
        eq(managerDismissedAnomalies.managerUserId, managerId),
        sql`${managerDismissedAnomalies.dismissedUntil} > NOW()`,
      ),
    );
  const out = new Set<string>();
  for (const r of rows) out.add(`${r.targetUserId}:${r.kind}`);
  return out;
};

/**
 * Returns devs in any of the manager's teams flagged by EITHER:
 *   - 30d spend ≥ 3σ above team mean (`detectSpike`), OR
 *   - WoW spike > +50% (`detectWowSpike`).
 *
 * Dismissed anomalies (manager-specific, 7-day TTL via
 * `manager_dismissed_anomalies`) are filtered out.
 *
 * REQ-18: result ordered alphabetically by `displayLabelFor(user)` —
 * NEVER by spend / sigma / any usage metric.
 */
export const getCheckInOpportunities = async (
  db: Db,
  params: { managerId: string; orgId: string },
): Promise<CheckInOpportunity[]> => {
  const { managerId, orgId } = params;

  const managerTeams = await loadManagerTeams(db, managerId, orgId);
  if (managerTeams.length === 0) return [];
  const teamIds = managerTeams.map((t) => t.teamId);
  const teamNameById = new Map(managerTeams.map((t) => [t.teamId, t.teamName]));

  const dismissed = await loadActiveDismissals(db, managerId, orgId);

  // Per-dev: 30d spend, prior-week spend, this-week spend, plus team mean/std.
  type Row = {
    userId: string;
    teamId: string;
    email: string;
    displayName: string | null;
    spend30d: number;
    spendThisWeek: number;
    spendLastWeek: number;
    teamMean: number;
    teamStdDev: number;
  };

  const result = await db.execute<Row>(sql`
    WITH per_dev AS (
      SELECT
        u.id AS user_id,
        u.team_id,
        u.email,
        u.display_name,
        COALESCE(SUM(CASE WHEN s.started_at >= NOW() - INTERVAL '30 days'
                          THEN s.total_cost_usd::float8 ELSE 0 END), 0) AS spend30d,
        COALESCE(SUM(CASE WHEN s.started_at >= NOW() - INTERVAL '7 days'
                          THEN s.total_cost_usd::float8 ELSE 0 END), 0) AS spend_this_week,
        COALESCE(SUM(CASE WHEN s.started_at >= NOW() - INTERVAL '14 days'
                          AND s.started_at < NOW() - INTERVAL '7 days'
                          THEN s.total_cost_usd::float8 ELSE 0 END), 0) AS spend_last_week
      FROM ${users} u
      LEFT JOIN ${sessionsAgg} s ON s.user_id = u.id
      WHERE u.org_id = ${orgId}
        AND u.team_id IN (${sql.join(
          teamIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY u.id, u.team_id, u.email, u.display_name
    ),
    team_stats AS (
      SELECT
        team_id,
        AVG(spend30d) AS team_mean,
        COALESCE(stddev_pop(spend30d), 0) AS team_std_dev
      FROM per_dev
      GROUP BY team_id
    )
    SELECT
      pd.user_id::text       AS "userId",
      pd.team_id::text       AS "teamId",
      pd.email               AS "email",
      pd.display_name        AS "displayName",
      pd.spend30d::float8    AS "spend30d",
      pd.spend_this_week::float8 AS "spendThisWeek",
      pd.spend_last_week::float8 AS "spendLastWeek",
      ts.team_mean::float8   AS "teamMean",
      ts.team_std_dev::float8 AS "teamStdDev"
    FROM per_dev pd
    INNER JOIN team_stats ts ON ts.team_id = pd.team_id
  `);

  const rows = extractExecRows<Row>(result);

  const flagged: CheckInOpportunity[] = [];
  for (const r of rows) {
    const spend30d = Number(r.spend30d);
    const teamMean = Number(r.teamMean);
    const teamStdDev = Number(r.teamStdDev);
    const thisWeek = Number(r.spendThisWeek);
    const lastWeek = Number(r.spendLastWeek);

    const spike = detectSpike({ thirtyDaySpend: spend30d, teamMean, teamStdDev });
    const wow = detectWowSpike({ thisWeek, lastWeek });

    if (!spike && !wow) continue;

    const trigger: 'spend-spike-30d' | 'spend-spike-wow' = spike
      ? 'spend-spike-30d'
      : 'spend-spike-wow';

    if (dismissed.has(`${r.userId}:${trigger}`)) continue;

    const teamName = teamNameById.get(r.teamId);
    if (!teamName) continue;

    const triggerDescription = spike
      ? `30d spend ${(teamStdDev > 0 ? (spend30d - teamMean) / teamStdDev : 0).toFixed(1)}σ above team avg`
      : `spend up ${lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0}% WoW`;

    flagged.push({
      targetUserId: r.userId,
      displayLabel: displayLabelFor({ display_name: r.displayName, email: r.email }),
      email: r.email,
      teamId: r.teamId,
      teamName,
      trigger,
      triggerDescription,
    });
  }

  // REQ-18: alphabetical by displayLabelFor — NEVER by spend.
  flagged.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  return flagged;
};

/**
 * Returns devs whose week-over-week active-days OR session count dropped
 * > 50% AND who were active in the prior week. Dismissed anomalies are
 * filtered out. REQ-18 ordering applied.
 */
export const getDropOffCandidates = async (
  db: Db,
  params: { managerId: string; orgId: string },
): Promise<DropOffCandidate[]> => {
  const { managerId, orgId } = params;

  const managerTeams = await loadManagerTeams(db, managerId, orgId);
  if (managerTeams.length === 0) return [];
  const teamIds = managerTeams.map((t) => t.teamId);
  const teamNameById = new Map(managerTeams.map((t) => [t.teamId, t.teamName]));

  const dismissed = await loadActiveDismissals(db, managerId, orgId);

  type Row = {
    userId: string;
    teamId: string;
    email: string;
    displayName: string | null;
    sessionsThisWeek: number;
    sessionsLastWeek: number;
  };

  const result = await db.execute<Row>(sql`
    SELECT
      u.id::text AS "userId",
      u.team_id::text AS "teamId",
      u.email AS "email",
      u.display_name AS "displayName",
      COUNT(*) FILTER (WHERE s.started_at >= NOW() - INTERVAL '7 days')::int AS "sessionsThisWeek",
      COUNT(*) FILTER (WHERE s.started_at >= NOW() - INTERVAL '14 days'
                       AND s.started_at < NOW() - INTERVAL '7 days')::int AS "sessionsLastWeek"
    FROM ${users} u
    LEFT JOIN ${sessionsAgg} s ON s.user_id = u.id
    WHERE u.org_id = ${orgId}
      AND u.team_id IN (${sql.join(
        teamIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    GROUP BY u.id, u.team_id, u.email, u.display_name
  `);

  const rows = extractExecRows<Row>(result);

  const flagged: DropOffCandidate[] = [];
  for (const r of rows) {
    const thisWeek = Number(r.sessionsThisWeek);
    const lastWeek = Number(r.sessionsLastWeek);
    const dropped = detectDropOff({ thisWeek, lastWeek });
    if (!dropped) continue;

    if (dismissed.has(`${r.userId}:dropoff-wow`)) continue;

    const teamName = teamNameById.get(r.teamId);
    if (!teamName) continue;

    const dropPct = lastWeek > 0 ? ((lastWeek - thisWeek) / lastWeek) * 100 : 0;
    flagged.push({
      targetUserId: r.userId,
      displayLabel: displayLabelFor({ display_name: r.displayName, email: r.email }),
      email: r.email,
      teamId: r.teamId,
      teamName,
      dropPct,
      triggerDescription: `usage down ${Math.round(dropPct)}% week-over-week`,
    });
  }

  flagged.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  return flagged;
};

// ---------------------------------------------------------------------------
// REQ-13 — getKnowledgeSharingOpportunities
// ---------------------------------------------------------------------------

export type KnowledgeSharingRow = {
  feature: string;
  topTeamId: string;
  topTeamName: string;
  bottomTeamId: string;
  bottomTeamName: string;
  ratio: number;
  copy: string;
};

/**
 * Detects "team X uses {feature} ≥ 2× median AND ≥ 4× lowest non-zero" rows
 * across the manager's teams. Currently scans:
 *   - subagent adoption (`subagent_usage_ratio > 0` rate per team)
 *   - top tool buckets (Edit, Read, Bash, Agent shares per team)
 *
 * Pure JS gate after pulling per-team usage — keeps the threshold logic in
 * `detectKnowledgeSharingOpportunity` (single source of truth, also used by
 * the unit tests).
 */
export const getKnowledgeSharingOpportunities = async (
  db: Db,
  params: { managerId: string; orgId: string },
): Promise<KnowledgeSharingRow[]> => {
  const { managerId, orgId } = params;

  const managerTeams = await loadManagerTeams(db, managerId, orgId);
  if (managerTeams.length < 2) return [];
  const teamIds = managerTeams.map((t) => t.teamId);
  const teamNameById = new Map(managerTeams.map((t) => [t.teamId, t.teamName]));

  // Collect per-team feature usage (subagent + tool shares).
  type SubRow = { teamId: string; pct: number | null };
  const subagentResult = await db.execute<SubRow>(sql`
    SELECT
      u.team_id::text AS "teamId",
      CASE WHEN COUNT(*) = 0 THEN NULL
           ELSE (
             COUNT(*) FILTER (WHERE s.subagent_usage_ratio > 0)::float8
             / COUNT(*)::float8
           ) * 100
      END AS "pct"
    FROM ${sessionsAgg} s
    INNER JOIN ${users} u ON u.id = s.user_id
    WHERE u.org_id = ${orgId}
      AND u.team_id IN (${sql.join(
        teamIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND s.started_at >= NOW() - INTERVAL '30 days'
    GROUP BY u.team_id
  `);
  const subagentRows = extractExecRows<SubRow>(subagentResult);

  type ToolRow = {
    teamId: string;
    toolName: string;
    cnt: number;
    teamTotal: number;
  };
  const toolResult = await db.execute<ToolRow>(sql`
    WITH team_tool AS (
      SELECT
        u.team_id,
        tc.tool_name,
        SUM(tc.count)::int AS cnt
      FROM ${toolCountAgg} tc
      INNER JOIN ${sessionsAgg} s
         ON s.user_id = tc.user_id AND s.session_id = tc.session_id
      INNER JOIN ${users} u ON u.id = tc.user_id
      WHERE u.org_id = ${orgId}
        AND u.team_id IN (${sql.join(
          teamIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        AND s.started_at >= NOW() - INTERVAL '30 days'
      GROUP BY u.team_id, tc.tool_name
    ),
    team_total AS (
      SELECT team_id, COALESCE(SUM(cnt), 0)::int AS team_total
      FROM team_tool
      GROUP BY team_id
    )
    SELECT
      tt.team_id::text AS "teamId",
      tt.tool_name     AS "toolName",
      tt.cnt::int      AS "cnt",
      tot.team_total::int AS "teamTotal"
    FROM team_tool tt
    INNER JOIN team_total tot ON tot.team_id = tt.team_id
  `);
  const toolRows = extractExecRows<ToolRow>(toolResult);

  // Group tool-mix per (teamId, bucket) using the central bucketizer so legacy
  // `Task` collapses into `Agent`. Share = bucketCount / teamTotal.
  const bucketByTeam = new Map<string, Map<ToolBucket, number>>();
  const teamTotals = new Map<string, number>();
  for (const r of toolRows) {
    const bucketed = bucketizeToolMix(
      Array.from({ length: r.cnt }, () => r.toolName),
    );
    const acc =
      bucketByTeam.get(r.teamId) ??
      new Map<ToolBucket, number>([
        ['Edit', 0],
        ['Read', 0],
        ['Bash', 0],
        ['Agent', 0],
        ['Other', 0],
      ]);
    for (const b of TOOL_BUCKETS) acc.set(b, (acc.get(b) ?? 0) + bucketed[b]);
    bucketByTeam.set(r.teamId, acc);
    teamTotals.set(r.teamId, r.teamTotal);
  }

  type Feature = {
    feature: string;
    perTeamUsage: { teamId: string; usage: number }[];
  };
  const features: Feature[] = [];

  // Subagent-adoption rate per team.
  features.push({
    feature: 'subagents',
    perTeamUsage: subagentRows.map((r) => ({
      teamId: r.teamId,
      usage: r.pct === null || r.pct === undefined ? 0 : Number(r.pct),
    })),
  });

  // Per-bucket share (Edit, Read, Bash, Agent) — Other is uninteresting for
  // knowledge sharing because it's a residual catch-all.
  const sharedBuckets: ToolBucket[] = ['Edit', 'Read', 'Bash', 'Agent'];
  for (const bucket of sharedBuckets) {
    const perTeamUsage = teamIds.map((teamId) => {
      const total = teamTotals.get(teamId) ?? 0;
      const cnt = bucketByTeam.get(teamId)?.get(bucket) ?? 0;
      return {
        teamId,
        usage: total === 0 ? 0 : (cnt / total) * 100,
      };
    });
    features.push({ feature: `${bucket} tool`, perTeamUsage });
  }

  const out: KnowledgeSharingRow[] = [];
  for (const f of features) {
    if (f.perTeamUsage.length < 2) continue;
    const result = detectKnowledgeSharingOpportunity({
      teams: f.perTeamUsage.map((t) => ({ usage: t.usage })),
    });
    if (!result.flagged) continue;
    const topIdx = result.topIdx ?? -1;
    const bottomIdx = result.bottomIdx ?? -1;
    if (topIdx < 0 || bottomIdx < 0) continue;
    const topTeamId = f.perTeamUsage[topIdx].teamId;
    const bottomTeamId = f.perTeamUsage[bottomIdx].teamId;
    const topTeamName = teamNameById.get(topTeamId) ?? topTeamId;
    const bottomTeamName = teamNameById.get(bottomTeamId) ?? bottomTeamId;
    const ratio = result.ratio ?? 0;
    out.push({
      feature: f.feature,
      topTeamId,
      topTeamName,
      bottomTeamId,
      bottomTeamName,
      ratio,
      copy: `Team ${topTeamName} uses ${f.feature} ${ratio.toFixed(1)}× more than ${bottomTeamName}. Consider sharing patterns.`,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// REQ-18 — getTeamMembersForManager
// ---------------------------------------------------------------------------

export type TeamMember = {
  userId: string;
  email: string;
  displayName: string | null;
  /** `displayName ?? email.split('@')[0]` — same as `displayLabelFor`. */
  displayLabel: string;
};

/**
 * Members of a team in alphabetical order by display label.
 *
 * REQ-18 anti-leaderboard rule (LOCKED): the ORDER BY clause is
 * `COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC`.
 * NEVER sort by spend / sessions / tokens / any usage signal. TC-I-33
 * inspects the source of this function for the literal ORDER BY string;
 * if a future refactor swaps the COALESCE for a bare `display_name`, the
 * NULL fallback breaks and the test fires.
 */
export const getTeamMembersForManager = async (
  db: Db,
  params: { orgId: string; teamId: string },
): Promise<TeamMember[]> => {
  const { orgId, teamId } = params;
  // Drizzle's query builder cannot express the COALESCE-in-ORDER-BY clause
  // statically; we use db.execute with the sql tag (still parameter-bound
  // — `${orgId}` and `${teamId}` are bind variables, NOT interpolated).
  // The literal `ORDER BY COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC`
  // is what TC-I-33 grep-asserts.
  const result = await db.execute<{
    userId: string;
    email: string;
    displayName: string | null;
  }>(sql`
    SELECT
      users.id::text         AS "userId",
      users.email            AS "email",
      users.display_name     AS "displayName"
    FROM ${users} users
    WHERE users.org_id = ${orgId}
      AND users.team_id = ${teamId}
    ORDER BY COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC
  `);
  const rows = extractExecRows<{
    userId: string;
    email: string;
    displayName: string | null;
  }>(result);

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName,
    displayLabel: displayLabelFor({ display_name: r.displayName, email: r.email }),
  }));
};
