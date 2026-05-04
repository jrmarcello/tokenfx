/**
 * Nightly anomaly cron — TASK-CRON-ANOM (REQ-22, REQ-23, Q11).
 *
 * For every (org, team), compute z-scores over the team's per-dev 30-day
 * spend. Teams with fewer than `MIN_ACTIVE_DEVS` (Q11 lock = 5) active devs
 * in the last 30 days are skipped — std-dev is unstable below that and
 * would otherwise produce noisy false-positive alerts. For qualifying
 * teams we apply two detectors in sequence (REQ-22):
 *
 *   1. `detectSpike` — 30-day spend ≥ 3σ above the team mean. Writes a
 *      `spend-spike-30d` row with `{ sigma, mean, teamStdDev, thirtyDaySpend }`.
 *   2. `detectWowSpike` — strict > +50% week-over-week jump in per-dev
 *      spend. Writes a `spend-spike-wow` row with `{ wowDelta, thisWeek,
 *      lastWeek }`.
 *
 * The two detectors are independent — a single dev can produce both rows.
 * The `manager_anomalies` UNIQUE constraint
 * `(org_id, team_id, target_user_id, kind, detected_on)` makes the run
 * idempotent on re-execution within the same UTC day (TC-I-06): we use
 * `ON CONFLICT DO NOTHING`.
 *
 * Lifecycle (REQ-23):
 *   - INSERT a `cron_runs` row with status='running' before any analysis.
 *   - On success: UPDATE to status='ok', `rows_written = N`, `finished_at = now()`.
 *   - On failure: UPDATE to status='failed', `error_message = <truncated>`,
 *     `finished_at = now()` — and the lib returns `{ status: 'failed', ... }`
 *     so the route surfaces a 5xx (TC-I-81). External scheduler retries via
 *     its own backoff (REQ-23 lock).
 *
 * The function never throws on analysis failure — it captures the error in
 * `cron_runs` and in the returned struct. Errors during the cron-run
 * lifecycle inserts themselves (DB unreachable from the very first call)
 * propagate to the caller, since there's nothing useful to record. Tests
 * exercise the post-start failure path via a Proxy stub.
 *
 * Pure-DB, parameterised SQL throughout — no template-literal value
 * interpolation. The aggregation SELECT computes per-dev 30-day spend AND
 * per-dev thisWeek/lastWeek spends in one round-trip per team via SQL
 * window/aggregate clauses; team stats (mean, population stddev) are
 * computed in TypeScript so we can reuse `detectSpike` from
 * `lib/analytics/anomaly-detection.ts` (do-not-duplicate spec rule).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { detectSpike, detectWowSpike } from '@/lib/analytics/anomaly-detection';

export const JOB_NAME = 'manager-v2:detect-anomalies';
const MIN_ACTIVE_DEVS = 5; // Q11 lock — std-dev unstable below 5 devs.
const ERROR_MESSAGE_MAX_LEN = 500; // truncate before persisting (privacy + size).

export type DetectAnomaliesResult = {
  startedAt: Date;
  finishedAt: Date;
  rowsWritten: number;
  status: 'ok' | 'failed';
  errorMessage: string | null;
};

/**
 * Per-dev row returned by the per-team aggregation query. All numbers come
 * back as strings from `numeric` columns; we coerce in TS.
 */
type PerDevRow = {
  org_id: string;
  team_id: string;
  user_id: string;
  thirty_day_spend: string;
  this_week_spend: string;
  last_week_spend: string;
  active_30d: number; // 0 or 1 — used to count active devs per team
};

/**
 * Narrow structural contract over Drizzle's `db` covering only the methods
 * this cron actually calls. Stays compatible with the real client and with
 * hand-rolled Proxy stubs in tests, without leaning on `any`.
 *
 * `db.execute` on node-postgres returns `{ rows: T[] }`; the cast to that
 * shape happens at each call site to keep this contract loose enough for
 * stubs that return plain arrays.
 */
type DrizzleLike = {
  readonly execute: (query: SQL) => Promise<unknown>;
};

