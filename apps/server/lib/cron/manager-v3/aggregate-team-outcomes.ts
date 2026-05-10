/**
 * Daily aggregation cron entry point — manager-dashboard-v3-outcomes spec
 * (REQ-11). Mirrors `manager-v2/aggregate-team-metrics.ts` structure, with
 * three semantic differences:
 *
 *   1. **Source: `session_outcomes_agg`** (NOT `sessions_agg`). The JOIN
 *      filters `WHERE outcome_status = 'evaluated'` — non-evaluated rows
 *      (cwd-missing / not-a-git-repo / no-user-email) are excluded from
 *      the rollup but kept in `session_outcomes_agg` for audit purposes.
 *
 *   2. **Per-org probe queries `team_outcomes_daily`** (NOT
 *      `team_metrics_daily`). Each table has its own first-run state
 *      machine — Fase 4 already exists in production with rows; Fase 5
 *      v3 starts empty regardless.
 *
 *   3. **`day` derived from `sessions_agg.started_at`** (NOT
 *      `session_outcomes_agg.ingested_at`). Outcome ingestion can lag
 *      session evaluation; using `started_at` keeps daily rows aligned
 *      with when the work happened, matching `team_metrics_daily`.
 *
 * `total_merged_pr_count` uses `SUM(merged_pr_count) FILTER (WHERE
 * merged_pr_count IS NOT NULL)` — when ALL contributing rows have
 * NULL, the SUM returns NULL (preserves "PR lookup off / all
 * rate-limited" vs "PR lookup on, 0 PRs merged today").
 *
 * Single SQL pass with a `windows(org_id, since)` CTE built from
 * `VALUES (...)`, every value parameter-bound through Drizzle's `sql`
 * template tag (security.md prepared-statement rule).
 */
import { sql } from 'drizzle-orm';

import type { getDb } from '@/lib/db/client';
import { cronRuns } from '@/lib/db/schema';

type Db = ReturnType<typeof getDb>;

/** Job name recorded in `cron_runs.job_name`. */
const JOB_NAME = 'aggregate-team-outcomes';

/** Default refresh window — short on purpose; rolling tail picks up late
 * pushes without re-aggregating ancient days each run. Mirrors Fase 4. */
const DEFAULT_WINDOW_DAYS = 2;

/** First-run backfill window when `team_outcomes_daily` is empty. */
const BACKFILL_DAYS = 90;

export type AggregateOptions = {
  /**
   * Optional explicit lower bound (inclusive). When omitted, per-org probe
   * detects empty `team_outcomes_daily` and chooses 90 days for the first
   * run, otherwise the default 2-day rolling tail.
   */
  since?: Date;
};

export type AggregateResult = {
  status: 'ok' | 'failed';
  rowsWritten: number;
  error?: string;
};

const startCronRun = async (db: Db): Promise<number> => {
  const rows = await db
    .insert(cronRuns)
    .values({ jobName: JOB_NAME, status: 'running' })
    .returning({ id: cronRuns.id });
  return rows[0].id;
};

const finishCronRun = async (
  db: Db,
  runId: number,
  status: 'ok' | 'failed',
  rowsWritten: number,
  errorMessage: string | null,
): Promise<void> => {
  const truncated = errorMessage === null ? null : errorMessage.slice(0, 4096);
  await db
    .update(cronRuns)
    .set({
      status,
      rowsWritten,
      errorMessage: truncated,
      finishedAt: new Date(),
    })
    .where(sql`${cronRuns.id} = ${runId}`);
};

/**
 * Per-org probe — same pattern as Fase 4 (lesson-learned applied — was a
 * global probe in v2 first-cut; followup `328806d` made it per-org). Each
 * org gets its own (90d backfill if empty, 2d rolling if populated)
 * window, all in one SQL pass.
 */
const resolveWindowStartsByOrg = async (
  db: Db,
  options: AggregateOptions,
): Promise<Map<string, Date>> => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rolling = new Date(today);
  rolling.setUTCDate(rolling.getUTCDate() - (DEFAULT_WINDOW_DAYS - 1));
  const backfill = new Date(today);
  backfill.setUTCDate(backfill.getUTCDate() - (BACKFILL_DAYS - 1));

  const probe = await db.execute<{ org_id: string; has_rows: boolean }>(sql`
    SELECT u.org_id::text AS org_id,
           EXISTS (
             SELECT 1 FROM team_outcomes_daily tod
             WHERE tod.org_id = u.org_id
             LIMIT 1
           ) AS has_rows
    FROM (SELECT DISTINCT org_id FROM users) AS u
  `);
  const rowsField = (
    probe as unknown as { rows?: { org_id: string; has_rows: boolean }[] }
  ).rows;
  const probeRows =
    rowsField ?? (probe as unknown as { org_id: string; has_rows: boolean }[]);
  const map = new Map<string, Date>();
  for (const r of Array.isArray(probeRows) ? probeRows : []) {
    if (options.since) {
      map.set(r.org_id, options.since);
    } else {
      map.set(r.org_id, r.has_rows ? rolling : backfill);
    }
  }
  return map;
};

