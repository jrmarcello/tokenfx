import type { DB } from '@/lib/db/client';

import type { CostSource } from '@/lib/analytics/cost-calibration';
import { getSessionScores } from '@/lib/queries/effectiveness';
export type { CostSource };

export type OverviewKpis = {
  spend30d: number;
  spendToday: number;
  spend7d: number;
  tokens30d: number;
  cacheHitRatio30d: number;
  sessionCount30d: number;
  /**
   * Count of sessions in the 30d window grouped by cost provenance. Used by
   * the "Custo 30d" KPI card tooltip to explain hybrid aggregates (REQ-13).
   */
  spend30dCostSources: { otel: number; calibrated: number; list: number };
};

export type DailyPoint = {
  date: string;
  spend: number;
  tokens: number;
  sessionCount: number;
};

/**
 * 4-way breakdown of session tokens. Feeds the "Tokens (30d)" KPI card tooltip
 * so users can see the mix that makes up the composite number — today's is
 * dominated by cache_read, blocking apples-to-apples comparison with ccusage
 * (REQ-3 token-accounting-parity spec).
 */
export type TokenBreakdown = {
  inputOutput: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
};

type TokenBreakdownRow = {
  inputOutput: number;
  cacheCreation: number;
  cacheRead: number;
};

export type TopSession = {
  id: string;
  project: string;
  startedAt: number;
  totalCostUsd: number;
  turnCount: number;
  costSource: CostSource;
};

type NumRow = { v: number };
type CostSourceRow = {
  otel: number | null;
  calibrated: number | null;
  list: number | null;
};

type TopSessionRow = {
  id: string;
  project: string;
  startedAt: number;
  totalCostUsd: number;
  turnCount: number;
  cost_source: string;
};

// Effective cost cascade: OTEL → list × global calibration rate → list.
// Applied in-SQL via a scalar subquery against `cost_calibration`. Family-
// specific calibration (REQ-4) is deferred to a follow-up iteration — for now
// the 'global' rate is the single adjustment lever.
const EFFECTIVE_COST_EXPR = `
  COALESCE(
    total_cost_usd_otel,
    total_cost_usd * (SELECT effective_rate FROM cost_calibration WHERE family='global' LIMIT 1),
    total_cost_usd
  )
`;

const COST_SOURCE_EXPR = `
  CASE
    WHEN total_cost_usd_otel IS NOT NULL THEN 'otel'
    WHEN (SELECT effective_rate FROM cost_calibration WHERE family='global' LIMIT 1) IS NOT NULL
      THEN 'calibrated'
    ELSE 'list'
  END
`;

