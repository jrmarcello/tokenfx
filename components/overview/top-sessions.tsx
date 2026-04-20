'use client';

import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { CostSourceBadge } from '@/components/cost-source-badge';
import { cn } from '@/lib/cn';
import { fmtDate, fmtUsd } from '@/lib/fmt';
import type { TopSession } from '@/lib/queries/overview';
import { type SortMode } from '@/lib/top-sessions-sort';

export { SortModeSchema, type SortMode } from '@/lib/top-sessions-sort';

const MODE_LABELS: Record<SortMode, string> = {
  cost: 'Custo',
  score: 'Score',
  turns: 'Turnos',
};

const MODE_HINTS: Record<SortMode, string> = {
  cost: 'Maior → menor custo',
  score: 'Menor → maior score (sessões caras com baixa efetividade)',
  turns: 'Mais longas primeiro',
};

type Props = {
  itemsByMode: Record<SortMode, TopSession[]>;
  mode: SortMode;
  modes?: SortMode[];
};

/**
 * Top-N sessões com toggle de ordenação. Caller pré-computa as 3 listas
 * (cost/score/turns) e passa via `itemsByMode`. O toggle é client-side,
 * atualiza `?sort=X` na URL via `router.replace` sem full reload.
 */
export function TopSessions({
  itemsByMode,
  mode,
  modes = ['cost', 'score', 'turns'],
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const items = itemsByMode[mode];

  const setMode = (next: SortMode) => {
    if (next === mode) return;
    const sp = new URLSearchParams(params?.toString() ?? '');
    if (next === 'cost') sp.delete('sort');
    else sp.set('sort', next);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : (pathname ?? '/'), {
      scroll: false,
    });
  };

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 p-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
        Sem sessões pra listar nesta janela.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Ordenar sessões por"
        className="inline-flex items-center gap-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 text-xs"
      >
        {modes.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${MODE_LABELS[m]} — ${MODE_HINTS[m]}`}
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2.5 py-1 transition-colors',
                active
                  ? 'bg-neutral-100 dark:bg-neutral-800 font-medium text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
              )}
            >
              {MODE_LABELS[m]}
            </button>
          );
        })}
      </div>
      <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
        <CardContent className="p-0">
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {items.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/sessions/${s.id}`}
                  className="group flex flex-col gap-2 px-4 py-3 transition hover:bg-neutral-100 dark:hover:bg-neutral-800/50 md:flex-row md:items-center md:justify-between md:gap-4"
                >
                  <div className="min-w-0 md:flex-1">
                    <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {s.project}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
                      {s.id}
                      <span className="mx-1.5 text-neutral-300 dark:text-neutral-700">•</span>
                      <span className="font-sans">{fmtDate(s.startedAt)}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm md:shrink-0 md:flex-nowrap md:gap-6">
                    <span className="inline-flex items-center gap-1.5 tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                      {fmtUsd(s.totalCostUsd)}
                      <CostSourceBadge source={s.costSource} />
                    </span>
                    <span className="tabular-nums text-neutral-500">
                      {s.turnCount} turnos
                    </span>
                    <ChevronRightIcon className="ml-auto size-4 shrink-0 text-neutral-400 dark:text-neutral-600 transition-colors group-hover:text-neutral-700 dark:group-hover:text-neutral-300 md:ml-0" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
