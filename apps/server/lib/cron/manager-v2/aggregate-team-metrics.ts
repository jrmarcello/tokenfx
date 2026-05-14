/**
 * 15-minute aggregation cron entry point (REQ-21 of `manager-dashboard-v2`).
 *
 * Aggregates per-session rows from `sessions_agg` + `tool_count_agg` into
 * `team_metrics_daily`, grouping by `users.team_id` and
 * `date_trunc('day', sessions_agg.started_at)`. The function is pure logic —
 * the POST route at `app/api/internal/cron/aggregate-team-metrics/route.ts`
 * authenticates and calls this.
 *
 * Window strategy:
 *  - Default: refresh the **last 2 days** (handles late reporter pushes).
 *  - First-run / empty `team_metrics_daily`: backfill the last **90 days**.
 *
 * Idempotency: the INSERT uses
 *   `ON CONFLICT (org_id, team_id, day) DO UPDATE SET ...`
 * so re-running on the same window is safe (TC-I-03), and concurrent
 * overlapping invocations serialize through the unique key (TC-I-70).
 *
 * Lifecycle: every invocation writes a `cron_runs` row — `'running'` on
 * entry, then UPDATE'd to `'ok'` (with `rows_written`) or `'failed'`
 * (with `error_message`) before return. TC-I-07 covers the failure path.
 *
 * Security (REQ-19): every interpolated value goes through Drizzle's
 * `sql` template tag, which binds parameters automatically. No
 * concatenation / template-string literals with user data.
 */
import { sql } from 'drizzle-orm';
import { cronRuns } from '@/lib/db/schema';
import { extractExecRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

/** Job name recorded in `cron_runs.job_name`. */
const JOB_NAME = 'aggregate-team-metrics';

/** Default refresh window — short on purpose; rolling tail picks up late
 * pushes without re-aggregating ancient days each run. */
const DEFAULT_WINDOW_DAYS = 2;

/** First-run backfill window when `team_metrics_daily` is empty. */
const BACKFILL_DAYS = 90;

export type AggregateOptions = {
  /**
   * Optional explicit lower bound (inclusive). When omitted, the function
   * detects an empty `team_metrics_daily` and chooses 90 days for the first
   * run, otherwise the default 2-day rolling tail.
   */
  since?: Date;
};

export type AggregateResult = {
  status: 'ok' | 'failed';
  rowsWritten: number;
  error?: string;
};

/**
 * Insert a `cron_runs` row in 'running' state and return its id.
 *
 * Kept as a separate helper so the lifecycle is obvious in `aggregateTeamMetrics`
 * — start row → try aggregation → finalize the same row to ok/failed.
 */
const startCronRun = async (db: Db): Promise<number> => {
  const rows = await db
    .insert(cronRuns)
    .values({ jobName: JOB_NAME, status: 'running' })
    .returning({ id: cronRuns.id });
  return rows[0].id;
};

/**
 * Finalize a `cron_runs` row to 'ok' or 'failed'.
 *
 * Uses `db.update(...)` (parameterized) — never template-string SQL — to
 * comply with REQ-19. The `error` field is truncated defensively at 4096
 * chars to keep oversized error blobs (e.g. stack traces) from bloating the
 * row.
 */
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
 * Decide the per-org lower bound of the aggregation window.
 *
 * Universe = `SELECT DISTINCT org_id FROM users` (REQ-12). Orgs with no
 * users have nothing to aggregate and are skipped — they never appear in
 * the returned Map.
 *
 * For each org in the universe, if `team_metrics_daily` already has any
 * row for that org → use the rolling 2-day window; otherwise (first time
 * this org is being aggregated) → backfill 90 days. Both windows execute
 * in the **same** `runAggregation` invocation via a `windows(org_id, since)`
 * CTE, so different orgs at different stages share a single SQL pass and
 * a single `cron_runs` row (REQ-9).
 *
 * If `options.since` is provided, that override is applied uniformly to
 * every org (REQ-11) — the per-org branching is skipped.
 *
 * SECURITY: every value injected into SQL goes through Drizzle's `sql`
 * template tag → bound parameters (REQ-19 of spec mãe).
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

  // Universe of orgs (`users.org_id`) joined with a per-org existence check
  // against `team_metrics_daily`. Single round-trip — N orgs is single-digit
  // for the foreseeable deployment but the LATERAL-equivalent EXISTS scales
  // linearly anyway.
  const probe = await db.execute<{ org_id: string; has_rows: boolean }>(sql`
    SELECT u.org_id::text AS org_id,
           EXISTS (
             SELECT 1 FROM team_metrics_daily tmd
             WHERE tmd.org_id = u.org_id
             LIMIT 1
           ) AS has_rows
    FROM (SELECT DISTINCT org_id FROM users) AS u
  `);
  // `db.execute` driver-shape unwrap is centralized in `extractExecRows`.
  const probeRows = extractExecRows<{ org_id: string; has_rows: boolean }>(probe);
  const map = new Map<string, Date>();
  for (const r of probeRows) {
    if (options.since) {
      map.set(r.org_id, options.since);
    } else {
      map.set(r.org_id, r.has_rows ? rolling : backfill);
    }
  }
  return map;
};

