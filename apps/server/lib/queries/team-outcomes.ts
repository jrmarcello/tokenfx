/**
 * Query module for `team_outcomes_daily` rollups + derived ratio helpers.
 * Spec: .specs/manager-dashboard-v3-outcomes.md (REQ-12).
 *
 * Drizzle queries are stateless objects; the pg driver internally caches
 * prepared statements per connection. NO WeakMap caching — that pattern
 * applies only to better-sqlite3's `db.prepare()` API (see local repo
 * `lib/queries/effectiveness.ts:420-450`). Functions here accept `db: Db`
 * as parameter and compose Drizzle queries.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { getDb } from '@/lib/db/client';
import { teamOutcomesDaily } from '@/lib/db/schema';

// Same convention as lib/queries/manager-v2.ts:52 — derive the Db type
// from the exported `getDb` factory rather than re-exporting Db itself.
type Db = ReturnType<typeof getDb>;

// ---- Derived ratio helpers (pure JS, REQ-12) ------------------------------

/**
 * Tokens (input + output) divided by merged LOC. NULL when locAdded === 0
 * to avoid division by zero. The killer metric: "how much AI input was
 * needed to ship each line that survived in main".
 */
export const tokensPerMergedLoc = (input: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLocAdded: number;
}): number | null => {
  if (input.totalLocAdded === 0) return null;
  return (input.totalInputTokens + input.totalOutputTokens) / input.totalLocAdded;
};

/**
 * Cost (USD) divided by merged LOC. NULL when locAdded === 0.
 */
export const costPerMergedLoc = (input: {
  totalCostUsd: number;
  totalLocAdded: number;
}): number | null => {
  if (input.totalLocAdded === 0) return null;
  return input.totalCostUsd / input.totalLocAdded;
};

/**
 * Reverts within 7d divided by total commits. NULL when commits === 0
 * (no work to revert from). Returns 0.0 (NOT null) when reverts === 0
 * AND commits > 0 — that's a clean team and should be visible as such.
 */
export const revertRate = (input: {
  totalReverts: number;
  totalCommits: number;
}): number | null => {
  if (input.totalCommits === 0) return null;
  return input.totalReverts / input.totalCommits;
};

/**
 * Average merged PR count per session that produced outcome data. NULL
 * when sessionsWithOutcome === 0 OR totalMergedPrCount is NULL (PR
 * lookup feature off / all rate-limited).
 */
export const avgMergedPrsPerSessionWithOutcome = (input: {
  totalMergedPrCount: number | null;
  sessionsWithOutcome: number;
}): number | null => {
  if (input.sessionsWithOutcome === 0) return null;
  if (input.totalMergedPrCount === null) return null;
  return input.totalMergedPrCount / input.sessionsWithOutcome;
};

// ---- DB queries -----------------------------------------------------------

export type TeamOutcomesRollup = {
  orgId: string;
  teamId: string;
  day: string;
  totalCommits: number;
  totalLocAdded: number;
  totalLocRemoved: number;
  totalFilesChanged: number;
  totalRevertsWithin7d: number;
  totalMergedPrCount: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionsWithOutcome: number;
};

/**
 * Read team_outcomes_daily rows for an org over a date window. Used by
 * `/manager/outcomes` to compute KPIs + trend chart + per-team table.
 * Date strings ISO-8601 (`YYYY-MM-DD`).
 */
export const getTeamOutcomesForOrg = async (
  db: Db,
  input: { orgId: string; sinceDay: string; untilDay: string },
): Promise<TeamOutcomesRollup[]> => {
  const rows = await db
    .select({
      orgId: teamOutcomesDaily.orgId,
      teamId: teamOutcomesDaily.teamId,
      day: teamOutcomesDaily.day,
      totalCommits: teamOutcomesDaily.totalCommits,
      totalLocAdded: teamOutcomesDaily.totalLocAdded,
      totalLocRemoved: teamOutcomesDaily.totalLocRemoved,
      totalFilesChanged: teamOutcomesDaily.totalFilesChanged,
      totalRevertsWithin7d: teamOutcomesDaily.totalRevertsWithin7d,
      totalMergedPrCount: teamOutcomesDaily.totalMergedPrCount,
      totalInputTokens: teamOutcomesDaily.totalInputTokens,
      totalOutputTokens: teamOutcomesDaily.totalOutputTokens,
      // numeric(14,6) returns string in pg; cast at the SQL layer.
      totalCostUsd: sql<number>`${teamOutcomesDaily.totalCostUsd}::float8`,
      sessionsWithOutcome: teamOutcomesDaily.sessionsWithOutcome,
    })
    .from(teamOutcomesDaily)
    .where(
      and(
        eq(teamOutcomesDaily.orgId, input.orgId),
        gte(teamOutcomesDaily.day, input.sinceDay),
        lte(teamOutcomesDaily.day, input.untilDay),
      ),
    );
  return rows;
};

/**
 * Aggregate totals across ALL rows returned by `getTeamOutcomesForOrg` —
 * used for the org-level KPI cards (manager view) when the org has 2+
 * teams. Per-team detail goes through `getTeamOutcomesForOrg` directly.
 *
 * Mirrors Fase 4 effectiveness/page.tsx:239-265 — sum at the JS layer
 * rather than running a second SQL aggregate.
 */
export const aggregateOrgRollup = (
  rows: ReadonlyArray<TeamOutcomesRollup>,
): {
  totalCommits: number;
  totalLocAdded: number;
  totalLocRemoved: number;
  totalRevertsWithin7d: number;
  totalMergedPrCount: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionsWithOutcome: number;
} => {
  let totalCommits = 0;
  let totalLocAdded = 0;
  let totalLocRemoved = 0;
  let totalRevertsWithin7d = 0;
  let totalMergedPrCount: number | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let sessionsWithOutcome = 0;

  for (const r of rows) {
    totalCommits += r.totalCommits;
    totalLocAdded += r.totalLocAdded;
    totalLocRemoved += r.totalLocRemoved;
    totalRevertsWithin7d += r.totalRevertsWithin7d;
    totalInputTokens += r.totalInputTokens;
    totalOutputTokens += r.totalOutputTokens;
    totalCostUsd += r.totalCostUsd;
    sessionsWithOutcome += r.sessionsWithOutcome;
    if (r.totalMergedPrCount !== null) {
      totalMergedPrCount = (totalMergedPrCount ?? 0) + r.totalMergedPrCount;
    }
  }

  return {
    totalCommits,
    totalLocAdded,
    totalLocRemoved,
    totalRevertsWithin7d,
    totalMergedPrCount,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    sessionsWithOutcome,
  };
};
