export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other';

export type ModelBreakdownItem = {
  family: ModelFamily;
  cost: number;
  pct: number;
};

/**
 * Colors used by UI to render each family. Stable across page loads and
 * shared with the legend/tooltip so the mapping can't drift.
 */
export const MODEL_FAMILY_COLORS: Record<ModelFamily, string> = {
  opus: '#a78bfa', // violet-400
  sonnet: '#38bdf8', // sky-400
  haiku: '#34d399', // emerald-400
  other: '#a3a3a3', // neutral-400
};

const FAMILY_PATTERN = /^claude-(opus|sonnet|haiku)\b/i;

/**
 * Classify a raw `turns.model` string into a family. Sufixos conhecidos do
 * Claude Code (`[1m]`, `-YYYYMMDD`) não alteram o resultado — o match é
 * só no prefixo `claude-<family>`.
 */
export function deriveModelFamily(model: string): ModelFamily {
  if (!model) return 'other';
  const m = FAMILY_PATTERN.exec(model);
  if (!m) return 'other';
  return m[1].toLowerCase() as ModelFamily;
}

const FAMILY_ORDER: Record<ModelFamily, number> = {
  opus: 0,
  sonnet: 1,
  haiku: 2,
  other: 3,
};

/**
 * Aggregate per-model cost rows into per-family totals with percent share.
 * Rows with `cost <= 0` are skipped; if every row is non-positive, returns
 * an empty array so the UI can hide the section.
 *
 * Sort order: cost DESC, ties broken by family enum order (opus, sonnet,
 * haiku, other) to keep the rendering stable across refreshes.
 */
export function groupByFamily(
  rows: ReadonlyArray<{ model: string; cost: number }>,
): ModelBreakdownItem[] {
  const totals = new Map<ModelFamily, number>();
  for (const r of rows) {
    if (!Number.isFinite(r.cost) || r.cost <= 0) continue;
    const family = deriveModelFamily(r.model);
    totals.set(family, (totals.get(family) ?? 0) + r.cost);
  }
  const grandTotal = Array.from(totals.values()).reduce((a, c) => a + c, 0);
  if (grandTotal <= 0) return [];
  return Array.from(totals.entries())
    .map(([family, cost]) => ({ family, cost, pct: cost / grandTotal }))
    .sort((a, b) => {
      if (b.cost !== a.cost) return b.cost - a.cost;
      return FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family];
    });
}
