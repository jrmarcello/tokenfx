import type { Statement } from 'better-sqlite3';
import type { DB } from '@/lib/db/client';

/**
 * Aggregations over the `otel_scrapes` append-only table.
 *
 * Claude Code exports Prometheus counters with `session_id` as a label, so
 * each (session_id, metric, labels...) combination is a distinct time
 * series that grows monotonically until the Claude Code process exits.
 * We scrape periodically, so a single series has multiple rows in
 * `otel_scrapes` with increasing values — the last (MAX) value is the
 * "final count" for that series.
 *
 * All queries here MAX per series and then aggregate, which is correct for
 * counters that don't reset within a series' active lifetime. Counter
 * resets across Claude Code process restarts aren't handled — for a
 * personal dashboard the small undercounting that implies is acceptable.
 *
 * When there are no scrapes at all (OTEL disabled), every query returns
 * zeros/empty arrays and `hasOtelData` is false. Callers use that flag
 * to hide OTEL-derived UI gracefully.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Validated 2026-04-18 against `SELECT DISTINCT metric_name FROM otel_scrapes`
// on a real DB populated by Claude Code (non-interactive telemetry). Previous
// constants had wrong suffixes:
//   `_decision_count_total` → actual is `_decision_total` (no `_count`)
//   `_active_time_total_seconds_total` → actual is `_active_time_total`
// Both silently returned 0 because the name never matched. `METRIC_PRS` and
// `METRIC_ACTIVE` were not observed in the validation dump (non-interactive
// session) so their exact names are inferred from the pattern of the other
// counters + Anthropic's published telemetry docs.
const METRIC_DECISION = 'claude_code_code_edit_tool_decision_total';
const METRIC_LINES = 'claude_code_lines_of_code_count_total';
const METRIC_COMMITS = 'claude_code_commit_count_total';
const METRIC_PRS = 'claude_code_pull_request_count_total';
const METRIC_ACTIVE = 'claude_code_active_time_total';
// Cost usage counter emitted by Claude Code. Real name is
// `claude_code_cost_usage_total` (validated); the `_usd_total` alias is a
// defensive fallback in case the OTel exporter ever appends the unit suffix.
const METRIC_COST_ALIASES = [
  'claude_code_cost_usage_total',
  'claude_code_cost_usage_usd_total',
] as const;

export type OtelInsights = {
  hasOtelData: boolean;
  acceptRate: number | null; // accepts / (accepts + rejects); null when zero decisions
  totalAccepts: number;
  totalRejects: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalCommits: number;
  totalPullRequests: number;
  totalActiveSeconds: number;
  costPerLineOfCode: number | null; // null when no code events
};

export type WeeklyAcceptRatePoint = {
  week: string;
  acceptRate: number;
  accepts: number;
  rejects: number;
};

export type SessionOtelStats = {
  hasData: boolean;
  accepts: number;
  rejects: number;
  acceptRate: number | null;
  linesAdded: number;
  linesRemoved: number;
  activeSeconds: number;
  commits: number;
};

type NumRow = { v: number | null };

/**
 * SQL fragment that yields one row per (session_id, decision) with the
 * MAX observed counter value for that series. Used by multiple queries.
 * `metric_name` is a bound parameter — callers must bind METRIC_DECISION
 * as the first positional parameter before any query-specific bindings.
 */
const DECISION_SERIES_SQL = `
  SELECT json_extract(labels_json, '$.session_id') AS session_id,
         json_extract(labels_json, '$.decision')   AS decision,
         MAX(value)                                AS final_value
  FROM otel_scrapes
  WHERE metric_name = ?
    AND json_extract(labels_json, '$.session_id') IS NOT NULL
  GROUP BY session_id, decision
`;

const LINES_SERIES_SQL = `
  SELECT json_extract(labels_json, '$.session_id') AS session_id,
         json_extract(labels_json, '$.type')       AS type,
         MAX(value)                                AS final_value
  FROM otel_scrapes
  WHERE metric_name = ?
    AND json_extract(labels_json, '$.session_id') IS NOT NULL
  GROUP BY session_id, type
`;

