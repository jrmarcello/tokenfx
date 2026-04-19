import type { DB } from '@/lib/db/client';

import type { CostSource } from '@/lib/analytics/cost-calibration';
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
    cacheRatioSince: db.prepare(
      'SELECT COALESCE(CAST(SUM(total_cache_read_tokens) AS REAL) / NULLIF(SUM(total_input_tokens + total_cache_read_tokens), 0), 0) AS v FROM sessions WHERE started_at >= ?'
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
  };
  cache.set(db, prepared);
  return prepared;
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
