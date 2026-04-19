import type { DB } from '@/lib/db/client';

export type UserSettings = {
  quotaTokens5h: number | null;
  quotaTokens7d: number | null;
  quotaSessions5h: number | null;
  quotaSessions7d: number | null;
  updatedAt: number | null;
};

export type QuotaUsage = {
  tokens5h: number;
  tokens7d: number;
  sessions5h: number;
  sessions7d: number;
};

export type QuotaHeatmapCell = {
  dow: number; // 0=Sunday .. 6=Saturday (strftime %w)
  hour: number; // 0..23
  tokens: number; // input_tokens + output_tokens (cache excluded)
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_7D_MS = 7 * MS_PER_DAY;
const WINDOW_28D_MS = 28 * MS_PER_DAY;

type PreparedSet = {
  getUserSettings: import('better-sqlite3').Statement<[]>;
  upsertUserSettings: import('better-sqlite3').Statement<
    [number | null, number | null, number | null, number | null, number]
  >;
  sumTokensSince: import('better-sqlite3').Statement<[number]>;
  countSessionsSince: import('better-sqlite3').Statement<[number]>;
  heatmap: import('better-sqlite3').Statement<[number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    getUserSettings: db.prepare(
      `SELECT quota_tokens_5h, quota_tokens_7d, quota_sessions_5h, quota_sessions_7d, updated_at
       FROM user_settings
       WHERE id = 1`
    ),
    upsertUserSettings: db.prepare(
      `INSERT INTO user_settings (
         id, quota_tokens_5h, quota_tokens_7d, quota_sessions_5h, quota_sessions_7d, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         quota_tokens_5h = excluded.quota_tokens_5h,
         quota_tokens_7d = excluded.quota_tokens_7d,
         quota_sessions_5h = excluded.quota_sessions_5h,
         quota_sessions_7d = excluded.quota_sessions_7d,
         updated_at = excluded.updated_at`
    ),
    sumTokensSince: db.prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
       FROM turns
       WHERE timestamp >= ?`
    ),
    countSessionsSince: db.prepare(
      `SELECT COUNT(*) AS sessions
       FROM sessions
       WHERE started_at >= ?`
    ),
    heatmap: db.prepare(
      `SELECT
         CAST(strftime('%w', timestamp/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
         CAST(strftime('%H', timestamp/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
       FROM turns
       WHERE timestamp >= ?
       GROUP BY dow, hour
       HAVING tokens > 0
       ORDER BY dow, hour`
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

type UserSettingsRow = {
  quota_tokens_5h: number | null;
  quota_tokens_7d: number | null;
  quota_sessions_5h: number | null;
  quota_sessions_7d: number | null;
  updated_at: number;
};

export const getUserSettings = (db: DB): UserSettings => {
  const p = getPrepared(db);
  const row = p.getUserSettings.get() as UserSettingsRow | undefined;
  if (!row) {
    return {
      quotaTokens5h: null,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
      updatedAt: null,
    };
  }
  return {
    quotaTokens5h: row.quota_tokens_5h,
    quotaTokens7d: row.quota_tokens_7d,
    quotaSessions5h: row.quota_sessions_5h,
    quotaSessions7d: row.quota_sessions_7d,
    updatedAt: row.updated_at,
  };
};

export const upsertUserSettings = (
  db: DB,
  input: UserSettings,
  now: number
): void => {
  const p = getPrepared(db);
  p.upsertUserSettings.run(
    input.quotaTokens5h,
    input.quotaTokens7d,
    input.quotaSessions5h,
    input.quotaSessions7d,
    now
  );
};

type SumRow = { tokens: number };
type CountRow = { sessions: number };

export const getQuotaUsage = (db: DB, now: number): QuotaUsage => {
  const p = getPrepared(db);
  const cutoff5h = now - WINDOW_5H_MS;
  const cutoff7d = now - WINDOW_7D_MS;
  const tokens5h = (p.sumTokensSince.get(cutoff5h) as SumRow).tokens;
  const tokens7d = (p.sumTokensSince.get(cutoff7d) as SumRow).tokens;
  const sessions5h = (p.countSessionsSince.get(cutoff5h) as CountRow).sessions;
  const sessions7d = (p.countSessionsSince.get(cutoff7d) as CountRow).sessions;
  return { tokens5h, tokens7d, sessions5h, sessions7d };
};

type HeatmapRow = {
  dow: number;
  hour: number;
  tokens: number;
};

export const getQuotaHeatmap = (db: DB, now: number): QuotaHeatmapCell[] => {
  const p = getPrepared(db);
  const cutoff = now - WINDOW_28D_MS;
  const rows = p.heatmap.all(cutoff) as HeatmapRow[];
  return rows.map((r) => ({ dow: r.dow, hour: r.hour, tokens: r.tokens }));
};
