import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { listSessions } from '@/lib/queries/session';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { fmtUsd, fmtDateTime } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SessionsPage() {
  await ensureFreshIngest();
  const db = getDb();
  const items = listSessions(db, 100);

  return (
    <section className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Sessões</h1>
        <p className="text-sm text-neutral-500">{items.length} recentes</p>
      </header>
      {items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400 text-sm">
          Sem sessões ainda. Rode{' '}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">
            pnpm ingest
          </code>
          .
        </div>
      ) : (
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-0">
            <ul className="divide-y divide-neutral-800">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/sessions/${s.id}`}
                    className="group flex items-center justify-between gap-4 px-4 py-3 transition hover:bg-neutral-800/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-neutral-100">
                        {s.project}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
                        {s.id}
                        <span className="mx-1.5 text-neutral-700">•</span>
                        <span className="font-sans">{fmtDateTime(s.startedAt)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-6 text-sm">
                      <span className="tabular-nums font-medium text-neutral-100">
                        {fmtUsd(s.totalCostUsd)}
                      </span>
                      <span className="tabular-nums text-neutral-500">
                        {s.turnCount} turnos
                      </span>
                      {s.avgRating !== null && (
                        <span className="tabular-nums text-neutral-400">
                          {s.avgRating.toFixed(1)}★
                        </span>
                      )}
                      <ChevronRightIcon className="size-4 text-neutral-600 transition-colors group-hover:text-neutral-300" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