type PreparedSet = {
  hasAnyScrape: Statement;
  decisionWindow: Statement<[string, number]>;
  linesWindow: Statement<[string, number]>;
  scalarWindow: Statement<[string, number]>;
  costInWindow: Statement<[number]>;
  weeklyAcceptRate: Statement<[string, number]>;
  sessionDecision: Statement<[string, string]>;
  sessionLines: Statement<[string, string]>;
  sessionScalar: Statement<[string, string]>;
  acceptRatesBySession: Statement<[string, number]>;
  costBySession: Statement<[string, string]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    hasAnyScrape: db.prepare('SELECT 1 FROM otel_scrapes LIMIT 1'),
    decisionWindow: db.prepare(
      `WITH d AS (${DECISION_SERIES_SQL})
       SELECT
         COALESCE(SUM(CASE WHEN decision = 'accept' THEN final_value ELSE 0 END), 0) AS accepts,
         COALESCE(SUM(CASE WHEN decision = 'reject' THEN final_value ELSE 0 END), 0) AS rejects
       FROM d
       JOIN sessions s ON s.id = d.session_id
       WHERE s.started_at >= ?`,
    ),
    linesWindow: db.prepare(
      `WITH l AS (${LINES_SERIES_SQL})
       SELECT
         COALESCE(SUM(CASE WHEN type = 'added' THEN final_value ELSE 0 END), 0) AS added,
         COALESCE(SUM(CASE WHEN type = 'removed' THEN final_value ELSE 0 END), 0) AS removed
       FROM l
       JOIN sessions s ON s.id = l.session_id
       WHERE s.started_at >= ?`,
    ),
    scalarWindow: db.prepare(
      `SELECT COALESCE(SUM(max_val), 0) AS v FROM (
         SELECT MAX(value) AS max_val
         FROM otel_scrapes o
         JOIN sessions s
           ON s.id = json_extract(o.labels_json, '$.session_id')
         WHERE o.metric_name = ?
           AND s.started_at >= ?
         GROUP BY json_extract(o.labels_json, '$.session_id')
       )`,
    ),
    costInWindow: db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) AS v FROM sessions WHERE started_at >= ?',
    ),
    weeklyAcceptRate: db.prepare(
      `WITH d AS (${DECISION_SERIES_SQL})
       SELECT
         strftime('%Y-%W', s.started_at/1000, 'unixepoch', 'localtime') AS week,
         COALESCE(SUM(CASE WHEN d.decision = 'accept' THEN d.final_value ELSE 0 END), 0) AS accepts,
         COALESCE(SUM(CASE WHEN d.decision = 'reject' THEN d.final_value ELSE 0 END), 0) AS rejects
       FROM d
       JOIN sessions s ON s.id = d.session_id
       WHERE s.started_at >= ?
       GROUP BY week
       ORDER BY week ASC`,
    ),
    sessionDecision: db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN json_extract(labels_json, '$.decision') = 'accept' THEN max_val ELSE 0 END), 0) AS accepts,
         COALESCE(SUM(CASE WHEN json_extract(labels_json, '$.decision') = 'reject' THEN max_val ELSE 0 END), 0) AS rejects
       FROM (
         SELECT labels_json, MAX(value) AS max_val
         FROM otel_scrapes
         WHERE metric_name = ?
           AND json_extract(labels_json, '$.session_id') = ?
         GROUP BY json_extract(labels_json, '$.decision')
       )`,
    ),
    sessionLines: db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN json_extract(labels_json, '$.type') = 'added' THEN max_val ELSE 0 END), 0) AS added,
         COALESCE(SUM(CASE WHEN json_extract(labels_json, '$.type') = 'removed' THEN max_val ELSE 0 END), 0) AS removed
       FROM (
         SELECT labels_json, MAX(value) AS max_val
         FROM otel_scrapes
         WHERE metric_name = ?
           AND json_extract(labels_json, '$.session_id') = ?
         GROUP BY json_extract(labels_json, '$.type')
       )`,
    ),
    sessionScalar: db.prepare(
      `SELECT COALESCE(MAX(value), 0) AS v
       FROM otel_scrapes
       WHERE metric_name = ?
         AND json_extract(labels_json, '$.session_id') = ?`,
    ),
    acceptRatesBySession: db.prepare(
      `WITH d AS (${DECISION_SERIES_SQL})
       SELECT
         d.session_id AS sessionId,
         COALESCE(SUM(CASE WHEN d.decision = 'accept' THEN d.final_value ELSE 0 END), 0) AS accepts,
         COALESCE(SUM(CASE WHEN d.decision = 'reject' THEN d.final_value ELSE 0 END), 0) AS rejects
       FROM d
       JOIN sessions s ON s.id = d.session_id
       WHERE s.started_at >= ?
       GROUP BY d.session_id`,
    ),
    costBySession: db.prepare(
      // MAX per (session_id, model) series → SUM across models per session.
      // Case-insensitive matching via LOWER() + 2 aliases covers the known
      // exporter name variants.
      `WITH c AS (
         SELECT json_extract(labels_json, '$.session_id') AS session_id,
                json_extract(labels_json, '$.model')      AS model,
                MAX(value)                                AS final_value
         FROM otel_scrapes
         WHERE LOWER(metric_name) IN (?, ?)
           AND json_extract(labels_json, '$.session_id') IS NOT NULL
         GROUP BY session_id, model
       )
       SELECT session_id AS sessionId, COALESCE(SUM(final_value), 0) AS cost
       FROM c
       GROUP BY session_id`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

function hasAnyOtelScrapes(p: PreparedSet): boolean {
  const row = p.hasAnyScrape.get() as unknown;
  return row !== undefined;
}

/**
 * Global OTEL insights for the dashboard's /effectiveness page. Scoped to
 * sessions that started within the last `days`. All numeric fields fall
 * back to 0 (or null for rates) when OTEL has no data — callers should
 * check `hasOtelData` before rendering the section.
 */
export function getOtelInsights(db: DB, days: number): OtelInsights {
  const empty: OtelInsights = {
    hasOtelData: false,
    acceptRate: null,
    totalAccepts: 0,
    totalRejects: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalCommits: 0,
    totalPullRequests: 0,
    totalActiveSeconds: 0,
    costPerLineOfCode: null,
  };
  const p = getPrepared(db);
  if (!hasAnyOtelScrapes(p)) return empty;

  const cutoff = Date.now() - days * DAY_MS;

  const decisionRow = p.decisionWindow.get(METRIC_DECISION, cutoff) as
    | { accepts: number; rejects: number }
    | undefined;

  const linesRow = p.linesWindow.get(METRIC_LINES, cutoff) as
    | { added: number; removed: number }
    | undefined;

  const scalar = (metric: string): number => {
    const row = p.scalarWindow.get(metric, cutoff) as NumRow | undefined;
    return row?.v ?? 0;
  };

  const totalCommits = scalar(METRIC_COMMITS);
  const totalPullRequests = scalar(METRIC_PRS);
  const totalActiveSeconds = scalar(METRIC_ACTIVE);

  const accepts = decisionRow?.accepts ?? 0;
  const rejects = decisionRow?.rejects ?? 0;
  const decisions = accepts + rejects;
  const acceptRate = decisions > 0 ? accepts / decisions : null;

  const totalLinesAdded = linesRow?.added ?? 0;
  const totalLinesRemoved = linesRow?.removed ?? 0;
  const totalLinesTouched = totalLinesAdded + totalLinesRemoved;

  // Cost per line = total session cost (in window) / lines touched. Uses
  // the canonical sessions.total_cost_usd so the metric matches the
  // rest of the dashboard.
  let costPerLineOfCode: number | null = null;
  if (totalLinesTouched > 0) {
    const costRow = p.costInWindow.get(cutoff) as NumRow | undefined;
    const cost = costRow?.v ?? 0;
    costPerLineOfCode = cost / totalLinesTouched;
  }

  const hasOtelData =
    decisions > 0 ||
    totalLinesTouched > 0 ||
    totalCommits > 0 ||
    totalPullRequests > 0 ||
    totalActiveSeconds > 0;

  return {
    hasOtelData,
    acceptRate,
    totalAccepts: accepts,
    totalRejects: rejects,
    totalLinesAdded,
    totalLinesRemoved,
    totalCommits,
    totalPullRequests,
    totalActiveSeconds,
    costPerLineOfCode,
  };
}

/**
 * Weekly accept rate (accepts / (accepts + rejects)) grouped by the week
 * a session started in. Returns [] when there's no OTEL decision data.
 */
export function getWeeklyAcceptRate(
  db: DB,
  weeks: number,
): WeeklyAcceptRatePoint[] {
  const p = getPrepared(db);
  if (!hasAnyOtelScrapes(p)) return [];
  const cutoff = Date.now() - weeks * WEEK_MS;
  const rows = p.weeklyAcceptRate.all(METRIC_DECISION, cutoff) as Array<{
    week: string;
    accepts: number;
    rejects: number;
  }>;

  return rows
    .filter((r) => r.accepts + r.rejects > 0)
    .map((r) => ({
      week: r.week,
      accepts: r.accepts,
      rejects: r.rejects,
      acceptRate: r.accepts / (r.accepts + r.rejects),
    }));
}

/**
 * Per-session OTEL stats for the session detail page. Returns hasData=false
 * when the session has no OTEL events (either OTEL is off, or the session
 * pre-dates OTEL activation). Callers should hide the extra KPI row then.
 */
export function getSessionOtelStats(
  db: DB,
  sessionId: string,
): SessionOtelStats {
  const empty: SessionOtelStats = {
    hasData: false,
    accepts: 0,
    rejects: 0,
    acceptRate: null,
    linesAdded: 0,
    linesRemoved: 0,
    activeSeconds: 0,
    commits: 0,
  };
  const p = getPrepared(db);
  if (!hasAnyOtelScrapes(p)) return empty;

  const decisionRow = p.sessionDecision.get(METRIC_DECISION, sessionId) as
    | { accepts: number; rejects: number }
    | undefined;

  const linesRow = p.sessionLines.get(METRIC_LINES, sessionId) as
    | { added: number; removed: number }
    | undefined;

  const scalarForSession = (metric: string): number => {
    const row = p.sessionScalar.get(metric, sessionId) as NumRow | undefined;
    return row?.v ?? 0;
  };

  const accepts = decisionRow?.accepts ?? 0;
  const rejects = decisionRow?.rejects ?? 0;
  const linesAdded = linesRow?.added ?? 0;
  const linesRemoved = linesRow?.removed ?? 0;
  const activeSeconds = scalarForSession(METRIC_ACTIVE);
  const commits = scalarForSession(METRIC_COMMITS);

  const hasData =
    accepts + rejects > 0 ||
    linesAdded + linesRemoved > 0 ||
    activeSeconds > 0 ||
    commits > 0;

  const acceptRate =
    accepts + rejects > 0 ? accepts / (accepts + rejects) : null;

  return {
    hasData,
    accepts,
    rejects,
    acceptRate,
    linesAdded,
    linesRemoved,
    activeSeconds,
    commits,
  };
}

/**
 * Map of sessionId → acceptRate, for sessions in the given window that
 * have OTEL decision data. Used by `effectiveness.ts` to feed the score
 * composite without running a per-session query in a loop.
 */
export function getAcceptRatesBySession(
  db: DB,
  days: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const p = getPrepared(db);
  if (!hasAnyOtelScrapes(p)) return out;
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.acceptRatesBySession.all(METRIC_DECISION, cutoff) as Array<{
    sessionId: string;
    accepts: number;
    rejects: number;
  }>;
  for (const r of rows) {
    const decisions = r.accepts + r.rejects;
    if (decisions > 0) {
      out.set(r.sessionId, r.accepts / decisions);
    }
  }
  return out;
}

/**
 * Authoritative cost (USD) per session, derived from
 * `claude_code_cost_usage_total` scrapes. For each distinct
 * (session_id, model) series we take MAX(value) — the last observed
 * cumulative counter value — and SUM across models per session.
 *
 * Matching is case-insensitive and accepts the `_usd_total` alias in
 * case the OTel exporter starts appending the unit suffix. Sessions
 * without any scrape don't appear in the returned Map — callers fall
 * back to `sessions.total_cost_usd` (computeCost-based) for those.
 *
 * Counter reset caveat (shared with other OTEL aggregations here): a
 * Claude Code process restart resets the counter to 0; MAX then shows
 * only the post-restart segment for that run. Undercount is bounded
 * by the lost delta between the last pre-restart scrape and restart.
 */
export function getOtelCostBySession(db: DB): Map<string, number> {
  const out = new Map<string, number>();
  const p = getPrepared(db);
  if (!hasAnyOtelScrapes(p)) return out;
  const rows = p.costBySession.all(...METRIC_COST_ALIASES) as Array<{
    sessionId: string;
    cost: number;
  }>;
  for (const r of rows) {
    if (Number.isFinite(r.cost) && r.cost > 0) {
      out.set(r.sessionId, r.cost);
    }
  }
  return out;
}

/** Convenience wrapper for the single-session lookup used by the writer. */
export function getOtelCostForSession(
  db: DB,
  sessionId: string,
): number | null {
  const map = getOtelCostBySession(db);
  return map.get(sessionId) ?? null;
}
