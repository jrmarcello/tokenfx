import type { DB } from '@/lib/db/client';
import {
  correctionPenalties,
  effectivenessScore,
  type TurnLike,
} from '@/lib/analytics/scoring';
import {
  groupByFamily,
  type ModelBreakdownItem,
} from '@/lib/analytics/model';
import {
  buildTrend,
  type RawTrendRow,
  type ToolTrendResult,
} from '@/lib/analytics/tool-trend';
import { getAcceptRatesBySession } from '@/lib/queries/otel';

export type { ModelBreakdownItem } from '@/lib/analytics/model';
export type { ToolTrendResult } from '@/lib/analytics/tool-trend';

export type EffectivenessKpis = {
  avgScore: number | null;
  avgOutputInputRatio: number | null;
  avgCacheHitRatio: number | null;
  ratedSessionCount: number;
};

export type WeeklyRatioPoint = { week: string; outputInputRatio: number };
export type CostPerTurnEntry = { cost: number };
export type ToolLeaderboardItem = {
  toolName: string;
  count: number;
  errorCount: number;
};
export type SessionScore = {
  sessionId: string;
  project: string;
  score: number;
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_SCORED_SESSIONS = 50;

type KpiRow = {
  avgCacheHitRatio: number | null;
  sumOutput: number | null;
  sumInput: number | null;
  ratedSessionCount: number;
};

type WeeklyRow = {
  week: string;
  sumOutput: number;
  sumInput: number;
};

type CostRow = { cost: number };

type TopSessionRow = {
  id: string;
  project: string;
  cacheHitRatio: number | null;
  outputInputRatio: number | null;
  avgRating: number | null;
  toolErrorRate: number | null;
};

type TurnRow = {
  session_id: string;
  id: string;
  sequence: number;
  user_prompt: string | null;
};

type LeaderboardRow = {
  toolName: string;
  count: number;
  errorCount: number | null;
};

type ModelCostRow = { model: string; cost: number };

type PreparedSet = {
  kpis: import('better-sqlite3').Statement<[number, number]>;
  weeklyRatio: import('better-sqlite3').Statement<[number]>;
  costPerTurn: import('better-sqlite3').Statement<[number]>;
  toolLeaderboard: import('better-sqlite3').Statement<[number, number]>;
  topSessions: import('better-sqlite3').Statement<[number, number]>;
  turnsForSessions: import('better-sqlite3').Statement<[string]>;
  modelBreakdown: import('better-sqlite3').Statement<[number]>;
  toolErrorTrend: import('better-sqlite3').Statement<[number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    kpis: db.prepare(
      // Weighted ratio is the mathematically-correct SUM(output)/SUM(input).
      // Previous formula `SUM(ratio × (input+output))/SUM(input+output)` was
      // double-weighted and produced ~10× inflated values on real data.
      `SELECT
         AVG(v.cache_hit_ratio) AS avgCacheHitRatio,
         SUM(s.total_output_tokens) AS sumOutput,
         SUM(s.total_input_tokens) AS sumInput,
         (SELECT COUNT(DISTINCT t.session_id)
            FROM ratings r JOIN turns t ON t.id = r.turn_id
            JOIN sessions ss ON ss.id = t.session_id
            WHERE ss.started_at >= ?) AS ratedSessionCount
       FROM session_effectiveness v
       JOIN sessions s ON s.id = v.id
       WHERE s.started_at >= ?`,
    ),
    weeklyRatio: db.prepare(
      `SELECT
         strftime('%Y-%W', started_at/1000, 'unixepoch', 'localtime') AS week,
         COALESCE(SUM(total_output_tokens), 0) AS sumOutput,
         COALESCE(SUM(total_input_tokens), 0) AS sumInput
       FROM sessions
       WHERE started_at >= ?
       GROUP BY week
       ORDER BY week ASC`,
    ),
    costPerTurn: db.prepare(
      // Inline COALESCE prefers OTEL authoritative cost; falls back to the
      // local sum. Bypasses the `session_effectiveness` view (Design §4) so
      // every read of "cost" in this module goes through the same funnel.
      // Cost cascade: OTEL → list × global calibration rate → list.
      `SELECT COALESCE(
                total_cost_usd_otel,
                total_cost_usd * (SELECT effective_rate FROM cost_calibration WHERE family='global' LIMIT 1),
                total_cost_usd
              ) / NULLIF(turn_count, 0) AS cost
       FROM sessions
       WHERE started_at >= ? AND turn_count > 0`,
    ),
    toolLeaderboard: db.prepare(
      `SELECT tc.tool_name AS toolName,
              COUNT(*) AS count,
              COALESCE(SUM(tc.result_is_error), 0) AS errorCount
       FROM tool_calls tc
       JOIN turns t ON t.id = tc.turn_id
       JOIN sessions s ON s.id = t.session_id
       WHERE s.started_at >= ?
       GROUP BY tc.tool_name
       ORDER BY count DESC
       LIMIT ?`,
    ),
    topSessions: db.prepare(
      // Orders by authoritative cost (OTEL when present, else local sum) so
      // sessions with hybrid provenance are ranked on the same axis the UI
      // eventually renders.
      `SELECT s.id AS id,
              s.project AS project,
              v.cache_hit_ratio AS cacheHitRatio,
              v.output_input_ratio AS outputInputRatio,
              v.avg_rating AS avgRating,
              (SELECT CAST(SUM(tc.result_is_error) AS REAL) /
                      NULLIF(COUNT(tc.id), 0)
                 FROM tool_calls tc
                 JOIN turns t ON t.id = tc.turn_id
                 WHERE t.session_id = s.id) AS toolErrorRate
       FROM sessions s
       LEFT JOIN session_effectiveness v ON v.id = s.id
       WHERE s.started_at >= ?
       ORDER BY COALESCE(
         s.total_cost_usd_otel,
         s.total_cost_usd * (SELECT effective_rate FROM cost_calibration WHERE family='global' LIMIT 1),
         s.total_cost_usd
       ) DESC
       LIMIT ?`,
    ),
    turnsForSessions: db.prepare(
      // Single round-trip for all top-N sessions. `?` binds a JSON array of
      // session ids; `json_each` unpacks it into a virtual table we join on.
      `SELECT t.session_id, t.id, t.sequence, t.user_prompt
       FROM turns t
       JOIN json_each(?) j ON j.value = t.session_id
       ORDER BY t.session_id, t.sequence ASC`,
    ),
    modelBreakdown: db.prepare(
      // Aggregate per exact model string within the session window. Zero-cost
      // turns are filtered upstream so `SUM(cost_usd)` is always positive.
      // Family folding happens in JS via `groupByFamily`.
      `SELECT t.model AS model, SUM(t.cost_usd) AS cost
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.started_at >= ? AND t.cost_usd > 0
       GROUP BY t.model`,
    ),
    toolErrorTrend: db.prepare(
      // All (week, tool_name, calls, errors) buckets in the window. Top-N
      // filter + threshold + null-gap logic live in JS via `buildTrend` —
      // keeps SQL simple (single bind) and avoids an extra CTE for ≤26
      // tools × 12 weeks = ~300 rows worst case. localtime week key is
      // consistent with getWeeklyRatio and getWeeklyAcceptRate.
      `SELECT strftime('%Y-%W', s.started_at/1000, 'unixepoch', 'localtime') AS week,
              tc.tool_name                                                   AS toolName,
              COUNT(*)                                                       AS calls,
              COALESCE(SUM(tc.result_is_error), 0)                           AS errors
       FROM tool_calls tc
       JOIN turns t     ON t.id = tc.turn_id
       JOIN sessions s  ON s.id = t.session_id
       WHERE s.started_at >= ?
       GROUP BY week, tc.tool_name
       ORDER BY week ASC, tc.tool_name ASC`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

/**
 * Weekly error-rate trend for the top-N most-called tools in the window.
 *
 * Defaults: `days = 30`, `topN = 5` (clamped to [1, 10]).
 *
 * See `lib/analytics/tool-trend.ts` for the threshold and shape rules —
 * the SQL here only returns raw buckets; `buildTrend` ranks, clamps, and
 * suppresses low-volume weeks. Sessions filtered by `started_at` (same
 * window semantics as other weekly queries).
 */
export function getToolErrorTrend(
  db: DB,
  opts?: { days?: number; topN?: number },
): ToolTrendResult {
  const days = opts?.days ?? 30;
  const rawTopN = opts?.topN ?? 5;
  const topN = Math.max(1, Math.min(10, Math.floor(rawTopN)));
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.toolErrorTrend.all(cutoff) as RawTrendRow[];
  return buildTrend(rows, topN);
}

export function getModelBreakdown(
  db: DB,
  days: number,
): ModelBreakdownItem[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.modelBreakdown.all(cutoff) as ModelCostRow[];
  return groupByFamily(rows);
}

export function getEffectivenessKpis(db: DB, days: number): EffectivenessKpis {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const row = p.kpis.get(cutoff, cutoff) as KpiRow | undefined;

  const avgCacheHitRatio =
    row && row.avgCacheHitRatio !== null ? row.avgCacheHitRatio : null;
  const sumInput = row?.sumInput ?? 0;
  const sumOutput = row?.sumOutput ?? 0;
  const avgOutputInputRatio = sumInput > 0 ? sumOutput / sumInput : null;
  const ratedSessionCount = row?.ratedSessionCount ?? 0;

  // Compute avgScore from session scores in the same window.
  const scores = getSessionScores(db, days);
  const avgScore =
    scores.length > 0
      ? scores.reduce((acc, s) => acc + s.score, 0) / scores.length
      : null;

  return {
    avgScore,
    avgOutputInputRatio,
    avgCacheHitRatio,
    ratedSessionCount,
  };
}

export function getWeeklyRatio(db: DB, weeks: number): WeeklyRatioPoint[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - weeks * WEEK_MS;
  const rows = p.weeklyRatio.all(cutoff) as WeeklyRow[];
  return rows
    .filter((r) => r.sumInput > 0)
    .map((r) => ({
      week: r.week,
      outputInputRatio: r.sumOutput / r.sumInput,
    }));
}

export function getCostPerTurnValues(db: DB, days: number): number[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.costPerTurn.all(cutoff) as CostRow[];
  return rows
    .map((r) => r.cost)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

export function getToolLeaderboard(
  db: DB,
  days: number,
  limit: number,
): ToolLeaderboardItem[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.toolLeaderboard.all(cutoff, limit) as LeaderboardRow[];
  return rows.map((r) => ({
    toolName: r.toolName,
    count: r.count,
    errorCount: r.errorCount ?? 0,
  }));
}

export function getSessionScores(db: DB, days: number): SessionScore[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const sessions = p.topSessions.all(cutoff, MAX_SCORED_SESSIONS) as TopSessionRow[];
  if (sessions.length === 0) return [];
  const acceptRates = getAcceptRatesBySession(db, days);

  // Fetch turns for all top sessions in a single query, then bucket by
  // session id. Keeps total DB round-trips constant (3) regardless of N.
  const ids = sessions.map((s) => s.id);
  const turnRows = p.turnsForSessions.all(JSON.stringify(ids)) as TurnRow[];
  const turnsBySession = new Map<string, TurnLike[]>();
  for (const r of turnRows) {
    const list = turnsBySession.get(r.session_id);
    const turn: TurnLike = {
      id: r.id,
      sequence: r.sequence,
      userPrompt: r.user_prompt,
    };
    if (list) list.push(turn);
    else turnsBySession.set(r.session_id, [turn]);
  }

  return sessions.map((s) => {
    const turns = turnsBySession.get(s.id) ?? [];
    const penalties = correctionPenalties(turns);
    const correctionDensity =
      turns.length > 0 ? penalties.size / turns.length : 0;
    const score = effectivenessScore({
      outputInputRatio: s.outputInputRatio,
      cacheHitRatio: s.cacheHitRatio,
      avgRating: s.avgRating,
      correctionDensity,
      toolErrorRate: s.toolErrorRate,
      acceptRate: acceptRates.get(s.id) ?? null,
    });
    return { sessionId: s.id, project: s.project, score };
  });
}
