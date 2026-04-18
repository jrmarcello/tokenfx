import type { DB } from '@/lib/db/client';
import {
  correctionPenalties,
  effectivenessScore,
  type TurnLike,
} from '@/lib/analytics/scoring';
import { getAcceptRatesBySession } from '@/lib/queries/otel';

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
// Cap on how many top-cost sessions get scored per call. `getSessionScores`
// fetches turns per session to compute correction penalties, so total queries
// scale as 2 + N (one top-sessions query + one accept-rates aggregate + one
// turns query per session). 50 is a reasonable upper bound for a personal
// dashboard; raising it means more queries per page load. To remove the cap
// entirely, push the penalty computation into SQL.
const MAX_SCORED_SESSIONS = 50;

type KpiRow = {
  avgCacheHitRatio: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
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
  id: string;
  sequence: number;
  user_prompt: string | null;
};

type LeaderboardRow = {
  toolName: string;
  count: number;
  errorCount: number | null;
};

type PreparedSet = {
  kpis: import('better-sqlite3').Statement<[number, number]>;
  weeklyRatio: import('better-sqlite3').Statement<[number]>;
  costPerTurn: import('better-sqlite3').Statement<[number]>;
  toolLeaderboard: import('better-sqlite3').Statement<[number, number]>;
  topSessions: import('better-sqlite3').Statement<[number, number]>;
  turnsForSession: import('better-sqlite3').Statement<[string]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    kpis: db.prepare(
      `SELECT
         AVG(v.cache_hit_ratio) AS avgCacheHitRatio,
         SUM(v.output_input_ratio *
             (s.total_input_tokens + s.total_output_tokens)) AS weightedNumerator,
         SUM(
           CASE WHEN v.output_input_ratio IS NOT NULL
                THEN (s.total_input_tokens + s.total_output_tokens)
                ELSE 0 END
         ) AS weightedDenominator,
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
      `SELECT total_cost_usd / NULLIF(turn_count, 0) AS cost
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
       ORDER BY s.total_cost_usd DESC
       LIMIT ?`,
    ),
    turnsForSession: db.prepare(
      `SELECT id, sequence, user_prompt
       FROM turns
       WHERE session_id = ?
       ORDER BY sequence ASC`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

export function getEffectivenessKpis(db: DB, days: number): EffectivenessKpis {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const row = p.kpis.get(cutoff, cutoff) as KpiRow | undefined;

  const avgCacheHitRatio =
    row && row.avgCacheHitRatio !== null ? row.avgCacheHitRatio : null;
  const denom =
    row && row.weightedDenominator !== null ? row.weightedDenominator : 0;
  const num =
    row && row.weightedNumerator !== null ? row.weightedNumerator : 0;
  const avgOutputInputRatio = denom > 0 ? num / denom : null;
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
  const acceptRates = getAcceptRatesBySession(db, days);
  const out: SessionScore[] = [];
  for (const s of sessions) {
    const turnRows = p.turnsForSession.all(s.id) as TurnRow[];
    const turns: TurnLike[] = turnRows.map((t) => ({
      id: t.id,
      sequence: t.sequence,
      userPrompt: t.user_prompt,
    }));
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
    out.push({ sessionId: s.id, project: s.project, score });
  }
  return out;
}
