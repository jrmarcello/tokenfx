import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { listSessions, listSessionsByDate } from '@/lib/queries/session';
import type { SessionListItem } from '@/lib/queries/session';
import { parseDateParam } from '@/lib/analytics/heatmap';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { fmtUsd, fmtDateTime, fmtRating } from '@/lib/fmt';
import { CostSourceBadge } from '@/components/cost-source-badge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionsPageProps = {
  searchParams: Promise<{ date?: string }>;
};

type Branch =
  | { kind: 'all'; items: SessionListItem[]; invalid: boolean }
  | { kind: 'filtered'; items: SessionListItem[]; date: string };

export default async function SessionsPage({ searchParams }: SessionsPageProps) {
  await ensureFreshIngest();
  const db = getDb();
  const params = await searchParams;
  const rawDate = params.date;
  const parsed = parseDateParam(rawDate);

  let branch: Branch;
  if (rawDate === undefined) {
    branch = { kind: 'all', items: listSessions(db, 100), invalid: false };
  } else if (parsed.valid) {
    branch = {
      kind: 'filtered',
      items: listSessionsByDate(db, parsed.date),
      date: parsed.date,
    };
  } else {
    branch = { kind: 'all', items: listSessions(db, 100), invalid: true };
  }

  const subtitle =
    branch.kind === 'filtered'
      ? `Sessões de ${branch.date} — ${branch.items.length} ${branch.items.length === 1 ? 'encontrada' : 'encontradas'}`
      : `${branch.items.length} recentes`;

  return (
    <section className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Sessões</h1>
        <p className="text-sm text-neutral-500">
          {subtitle}
          {branch.kind === 'filtered' && branch.items.length > 0 && (
            <>
              {' '}
              <Link
                href="/sessions"
                className="text-neutral-400 underline-offset-2 hover:underline"
              >
                ver todas
              </Link>
            </>
          )}
        </p>
      </header>
      {branch.kind === 'all' && branch.invalid && (
        <div className="rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
          Parâmetro date inválido — mostrando todas.
        </div>
      )}
      {branch.kind === 'filtered' && branch.items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-sm text-neutral-400">
          Sem sessões em {branch.date}.{' '}
          <Link
            href="/sessions"
            className="text-neutral-300 underline-offset-2 hover:underline"
          >
            ver todas
          </Link>
        </div>
      ) : branch.items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-sm text-neutral-400">
          Sem sessões ainda. Rode{' '}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5">
            pnpm ingest
          </code>
          .
        </div>
      ) : (
        <Card className="border-neutral-800 bg-neutral-900">
          <CardContent className="p-0">
            <ul className="divide-y divide-neutral-800">
              {branch.items.map((s) => (
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
                      <span className="inline-flex items-center gap-1.5 font-medium tabular-nums text-neutral-100">
                        {fmtUsd(s.totalCostUsd)}
                        <CostSourceBadge source={s.costSource} />
                      </span>
                      <span className="tabular-nums text-neutral-500">
                        {s.turnCount} turnos
                      </span>
                      {s.avgRating !== null && (
                        <span
                          className="tabular-nums text-neutral-400"
                          title="Avaliação média (−1 ruim · 0 neutro · +1 bom)"
                        >
                          aval {fmtRating(s.avgRating)}
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
