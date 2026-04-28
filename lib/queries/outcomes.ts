import type { DB } from '@/lib/db/client';
import {
  effectiveCostForSession,
  type Calibration,
} from '@/lib/analytics/cost-calibration';
import { getCostCalibration } from '@/lib/queries/calibration';
import type { OutcomeStatus } from '@/lib/ingest/git/types';

/**
 * Per-session outcome row mapped to camelCase. Mirrors the `session_outcomes`
 * table schema. `mergedPrCount` is `null` when GH PR lookup is disabled / not
 * evaluated; `0` would mean "evaluated and there are zero merged PRs".
 */
export type SessionOutcome = {
  sessionId: string;
  commitCount: number;
  locAdded: number;
  locRemoved: number;
  filesChanged: number;
  revertsWithin7d: number;
  mergedPrCount: number | null;
  status: OutcomeStatus;
  lastEvaluatedAt: number;
};

export type CostPerLocResult = {
  totalCost: number;
  totalLoc: number;
  ratio: number | null;
};

export type CostPerCommitResult = {
  totalCost: number;
  totalCommits: number;
  ratio: number | null;
};

export type RevertRateResult = {
  sessionsWithCommits: number;
  sessionsWithReverts: number;
  ratio: number | null;
};

export type HighCostNoOutputSession = {
  sessionId: string;
  project: string;
  totalCostUsd: number;
  commitCount: number;
};

const DAY_MS = 86_400_000;

/**
 * Raw join row used by the cost/LOC aggregations. We pull `total_cost_usd` and
 * `total_cost_usd_otel` plus the session's dominant model so the JS-side
 * `effectiveCostForSession` cascade (OTEL → calibrated family → calibrated
 * global → list) is identical to the rest of the dashboard. Outcomes (LOC,
 * commits, reverts) are pulled in the same query to avoid N+1.
 *
 * Dominant model is computed via a correlated MAX(cost) lookup over `turns`
 * (mirrors the pattern in `lib/queries/calibration.ts`). Sessions with no
 * `turns` rows fall back to an empty string — `effectiveCostForSession` maps
 * unknown models to the global / list fallback, which is the right behaviour
 * for early sessions that have no per-turn cost data yet.
 */
type SessionOutcomeJoinRow = {
  id: string;
  project: string;
  total_cost_usd: number;
  total_cost_usd_otel: number | null;
  dominant_model: string | null;
  commit_count: number;
  loc_added: number;
  loc_removed: number;
  reverts_within_7d: number;
};

type SessionOutcomeRow = {
  session_id: string;
  commit_count: number;
  loc_added: number;
  loc_removed: number;
  files_changed: number;
  reverts_within_7d: number;
  merged_pr_count: number | null;
  status: string;
  last_evaluated_at: number;
};

type RevertRow = {
  sessionsWithCommits: number;
  sessionsWithReverts: number;
};

type PreparedSet = {
  getOutcome: ReturnType<DB['prepare']>;
  // Joined session × outcome rows for the window-aware aggregations. The
  // single shape works for getCostPerLoc, getCostPerCommit, and
  // getHighCostNoOutputSessions — they all need the same effective-cost
  // ingredients.
  joinedInWindow: ReturnType<DB['prepare']>;
  revertRate: ReturnType<DB['prepare']>;
};

const cache = new WeakMap<DB, PreparedSet>();

/**
 * Subquery: pick the model with the highest SUM(cost_usd) across each
 * session's turns. Mirrors `session_dominant` in
 * `lib/queries/calibration.ts`. Used to feed `effectiveCostForSession` so
 * family-specific calibration applies.
 */
const DOMINANT_MODEL_CTE = `
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
`;