/**
 * Aggregate per-session rows into `team_metrics_daily`.
 *
 * Single SQL statement — INSERT … SELECT … FROM sessions_agg JOIN users
 * LEFT JOIN tool_count_agg, GROUP BY (org, team, day), with ON CONFLICT
 * DO UPDATE SET … excluded.* for idempotent refresh.
 *
 * Tool-mix is built in SQL with `jsonb_object_agg` over a CASE that mirrors
 * the bucketing in `lib/analytics/tool-mix.ts` (Edit / Read / Bash / Agent
 * (Task ∪ Agent) / Other). Cheaper than streaming rows back to Node and
 * re-bucketing per-team-per-day in JS.
 *
 * Composite_avg is the team-day mean of the per-session composite, computed
 * inline with the same weights as `lib/analytics/composite-score.ts`
 * (cacheHit 0.40, outputInput-clamped/5 0.40, min(subagent×2,1) 0.10,
 * (rating+1)/2 0.10), with NULL components dropped from each session's
 * weight pool. Subagent_adoption_pct is `% of sessions where
 * subagent_usage_ratio > 0` (REQ-4 strict). good_session_pct is
 * `% of sessions where composite >= 60 OR avg_rating >= 0` (REQ-2 default;
 * the threshold env var is read at query time in the Node consumer for
 * single-team reads, but the rollup uses the spec default 60 — divergent
 * thresholds would make the rollup unstable).
 *
 * Returns the affected row count from the INSERT statement.
 *
 * Per-org windows are injected via a `windows(org_id, since)` CTE built
 * from a `VALUES (...)` list, with every value parameter-bound through
 * Drizzle's `sql` template (REQ-19 of spec mãe). When `windowsByOrg` is
 * empty (zero orgs in `users`), Postgres' `VALUES` clause cannot be empty
 * — we short-circuit and return `0` without executing SQL.
 */
