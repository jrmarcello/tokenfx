import type { DB } from '@/lib/db/client';

export type OverviewKpis = {
  spend30d: number;
  spendToday: number;
  spend7d: number;
  tokens30d: number;
  cacheHitRatio30d: number;
  sessionCount30d: number;
};

export type DailyPoint = { date: string; spend: number; tokens: number };

export type TopSession = {
  id: string;
  project: string;
  startedAt: number;
  totalCostUsd: number;
  turnCount: number;
};

type NumRow = { v: number };

type PreparedSet = {
  spendSince: import('better-sqlite3').Statement<[number]>;
  tokensSince: import('better-sqlite3').Statement<[number]>;
  cacheRatioSince: import('better-sqlite3').Statement<[number]>;
  sessionCountSince: import('better-sqlite3').Statement<[number]>;
  dailySpend: import('better-sqlite3').Statement<[number]>;
  topSessions: import('better-sqlite3').Statement<[number, number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    spendSince: db.prepare(
      'SELECT COALESCE(SUM(total_cost_usd), 0) AS v FROM sessions WHERE started_at >= ?'
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
    dailySpend: db.prepare(
      `SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS date,
              COALESCE(SUM(total_cost_usd), 0) AS spend,
              COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens), 0) AS tokens
       FROM sessions
       WHERE started_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    ),
    topSessions: db.prepare(
      `SELECT id, project, started_at AS startedAt, total_cost_usd AS totalCostUsd, turn_count AS turnCount
       FROM sessions
       WHERE started_at >= ?
       ORDER BY total_cost_usd DESC
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

  return {
    spend30d,
    spendToday,
    spend7d,
    tokens30d,
    cacheHitRatio30d,
    sessionCount30d,
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
    });
  }

  const result: DailyPoint[] = [];
  // Build `days` entries from (days-1) days ago through today, inclusive.
  const todayStart = startOfTodayLocalMs(now);
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = todayStart - i * DAY_MS;
    const key = formatLocalDate(dayMs);
    result.push(byDate.get(key) ?? { date: key, spend: 0, tokens: 0 });
  }
  return result;
}

export function getTopSessions(db: DB, limit: number, days: number): TopSession[] {
  const p = getPrepared(db);
  const cutoff = Date.now() - days * DAY_MS;
  const rows = p.topSessions.all(cutoff, limit) as TopSession[];
  return rows;
}