const getPrepared = (db: DB): PreparedSet => {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    getOutcome: db.prepare(
      `SELECT session_id, commit_count, loc_added, loc_removed,
              files_changed, reverts_within_7d, merged_pr_count,
              status, last_evaluated_at
         FROM session_outcomes
         WHERE session_id = ?`,
    ),
    // Inner-join on `session_outcomes`: aggregations should only consider
    // sessions that have actually been evaluated — sessions with no row are
    // implicitly excluded (UI surfaces them as "not yet evaluated"). Window
    // is bound to `sessions.started_at` to match every other dashboard
    // query.
    joinedInWindow: db.prepare(
      `${DOMINANT_MODEL_CTE}
       SELECT
         s.id,
         s.project,
         s.total_cost_usd,
         s.total_cost_usd_otel,
         sd.dominant_model AS dominant_model,
         o.commit_count,
         o.loc_added,
         o.loc_removed,
         o.reverts_within_7d
       FROM sessions s
       JOIN session_outcomes o ON o.session_id = s.id
       LEFT JOIN session_dominant sd ON sd.session_id = s.id
       WHERE s.started_at >= ?`,
    ),
    revertRate: db.prepare(
      `SELECT
         SUM(CASE WHEN o.commit_count > 0 THEN 1 ELSE 0 END)        AS sessionsWithCommits,
         SUM(CASE WHEN o.reverts_within_7d > 0 THEN 1 ELSE 0 END)   AS sessionsWithReverts
       FROM sessions s
       JOIN session_outcomes o ON o.session_id = s.id
       WHERE s.started_at >= ?`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
};

/**
 * Map a raw `session_outcomes` row to the camelCase domain type. Status is
 * narrowed defensively: legacy rows might pre-date the CHECK constraint, so
 * we accept the four canonical values and otherwise log nothing — the
 * default `'evaluated'` keeps the UI rendering instead of throwing.
 */
const toSessionOutcome = (row: SessionOutcomeRow): SessionOutcome => ({
  sessionId: row.session_id,
  commitCount: row.commit_count,
  locAdded: row.loc_added,
  locRemoved: row.loc_removed,
  filesChanged: row.files_changed,
  revertsWithin7d: row.reverts_within_7d,
  mergedPrCount: row.merged_pr_count,
  status: narrowStatus(row.status),
  lastEvaluatedAt: row.last_evaluated_at,
});

const narrowStatus = (raw: string): OutcomeStatus => {
  if (
    raw === 'evaluated' ||
    raw === 'cwd-missing' ||
    raw === 'not-a-git-repo' ||
    raw === 'no-user-email'
  ) {
    return raw;
  }
  return 'evaluated';
};

/**
 * Compute effective cost for a single session row using
 * `effectiveCostForSession`. Centralises the OTEL → calibrated → list
 * cascade so all aggregations in this module agree on the lens.
 */
const effectiveCostFor = (
  row: Pick<
    SessionOutcomeJoinRow,
    'total_cost_usd' | 'total_cost_usd_otel' | 'dominant_model'
  >,
  calibration: Calibration,
): number =>
  effectiveCostForSession({
    localCost: row.total_cost_usd,
    otelCost: row.total_cost_usd_otel,
    model: row.dominant_model ?? '',
    calibration,
  }).value;

/**
 * Fetch the outcome row for `sessionId`, or `null` when no row exists.
 * The UI maps `null` → "Outcome not yet evaluated" empty state.
 */
export const getSessionOutcome = (
  db: DB,
  sessionId: string,
): SessionOutcome | null => {
  const p = getPrepared(db);
  const row = p.getOutcome.get(sessionId) as SessionOutcomeRow | undefined;
  if (!row) return null;
  return toSessionOutcome(row);
};

/**
 * Cost-per-LOC aggregate over the last `days`.
 *
 * `totalLoc` is `SUM(loc_added)` only — removed lines aren't shipped value
 * (locked decision Q3, see spec). `totalCost` flows through
 * `effectiveCostForSession` per session so the aggregate inherits the same
 * calibration cascade as the rest of the dashboard. Ratio is `null` when
 * `totalLoc` is 0 to avoid division by zero.
 */
export const getCostPerLoc = (
  db: DB,
  opts: { days: number },
): CostPerLocResult => {
  const p = getPrepared(db);
  const calibration = getCostCalibration(db);
  const cutoff = Date.now() - opts.days * DAY_MS;
  const rows = p.joinedInWindow.all(cutoff) as SessionOutcomeJoinRow[];

  let totalCost = 0;
  let totalLoc = 0;
  for (const row of rows) {
    totalCost += effectiveCostFor(row, calibration);
    totalLoc += row.loc_added;
  }
  const ratio = totalLoc > 0 ? totalCost / totalLoc : null;
  return { totalCost, totalLoc, ratio };
};

/**
 * Cost-per-commit aggregate over the last `days`. Same calibration cascade
 * as `getCostPerLoc`. `ratio` is `null` when `totalCommits` is 0.
 */
export const getCostPerCommit = (
  db: DB,
  opts: { days: number },
): CostPerCommitResult => {
  const p = getPrepared(db);
  const calibration = getCostCalibration(db);
  const cutoff = Date.now() - opts.days * DAY_MS;
  const rows = p.joinedInWindow.all(cutoff) as SessionOutcomeJoinRow[];

  let totalCost = 0;
  let totalCommits = 0;
  for (const row of rows) {
    totalCost += effectiveCostFor(row, calibration);
    totalCommits += row.commit_count;
  }
  const ratio = totalCommits > 0 ? totalCost / totalCommits : null;
  return { totalCost, totalCommits, ratio };
};

/**
 * Revert rate over the last `days`.
 *
 * Denominator: sessions with `commit_count > 0` (no point measuring revert
 * rate on sessions that shipped nothing).
 * Numerator: sessions with `reverts_within_7d > 0`.
 *
 * `ratio` is `null` when the denominator is 0 — the UI surfaces this as
 * "—" rather than 0%.
 */
export const getRevertRate = (
  db: DB,
  opts: { days: number },
): RevertRateResult => {
  const p = getPrepared(db);
  const cutoff = Date.now() - opts.days * DAY_MS;
  const row = p.revertRate.get(cutoff) as RevertRow | undefined;
  // SUM over zero rows yields NULL in SQLite; map those to 0 in JS so the
  // shape is always concrete. better-sqlite3 returns null typed as number,
  // hence the `?? 0` guard.
  const sessionsWithCommits = row?.sessionsWithCommits ?? 0;
  const sessionsWithReverts = row?.sessionsWithReverts ?? 0;
  const ratio =
    sessionsWithCommits > 0 ? sessionsWithReverts / sessionsWithCommits : null;
  return { sessionsWithCommits, sessionsWithReverts, ratio };
};

/**
 * Top-N "high-cost no-output" sessions in the window: sessions that burned
 * tokens (high effective cost) but produced no commits attributable to the
 * user. Ordered by effective cost DESC; ties broken by session id ASC for
 * determinism. Used by the overview "Outcomes" card to surface the most
 * actionable signals.
 *
 * Sort is in JS because the cost function isn't expressible as a single
 * SQL expression once family-specific calibration enters the mix —
 * `effectiveCostForSession` cascades through OTEL, family-specific rate,
 * global rate, list price.
 */
export const getHighCostNoOutputSessions = (
  db: DB,
  opts: { days: number; limit: number },
): HighCostNoOutputSession[] => {
  const p = getPrepared(db);
  const calibration = getCostCalibration(db);
  const cutoff = Date.now() - opts.days * DAY_MS;
  const rows = p.joinedInWindow.all(cutoff) as SessionOutcomeJoinRow[];

  const noOutput = rows.filter((row) => row.commit_count === 0);
  const enriched = noOutput.map((row) => ({
    sessionId: row.id,
    project: row.project,
    totalCostUsd: effectiveCostFor(row, calibration),
    commitCount: row.commit_count,
  }));
  enriched.sort((a, b) => {
    if (b.totalCostUsd !== a.totalCostUsd) {
      return b.totalCostUsd - a.totalCostUsd;
    }
    // Stable tiebreak so the leaderboard is deterministic across calls.
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  return enriched.slice(0, opts.limit);
};
