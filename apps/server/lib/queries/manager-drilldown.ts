/**
 * `manager-drilldown` — dev-level queries for the manager drilldown surfaces
 * (TASK-QUERIES-DRILLDOWN of `.specs/manager-dashboard-v2.md`).
 *
 * # Anti-surveillance principle 1 (load-bearing)
 *
 * The spec's anti-surveillance principle 1 states: "Aggregated by default.
 * Individual data is opt-in for the manager and gated by reason + audit +
 * notification." The manager-facing UI defaults to TEAM-AGGREGATED views
 * (`manager-v2.ts`); only the drilldown surfaces (`/manager/check-in/...`,
 * `/manager/devs/...`) reach for individual dev data, AND every such
 * request must:
 *
 *   1. Pass cross-team / cross-org authorization (route layer).
 *   2. Write a row to `manager_drilldown_audit` BEFORE rendering data
 *      (`writeAudit(tx, audit)`).
 *   3. Run audit + data fetch atomically in a single Drizzle transaction
 *      (route layer wraps both in `db.transaction(...)`), so audit
 *      failure → tx rollback → no data leak.
 *   4. Enqueue a notification to the target dev when the audit row is a
 *      real INSERT (REQ-16; `writeAudit` returns `{ inserted: boolean }`).
 *
 * Steps 2-4 happen in the ROUTE handler. This module is a leaf data
 * library — it does NOT enforce any of the above. What it DOES enforce
 * is a TYPE-LEVEL guard: every export here takes a REQUIRED
 * `audit: AuditContext` parameter. A caller that omits it is a TypeScript
 * compile error. The audit param does not change query behavior — it is
 * a "you cannot forget the audit step" gate.
 *
 * # Why a TYPE-LEVEL gate (not just runtime)
 *
 * A runtime check (e.g. throwing if `audit` is missing) lets the wrong
 * code path COMPILE. Anti-surveillance is a forever-rule: it must be
 * impossible to query dev-level data accidentally, including in tests
 * and one-off scripts. A type-level required parameter shifts the failure
 * mode from "tests pass on a code path that bypasses audit" to "the
 * `tsc` build fails at the call site". TC-I-26 pins this contract via
 * `// @ts-expect-error` assertions in the colocated test.
 *
 * # Cross-team / cross-org enforcement is the ROUTE's responsibility
 *
 * This lib does NOT validate that `audit.targetUserId` belongs to one
 * of the manager's teams (TC-I-28). The route handler resolves the
 * dev id, validates team membership via `getTeamMembersForManager`, then
 * calls these queries with the validated id. Adding a defensive
 * row-filter at the lib layer would be a CHANGE not a hardening — it
 * would silently mask route-level bugs and create two sources of truth.
 *
 * # SQL-side patterns
 *
 *   - All queries use Drizzle ORM (`.select()`) or its parameterized
 *     `sql` template tag (REQ-19). No template-literal concatenation of
 *     user-supplied values into SQL.
 *   - Time windows use `NOW() - INTERVAL '<n> days'` driven by the
 *     `days` param (positive integer); `days` is NOT user-supplied —
 *     the route hard-codes 30 today. The Postgres-side INTERVAL string
 *     is built from the bound `days` integer using `sql`'s parameter
 *     binding, NOT string concatenation.
 *   - `displayLabelFor()` is the SAME fallback chain encoded in the
 *     SQL `ORDER BY COALESCE(display_name, split_part(email, '@', 1))`
 *     of `getTeamMembersForManager` — keeps the rendered label aligned
 *     with the database-sorted key.
 */
import { sql } from 'drizzle-orm';
import { displayLabelFor } from '@/lib/util/user-display';
import { bucketizeToolMix, type ToolBucket } from '@/lib/analytics/tool-mix';
import type { AuditContext } from '@/lib/audit/drilldown-audit';
import { extractExecRows as extractRows } from '@/lib/db/exec';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The drilldown queries accept either the top-level db handle or a
 * Drizzle transaction handle. The route's canonical pattern is:
 *
 *   db.transaction(async (tx) => {
 *     await writeAudit(tx, audit);
 *     const detail = await getDevSpendDetail(tx, audit, { userId, days: 30 });
 *     // ... fetch the rest, render
 *   });
 *
 * which makes the audit + reads atomic.
 */
type DrilldownExecutor = Db | DrizzleTx;

