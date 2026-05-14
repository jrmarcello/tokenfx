/**
 * `me-visibility` — queries powering `/me/visibility` (REQ-17 of
 * `.specs/manager-dashboard-v2.md`).
 *
 * # Why this lives in its own module (and not in `manager-v2.ts`)
 *
 * The `/me/visibility` page is a **dev-facing** surface — the dev viewing
 * their OWN data. Anti-surveillance principle 5 of the spec ("Devs see what
 * their manager sees") makes this a first-class trust contract: a dev MUST
 * be able to read every drilldown audit row where `target_user_id = self`,
 * even after the org disables `drilldown_notification_enabled`. Co-locating
 * the query with the manager-facing helpers risks future refactors that
 * accidentally reuse a manager-scoped predicate (e.g. `manager_user_id`)
 * here. Keeping a separate module pins the contract.
 *
 * # Two queries
 *
 *   - `getMyKpis(db, userId)` — single round-trip aggregation across the
 *     dev's last-30d sessions. Returns `cacheHitRatioAvg`, `goodSessionPct`,
 *     `subagentAdoptionPct`, plus the 5-bucket `toolMix`. Mirrors the
 *     manager-aggregated KPIs the manager sees about this dev.
 *
 *   - `getMyDrilldownAudit(db, { userId, page, pageSize })` — paginated
 *     chronological audit log. The query is keyed on `target_user_id`
 *     (the dev's OWN id, derived from `auth().user.id` at the route layer).
 *     The SQL string is exposed as `GET_MY_DRILLDOWN_AUDIT_SQL` so TC-I-54
 *     can inspect it for the literal `WHERE target_user_id = $1` predicate.
 *
 * # SQL-side label rendering
 *
 * The audit-log table renders the manager identity via the SAME COALESCE
 * expression the React-side `displayLabelFor` uses:
 *
 *   COALESCE(users.display_name, split_part(users.email, '@', 1))
 *
 * Doing it in SQL (rather than fetching `displayName + email` and computing
 * client-side) keeps the wire format minimal — we never expose the raw
 * email of the manager in the response payload, only the rendered label.
 * This is a privacy hardening: a future leak of the page's hydration data
 * cannot reveal a manager's full email address.
 *
 * # Validation
 *
 * `page` and `pageSize` are positive integers. The page layer validates
 * `page` with Zod (`z.coerce.number().int().min(1)`); this lib defends in
 * depth by throwing `RangeError` on `page <= 0` or `pageSize <= 0`. TC-I-71
 * and TC-I-72 lock this contract.
 */
