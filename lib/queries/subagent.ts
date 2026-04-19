import type { DB } from '@/lib/db/client';

export type SubagentBreakdownRow = {
  subagentType: string | null; // null = Main (main agent work)
  turns: number;
  costUsd: number;
  outputTokens: number;
  pct: number; // [0, 1]; sum across rows ≈ 1.0 for non-empty result
};

type PreparedSet = {
  breakdown: import('better-sqlite3').Statement<[string]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    breakdown: db.prepare(
      // SQLite's GROUP BY treats NULL as its own distinct group, so the
      // main-agent bucket (subagent_type IS NULL) naturally appears as a
      // single row alongside the named sub-agents.
      `SELECT subagent_type                    AS subagentType,
              COUNT(*)                         AS turns,
              COALESCE(SUM(cost_usd), 0)       AS costUsd,
              COALESCE(SUM(output_tokens), 0)  AS outputTokens
       FROM turns
       WHERE session_id = ?
       GROUP BY subagent_type`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

type BreakdownRow = {
  subagentType: string | null;
  turns: number;
  costUsd: number;
  outputTokens: number;
};

/**
 * Breakdown of a session's cost by sub-agent. Groups turns by
 * `subagent_type` (NULL becomes the `null` row labeled "Main" in the UI).
 *
 * Ordering (stable): the `null` row (Main) comes FIRST as a baseline
 * anchor; the remaining rows are sorted by `costUsd` DESC. Ties are
 * broken by `subagentType` ascending for determinism.
 *
 * Returns `[]` in three fast-paths:
 * - session not found
 * - session has no turns
 * - sum(cost_usd) = 0 across all turns of the session (avoids div-by-0
 *   and keeps the UI from rendering an empty/meaningless breakdown)
 */
export function getSubagentBreakdown(
  db: DB,
  sessionId: string,
): SubagentBreakdownRow[] {
  const p = getPrepared(db);
  const rows = p.breakdown.all(sessionId) as BreakdownRow[];
  if (rows.length === 0) return [];

  const total = rows.reduce((acc, r) => acc + r.costUsd, 0);
  if (total === 0) return [];

  const withPct: SubagentBreakdownRow[] = rows.map((r) => ({
    subagentType: r.subagentType,
    turns: r.turns,
    costUsd: r.costUsd,
    outputTokens: r.outputTokens,
    pct: r.costUsd / total,
  }));

  const mainRow = withPct.find((r) => r.subagentType === null) ?? null;
  const rest = withPct.filter((r) => r.subagentType !== null);
  rest.sort((a, b) => {
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    // Stable tiebreak: subagentType ascending. Non-null here by construction.
    const aName = a.subagentType ?? '';
    const bName = b.subagentType ?? '';
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });

  return mainRow ? [mainRow, ...rest] : rest;
}
