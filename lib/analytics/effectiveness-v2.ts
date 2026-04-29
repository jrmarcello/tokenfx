/**
 * Helpers and constants for the personal-effectiveness v2 module.
 *
 * Pure functions only — zero side effects. Consumed by `lib/queries/effectiveness-v2.ts`
 * and the `<EffectivenessHeatmap />` / `<EffectivenessInsightPanel />` components.
 */

/**
 * Tool-error-rate threshold below which a session is considered "low-error".
 * Locked at 0.1 (10%) per spec REQ-21 / Design §12.
 */
export const LOW_TOOL_ERROR_RATE_THRESHOLD = 0.1;

/**
 * Minimum number of sessions in a window for the effectiveness funnel to
 * surface medians. Below this the funnel returns `[]` (signal-to-noise too
 * low). Mirrors `MIN_CALLS_PER_BUCKET` in `tool-trend.ts`.
 */
export const MIN_FUNNEL_SESSIONS = 5;

/**
 * Bipolar palette for the effectiveness heatmap. Five swatches indexed by
 * level L0..L4:
 * - L0: no data (neutral-600)
 * - L1: ruim — rose-400
 * - L2: médio — amber-400
 * - L3: bom — lime-400
 * - L4: ótimo — emerald-400
 *
 * Spec REQ-24 / Design §12. Locked hex values (Tailwind tokens).
 */
export const EFFECTIVENESS_PALETTE = [
  '#525252', // L0 sem dado — neutral-600
  '#fb7185', // L1 ruim — rose-400
  '#fbbf24', // L2 médio — amber-400
  '#a3e635', // L3 bom — lime-400
  '#34d399', // L4 ótimo — emerald-400
] as const;

export type EffectivenessLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Map a composite effectiveness score (0..100) to a palette level.
 *
 * - `null`        → 0 (no data)
 * - `[0, 25)`     → 1 (ruim)
 * - `[25, 50)`    → 2 (médio-baixo)
 * - `[50, 75)`    → 3 (médio-bom)
 * - `[75, 100]`   → 4 (ótimo) — note: 100 is inclusive
 *
 * Authoritative source: spec `effectiveness-personal-v2.md` Design §10
 * (fixed quartile breakpoints). REQ-24's `Math.ceil(4 * score / 100)`
 * formula is approximate and DIVERGES at boundary integers (25/50/75) —
 * Design §10 takes precedence; tests pin Design §10 behavior.
 */
export const effectivenessLevelFor = (
  score: number | null,
): EffectivenessLevel => {
  if (score === null) return 0;
  if (score < 25) return 1;
  if (score < 50) return 2;
  if (score < 75) return 3;
  return 4;
};

/**
 * Median of a numeric series. Filters NaN/Infinity defensively before sorting
 * so a single bad input cannot poison the result.
 *
 * - empty array → `null`
 * - odd count   → middle value
 * - even count  → mean of two middle values
 * - all values filtered out → `null`
 */
export const computeMedian = (values: number[]): number | null => {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  const sorted = [...finite].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The four metrics the insight panel surfaces (top vs bottom quartile).
 * Order matches the row order in `<EffectivenessInsightPanel />`.
 */
export type InsightMetric =
  | 'tokensUntilFirstEdit'
  | 'readsToEditsRatio'
  | 'toolErrorRate'
  | 'cacheHitRatio';

/**
 * Per-metric microcopy descriptors.
 *
 * - `verb` is the action verb the template uses ("leem", "erram", ...).
 * - `unit` is the trailing clause that follows the value ("arquivos por Edit",
 *   "tokens antes do 1º Edit", "das tool calls", "do contexto").
 * - `format` decides how the numeric value is rendered:
 *   - `'integer'` → `Math.round(value)` then stringify
 *   - `'percent'` → `Math.round(value * 100)` + `'%'`
 *
 * pt-BR per user preference; technical comments stay in EN.
 */
type MetricCopy = {
  readonly verb: string;
  readonly unit: string;
  readonly format: 'integer' | 'percent';
};

const METRIC_COPY: Record<InsightMetric, MetricCopy> = {
  tokensUntilFirstEdit: {
    verb: 'exploram',
    unit: 'tokens antes do 1º Edit',
    format: 'integer',
  },
  readsToEditsRatio: {
    verb: 'leem',
    unit: 'arquivos por Edit',
    format: 'integer',
  },
  toolErrorRate: {
    verb: 'erram',
    unit: 'das tool calls',
    format: 'percent',
  },
  cacheHitRatio: {
    verb: 'reaproveitam',
    unit: 'do contexto',
    format: 'percent',
  },
};

const formatValue = (value: number, format: MetricCopy['format']): string => {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  return `${Math.round(value)}`;
};

/**
 * Render a deterministic pt-BR insight line comparing top-quartile vs
 * bottom-quartile values for a single metric.
 *
 * Cases (spec Design §12):
 * - `top === bottom` (and not null) → `"Padrão consistente em **{value}**"`
 * - `top` null, `bottom` present → `"Suas piores sessões ... ; sem dado das melhores ainda"`
 * - `top` present, `bottom` null → `"Suas melhores sessões ... ; sem dado das piores ainda"`
 * - both null → `"Sem dado suficiente ainda"` (defensive — caller should usually
 *   render `null` instead, but we never throw here).
 * - both present → full comparative template per metric.
 */
export const formatInsightLine = (
  metric: InsightMetric,
  top: number | null,
  bottom: number | null,
): string => {
  const copy = METRIC_COPY[metric];
  const { verb, unit, format } = copy;

  if (top === null) {
    if (bottom === null) {
      return 'Sem dado suficiente ainda';
    }
    const b = formatValue(bottom, format);
    return `Suas piores sessões ${verb} **${b}** ${unit}; sem dado das melhores ainda`;
  }

  if (bottom === null) {
    const t = formatValue(top, format);
    return `Suas melhores sessões ${verb} **${t}** ${unit}; sem dado das piores ainda`;
  }

  // both non-null at this point
  if (top === bottom) {
    return `Padrão consistente em **${formatValue(top, format)}**`;
  }

  const t = formatValue(top, format);
  const b = formatValue(bottom, format);
  return `Suas melhores sessões ${verb} **${t}** ${unit}; suas piores ${verb} **${b}**`;
};
