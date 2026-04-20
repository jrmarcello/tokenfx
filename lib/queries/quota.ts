import type { DB } from '@/lib/db/client';

export type UserSettings = {
  quotaTokens5h: number | null;
  quotaTokens7d: number | null;
  quotaSessions5h: number | null;
  quotaSessions7d: number | null;
  /**
   * Opt-in calibrations: epoch-ms timestamp of when the respective quota
   * window resets, as the user read it off Claude.ai's Account & Usage
   * panel. When present, `getQuotaResetEstimates` anchors modular math
   * here (auto-advances +5h or +7d once the timestamp passes). When
   * `null`, falls back to the activity-derived heuristic.
   */
  quota5hResetAt: number | null;
  quota7dResetAt: number | null;
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

export type DailyTokenPoint = {
  /** YYYY-MM-DD in user's local timezone. */
  dateKey: string;
  /** input_tokens + output_tokens (cache excluded — same axis as heatmap). */
  tokens: number;
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_7D_MS = 7 * MS_PER_DAY;
const WINDOW_28D_MS = 28 * MS_PER_DAY;

type PreparedSet = {
  getUserSettings: import('better-sqlite3').Statement<[]>;
  upsertUserSettings: import('better-sqlite3').Statement<
    [
      number | null, // quota_tokens_5h
      number | null, // quota_tokens_7d
      number | null, // quota_sessions_5h
      number | null, // quota_sessions_7d
      number | null, // quota_5h_reset_at
      number | null, // quota_7d_reset_at
      number, // updated_at
    ]
  >;
  sumTokensSince: import('better-sqlite3').Statement<[number]>;
  countSessionsSince: import('better-sqlite3').Statement<[number]>;
  heatmap: import('better-sqlite3').Statement<[number]>;
  dailyTokensSince: import('better-sqlite3').Statement<[number]>;
  sessionAnchor: import('better-sqlite3').Statement<[number, number]>;
  mostRecentTurn: import('better-sqlite3').Statement<[number]>;
  oldestTurnSince: import('better-sqlite3').Statement<[number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    getUserSettings: db.prepare(
      `SELECT quota_tokens_5h, quota_tokens_7d, quota_sessions_5h, quota_sessions_7d, quota_5h_reset_at, quota_7d_reset_at, updated_at
       FROM user_settings
       WHERE id = 1`
    ),
    upsertUserSettings: db.prepare(
      `INSERT INTO user_settings (
         id, quota_tokens_5h, quota_tokens_7d, quota_sessions_5h, quota_sessions_7d, quota_5h_reset_at, quota_7d_reset_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         quota_tokens_5h = excluded.quota_tokens_5h,
         quota_tokens_7d = excluded.quota_tokens_7d,
         quota_sessions_5h = excluded.quota_sessions_5h,
         quota_sessions_7d = excluded.quota_sessions_7d,
         quota_5h_reset_at = excluded.quota_5h_reset_at,
         quota_7d_reset_at = excluded.quota_7d_reset_at,
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
    dailyTokensSince: db.prepare(
      `SELECT
         strftime('%Y-%m-%d', timestamp/1000, 'unixepoch', 'localtime') AS dateKey,
         COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
       FROM turns
       WHERE timestamp >= ?
       GROUP BY dateKey
       HAVING tokens > 0
       ORDER BY dateKey ASC`
    ),
    // Session anchor for 5h block detection: find the MAX timestamp T in the
    // last 7 days such that either (a) T is the oldest turn in the window or
    // (b) the turn immediately preceding T is more than 5h earlier. That T is
    // the "first message after the last long idle" — the natural origin of
    // the user's current 5h block cycle.
    sessionAnchor: db.prepare(
      `WITH turns_in_window AS (
         SELECT timestamp,
                LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
         FROM turns
         WHERE timestamp >= ?
       )
       SELECT timestamp AS t
       FROM turns_in_window
       WHERE prev_ts IS NULL OR (timestamp - prev_ts) > ?
       ORDER BY timestamp DESC
       LIMIT 1`
    ),
    mostRecentTurn: db.prepare(
      `SELECT MAX(timestamp) AS t FROM turns WHERE timestamp >= ?`
    ),
    oldestTurnSince: db.prepare(
      `SELECT MIN(timestamp) AS t FROM turns WHERE timestamp >= ?`
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
  quota_5h_reset_at: number | null;
  quota_7d_reset_at: number | null;
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
      quota5hResetAt: null,
      quota7dResetAt: null,
      updatedAt: null,
    };
  }
  return {
    quotaTokens5h: row.quota_tokens_5h,
    quotaTokens7d: row.quota_tokens_7d,
    quotaSessions5h: row.quota_sessions_5h,
    quotaSessions7d: row.quota_sessions_7d,
    quota5hResetAt: row.quota_5h_reset_at,
    quota7dResetAt: row.quota_7d_reset_at,
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
    input.quota5hResetAt,
    input.quota7dResetAt,
    now
  );
};

type SumRow = { tokens: number };
type CountRow = { sessions: number };

/**
 * Tokens + sessions consumed in the current quota window.
 *
 * Claude Max uses BLOCK semantics, not rolling: once a 5h block resets,
 * the counter starts fresh; tokens from the previous block shouldn't
 * count toward the new one. Same for 7d. Callers must pass the current
 * block's start timestamp for each window to get Claude.ai-accurate
 * numbers.
 *
 * The optional `cycleStarts` parameter carries those timestamps. When
 * omitted or null, the function falls back to a rolling `now - windowMs`
 * cutoff (legacy behavior; only correct when the block happens to align
 * with the rolling view, which it rarely does post-reset).
 *
 * Usually wired from `getQuotaResetEstimates` like:
 *   cycleStart5hMs = resets.reset5hMs - 5h
 *   cycleStart7dMs = resets.reset7dMs - 7d
 */
export const getQuotaUsage = (
  db: DB,
  now: number,
  cycleStarts: {
    cycleStart5hMs?: number | null;
    cycleStart7dMs?: number | null;
  } = {},
): QuotaUsage => {
  const p = getPrepared(db);
  const cutoff5h = cycleStarts.cycleStart5hMs ?? now - WINDOW_5H_MS;
  const cutoff7d = cycleStarts.cycleStart7dMs ?? now - WINDOW_7D_MS;
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

/**
 * Daily token totals for the last N days (local timezone), used to feed the
 * "estatísticas de consumo" panel on `/quota`. Same data source as
 * {@link getQuotaHeatmap} but aggregated by calendar day instead of
 * (dow × hour). Zero-activity days are omitted (callers zero-fill in JS
 * when they need dense arrays).
 */
export const getDailyTokenSums = (
  db: DB,
  now: number,
  days: number,
): DailyTokenPoint[] => {
  const p = getPrepared(db);
  const cutoff = now - days * MS_PER_DAY;
  const rows = p.dailyTokensSince.all(cutoff) as DailyTokenPoint[];
  return rows.map((r) => ({ dateKey: r.dateKey, tokens: r.tokens }));
};

type MinTimestampRow = { t: number | null };

export type QuotaResetEstimates = {
  reset5hMs: number | null;
  reset7dMs: number | null;
};

/**
 * Estimate when the 5h and 7d rolling quota windows will next "reset" based on
 * recent turn activity.
 *
 * 5h block detection — modular cycle anchored on the last long idle:
 *
 *   Claude Max uses fixed 5h blocks that start on the user's FIRST message
 *   after the previous block expired. Blocks don't adapt to short idle gaps
 *   during continuous use: if a user is active 9am→2pm continuously, the
 *   block ends at exactly 2pm regardless of brief pauses. What resets the
 *   block cycle is a *long* idle (overnight, meals, etc.) — i.e. any gap
 *   >5h between consecutive turns.
 *
 *   Algorithm:
 *     1. Find the SESSION ANCHOR via SQL: the MAX timestamp T in the last
 *        7 days such that either (a) T is the oldest turn in the window or
 *        (b) the turn immediately before T is more than 5h earlier.
 *     2. If there's no turn in the last 7 days → null (inactive account).
 *     3. If the most-recent turn is more than 5h ago → null (block expired;
 *        next message starts a fresh block).
 *     4. Compute how many 5h blocks have elapsed since the anchor:
 *        blocksPassed = floor((now - anchor) / 5h)
 *     5. currentBlockStart = anchor + blocksPassed * 5h
 *        reset5hMs         = currentBlockStart + 5h
 *     6. Defensive clamp: if reset5hMs <= now, return null.
 *
 *   Window of 7 days captures typical overnight gaps (~8-12h). Using a
 *   narrow window (like 10h) misses the idle and falls back to
 *   "oldest turn in window", producing wrong estimates for users with >8h
 *   continuous activity today.
 *
 * 7d rolling — two modes:
 *
 *   MODE A — calibrated (preferred when user copied Claude.ai's reset):
 *     `calibratedResetAt` is a known future reset timestamp. We advance it
 *     by +7d as many times as needed until it's > now (handles stale
 *     calibrations silently — next cycle's reset = calibration + 7d).
 *
 *   MODE B — heuristic (fallback, no calibration):
 *     `oldest turn in last 7d + 7d`. Close but can diverge from Claude.ai's
 *     actual reset by up to a day because Claude's weekly anchor likely
 *     depends on plan/billing data we don't have access to. User can switch
 *     to MODE A via the "Calibrar reset" dialog on the 7d card.
 */
export const getQuotaResetEstimates = (
  db: DB,
  now: number,
  opts: {
    calibratedReset5hAt?: number | null;
    calibratedReset7dAt?: number | null;
  } = {}
): QuotaResetEstimates => {
  const p = getPrepared(db);
  const cutoff7d = now - WINDOW_7D_MS;

  // --- 5h: calibrated mode takes precedence, then heuristic ---
  let reset5hMs: number | null = null;
  const cal5h = opts.calibratedReset5hAt ?? null;
  if (cal5h !== null) {
    let candidate = cal5h;
    while (candidate <= now) candidate += WINDOW_5H_MS;
    reset5hMs = candidate;
  } else {
    const mostRecent = p.mostRecentTurn.get(cutoff7d) as
      | MinTimestampRow
      | undefined;
    if (
      mostRecent &&
      mostRecent.t !== null &&
      now - mostRecent.t <= WINDOW_5H_MS
    ) {
      const anchorRow = p.sessionAnchor.get(cutoff7d, WINDOW_5H_MS) as
        | MinTimestampRow
        | undefined;
      if (anchorRow && anchorRow.t !== null) {
        const anchor = anchorRow.t;
        const elapsed = now - anchor;
        const blocksPassed = Math.max(0, Math.floor(elapsed / WINDOW_5H_MS));
        const currentBlockStart = anchor + blocksPassed * WINDOW_5H_MS;
        const candidate = currentBlockStart + WINDOW_5H_MS;
        if (candidate > now) {
          reset5hMs = candidate;
        }
      }
    }
  }

  // --- 7d: calibrated mode takes precedence, then heuristic ---
  let reset7dMs: number | null = null;
  const cal7d = opts.calibratedReset7dAt ?? null;
  if (cal7d !== null) {
    // Auto-advance by +7d until the stored value is in the future. Handles
    // the case where the user calibrated a cycle that has since rolled over
    // without them needing to re-edit.
    let candidate = cal7d;
    while (candidate <= now) candidate += WINDOW_7D_MS;
    reset7dMs = candidate;
  } else {
    const row = p.oldestTurnSince.get(cutoff7d) as MinTimestampRow | undefined;
    reset7dMs = row && row.t !== null ? row.t + WINDOW_7D_MS : null;
  }

  return { reset5hMs, reset7dMs };
};