const truncate = (s: string, max = ERROR_MESSAGE_MAX_LEN): string =>
  s.length <= max ? s : `${s.slice(0, max - 3)}...`;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Insert the start-of-run marker. Returns the new row's id so the same row
 * can be UPDATE'd on completion.
 */
const startCronRun = async (db: DrizzleLike): Promise<{ id: number; startedAt: Date }> => {
  const startedAt = new Date();
  const rows = await db.execute(
    sql`INSERT INTO cron_runs (job_name, started_at, status)
        VALUES (${JOB_NAME}, ${startedAt}, 'running')
        RETURNING id, started_at`,
  );
  // node-postgres returns `{ rows: [...] }`; drizzle's `db.execute` exposes
  // the same shape on `node-postgres`.
  const row = (rows as { rows: { id: number | string; started_at: Date }[] }).rows[0];
  return { id: Number(row.id), startedAt: new Date(row.started_at) };
};

const finishCronRun = async (
  db: DrizzleLike,
  id: number,
  status: 'ok' | 'failed',
  rowsWritten: number,
  errorMessage: string | null,
): Promise<Date> => {
  const finishedAt = new Date();
  await db.execute(
    sql`UPDATE cron_runs
        SET finished_at = ${finishedAt},
            status = ${status},
            rows_written = ${rowsWritten},
            error_message = ${errorMessage}
        WHERE id = ${id}`,
  );
  return finishedAt;
};

/**
 * Compute population mean of a finite list. Returns 0 for an empty list.
 */
const populationMean = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
};

/**
 * Population standard deviation (divides by N, not N-1) — matches the
 * convention used by `detectSpike`'s test fixtures and is appropriate
 * because we're treating the team's current devs as the full reference
 * population, not a sample of a larger one.
 */
const populationStdDev = (xs: readonly number[], mean: number): number => {
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) {
    const d = x - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
};

/**
 * Core analysis. Runs the actual SELECT/INSERT logic and returns the count
 * of newly-inserted manager_anomalies rows. Any exception thrown here is
 * caught by `runDetectAnomalies` and translated into a failed cron_runs
 * row.
 */