type PreparedSet = {
  spendSince: import('better-sqlite3').Statement<[number]>;
  tokensSince: import('better-sqlite3').Statement<[number]>;
  cacheRatioSince: import('better-sqlite3').Statement<[number]>;
  sessionCountSince: import('better-sqlite3').Statement<[number]>;
  costSourcesSince: import('better-sqlite3').Statement<[number]>;
  dailySpend: import('better-sqlite3').Statement<[number]>;
  topSessions: import('better-sqlite3').Statement<[number, number]>;
  sessionsByIds: import('better-sqlite3').Statement<[string]>;
  tokenBreakdown: import('better-sqlite3').Statement<[number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    // Prefers the OTEL-authoritative value, falls back to the local sum. All
    // cost-facing aggregates go through this COALESCE (see Design §4 of
    // .specs/pricing-otel-source-of-truth.md).
    spendSince: db.prepare(
      `SELECT COALESCE(SUM(${EFFECTIVE_COST_EXPR}), 0) AS v FROM sessions WHERE started_at >= ?`
    ),
    tokensSince: db.prepare(
      'SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens), 0) AS v FROM sessions WHERE started_at >= ?'
    ),
    // Cache-hit formula: read / (input + read + creation). Source of truth is
    // the `session_effectiveness` view in lib/db/schema.sql — keep the two in
    // sync (including cache-creation writes in the denominator matches the
    // "% de tokens reaproveitados" mental model).
    cacheRatioSince: db.prepare(
      'SELECT COALESCE(CAST(SUM(total_cache_read_tokens) AS REAL) / NULLIF(SUM(total_input_tokens + total_cache_read_tokens + total_cache_creation_tokens), 0), 0) AS v FROM sessions WHERE started_at >= ?'
    ),
    sessionCountSince: db.prepare(
      'SELECT COUNT(*) AS v FROM sessions WHERE started_at >= ?'
    ),
    // Counts sessions by cost provenance — feeds OverviewKpis.spend30dCostSources
    // which populates the hybrid-aggregate tooltip (REQ-13).
    costSourcesSince: db.prepare(
      `SELECT
         SUM(CASE WHEN ${COST_SOURCE_EXPR} = 'otel' THEN 1 ELSE 0 END) AS otel,
         SUM(CASE WHEN ${COST_SOURCE_EXPR} = 'calibrated' THEN 1 ELSE 0 END) AS calibrated,
         SUM(CASE WHEN ${COST_SOURCE_EXPR} = 'list' THEN 1 ELSE 0 END) AS list
       FROM sessions
       WHERE started_at >= ?`
    ),
    dailySpend: db.prepare(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS date,
              COALESCE(SUM(${EFFECTIVE_COST_EXPR}), 0) AS spend,
              COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens), 0) AS tokens,
              COUNT(*) AS sessionCount
       FROM sessions
       WHERE started_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    ),
    topSessions: db.prepare(
      `SELECT id,
              project,
              started_at AS startedAt,
              ${EFFECTIVE_COST_EXPR} AS totalCostUsd,
              turn_count AS turnCount,
              ${COST_SOURCE_EXPR} AS cost_source
       FROM sessions
       WHERE started_at >= ?
       ORDER BY totalCostUsd DESC
       LIMIT ?`
    ),
    // Metadata for an arbitrary set of session ids (bound as a JSON array),
    // used by getTopSessionsByScore to fetch rows chosen by SCORE rank —
    // which a cost-ordered LIMIT could never surface. Reuses the shared cost
    // expressions (never a third inline copy). Same json_each pattern as
    // effectiveness.ts's turnsForSessions.
    sessionsByIds: db.prepare(
      `SELECT sessions.id AS id,
              sessions.project AS project,
              sessions.started_at AS startedAt,
              ${EFFECTIVE_COST_EXPR} AS totalCostUsd,
              sessions.turn_count AS turnCount,
              ${COST_SOURCE_EXPR} AS cost_source
       FROM sessions
       JOIN json_each(?) j ON j.value = sessions.id`
    ),
    // 4-way split of token usage for sessions in the window. Powers the
    // "Tokens (30d)" KPI tooltip — `total` is derived in TS to preserve the
    // arithmetic invariant inputOutput + cacheCreation + cacheRead === total.
    tokenBreakdown: db.prepare(
      `SELECT
         COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS inputOutput,
         COALESCE(SUM(total_cache_creation_tokens), 0)              AS cacheCreation,
         COALESCE(SUM(total_cache_read_tokens), 0)                  AS cacheRead
       FROM sessions
       WHERE started_at >= ?`
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

export function getTokenBreakdown(db: DB, days: number): TokenBreakdown {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const row = p.tokenBreakdown.get(cutoff) as TokenBreakdownRow | undefined;
  if (!row) {
    return { inputOutput: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
  }
  return {
    inputOutput: row.inputOutput,
    cacheCreation: row.cacheCreation,
    cacheRead: row.cacheRead,
    total: row.inputOutput + row.cacheCreation + row.cacheRead,
  };
}

const DAY_MS = 86_400_000;

function startOfTodayLocalMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getOverviewKpis(db: DB): OverviewKpis {
  const p = getPrepared(db);
  const now = Date.now();
  const cutoff30 = now - 30 * DAY_MS;
  const cutoff7 = now - 7 * DAY_MS;
  const cutoffToday = startOfTodayLocalMs(now);

  const spend30d = (p.spendSince.get(cutoff30) as NumRow | undefined)?.v ?? 0;
  const spendToday = (p.spendSince.get(cutoffToday) as NumRow | undefined)?.v ?? 0;
  const spend7d = (p.spendSince.get(cutoff7) as NumRow | undefined)?.v ?? 0;
  const tokens30d = (p.tokensSince.get(cutoff30) as NumRow | undefined)?.v ?? 0;
  const cacheHitRatio30d =
    (p.cacheRatioSince.get(cutoff30) as NumRow | undefined)?.v ?? 0;
  const sessionCount30d =
    (p.sessionCountSince.get(cutoff30) as NumRow | undefined)?.v ?? 0;
  const costSourcesRow = p.costSourcesSince.get(cutoff30) as
    | CostSourceRow
    | undefined;
  const spend30dCostSources = {
    otel: costSourcesRow?.otel ?? 0,
    calibrated: costSourcesRow?.calibrated ?? 0,
    list: costSourcesRow?.list ?? 0,
  };

  return {
    spend30d,
    spendToday,
    spend7d,
    tokens30d,
    cacheHitRatio30d,
    sessionCount30d,
    spend30dCostSources,
  };
}

export function getDailySpend(db: DB, days: number): DailyPoint[] {
  const p = getPrepared(db);
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
  const rows = p.dailySpend.all(cutoff) as DailyPoint[];

  const byDate = new Map<string, DailyPoint>();
  for (const row of rows) {
    byDate.set(row.date, {
      date: row.date,
      spend: row.spend ?? 0,
      tokens: row.tokens ?? 0,
      sessionCount: row.sessionCount ?? 0,
    });
  }

  const result: DailyPoint[] = [];
  // Build `days` entries from (days-1) days ago through today, inclusive.
  const todayStart = startOfTodayLocalMs(now);
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = todayStart - i * DAY_MS;
    const key = formatLocalDate(dayMs);
    result.push(
      byDate.get(key) ?? { date: key, spend: 0, tokens: 0, sessionCount: 0 }
    );
  }
  return result;
}

export function getTopSessions(db: DB, limit: number, days: number): TopSession[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.topSessions.all(cutoff, limit) as TopSessionRow[];
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    startedAt: r.startedAt,
    totalCostUsd: r.totalCostUsd,
    turnCount: r.turnCount,
    costSource: r.cost_source as CostSource,
  }));
}

