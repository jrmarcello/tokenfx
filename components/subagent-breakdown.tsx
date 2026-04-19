import type { SubagentBreakdownRow } from '@/lib/queries/subagent';
import { fmtUsdFine, fmtCompact } from '@/lib/fmt';
import { distributePercents } from '@/lib/analytics/percent';

/**
 * Renders the cost breakdown of a session grouped by sub-agent.
 *
 * Hides itself (returns null) when `items.length <= 1` — a session with
 * only Main turns has nothing to compare against, so showing a single-row
 * table would be noise.
 *
 * Order follows `getSubagentBreakdown`: Main (subagentType=null) comes
 * first as a baseline anchor, then named sub-agents by cost desc. The
 * component does NOT re-sort — the query is authoritative.
 */
export function SubagentBreakdown({
  items,
}: {
  items: SubagentBreakdownRow[];
}) {
  if (items.length <= 1) return null;

  // Render with 2-decimal precision via largest-remainder distribution so
  // (a) tiny shares (< 0.05%) don't round down to 0.00% and (b) the
  // column sums exactly to 100.00%.
  const pctLabels = distributePercents(
    items.map((i) => i.pct),
    2,
  );

  return (
    <section aria-labelledby="subagent-breakdown-heading">
      <h2
        id="subagent-breakdown-heading"
        className="mb-3 text-lg font-medium"
      >
        Distribuição por agente
      </h2>
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Custo agregado por agente nesta sessão, com contagem de turnos,
            tokens de saída e percentual do spend total.
          </caption>
          <thead className="bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th scope="col" className="px-4 py-2 text-left font-medium">
                Agente
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right font-medium tabular-nums"
              >
                Turnos
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right font-medium tabular-nums"
              >
                Custo
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right font-medium tabular-nums"
              >
                Tokens
              </th>
              <th
                scope="col"
                className="px-4 py-2 text-right font-medium tabular-nums"
              >
                %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {items.map((row, idx) => {
              const isMain = row.subagentType === null;
              return (
                <tr key={row.subagentType ?? '__main__'}>
                  <td
                    className={`px-4 py-2 font-medium ${
                      isMain ? 'text-neutral-400' : 'text-amber-300'
                    }`}
                  >
                    {isMain ? 'Main' : row.subagentType}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-neutral-300">
                    {row.turns}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-neutral-100">
                    {fmtUsdFine(row.costUsd)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-neutral-300">
                    {fmtCompact(row.outputTokens)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-neutral-400">
                    {pctLabels[idx]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