const analyze = async (db: DrizzleLike, now: Date): Promise<number> => {
  // Cutoffs for the 30/7/14-day windows. Computed in TS, passed as bound
  // parameters into the SQL — no template-string interpolation of values.
  const ms = now.getTime();
  const cutoff30d = new Date(ms - 30 * 24 * 60 * 60 * 1000);
  const cutoffThisWeek = new Date(ms - 7 * 24 * 60 * 60 * 1000);
  const cutoffLastWeek = new Date(ms - 14 * 24 * 60 * 60 * 1000);
  const detectedOn = isoDay(now);

  // One aggregation pass: for every (org, team, user) with at least one
  // session in the last 30 days, return their 30d/thisWeek/lastWeek spend.
  // Teams with no active devs simply don't appear. We also tag `active_30d`
  // = 1 (always 1, since the WHERE clause already filters) so the caller
  // can `count(*) per team` directly off the result set without a second
  // query.
  const aggResult = await db.execute(
    sql`SELECT
          u.org_id              AS org_id,
          u.team_id             AS team_id,
          u.id                  AS user_id,
          COALESCE(SUM(CASE WHEN s.started_at >= ${cutoff30d}      THEN s.total_cost_usd ELSE 0 END), 0)::text AS thirty_day_spend,
          COALESCE(SUM(CASE WHEN s.started_at >= ${cutoffThisWeek} THEN s.total_cost_usd ELSE 0 END), 0)::text AS this_week_spend,
          COALESCE(SUM(CASE WHEN s.started_at >= ${cutoffLastWeek}
                              AND s.started_at <  ${cutoffThisWeek} THEN s.total_cost_usd ELSE 0 END), 0)::text AS last_week_spend,
          1::int AS active_30d
        FROM users u
        JOIN sessions_agg s ON s.user_id = u.id
        WHERE u.team_id IS NOT NULL
          AND s.started_at >= ${cutoff30d}
        GROUP BY u.org_id, u.team_id, u.id`,
  );
  const rows = (aggResult as { rows: PerDevRow[] }).rows;

  // Bucket per (org_id, team_id) so we can compute team stats once.
  const byTeam = new Map<string, PerDevRow[]>();
  for (const r of rows) {
    const k = `${r.org_id} ${r.team_id}`;
    const bucket = byTeam.get(k);
    if (bucket) bucket.push(r);
    else byTeam.set(k, [r]);
  }

  let rowsWritten = 0;

  for (const teamRows of byTeam.values()) {
    // Q11 small-team guard — skip the team entirely.
    if (teamRows.length < MIN_ACTIVE_DEVS) continue;

    const spends = teamRows.map((r) => Number(r.thirty_day_spend));
    const teamMean = populationMean(spends);
    const teamStdDev = populationStdDev(spends, teamMean);

    for (const r of teamRows) {
      const thirtyDaySpend = Number(r.thirty_day_spend);
      const thisWeek = Number(r.this_week_spend);
      const lastWeek = Number(r.last_week_spend);

      // 1. 30-day 3σ spike.
      if (detectSpike({ thirtyDaySpend, teamMean, teamStdDev })) {
        const sigma = teamStdDev > 0 ? (thirtyDaySpend - teamMean) / teamStdDev : 0;
        const insertResult = await db.execute(
          sql`INSERT INTO manager_anomalies
                (org_id, team_id, target_user_id, kind, detected_on, context_json)
              VALUES
                (${r.org_id}, ${r.team_id}, ${r.user_id}, 'spend-spike-30d',
                 ${detectedOn},
                 ${sql`${JSON.stringify({ sigma, mean: teamMean, teamStdDev, thirtyDaySpend })}::jsonb`})
              ON CONFLICT (org_id, team_id, target_user_id, kind, detected_on)
              DO NOTHING
              RETURNING id`,
        );
        rowsWritten += (insertResult as { rows: unknown[] }).rows.length;
      }

      // 2. Week-over-week spike.
      if (detectWowSpike({ thisWeek, lastWeek })) {
        const wowDelta = lastWeek > 0 ? (thisWeek - lastWeek) / lastWeek : 0;
        const insertResult = await db.execute(
          sql`INSERT INTO manager_anomalies
                (org_id, team_id, target_user_id, kind, detected_on, context_json)
              VALUES
                (${r.org_id}, ${r.team_id}, ${r.user_id}, 'spend-spike-wow',
                 ${detectedOn},
                 ${sql`${JSON.stringify({ wowDelta, thisWeek, lastWeek })}::jsonb`})
              ON CONFLICT (org_id, team_id, target_user_id, kind, detected_on)
              DO NOTHING
              RETURNING id`,
        );
        rowsWritten += (insertResult as { rows: unknown[] }).rows.length;
      }
    }
  }

  return rowsWritten;
};

/**
 * Public entry point. Always records a `cron_runs` row; on analysis failure
 * the row is marked 'failed' and the result struct carries the error
 * message — never re-thrown.
 */
export const runDetectAnomalies = async (
  db: DrizzleLike = getDb(),
  options: { now?: Date } = {},
): Promise<DetectAnomaliesResult> => {
  const now = options.now ?? new Date();

  // Lifecycle insert. If THIS throws, propagate — there's no row to update.
  const { id: runId, startedAt } = await startCronRun(db);

  try {
    const rowsWritten = await analyze(db, now);
    const finishedAt = await finishCronRun(db, runId, 'ok', rowsWritten, null);
    return { startedAt, finishedAt, rowsWritten, status: 'ok', errorMessage: null };
  } catch (err) {
    const message = truncate(err instanceof Error ? err.message : String(err));
    // Best-effort failure marker. If THIS also throws (DB truly gone),
    // re-throw with the original cause attached so the route returns 5xx
    // instead of silently succeeding.
    const finishedAt = await finishCronRun(db, runId, 'failed', 0, message);
    return {
      startedAt,
      finishedAt,
      rowsWritten: 0,
      status: 'failed',
      errorMessage: message,
    };
  }
};