import { sql } from 'drizzle-orm';
import { bucketizeToolMix, type ToolBucket } from '@/lib/analytics/tool-mix';
import { extractExecRows as extractRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MyKpis = {
  /** Mean of `sessions_agg.cache_hit_ratio` over non-null sessions in the
   *  30d window. `null` when the dev has zero rated sessions. */
  cacheHitRatioAvg: number | null;
  /** % of sessions with `avg_rating >= 4 OR cache_hit_ratio >= 0.6`
   *  (REQ-2 "good session" gate, mirrored at session level for the
   *  per-dev rollup). 0 when the dev has zero sessions. */
  goodSessionPct: number;
  /** % of sessions with `subagent_usage_ratio > 0` (strict, matches
   *  the manager-side definition in `getTeamSubagentAdoption`). */
  subagentAdoptionPct: number;
  /** 5-bucket tool mix counts (Edit / Read / Bash / Agent / Other) over
   *  the dev's 30d sessions. `Task` legacy alias collapses to `Agent`. */
  toolMix: Record<ToolBucket, number>;
};

export type MyDrilldownAuditItem = {
  viewedAt: Date;
  /** Same fallback as `displayLabelFor` — never null, never empty. */
  managerDisplayLabel: string;
  /** Locked enum: 'training-check' | 'quota-investigation'
   *  | 'cost-investigation' | 'other'. */
  reason: string;
  /** Free-text rationale provided by the manager when reason='other' (or
   *  when they elaborated). Nullable. */
  reasonText: string | null;
};

export type MyDrilldownAuditPage = {
  items: MyDrilldownAuditItem[];
  /** Total count for the dev (NOT page-bounded), used to compute hasNext
   *  in the page layer. */
  total: number;
};

// ---------------------------------------------------------------------------
// Source-level constant — TC-I-54 inspects this to lock the predicate.
// ---------------------------------------------------------------------------

/**
 * The literal SQL fragment that drives `getMyDrilldownAudit`. Exposed as a
 * top-level constant so TC-I-54 can grep-assert the WHERE predicate without
 * executing the query. If a future refactor changes this string, TC-I-54
 * fires immediately — preventing accidental drift away from
 * `target_user_id` (e.g. swapping for `manager_user_id`, which would
 * silently break the trust contract).
 */
export const GET_MY_DRILLDOWN_AUDIT_SQL = `
SELECT
  mda.viewed_at AS "viewedAt",
  COALESCE(u.display_name, split_part(u.email, '@', 1)) AS "managerDisplayLabel",
  mda.reason AS "reason",
  mda.reason_text AS "reasonText"
FROM manager_drilldown_audit mda
INNER JOIN users u ON u.id = mda.manager_user_id
WHERE target_user_id = $1
ORDER BY mda.viewed_at DESC
LIMIT $2 OFFSET $3
`.trim();

// ---------------------------------------------------------------------------
// getMyKpis
// ---------------------------------------------------------------------------

/**
 * 30-day aggregated KPIs for a single dev — the SAME numbers their manager
 * sees about them in aggregate (REQ-17, anti-surveillance principle 5).
 *
 * Two round-trips, both `user_id`-scoped:
 *   1. `sessions_agg` aggregate — cacheHitRatioAvg + goodSessionPct +
 *      subagentAdoptionPct in one query.
 *   2. `tool_count_agg` join — per-tool counts across the dev's 30d
 *      sessions, bucketized in JS to keep the bucket mapping single-sourced
 *      in `lib/analytics/tool-mix.ts`.
 */
export const getMyKpis = async (db: Db, userId: string): Promise<MyKpis> => {
  type AggRow = {
    cacheHitRatioAvg: string | null;
    goodSessionPct: string | null;
    subagentAdoptionPct: string | null;
  };

  const aggResult = await db.execute<AggRow>(sql`
    SELECT
      AVG(s.cache_hit_ratio)::float8 AS "cacheHitRatioAvg",
      CASE WHEN COUNT(*) = 0 THEN 0
           ELSE (
             COUNT(*) FILTER (
               WHERE s.avg_rating >= 4 OR s.cache_hit_ratio >= 0.6
             )::float8
             / COUNT(*)::float8
           ) * 100
      END AS "goodSessionPct",
      CASE WHEN COUNT(*) = 0 THEN 0
           ELSE (
             COUNT(*) FILTER (WHERE s.subagent_usage_ratio > 0)::float8
             / COUNT(*)::float8
           ) * 100
      END AS "subagentAdoptionPct"
    FROM sessions_agg s
    WHERE s.user_id = ${userId}
      AND s.started_at >= NOW() - INTERVAL '30 days'
  `);
  const aggRows = extractRows<AggRow>(aggResult);
  const aggRow = aggRows[0];

  const cacheHitRatioAvg =
    aggRow?.cacheHitRatioAvg == null ? null : Number(aggRow.cacheHitRatioAvg);
  const goodSessionPct = Number(aggRow?.goodSessionPct ?? 0);
  const subagentAdoptionPct = Number(aggRow?.subagentAdoptionPct ?? 0);

  // Tool mix — sum tool_count_agg.count grouped by raw tool_name across the
  // dev's last-30d sessions. Bucketize at the JS layer so the Task→Agent
  // mapping stays in `lib/analytics/tool-mix.ts` (single source of truth).
  type ToolRow = { toolName: string; count: number | string };
  const toolResult = await db.execute<ToolRow>(sql`
    SELECT
      tca.tool_name AS "toolName",
      SUM(tca.count)::int AS "count"
    FROM tool_count_agg tca
    INNER JOIN sessions_agg s
       ON s.user_id = tca.user_id AND s.session_id = tca.session_id
    WHERE tca.user_id = ${userId}
      AND s.started_at >= NOW() - INTERVAL '30 days'
    GROUP BY tca.tool_name
  `);
  const toolRows = extractRows<ToolRow>(toolResult);

  const flatNames: string[] = [];
  for (const row of toolRows) {
    const n = Number(row.count);
    if (!Number.isFinite(n) || n <= 0) continue;
    for (let i = 0; i < n; i += 1) flatNames.push(row.toolName);
  }
  const toolMix = bucketizeToolMix(flatNames);

  return {
    cacheHitRatioAvg:
      cacheHitRatioAvg === null || !Number.isFinite(cacheHitRatioAvg)
        ? null
        : cacheHitRatioAvg,
    goodSessionPct: Number.isFinite(goodSessionPct) ? goodSessionPct : 0,
    subagentAdoptionPct: Number.isFinite(subagentAdoptionPct)
      ? subagentAdoptionPct
      : 0,
    toolMix,
  };
};

// ---------------------------------------------------------------------------
// getMyDrilldownAudit
// ---------------------------------------------------------------------------

export const DEFAULT_AUDIT_PAGE_SIZE = 25;

/**
 * Paginated chronological audit log for the dev's own drilldowns.
 *
 * The query is **keyed on `target_user_id`** (the dev's OWN id) — TC-I-54
 * locks this with a literal-string check on `GET_MY_DRILLDOWN_AUDIT_SQL`.
 * Cross-org isolation is implicit: the predicate matches only rows where
 * `target_user_id` equals the caller's id, so a row from a different org
 * referencing a different user is structurally unreachable (TC-I-38).
 *
 * Pagination: `page` is 1-based, `pageSize` defaults to 25. `RangeError`
 * on `page <= 0` or `pageSize <= 0` (defense-in-depth — page layer also
 * validates with Zod).
 *
 * @returns `{ items, total }` where `total` is the unbounded count of
 *   rows for the dev (NOT page-bounded).
 */
export const getMyDrilldownAudit = async (
  db: Db,
  params: { userId: string; page: number; pageSize?: number },
): Promise<MyDrilldownAuditPage> => {
  const pageSize = params.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
  if (params.page <= 0 || !Number.isInteger(params.page)) {
    throw new RangeError(
      `getMyDrilldownAudit: page must be a positive integer, got ${params.page}`,
    );
  }
  if (pageSize <= 0 || !Number.isInteger(pageSize)) {
    throw new RangeError(
      `getMyDrilldownAudit: pageSize must be a positive integer, got ${pageSize}`,
    );
  }
  const offset = (params.page - 1) * pageSize;

  // The query mirrors `GET_MY_DRILLDOWN_AUDIT_SQL` byte-for-byte modulo the
  // parameter markers Drizzle emits. TC-I-54 inspects the literal string
  // constant; we keep the executable form here because Drizzle's `sql` tag
  // gives us safe parameter binding (the values are NEVER interpolated into
  // the SQL text — they're bound via `$N` placeholders by node-postgres).
  type Row = {
    viewedAt: Date | string;
    managerDisplayLabel: string;
    reason: string;
    reasonText: string | null;
  };

  const result = await db.execute<Row>(sql`
    SELECT
      mda.viewed_at AS "viewedAt",
      COALESCE(u.display_name, split_part(u.email, '@', 1)) AS "managerDisplayLabel",
      mda.reason AS "reason",
      mda.reason_text AS "reasonText"
    FROM manager_drilldown_audit mda
    INNER JOIN users u ON u.id = mda.manager_user_id
    WHERE target_user_id = ${params.userId}
    ORDER BY mda.viewed_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);
  const rows = extractRows<Row>(result);

  // Total count — separate aggregate so pagination doesn't lie when the
  // dev has > pageSize audit rows.
  type CountRow = { total: number | string };
  const countResult = await db.execute<CountRow>(sql`
    SELECT COUNT(*)::int AS "total"
    FROM manager_drilldown_audit
    WHERE target_user_id = ${params.userId}
  `);
  const countRows = extractRows<CountRow>(countResult);
  const total = Number(countRows[0]?.total ?? 0);

  return {
    items: rows.map((r) => ({
      viewedAt: r.viewedAt instanceof Date ? r.viewedAt : new Date(r.viewedAt),
      managerDisplayLabel: r.managerDisplayLabel,
      reason: r.reason,
      reasonText: r.reasonText,
    })),
    total: Number.isFinite(total) ? total : 0,
  };
};

// ---- v3 outcome KPIs (manager-dashboard-v3-outcomes spec REQ-16) ----------

/**
 * Personal outcome KPIs for `/me/visibility` — paridade com o que o manager
 * vê sobre o dev em `team_outcomes_daily` (REQ-16, anti-surveillance
 * principle 5: o dev sabe exatamente o que o manager sabe).
 *
 * Strictly scoped to the authenticated user's `user_id` (horizontal-
 * privilege-escalation guard). Window: last 30 days, joined to
 * `sessions_agg.started_at` (NOT `session_outcomes_agg.ingested_at` —
 * keeps day alignment consistent with manager rollup).
 *
 * Only `outcome_status='evaluated'` sessions contribute. Empty result
 * (dev has 0 evaluated sessions in the window): all fields are `null`.
 */
export type MyOutcomeKpis = {
  /** Total LOC added across the dev's evaluated sessions in the window. */
  totalLocAdded: number;
  /** Total commits across the dev's evaluated sessions in the window. */
  totalCommits: number;
  /** Total reverts within 7d across the dev's evaluated sessions. */
  totalRevertsWithin7d: number;
  /** Total cost (USD) — `effectiveCostForSession` cascade preserved at
   *  the row layer in `sessions_agg.total_cost_usd`. */
  totalCostUsd: number;
  /** Total input + output tokens. */
  totalTokens: number;
  /** Sessions with outcome_status='evaluated' in the window. */
  sessionsWithOutcome: number;
  /** Total merged PRs — NULL when ALL contributing sessions had NULL
   *  (PR lookup feature off / all rate-limited). */
  totalMergedPrCount: number | null;
};

export const getMyOutcomeKpis = async (
  db: Db,
  userId: string,
): Promise<MyOutcomeKpis> => {
  type AggRow = {
    totalLocAdded: number | null;
    totalCommits: number | null;
    totalRevertsWithin7d: number | null;
    totalCostUsd: string | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    sessionsWithOutcome: number | null;
    totalMergedPrCount: number | null;
  };

  const result = await db.execute<AggRow>(sql`
    SELECT
      COALESCE(SUM(so.loc_added), 0)::int           AS "totalLocAdded",
      COALESCE(SUM(so.commit_count), 0)::int        AS "totalCommits",
      COALESCE(SUM(so.reverts_within_7d), 0)::int   AS "totalRevertsWithin7d",
      COALESCE(SUM(s.total_cost_usd), 0)::numeric(14,6) AS "totalCostUsd",
      COALESCE(SUM(s.total_input_tokens), 0)::bigint    AS "totalInputTokens",
      COALESCE(SUM(s.total_output_tokens), 0)::bigint   AS "totalOutputTokens",
      COUNT(*)::int                                 AS "sessionsWithOutcome",
      SUM(so.merged_pr_count) FILTER (WHERE so.merged_pr_count IS NOT NULL)::int
                                                    AS "totalMergedPrCount"
    FROM session_outcomes_agg so
    INNER JOIN sessions_agg s
      ON s.user_id = so.user_id AND s.session_id = so.session_id
    WHERE so.user_id = ${userId}
      AND so.outcome_status = 'evaluated'
      AND s.started_at >= now() - INTERVAL '30 days'
  `);
  const rows = extractRows<AggRow>(result);
  const row: AggRow | undefined = rows[0];

  return {
    totalLocAdded: row?.totalLocAdded ?? 0,
    totalCommits: row?.totalCommits ?? 0,
    totalRevertsWithin7d: row?.totalRevertsWithin7d ?? 0,
    totalCostUsd: row?.totalCostUsd ? Number(row.totalCostUsd) : 0,
    totalTokens: (row?.totalInputTokens ?? 0) + (row?.totalOutputTokens ?? 0),
    sessionsWithOutcome: row?.sessionsWithOutcome ?? 0,
    totalMergedPrCount: row?.totalMergedPrCount ?? null,
  };
};