export type DevSpendDetail = {
  userId: string;
  /** `displayLabelFor(user)` — never null, never empty. */
  displayLabel: string;
  email: string;
  thirtyDaySpendUsd: number;
  sevenDaySpendUsd: number;
  /** Daily totals over the `days` window, oldest-first (ASC by day). */
  trend: { day: string; spendUsd: number }[];
};

export type DevSessionRow = {
  sessionId: string;
  /** ISO 8601 timestamp string. */
  startedAt: string;
  /** ISO 8601 timestamp string; null when the reporter never closed the session. */
  endedAt: string | null;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheHitRatio: number | null;
  manualRating: number | null;
};

export type DevToolUsage = Record<ToolBucket, number>;

const DEFAULT_SESSION_LIST_LIMIT = 100;

const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

const toIsoTimestamp = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toFiniteNumber = (value: unknown): number => {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toNullableNumber = (value: unknown): number | null => {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Per-day spend trend + 30d / 7d totals for a single dev.
 *
 * **Audit context required at type level** — pair with
 * `writeAudit(tx, audit)` in the same transaction at the route layer.
 * The `audit` argument does NOT change query behavior; it is a
 * compile-time gate to make sure callers cannot forget the audit step
 * (anti-surveillance principle 1). Cross-team / cross-org enforcement
 * is the route's responsibility — this lib returns data for any user
 * id the caller asks about (TC-I-28).
 *
 * Returns `null` when the dev has no sessions in the window OR the user
 * id does not exist (locked contract per TC-I-32 — null beats an
 * all-zeros DTO so the UI can render "No data" instead of misleading
 * zeroes).
 */
export const getDevSpendDetail = async (
  exec: DrilldownExecutor,
  audit: AuditContext,
  params: { userId: string; days: number },
): Promise<DevSpendDetail | null> => {
  // `audit` is a type-level gate (see file header) — touch it to keep
  // the lint clean without a directive comment.
  void audit;
  const { userId, days } = params;

  // 1. Resolve the user (display_name + email) for the label fallback.
  //    A missing user → null short-circuit (TC-I-32 contract).
  const userResult = await exec.execute(sql`
    SELECT id, email, display_name AS "displayName"
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `);
  const userRows = extractRows<{
    id: string;
    email: string;
    displayName: string | null;
  }>(userResult);
  if (userRows.length === 0) return null;
  const user = userRows[0];

  // 2. Per-day spend within the window. `total_cost_usd` is the
  //    list-price local figure from the reporter; the manager dashboard
  //    intentionally does NOT apply the OTEL/calibration cascade here
  //    (this is a drilldown sanity check, not the cost dashboard —
  //    spec 1 owns the calibrated view). Scope can extend later once
  //    the V2 spec adds a calibrated drilldown surface.
  const trendResult = await exec.execute(sql`
    SELECT
      to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
      SUM(total_cost_usd)::text AS "spendUsd"
    FROM sessions_agg
    WHERE user_id = ${userId}
      AND started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY day
    ORDER BY day ASC
  `);
  const trendRows = extractRows<{ day: string; spendUsd: string | null }>(trendResult);
  if (trendRows.length === 0) return null;

  const trend = trendRows.map((row) => ({
    day: row.day,
    spendUsd: toFiniteNumber(row.spendUsd),
  }));
  const thirtyDaySpendUsd = trend.reduce((acc, p) => acc + p.spendUsd, 0);

  // 3. 7-day total — same source, narrower window. Computed via a
  //    second aggregate so the per-day buckets stay independent.
  const sevenDayResult = await exec.execute(sql`
    SELECT COALESCE(SUM(total_cost_usd), 0)::text AS "spendUsd"
    FROM sessions_agg
    WHERE user_id = ${userId}
      AND started_at >= NOW() - INTERVAL '7 days'
  `);
  const sevenDayRows = extractRows<{ spendUsd: string | null }>(sevenDayResult);
  const sevenDaySpendUsd = toFiniteNumber(sevenDayRows[0]?.spendUsd);

  return {
    userId: user.id,
    displayLabel: displayLabelFor({
      display_name: user.displayName,
      email: user.email,
    }),
    email: user.email,
    thirtyDaySpendUsd,
    sevenDaySpendUsd,
    trend,
  };
};

/**
 * Session list for a single dev within a window, newest-first.
 *
 * **Audit context required at type level** — pair with
 * `writeAudit(tx, audit)` in the same transaction at the route layer.
 * Cross-team / cross-org enforcement is the route's responsibility
 * (TC-I-28).
 *
 * `limit` defaults to `DEFAULT_SESSION_LIST_LIMIT` to bound the response
 * (a heavy dev can have hundreds of sessions in 30d; the drilldown UI
 * paginates client-side from this slice).
 */
export const getDevSessionList = async (
  exec: DrilldownExecutor,
  audit: AuditContext,
  params: { userId: string; days: number; limit?: number },
): Promise<DevSessionRow[]> => {
  void audit; // type-level gate, see file header
  const { userId, days } = params;
  const limit = params.limit ?? DEFAULT_SESSION_LIST_LIMIT;

  const result = await exec.execute(sql`
    SELECT
      session_id            AS "sessionId",
      started_at            AS "startedAt",
      ended_at              AS "endedAt",
      total_cost_usd::text  AS "totalCostUsd",
      total_input_tokens    AS "totalInputTokens",
      total_output_tokens   AS "totalOutputTokens",
      cache_hit_ratio::text AS "cacheHitRatio",
      avg_rating::text      AS "manualRating"
    FROM sessions_agg
    WHERE user_id = ${userId}
      AND started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    ORDER BY started_at DESC
    LIMIT ${limit}
  `);
  const rows = extractRows<{
    sessionId: string;
    startedAt: Date | string;
    endedAt: Date | string | null;
    totalCostUsd: string | null;
    totalInputTokens: number | string;
    totalOutputTokens: number | string;
    cacheHitRatio: string | null;
    manualRating: string | null;
  }>(result);

  return rows.map((row) => ({
    sessionId: row.sessionId,
    startedAt: toIsoTimestamp(row.startedAt),
    endedAt: row.endedAt == null ? null : toIsoTimestamp(row.endedAt),
    totalCostUsd: toFiniteNumber(row.totalCostUsd),
    totalInputTokens: Number(row.totalInputTokens),
    totalOutputTokens: Number(row.totalOutputTokens),
    cacheHitRatio: toNullableNumber(row.cacheHitRatio),
    manualRating: toNullableNumber(row.manualRating),
  }));
};

/**
 * Per-tool usage rolled into the closed 5-element bucket shape
 * (Edit / Read / Bash / Agent / Other).
 *
 * `Task` (legacy name) and `Agent` (current name) both land in the
 * `Agent` bucket — the Claude Code tool was renamed Task → Agent
 * without bumping the tool_use schema, so both names appear in
 * historical data. `bucketizeToolMix` (in `lib/analytics/tool-mix.ts`)
 * is the single source of truth for the mapping.
 *
 * **Audit context required at type level** — pair with
 * `writeAudit(tx, audit)` in the same transaction at the route layer
 * (TC-I-28: cross-team enforcement is the route, not this lib).
 *
 * Returns the full 5-element shape with all keys present (zero counts
 * when the dev has no sessions in the window) — the UI never has to
 * null-check (TC-I-32 contract).
 */
export const getDevToolUsage = async (
  exec: DrilldownExecutor,
  audit: AuditContext,
  params: { userId: string; days: number },
): Promise<DevToolUsage> => {
  void audit; // type-level gate, see file header
  const { userId, days } = params;

  // Sum tool_count_agg.count grouped by raw tool_name across the dev's
  // sessions in the window. Bucketize at JS layer using `bucketizeToolMix`
  // — keeps the bucket-mapping logic in ONE place
  // (`lib/analytics/tool-mix.ts`).
  const result = await exec.execute(sql`
    SELECT
      tca.tool_name AS "toolName",
      SUM(tca.count)::int AS "count"
    FROM tool_count_agg tca
    JOIN sessions_agg s
      ON s.user_id = tca.user_id AND s.session_id = tca.session_id
    WHERE tca.user_id = ${userId}
      AND s.started_at >= NOW() - (${days}::int * INTERVAL '1 day')
    GROUP BY tca.tool_name
  `);
  const rows = extractRows<{ toolName: string; count: number | string }>(result);

  // Expand into the flat list `bucketizeToolMix` expects (one entry per
  // raw call). Cheap: the rows are already aggregated by tool_name, so
  // the expansion is at most ~dozens of entries.
  const flatNames: string[] = [];
  for (const row of rows) {
    const n = Number(row.count);
    if (!Number.isFinite(n) || n <= 0) continue;
    for (let i = 0; i < n; i += 1) flatNames.push(row.toolName);
  }
  return bucketizeToolMix(flatNames);
};

// Touch helpers used in the file so unused-import lint stays quiet on
// a future refactor; `toIsoDate` is exported privately only to share with
// tests in the same package if needed in the future.
export { toIsoDate as _toIsoDate_for_tests };
