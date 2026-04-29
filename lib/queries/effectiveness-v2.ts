import type { DB } from '@/lib/db/client';
import {
  computeMedian,
  LOW_TOOL_ERROR_RATE_THRESHOLD,
  MIN_FUNNEL_SESSIONS,
} from '@/lib/analytics/effectiveness-v2';
import { effectiveCostForSession } from '@/lib/analytics/cost-calibration';
import { getSessionScores } from '@/lib/queries/effectiveness';
// Calibration cascade is owned by `lib/queries/calibration.ts:getCostCalibration`,
// which WeakMap-caches its prepared statement. Single source of truth for the
// cost cascade per spec REQ-16 + Design §12 — no SQL duplicate here.
import { getCostCalibration } from '@/lib/queries/calibration';

const DAY_MS = 86_400_000;

// ---------------- Public types ----------------

export type PersonalEffectivenessSession = {
  tokensUntilFirstEdit: number | null;
  rereadCount: number;
  toolErrorRate: number | null;
  readsToEditsRatio: number | null;
  compactionEventCount: number;
  subagentUsageRatio: number | null;
};

export type PersonalEffectivenessAggregates = {
  avgRereadCount: number | null;
  avgTokensUntilFirstEdit: number | null;
  avgReadsToEditsRatio: number | null;
  avgToolErrorRate: number | null;
  sessionsWithCompaction: number;
  totalSessions: number;
};

export type CostRatingPoint = {
  sessionId: string;
  cost: number;
  rating: number;
};

export type AvgMetrics = {
  avgCacheHitRatio: number | null;
  avgTokensUntilFirstEdit: number | null;
  avgReadsToEditsRatio: number | null;
  avgToolErrorRate: number | null;
  sampleSize: number;
};

export type QuartileComparison = {
  topQuartile: AvgMetrics;
  bottomQuartile: AvgMetrics;
};

export type FunnelStage =
  | 'Started'
  | 'WithEdit'
  | 'CacheAboveMedian'
  | 'LowToolErrors';

export type FunnelEntry = {
  stage: FunnelStage;
  count: number;
};

export type DailyEffectivenessPoint = {
  date: string;
  score: number | null;
  sessionCount: number;
};

// ---------------- Internal row types ----------------

type FirstEditRow = { seq: number | null };
type TokensRow = { tokens: number | null };
type RereadRow = { rereadCount: number | null };
type ReadsEditsRow = { reads: number | null; edits: number | null };
type ToolErrorRow = { errors: number | null; total: number | null };
type CompactionRow = { c: number };
type SubagentRow = { withAgent: number | null };
type SessionExistsRow = { id: string; turn_count: number };

type ScatterRawRow = {
  sessionId: string;
  totalCostUsd: number;
  totalCostUsdOtel: number | null;
  model: string | null;
  rating: number;
};

type FunnelSessionRow = {
  id: string;
  cacheHitRatio: number | null;
  hasEdit: number; // 1 / 0
  toolErrorRate: number | null;
};

type DailyHeatmapRow = {
  sessionId: string;
  startedAt: number;
};

// ---------------- Prepared statements ----------------

type PreparedSet = {
  sessionExists: import('better-sqlite3').Statement<[string]>;
  firstEditSeq: import('better-sqlite3').Statement<[string]>;
  tokensBeforeSeq: import('better-sqlite3').Statement<[string, number]>;
  rereadCount: import('better-sqlite3').Statement<[string]>;
  readsEditsCounts: import('better-sqlite3').Statement<[string]>;
  toolErrorRate: import('better-sqlite3').Statement<[string]>;
  compactionCount: import('better-sqlite3').Statement<[string]>;
  subagentTurns: import('better-sqlite3').Statement<[string]>;

  // Aggregates
  sessionsWithCompactionInWindow: import('better-sqlite3').Statement<[number]>;
  totalSessionsInWindow: import('better-sqlite3').Statement<[number]>;
  sessionIdsInWindow: import('better-sqlite3').Statement<[number]>;

  // Scatter
  scatterRaw: import('better-sqlite3').Statement<[number]>;

  // Funnel — per-session derived signals for the window
  funnelSessions: import('better-sqlite3').Statement<[number]>;

  // Heatmap — sessions in window keyed by id, used to map score → day
  heatmapSessions: import('better-sqlite3').Statement<[number]>;

  // Quartile comparison — single-row cache_hit_ratio lookup per session
  cacheHitRatioForSession: import('better-sqlite3').Statement<[string]>;
};