const runAggregation = async (db: Db, windowsByOrg: Map<string, Date>): Promise<number> => {
  if (windowsByOrg.size === 0) return 0;

  // Build the VALUES list for the windows CTE. Each fragment is
  // `(${id}::uuid, ${date}::timestamptz)` with bound parameters.
  const windowFragments = Array.from(windowsByOrg.entries()).map(
    ([orgId, since]) => sql`(${orgId}::uuid, ${since}::timestamptz)`,
  );
  const windowsValues = sql.join(windowFragments, sql`, `);

  const result = await db.execute(sql`
    WITH windows(org_id, since) AS (
      VALUES ${windowsValues}
    ),
    session_metrics AS (
      SELECT
        u.org_id,
        u.team_id,
        date_trunc('day', s.started_at AT TIME ZONE 'UTC')::date AS day,
        s.user_id,
        s.session_id,
        s.cache_hit_ratio::float AS cache_hit,
        s.output_input_ratio::float AS output_input,
        s.subagent_usage_ratio::float AS subagent_usage,
        s.avg_rating::float AS avg_rating
      FROM sessions_agg s
      INNER JOIN users u ON u.id = s.user_id
      INNER JOIN windows w ON w.org_id = u.org_id AND s.started_at >= w.since
    ),
    composite AS (
      SELECT
        org_id,
        team_id,
        day,
        user_id,
        session_id,
        cache_hit,
        output_input,
        subagent_usage,
        avg_rating,
        -- Per-session composite with NULL-weight redistribution.
        CASE
          WHEN cache_hit IS NULL AND output_input IS NULL
               AND subagent_usage IS NULL AND avg_rating IS NULL
          THEN NULL
          ELSE (
            (
              COALESCE(LEAST(GREATEST(cache_hit, 0), 1) * 0.40, 0)
              + COALESCE((LEAST(GREATEST(output_input, 0), 5) / 5.0) * 0.40, 0)
              + COALESCE((LEAST(GREATEST(subagent_usage, 0), 0.5) * 2.0) * 0.10, 0)
              + COALESCE(((LEAST(GREATEST(avg_rating, -1), 1) + 1) / 2.0) * 0.10, 0)
            )
            /
            (
              CASE WHEN cache_hit IS NULL THEN 0 ELSE 0.40 END
              + CASE WHEN output_input IS NULL THEN 0 ELSE 0.40 END
              + CASE WHEN subagent_usage IS NULL THEN 0 ELSE 0.10 END
              + CASE WHEN avg_rating IS NULL THEN 0 ELSE 0.10 END
            )
          ) * 100
        END AS composite_score
      FROM session_metrics
    ),
    per_team_day AS (
      SELECT
        org_id,
        team_id,
        day,
        AVG(cache_hit) AS cache_hit_ratio_avg,
        AVG(composite_score) AS composite_avg,
        (
          COUNT(*) FILTER (
            WHERE (composite_score IS NOT NULL AND composite_score >= 60)
               OR (avg_rating IS NOT NULL AND avg_rating >= 0)
          )::numeric
          / NULLIF(COUNT(*), 0)
          * 100
        ) AS good_session_pct,
        (
          COUNT(*) FILTER (WHERE subagent_usage IS NOT NULL AND subagent_usage > 0)::numeric
          / NULLIF(COUNT(*), 0)
          * 100
        ) AS subagent_adoption_pct,
        COUNT(*)::int AS total_sessions,
        COUNT(DISTINCT user_id)::int AS total_devs
      FROM composite
      GROUP BY org_id, team_id, day
    ),
    tool_buckets AS (
      SELECT
        u.org_id,
        u.team_id,
        date_trunc('day', s.started_at AT TIME ZONE 'UTC')::date AS day,
        CASE
          WHEN tc.tool_name = 'Edit' THEN 'Edit'
          WHEN tc.tool_name = 'Read' THEN 'Read'
          WHEN tc.tool_name = 'Bash' THEN 'Bash'
          WHEN tc.tool_name IN ('Task', 'Agent') THEN 'Agent'
          ELSE 'Other'
        END AS bucket,
        SUM(tc.count)::int AS cnt
      FROM tool_count_agg tc
      INNER JOIN sessions_agg s
         ON s.user_id = tc.user_id
        AND s.session_id = tc.session_id
      INNER JOIN users u ON u.id = tc.user_id
      INNER JOIN windows w ON w.org_id = u.org_id AND s.started_at >= w.since
      GROUP BY u.org_id, u.team_id, date_trunc('day', s.started_at AT TIME ZONE 'UTC'), bucket
    ),
    tool_mix AS (
      SELECT
        org_id,
        team_id,
        day,
        jsonb_object_agg(bucket, cnt) AS tool_mix_json
      FROM tool_buckets
      GROUP BY org_id, team_id, day
    )
    INSERT INTO team_metrics_daily (
      org_id, team_id, day,
      cache_hit_ratio_avg, good_session_pct, subagent_adoption_pct,
      composite_avg, total_sessions, total_devs, tool_mix_json, computed_at
    )
    SELECT
      p.org_id,
      p.team_id,
      p.day,
      ROUND(p.cache_hit_ratio_avg::numeric, 4),
      ROUND(p.good_session_pct::numeric, 2),
      ROUND(p.subagent_adoption_pct::numeric, 2),
      ROUND(p.composite_avg::numeric, 2),
      p.total_sessions,
      p.total_devs,
      tm.tool_mix_json,
      now()
    FROM per_team_day p
    LEFT JOIN tool_mix tm
      ON tm.org_id = p.org_id
     AND tm.team_id = p.team_id
     AND tm.day = p.day
    ON CONFLICT (org_id, team_id, day) DO UPDATE SET
      cache_hit_ratio_avg = excluded.cache_hit_ratio_avg,
      good_session_pct = excluded.good_session_pct,
      subagent_adoption_pct = excluded.subagent_adoption_pct,
      composite_avg = excluded.composite_avg,
      total_sessions = excluded.total_sessions,
      total_devs = excluded.total_devs,
      tool_mix_json = excluded.tool_mix_json,
      computed_at = now()
  `);

  // `db.execute` returns a `pg.Result` from the node-postgres adapter;
  // `rowCount` is the affected count for INSERT/UPDATE. Type defensively.
  const rowCount = (result as unknown as { rowCount?: number | null }).rowCount;
  return typeof rowCount === 'number' ? rowCount : 0;
};

/**
 * Public entry point for the cron job. Always returns a result (never throws)
 * so the caller (the route handler) can decide on status code without a
 * try/catch of its own. Errors during aggregation are caught, written to
 * `cron_runs.error_message`, and surfaced via the returned `error` field.
 */
export const aggregateTeamMetrics = async (
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
    // Best-effort lifecycle update — if THIS update fails too, surface the
    // original aggregation error to the caller (the cron run row will be
    // left in 'running'; an alarm on 'running' rows older than the cron
    // cadence is the operational backstop).
    try {
      await finishCronRun(db, runId, 'failed', 0, message);
    } catch {
      // Swallow — the original error is more informative than the
      // "couldn't update cron_runs" follow-up error.
    }
    return { status: 'failed', rowsWritten: 0, error: message };
  }
};
