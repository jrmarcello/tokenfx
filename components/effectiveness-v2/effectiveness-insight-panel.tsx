import type { ReactNode } from 'react';

import {
  formatInsightLine,
  type InsightMetric,
} from '@/lib/analytics/effectiveness-v2';

type AvgMetrics = {
  avgCacheHitRatio: number | null;
  avgTokensUntilFirstEdit: number | null;
  avgReadsToEditsRatio: number | null;
  avgToolErrorRate: number | null;
  sampleSize: number;
};

type Quartiles = {
  topQuartile: AvgMetrics;
  bottomQuartile: AvgMetrics;
};

type Props = {
  quartiles: Quartiles | null;
};

/**
 * Mapping from each insight row to the corresponding `AvgMetrics` field.
 * Order is fixed (cache, tokensUntilFirstEdit, readsToEdits, toolErrorRate)
 * per spec Design §12.
 */
const ROWS: ReadonlyArray<{
  metric: InsightMetric;
  field: keyof Omit<AvgMetrics, 'sampleSize'>;
}> = [
  { metric: 'cacheHitRatio', field: 'avgCacheHitRatio' },
  { metric: 'tokensUntilFirstEdit', field: 'avgTokensUntilFirstEdit' },
  { metric: 'readsToEditsRatio', field: 'avgReadsToEditsRatio' },
  { metric: 'toolErrorRate', field: 'avgToolErrorRate' },
] as const;

/**
 * Parse a string with `**bold**` markers into a React node, rendering the
 * bolded segments via `<strong>` and the rest via `<span>`. No
 * `dangerouslySetInnerHTML` — the input is split deterministically and each
 * segment is rendered through JSX (escaped by React).
 */
const renderBold = (text: string): ReactNode => {
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
};

/**
 * Server Component — renders four pt-BR natural-language insight lines
 * comparing top-quartile vs bottom-quartile sessions across the four
 * effectiveness metrics. Returns `null` when `quartiles` is `null`; the
 * parent decides empty-state copy.
 *
 * Markup is a `<table>` with one column (the formatted insight) so that the
 * `<caption>` + `<th scope="col">` semantics communicate the intent to
 * screen readers, even though the column header is visually hidden.
 */
export function EffectivenessInsightPanel({
  quartiles,
}: Props): React.JSX.Element | null {
  if (quartiles === null) return null;

  const { topQuartile, bottomQuartile } = quartiles;

  return (
    <table className="w-full text-sm text-neutral-700 dark:text-neutral-300">
      <caption className="sr-only">
        Insights comparativos: melhores vs piores sessões
      </caption>
      <thead>
        <tr>
          <th scope="col" className="sr-only">
            Insight
          </th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(({ metric, field }) => {
          const line = formatInsightLine(
            metric,
            topQuartile[field],
            bottomQuartile[field],
          );
          return (
            <tr key={metric}>
              <td className="py-1.5">{renderBold(line)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