// --------------- Daily accept-rate (OTEL) ---------------

export type DailyAcceptRatePoint = {
  date: string; // local YYYY-MM-DD
  acceptRate: number | null; // null when day had zero decisions
};

/**
 * Per-day accept rate from `otel_scrapes.claude_code_code_edit_tool_decision_total`.
 * Buckets by local date (strftime). Days with zero decisions get `null`
 * (renders as a line gap in charts). Returns the last `days` days in
 * chronological order (backfills empty dates with null).
 */
export function getDailyAcceptRate(
  db: DB,
  days: number,
): DailyAcceptRatePoint[] {
  const cutoff = Date.now() - days * DAY_MS;
  const rows = db
    .prepare(
      `WITH daily AS (
         SELECT
           strftime('%Y-%m-%d', datetime(scraped_at/1000, 'unixepoch', 'localtime')) AS date,
           SUM(CASE WHEN json_extract(labels_json, '$.decision') = 'accept' THEN value ELSE 0 END) AS accepts,
           SUM(value) AS total
         FROM otel_scrapes
         WHERE metric_name = 'claude_code_code_edit_tool_decision_total'
           AND scraped_at >= ?
         GROUP BY date
       )
       SELECT date, accepts, total FROM daily`,
    )
    .all(cutoff) as Array<{ date: string; accepts: number; total: number }>;
  const byDate = new Map<string, number | null>();
  for (const r of rows) {
    byDate.set(r.date, r.total > 0 ? r.accepts / r.total : null);
  }
  const out: DailyAcceptRatePoint[] = [];
  const today = startOfTodayLocalMs();
  for (let i = days - 1; i >= 0; i--) {
    const ms = today - i * DAY_MS;
    const key = formatLocalDate(ms);
    out.push({ date: key, acceptRate: byDate.get(key) ?? null });
  }
  return out;
}

// --------------- Top sessions — alternative orderings ---------------

/**
 * Top-N sessions by score ascending (worst first — these are the most
 * valuable to drill into: poorly rated regardless of cost). Scores EVERY
 * session in the window (`getSessionScores` is uncapped), sorts by score asc
 * with a deterministic `sessionId asc` tie-break, takes `limit` ids, and
 * fetches their metadata by id via `sessionsByIds` (so a cheap-but-bad
 * session is never dropped by a cost-ordered candidate cap — the previous
 * bug). All returned fields come from the metadata row, not from
 * `SessionScore`.
 */
export function getTopSessionsByScore(
  db: DB,
  limit: number,
  days: number,
): TopSession[] {
  const scored = getSessionScores(db, days);
  if (scored.length === 0) return [];
  const worst = [...scored]
    .sort((a, b) => a.score - b.score || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit);
  const ids = worst.map((s) => s.sessionId);
  const p = getPrepared(db);
  const rows = p.sessionsByIds.all(JSON.stringify(ids)) as TopSessionRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Final order = worst (score asc); every field comes from the metadata row.
  return worst.flatMap((s) => {
    const r = byId.get(s.sessionId);
    return r
      ? [
          {
            id: r.id,
            project: r.project,
            startedAt: r.startedAt,
            totalCostUsd: r.totalCostUsd,
            turnCount: r.turnCount,
            costSource: r.cost_source as CostSource,
          },
        ]
      : [];
  });
}

/**
 * Top-N sessions by turn count descending — "longest sessions" view.
 */
export function getTopSessionsByTurns(
  db: DB,
  limit: number,
  days: number,
): TopSession[] {
  const cutoff = Date.now() - days * DAY_MS;
  const rows = db
    .prepare(
      `SELECT id,
              project,
              started_at AS startedAt,
              ${EFFECTIVE_COST_EXPR} AS totalCostUsd,
              turn_count AS turnCount,
              ${COST_SOURCE_EXPR} AS cost_source
       FROM sessions
       WHERE started_at >= ?
       ORDER BY turn_count DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as TopSessionRow[];
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    startedAt: r.startedAt,
    totalCostUsd: r.totalCostUsd,
    turnCount: r.turnCount,
    costSource: r.cost_source as CostSource,
  }));
}