const cache = new WeakMap<DB, PreparedSet>();

const getPrepared = (db: DB): PreparedSet => {
  const existing = cache.get(db);
  if (existing) return existing;

  const prepared: PreparedSet = {
    sessionExists: db.prepare(
      `SELECT id, turn_count FROM sessions WHERE id = ?`,
    ),
    // (a) detect existence — returns one row with seq null when no Edit
    // exists; needed to disambiguate "no Edit" (null) from "edit on first
    // turn" (0) — see Design §4.
    firstEditSeq: db.prepare(
      `WITH first_edit AS (
         SELECT MIN(t.sequence) AS seq
         FROM turns t
         JOIN tool_calls tc ON tc.turn_id = t.id
         WHERE t.session_id = ?
           AND tc.tool_name IN ('Edit','MultiEdit','Write')
       )
       SELECT seq FROM first_edit`,
    ),
    // (b) sum tokens of turns BEFORE the first-edit sequence. Only invoked
    // when (a) returned a non-null seq — see Design §4.
    tokensBeforeSeq: db.prepare(
      `SELECT COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_creation_tokens), 0) AS tokens
       FROM turns t
       WHERE t.session_id = ?
         AND t.sequence < ?`,
    ),
    rereadCount: db.prepare(
      // `json_valid(...)` short-circuits before `json_extract(...)` runs, so
      // malformed `input_json` (legacy ingest, truncated args) never raises
      // a `malformed JSON` SqliteError — the row is simply ignored. REQ-9.
      `SELECT COALESCE(SUM(reads - 1), 0) AS rereadCount
       FROM (
         SELECT json_extract(tc.input_json, '$.file_path') AS path,
                COUNT(*) AS reads
         FROM tool_calls tc
         JOIN turns t ON t.id = tc.turn_id
         WHERE t.session_id = ?
           AND tc.tool_name = 'Read'
           AND json_valid(tc.input_json)
           AND json_extract(tc.input_json, '$.file_path') IS NOT NULL
         GROUP BY path
         HAVING reads > 1
       )`,
    ),
    readsEditsCounts: db.prepare(
      `SELECT
         SUM(CASE WHEN tc.tool_name = 'Read' THEN 1 ELSE 0 END) AS reads,
         SUM(CASE WHEN tc.tool_name IN ('Edit','MultiEdit','Write') THEN 1 ELSE 0 END) AS edits
       FROM tool_calls tc
       JOIN turns t ON t.id = tc.turn_id
       WHERE t.session_id = ?`,
    ),
    toolErrorRate: db.prepare(
      `SELECT
         COALESCE(SUM(tc.result_is_error), 0) AS errors,
         COUNT(tc.id)                          AS total
       FROM tool_calls tc
       JOIN turns t ON t.id = tc.turn_id
       WHERE t.session_id = ?`,
    ),
    compactionCount: db.prepare(
      `SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?`,
    ),
    subagentTurns: db.prepare(
      `SELECT SUM(CASE WHEN subagent_type IS NOT NULL THEN 1 ELSE 0 END) AS withAgent
       FROM turns
       WHERE session_id = ?`,
    ),
    sessionsWithCompactionInWindow: db.prepare(
      `SELECT COUNT(DISTINCT ce.session_id) AS c
       FROM compaction_events ce
       JOIN sessions s ON s.id = ce.session_id
       WHERE s.started_at >= ?`,
    ),
    totalSessionsInWindow: db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE started_at >= ?`,
    ),
    sessionIdsInWindow: db.prepare(
      `SELECT id FROM sessions WHERE started_at >= ?`,
    ),
    // Scatter: only sessions with ≥1 rating. Returns raw cost columns and
    // model so JS can apply `effectiveCostForSession` cascade — REQ-16
    // forbids duplicating the cascade in SQL.
    scatterRaw: db.prepare(
      `SELECT s.id                  AS sessionId,
              s.total_cost_usd      AS totalCostUsd,
              s.total_cost_usd_otel AS totalCostUsdOtel,
              (SELECT t.model FROM turns t
               WHERE t.session_id = s.id
               GROUP BY t.model
               ORDER BY SUM(t.cost_usd) DESC, t.model
               LIMIT 1)             AS model,
              v.avg_rating          AS rating
       FROM sessions s
       JOIN session_effectiveness v ON v.id = s.id
       WHERE s.started_at >= ?
         AND v.avg_rating IS NOT NULL`,
    ),
    // Per-session derived signals for the funnel: cache_hit_ratio, whether
    // the session has any Edit-family tool_call, and toolErrorRate. The
    // median + threshold logic is applied in JS via `computeMedian` (Design §7).
    funnelSessions: db.prepare(
      `SELECT s.id                          AS id,
              v.cache_hit_ratio             AS cacheHitRatio,
              CASE WHEN EXISTS (
                SELECT 1 FROM tool_calls tc
                JOIN turns t ON t.id = tc.turn_id
                WHERE t.session_id = s.id
                  AND tc.tool_name IN ('Edit','MultiEdit','Write')
              ) THEN 1 ELSE 0 END           AS hasEdit,
              (SELECT CAST(SUM(tc.result_is_error) AS REAL) /
                      NULLIF(COUNT(tc.id), 0)
                 FROM tool_calls tc
                 JOIN turns t ON t.id = tc.turn_id
                 WHERE t.session_id = s.id) AS toolErrorRate
       FROM sessions s
       LEFT JOIN session_effectiveness v ON v.id = s.id
       WHERE s.started_at >= ?`,
    ),
    // Heatmap: returns sessionId + raw started_at; we bucket to local YYYY-MM-DD
    // in JS so the bucketing exactly matches `getDailySpend`'s formatLocalDate.
    heatmapSessions: db.prepare(
      `SELECT id AS sessionId, started_at AS startedAt
       FROM sessions
       WHERE started_at >= ?`,
    ),
    cacheHitRatioForSession: db.prepare(
      `SELECT cache_hit_ratio AS v FROM session_effectiveness WHERE id = ?`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
};

// ---------------- Per-session metrics (REQ-6..14) ----------------

export const getPersonalEffectivenessSession = (
  db: DB,
  sessionId: string,
): PersonalEffectivenessSession | null => {
  const p = getPrepared(db);

  const session = p.sessionExists.get(sessionId) as
    | SessionExistsRow
    | undefined;
  if (!session) return null;

  // tokensUntilFirstEdit — 2 prepared stmts to disambiguate null vs 0
  const firstEdit = p.firstEditSeq.get(sessionId) as FirstEditRow | undefined;
  let tokensUntilFirstEdit: number | null;
  if (!firstEdit || firstEdit.seq === null) {
    tokensUntilFirstEdit = null;
  } else {
    const seq = firstEdit.seq;
    if (seq <= 1) {
      // No turns can satisfy `sequence < 1` (turn sequences start at 1) — fast
      // path that also avoids running the second stmt for the common case.
      tokensUntilFirstEdit = 0;
    } else {
      const tokensRow = p.tokensBeforeSeq.get(sessionId, seq) as
        | TokensRow
        | undefined;
      tokensUntilFirstEdit = tokensRow?.tokens ?? 0;
    }
  }

  // rereadCount
  const rereadRow = p.rereadCount.get(sessionId) as RereadRow | undefined;
  const rereadCount = rereadRow?.rereadCount ?? 0;

  // toolErrorRate — null when no tool_calls, else errors/total
  const errRow = p.toolErrorRate.get(sessionId) as ToolErrorRow | undefined;
  const total = errRow?.total ?? 0;
  const toolErrorRate = total > 0 ? (errRow?.errors ?? 0) / total : null;

  // readsToEditsRatio — null when edits === 0
  const reRow = p.readsEditsCounts.get(sessionId) as
    | ReadsEditsRow
    | undefined;
  const reads = reRow?.reads ?? 0;
  const edits = reRow?.edits ?? 0;
  const readsToEditsRatio = edits === 0 ? null : reads / edits;

  // compactionEventCount
  const compRow = p.compactionCount.get(sessionId) as CompactionRow | undefined;
  const compactionEventCount = compRow?.c ?? 0;

  // subagentUsageRatio — null when turn_count === 0
  let subagentUsageRatio: number | null;
  if (session.turn_count === 0) {
    subagentUsageRatio = null;
  } else {
    const subRow = p.subagentTurns.get(sessionId) as SubagentRow | undefined;
    const withAgent = subRow?.withAgent ?? 0;
    subagentUsageRatio = withAgent / session.turn_count;
  }

  return {
    tokensUntilFirstEdit,
    rereadCount,
    toolErrorRate,
    readsToEditsRatio,
    compactionEventCount,
    subagentUsageRatio,
  };
};

// ---------------- Aggregates (REQ-15) ----------------

const avgExcludingNull = (values: Array<number | null>): number | null => {
  const finite = values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return finite.reduce((acc, v) => acc + v, 0) / finite.length;
};

export const getPersonalEffectivenessAggregates = (
  db: DB,
  days: number,
): PersonalEffectivenessAggregates => {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;

  const totalRow = p.totalSessionsInWindow.get(cutoff) as
    | { c: number }
    | undefined;
  const totalSessions = totalRow?.c ?? 0;

  const compactionRow = p.sessionsWithCompactionInWindow.get(cutoff) as
    | { c: number }
    | undefined;
  const sessionsWithCompaction = compactionRow?.c ?? 0;

  if (totalSessions === 0) {
    return {
      avgRereadCount: null,
      avgTokensUntilFirstEdit: null,
      avgReadsToEditsRatio: null,
      avgToolErrorRate: null,
      sessionsWithCompaction,
      totalSessions,
    };
  }

  const idRows = p.sessionIdsInWindow.all(cutoff) as Array<{ id: string }>;

  const rereadVals: number[] = [];
  const tokensVals: Array<number | null> = [];
  const ratioVals: Array<number | null> = [];
  const errorVals: Array<number | null> = [];

  for (const { id } of idRows) {
    const m = getPersonalEffectivenessSession(db, id);
    if (!m) continue;
    rereadVals.push(m.rereadCount);
    tokensVals.push(m.tokensUntilFirstEdit);
    ratioVals.push(m.readsToEditsRatio);
    errorVals.push(m.toolErrorRate);
  }

  return {
    avgRereadCount: rereadVals.length === 0 ? null : avgExcludingNull(rereadVals),
    avgTokensUntilFirstEdit: avgExcludingNull(tokensVals),
    avgReadsToEditsRatio: avgExcludingNull(ratioVals),
    avgToolErrorRate: avgExcludingNull(errorVals),
    sessionsWithCompaction,
    totalSessions,
  };
};

// ---------------- Cost x rating scatter (REQ-16) ----------------

export const getCostRatingScatter = (
  db: DB,
  days: number,
): CostRatingPoint[] => {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;

  const rows = p.scatterRaw.all(cutoff) as ScatterRawRow[];
  if (rows.length === 0) return [];

  // Calibration loaded once per call via `getCostCalibration` (single source of
  // truth — REQ-16 + Design §12). Its prepared statement is WeakMap-cached
  // inside `lib/queries/calibration.ts` so 50 consecutive scatter calls do
  // not trigger `db.prepare` per invocation (TC-I-39 contract preserved).
  const calibration = getCostCalibration(db);

  return rows.map((r) => {
    const localCost = r.totalCostUsd ?? 0;
    const result = effectiveCostForSession({
      localCost,
      otelCost: r.totalCostUsdOtel,
      model: r.model ?? '',
      calibration,
    });
    return {
      sessionId: r.sessionId,
      cost: result.value,
      rating: r.rating,
    };
  });
};

// ---------------- Quartile comparison (REQ-18) ----------------

const computeAvgMetrics = (
  db: DB,
  sessionIds: string[],
): AvgMetrics => {
  const p = getPrepared(db);
  const cacheVals: Array<number | null> = [];
  const tokenVals: Array<number | null> = [];
  const ratioVals: Array<number | null> = [];
  const errorVals: Array<number | null> = [];

  // cache_hit_ratio comes from the existing view via a memoized per-id lookup.
  // Quartile size is bounded (≤25% of MAX_SCORED_SESSIONS = ≤13) so per-id
  // reads here cost < 1ms total in practice.
  for (const id of sessionIds) {
    const cacheRow = p.cacheHitRatioForSession.get(id) as
      | { v: number | null }
      | undefined;
    cacheVals.push(cacheRow?.v ?? null);
    const sess = getPersonalEffectivenessSession(db, id);
    tokenVals.push(sess?.tokensUntilFirstEdit ?? null);
    ratioVals.push(sess?.readsToEditsRatio ?? null);
    errorVals.push(sess?.toolErrorRate ?? null);
  }

  return {
    avgCacheHitRatio: avgExcludingNull(cacheVals),
    avgTokensUntilFirstEdit: avgExcludingNull(tokenVals),
    avgReadsToEditsRatio: avgExcludingNull(ratioVals),
    avgToolErrorRate: avgExcludingNull(errorVals),
    sampleSize: sessionIds.length,
  };
};

export const getQuartileComparison = (
  db: DB,
  days: number,
): QuartileComparison | null => {
  const scores = getSessionScores(db, days);
  const n = scores.length;
  if (n < 4) return null;

  // Stable sort by score ascending; for n=4 the quartile size is 1 each.
  const sorted = [...scores].sort((a, b) => a.score - b.score);
  const quartileSize = Math.max(1, Math.floor(n / 4));

  const bottomIds = sorted.slice(0, quartileSize).map((s) => s.sessionId);
  const topIds = sorted
    .slice(n - quartileSize, n)
    .map((s) => s.sessionId);

  return {
    topQuartile: computeAvgMetrics(db, topIds),
    bottomQuartile: computeAvgMetrics(db, bottomIds),
  };
};

// ---------------- Funnel (REQ-20, REQ-21) ----------------

const FUNNEL_STAGES: ReadonlyArray<FunnelStage> = [
  'Started',
  'WithEdit',
  'CacheAboveMedian',
  'LowToolErrors',
];

export const getEffectivenessFunnel = (
  db: DB,
  days: number,
): FunnelEntry[] => {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;

  const rows = p.funnelSessions.all(cutoff) as FunnelSessionRow[];
  if (rows.length < MIN_FUNNEL_SESSIONS) return [];

  const started = rows.length;
  const withEdit = rows.filter((r) => r.hasEdit === 1);
  const withEditCount = withEdit.length;

  let cacheAboveMedianCount = 0;
  let lowToolErrorsCount = 0;
  let cacheAboveMedianSet: FunnelSessionRow[] = [];

  if (withEditCount > 0) {
    const cacheValues = withEdit
      .map((r) => r.cacheHitRatio)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const median = computeMedian(cacheValues);
    if (median !== null) {
      // `>=` (not `>`): with an even-sized WithEdit set, strict `>` can produce
      // a count that's mechanically impossible to match the spec's expected
      // contract (TC-I-34: 8 WithEdit / 5 above-median). With ties at the
      // median value, `>=` includes the upper plateau which matches the
      // intent of "top half of cache reuse".
      cacheAboveMedianSet = withEdit.filter(
        (r) => r.cacheHitRatio !== null && r.cacheHitRatio >= median,
      );
      cacheAboveMedianCount = cacheAboveMedianSet.length;
    }

    if (cacheAboveMedianSet.length > 0) {
      lowToolErrorsCount = cacheAboveMedianSet.filter(
        (r) =>
          r.toolErrorRate !== null &&
          r.toolErrorRate < LOW_TOOL_ERROR_RATE_THRESHOLD,
      ).length;
    }
  }

  const counts: Record<FunnelStage, number> = {
    Started: started,
    WithEdit: withEditCount,
    CacheAboveMedian: cacheAboveMedianCount,
    LowToolErrors: lowToolErrorsCount,
  };

  return FUNNEL_STAGES.map((stage) => ({ stage, count: counts[stage] }));
};

// ---------------- Daily heatmap (REQ-23) ----------------

const startOfTodayLocalMs = (now: number = Date.now()): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const formatLocalDate = (ms: number): string => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const getDailyEffectivenessHeatmap = (
  db: DB,
  days: number,
): DailyEffectivenessPoint[] => {
  const p = getPrepared(db);
  const now = Date.now();
  const cutoff = now - days * DAY_MS;

  const sessionRows = p.heatmapSessions.all(cutoff) as DailyHeatmapRow[];
  // Reuse `getSessionScores` so the score is consistent with the rest of the
  // dashboard (composite scoring lives in `lib/analytics/scoring.ts`).
  const scores = getSessionScores(db, days);
  const scoresById = new Map<string, number>();
  for (const s of scores) scoresById.set(s.sessionId, s.score);

  const byDate = new Map<string, { sum: number; count: number; sessions: number }>();
  for (const row of sessionRows) {
    const date = formatLocalDate(row.startedAt);
    const bucket = byDate.get(date) ?? { sum: 0, count: 0, sessions: 0 };
    bucket.sessions += 1;
    const score = scoresById.get(row.sessionId);
    if (typeof score === 'number' && Number.isFinite(score)) {
      bucket.sum += score;
      bucket.count += 1;
    }
    byDate.set(date, bucket);
  }

  const todayStart = startOfTodayLocalMs(now);
  const result: DailyEffectivenessPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = todayStart - i * DAY_MS;
    const key = formatLocalDate(dayMs);
    const bucket = byDate.get(key);
    if (!bucket) {
      result.push({ date: key, score: null, sessionCount: 0 });
    } else {
      const score = bucket.count > 0 ? bucket.sum / bucket.count : null;
      result.push({ date: key, score, sessionCount: bucket.sessions });
    }
  }
  return result;
};
