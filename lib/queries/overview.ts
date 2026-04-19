import type { DB } from '@/lib/db/client';

/**
 * Provenance tag for every cost surface. `otel` means the value came from
 * `sessions.total_cost_usd_otel` (authoritative via Claude Code OTEL counter);
 * `local` means the session fell back to `sessions.total_cost_usd` (sum of
 * per-turn costs via `lib/analytics/pricing`).
 */
export type CostSource = 'otel' | 'local';

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
  spend30dCostSources: { otel: number; local: number };
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
type CostSourceRow = { otel: number | null; local: number | null };

type TopSessionRow = {
  id: string;
  project: string;
  startedAt: number;
  totalCostUsd: number;
  turnCount: number;
  cost_from_otel: number;
};

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
      'SELECT COALESCE(SUM(COALESCE(total_cost_usd_otel, total_cost_usd)), 0) AS v FROM sessions WHERE started_at >= ?'
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
         SUM(CASE WHEN total_cost_usd_otel IS NOT NULL THEN 1 ELSE 0 END) AS otel,
         SUM(CASE WHEN total_cost_usd_otel IS NULL THEN 1 ELSE 0 END) AS local
       FROM sessions
       WHERE started_at >= ?`
    ),
    dailySpend: db.prepare(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS date,
              COALESCE(SUM(COALESCE(total_cost_usd_otel, total_cost_usd)), 0) AS spend,
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
              COALESCE(total_cost_usd_otel, total_cost_usd) AS totalCostUsd,
              turn_count AS turnCount,
              (total_cost_usd_otel IS NOT NULL) AS cost_from_otel
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
    local: costSourcesRow?.local ?? 0,
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
    // SQLite represents the `IS NOT NULL` predicate as 1/0; coerce to the
    // union literal expected by consumers (and by the UI badge).
    costSource: r.cost_from_otel ? 'otel' : 'local',
  }));
}
