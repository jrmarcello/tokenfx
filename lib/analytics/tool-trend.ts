/**
 * Pure helpers for the Tool Success Trends feature (lib/queries/effectiveness
 * hosts the SQL; this module owns the analytics rules + color palette).
 */

/**
 * Minimum tool_calls in a (tool, week) bucket for the error rate to be
 * displayed. Below this threshold the rate is `null` and the chart shows
 * a gap — a single errored call in an otherwise-quiet week shouldn't spike
 * the line to 100%. Chosen empirically: 5 is the smallest N where a lone
 * error (20%) stops looking like pure noise.
 */
export const MIN_CALLS_PER_BUCKET = 5;

/**
 * 10-color dark-friendly palette for per-tool lines. Chosen for
 * discriminability against the #171717 surface and against each other.
 * Keep ordering stable — the hash-to-index mapping is cross-session.
 */
export const PALETTE = [
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#a855f7', // violet
  '#f43f5e', // rose
  '#14b8a6', // teal
  '#d946ef', // fuchsia
  '#84cc16', // lime
  '#fb923c', // orange
  '#06b6d4', // cyan
] as const;

/**
 * Deterministic string → index mapping using a Java-style 31-multiplier
 * hash, modded into the palette. Same tool name → same color across
 * runs/machines. Collisions exist beyond ~10 tools but don't matter for
 * the top-5 default — the UI never shows more than `topN` lines anyway.
 *
 * Empty strings still produce a valid index (0) and a valid color.
 */
export function colorForTool(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  return PALETTE[idx];
}

export type RawTrendRow = {
  week: string;
  toolName: string;
  calls: number;
  errors: number;
};

export type TrendPoint = {
  week: string;
  rates: Record<string, number | null>;
  counts: Record<string, { calls: number; errors: number }>;
};

export type ToolTrendResult = {
  tools: string[];
  points: TrendPoint[];
};

/**
 * Transforms raw `(week, toolName, calls, errors)` rows from SQL into a
 * `ToolTrendResult` suitable for Recharts multi-line consumption.
 *
 * Pipeline:
 *   1. Pick top-N tools by total `calls` within the window (desc), with
 *      alphabetic ascending tiebreak for determinism.
 *   2. For each (tool, week) bucket, compute `errors / calls` when
 *      `calls >= MIN_CALLS_PER_BUCKET`; otherwise emit `null` so the
 *      chart renders a gap. Counts are always preserved for tooltips.
 *   3. Clamp rates to `[0, 1]` (defense against `errors > calls` data).
 *   4. Omit weeks where EVERY kept tool has a null rate — those points
 *      carry no visible signal and would just pollute the X axis.
 */
export function buildTrend(
  rawRows: RawTrendRow[],
  topN: number,
): ToolTrendResult {
  if (rawRows.length === 0) return { tools: [], points: [] };

  // Step 1: rank tools by total calls in the window.
  const totalByTool = new Map<string, number>();
  for (const r of rawRows) {
    totalByTool.set(r.toolName, (totalByTool.get(r.toolName) ?? 0) + r.calls);
  }
  const rankedTools = Array.from(totalByTool.entries())
    .sort(([aName, aTotal], [bName, bTotal]) => {
      if (bTotal !== aTotal) return bTotal - aTotal;
      return aName < bName ? -1 : aName > bName ? 1 : 0;
    })
    .slice(0, Math.max(1, topN))
    .map(([name]) => name);
  const toolSet = new Set(rankedTools);

  // Step 2: bucket raw rows by week, keeping only tools in the top-N.
  type Bucket = Map<string, { calls: number; errors: number }>;
  const byWeek = new Map<string, Bucket>();
  for (const r of rawRows) {
    if (!toolSet.has(r.toolName)) continue;
    let bucket = byWeek.get(r.week);
    if (!bucket) {
      bucket = new Map();
      byWeek.set(r.week, bucket);
    }
    bucket.set(r.toolName, { calls: r.calls, errors: r.errors });
  }

  // Step 3: emit points in ASC week order, computing rates with threshold
  // + clamp. Drop weeks with zero non-null rates.
  const sortedWeeks = Array.from(byWeek.keys()).sort();
  const points: TrendPoint[] = [];
  for (const week of sortedWeeks) {
    const bucket = byWeek.get(week)!;
    const rates: Record<string, number | null> = {};
    const counts: Record<string, { calls: number; errors: number }> = {};
    let anyValid = false;
    for (const tool of rankedTools) {
      const c = bucket.get(tool);
      if (!c) continue; // tool didn't appear this week at all
      counts[tool] = { calls: c.calls, errors: c.errors };
      if (c.calls >= MIN_CALLS_PER_BUCKET) {
        const raw = c.calls > 0 ? c.errors / c.calls : 0;
        const clamped = Math.max(0, Math.min(1, raw));
        rates[tool] = clamped;
        anyValid = true;
      } else {
        rates[tool] = null;
      }
    }
    if (anyValid) {
      points.push({ week, rates, counts });
    }
  }

  return { tools: rankedTools, points };
}
