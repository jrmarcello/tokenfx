import {
  MODEL_FAMILY_COLORS,
  type ModelBreakdownItem,
} from '@/lib/analytics/model';
import { fmtUsdFine, fmtPct } from '@/lib/fmt';

type Props = { items: ModelBreakdownItem[] };

/**
 * Horizontal stacked bar substituindo o pie chart. Escala linearmente
 * com N famílias (pie fica ruim com 4+). Cada segmento é proporcional ao
 * custo da família no total. Legend abaixo com label + custo + percentual.
 */
export function ModelBreakdownBar({ items }: Props) {
  if (items.length === 0) return null;

  const total = items.reduce((sum, i) => sum + i.cost, 0);
  if (total <= 0) return null;

  return (
    <div className="w-full space-y-3">
      <div
        className="flex h-8 w-full overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800"
        role="img"
        aria-label={`Distribuição de custo por família de modelo: ${items
          .map((i) => `${i.family} ${fmtPct(i.pct)}`)
          .join(', ')}`}
      >
        {items.map((it) => (
          <div
            key={it.family}
            style={{
              width: `${(it.cost / total) * 100}%`,
              backgroundColor: MODEL_FAMILY_COLORS[it.family],
            }}
            title={`${it.family}: ${fmtUsdFine(it.cost)} (${fmtPct(it.pct)})`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {items.map((it) => (
          <li
            key={it.family}
            className="inline-flex items-center gap-1.5 text-neutral-700 dark:text-neutral-300"
          >
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: MODEL_FAMILY_COLORS[it.family] }}
            />
            <span className="font-medium">{it.family}</span>
            <span className="text-neutral-500 tabular-nums">
              {fmtUsdFine(it.cost)} · {fmtPct(it.pct)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