/**
 * Single SQL aggregation pass. JOIN chain:
 *   session_outcomes_agg WHERE outcome_status='evaluated'
 *     INNER JOIN sessions_agg USING (user_id, session_id)  -- gets started_at + tokens + cost
 *     INNER JOIN users WHERE users.team_id IS NOT NULL     -- teamless users excluded
 *     INNER JOIN windows w ON w.org_id = users.org_id AND sessions_agg.started_at >= w.since
 *   GROUP BY org_id, team_id, day
 *
 * `total_merged_pr_count` uses FILTER WHERE NOT NULL → SUM returns NULL
 * when all contributing rows had merged_pr_count = NULL.
 */
const runAggregation = async (
  db: Db,
  windowsByOrg: Map<string, Date>,
): Promise<number> => {
  if (windowsByOrg.size === 0) return 0;

  const windowFragments = Array.from(windowsByOrg.entries()).map(
    ([orgId, since]) => sql`(${orgId}::uuid, ${since}::timestamptz)`,
  );
  const windowsValues = sql.join(windowFragments, sql`, `);

  const result = await db.execute(sql`
    WITH windows(org_id, since) AS (
      VALUES ${windowsValues}
    ),
    contributing AS (
      SELECT
        u.org_id,
        u.team_id,
        date_trunc('day', s.started_at AT TIME ZONE 'UTC')::date AS day,
        so.commit_count,
        so.loc_added,
        so.loc_removed,
        so.files_changed,
        so.reverts_within_7d,
        so.merged_pr_count,
        s.total_input_tokens,
        s.total_output_tokens,
        s.total_cost_usd
      FROM session_outcomes_agg so
      INNER JOIN sessions_agg s
        ON s.user_id = so.user_id AND s.session_id = so.session_id
      INNER JOIN users u
        ON u.id = s.user_id AND u.team_id IS NOT NULL
      INNER JOIN windows w
        ON w.org_id = u.org_id AND s.started_at >= w.since
      WHERE so.outcome_status = 'evaluated'
    )
    INSERT INTO team_outcomes_daily (
      org_id, team_id, day,
      total_commits, total_loc_added, total_loc_removed,
      total_files_changed, total_reverts_within_7d, total_merged_pr_count,
      total_input_tokens, total_output_tokens, total_cost_usd,
      sessions_with_outcome, computed_at
    )
    SELECT
      org_id,
      team_id,
      day,
      COALESCE(SUM(commit_count), 0)::int AS total_commits,
      COALESCE(SUM(loc_added), 0)::int AS total_loc_added,
      COALESCE(SUM(loc_removed), 0)::int AS total_loc_removed,
      COALESCE(SUM(files_changed), 0)::int AS total_files_changed,
      COALESCE(SUM(reverts_within_7d), 0)::int AS total_reverts_within_7d,
      -- FILTER + SUM returns NULL when all contributing rows are NULL.
      SUM(merged_pr_count) FILTER (WHERE merged_pr_count IS NOT NULL)::int AS total_merged_pr_count,
      COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
      COALESCE(SUM(total_output_tokens), 0)::bigint AS total_output_tokens,
      COALESCE(SUM(total_cost_usd), 0)::numeric(14,6) AS total_cost_usd,
      COUNT(*)::int AS sessions_with_outcome,
      now()
    FROM contributing
    GROUP BY org_id, team_id, day
    ON CONFLICT (org_id, team_id, day) DO UPDATE SET
      total_commits = excluded.total_commits,
      total_loc_added = excluded.total_loc_added,
      total_loc_removed = excluded.total_loc_removed,
      total_files_changed = excluded.total_files_changed,
      total_reverts_within_7d = excluded.total_reverts_within_7d,
      total_merged_pr_count = excluded.total_merged_pr_count,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cost_usd = excluded.total_cost_usd,
      sessions_with_outcome = excluded.sessions_with_outcome,
      computed_at = now()
  `);

  const rowCount = (result as unknown as { rowCount?: number | null }).rowCount;
  return typeof rowCount === 'number' ? rowCount : 0;
};

/**
 * Public entry point. Always returns a result (never throws) so the
 * route handler can decide HTTP status without try/catch of its own.
 */
export const aggregateTeamOutcomes = async (
  db: Db,
  options: AggregateOptions = {},
): Promise<AggregateResult> => {
  const runId = await startCronRun(db);
  try {
    const windowsByOrg = await resolveWindowStartsByOrg(db, options);
    const rowsWritten = await runAggregation(db, windowsByOrg);
    await finishCronRun(db, runId, 'ok', rowsWritten, null);
    return { status: 'ok', rowsWritten };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await finishCronRun(db, runId, 'failed', 0, message);
    } catch {
      // Swallow — original aggregation error is more informative than
      // a follow-up "couldn't update cron_runs" error.
    }
    return { status: 'failed', rowsWritten: 0, error: message };
  }
};
