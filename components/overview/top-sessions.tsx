import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { CostSourceBadge } from '@/components/cost-source-badge';
import { fmtDate, fmtUsd } from '@/lib/fmt';
import type { TopSession } from '@/lib/queries/overview';

export function TopSessions({ items }: { items: TopSession[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
      <CardContent className="p-0">
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {items.map((s) => (
            <li key={s.id}>
              <Link
                href={`/sessions/${s.id}`}
                className="group flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-neutral-100 dark:hover:bg-neutral-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {s.project}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
                    {s.id}
                    <span className="mx-1.5 text-neutral-300 dark:text-neutral-700">•</span>
                    <span className="font-sans">{fmtDate(s.startedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-6 text-sm">
                  <span className="inline-flex items-center gap-1.5 tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                    {fmtUsd(s.totalCostUsd)}
                    <CostSourceBadge source={s.costSource} />
                  </span>
                  <span className="tabular-nums text-neutral-500">
                    {s.turnCount} turnos
                  </span>
                  <ChevronRightIcon className="size-4 text-neutral-400 dark:text-neutral-600 transition-colors group-hover:text-neutral-300" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
