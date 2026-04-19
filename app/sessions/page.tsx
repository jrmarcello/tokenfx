import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import {
  listSessions,
  listSessionsByDate,
  countSessions,
  countSessionsByDate,
} from '@/lib/queries/session';
import type { SessionListItem } from '@/lib/queries/session';
import { parseDateParam } from '@/lib/analytics/heatmap';
import {
  computePagination,
  type PaginationState,
} from '@/lib/analytics/pagination';
import { PaginationNav } from '@/components/pagination-nav';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { fmtUsd, fmtDateTime, fmtRating } from '@/lib/fmt';
import { CostSourceBadge } from '@/components/cost-source-badge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionsPageProps = {
  searchParams: Promise<{ date?: string; offset?: string }>;
};

type Branch =
  | {
      kind: 'all';
      items: SessionListItem[];
      total: number;
      pagination: PaginationState;
      invalid: boolean;
    }
  | {
      kind: 'filtered';
      items: SessionListItem[];
      total: number;
      pagination: PaginationState;
      date: string;
    };

function buildSubtitle(branch: Branch): string {
  const { pagination, total } = branch;
  const { rangeStart, rangeEnd, pageSize } = pagination;
  const showsRange = total > pageSize && !pagination.overflow;

  if (branch.kind === 'filtered') {
    const base = `${total} ${total === 1 ? 'encontrada' : 'encontradas'} em ${branch.date}`;
    return showsRange ? `${base} · exibindo ${rangeStart}–${rangeEnd}` : base;
  }
  // kind === 'all'
  if (total === 0) return '0 recentes';
  const base = `${total} ${total === 1 ? 'sessão' : 'sessões'}`;
  return showsRange ? `${base} · exibindo ${rangeStart}–${rangeEnd}` : base;
}

export default async function SessionsPage({ searchParams }: SessionsPageProps) {
  await ensureFreshIngest();
  const db = getDb();
  const params = await searchParams;
  const rawDate = params.date;
  const rawOffset = params.offset;
  const parsed = parseDateParam(rawDate);

  let branch: Branch;
  if (rawDate === undefined) {
    const total = countSessions(db);
    const pagination = computePagination({ rawOffset, total });
    const items = pagination.overflow
      ? []
      : listSessions(db, { limit: pagination.pageSize, offset: pagination.offset });
    branch = { kind: 'all', items, total, pagination, invalid: false };
  } else if (parsed.valid) {
    const total = countSessionsByDate(db, { start: parsed.start, end: parsed.end });
    const pagination = computePagination({ rawOffset, total });
    const items = pagination.overflow
      ? []
      : listSessionsByDate(db, parsed.date, {
          limit: pagination.pageSize,
          offset: pagination.offset,
        });
    branch = { kind: 'filtered', items, total, pagination, date: parsed.date };
  } else {
    // Invalid date: fall back to all-branch, paginate the full set.
    const total = countSessions(db);
    const pagination = computePagination({ rawOffset, total });
    const items = pagination.overflow
      ? []
      : listSessions(db, { limit: pagination.pageSize, offset: pagination.offset });
    branch = { kind: 'all', items, total, pagination, invalid: true };
  }

  const subtitle = buildSubtitle(branch);

  const firstPageHref =
    branch.kind === 'filtered' ? `/sessions?date=${branch.date}` : '/sessions';

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
      {branch.pagination.overflow && branch.total > 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-sm text-neutral-400">
          Sem sessões nesta página.{' '}
          <Link
            href={firstPageHref}
            className="text-neutral-300 underline-offset-2 hover:underline"
          >
            Voltar pra primeira página
          </Link>
        </div>
      ) : branch.kind === 'filtered' &&
        branch.items.length === 0 &&
        !branch.pagination.overflow ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-sm text-neutral-400">
          Sem sessões em {branch.date}.{' '}
          <Link
            href="/sessions"
            className="text-neutral-300 underline-offset-2 hover:underline"
          >
            ver todas
          </Link>
        </div>
      ) : branch.items.length === 0 && !branch.pagination.overflow ? (
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
      {!branch.pagination.overflow && (
        <PaginationNav
          basePath="/sessions"
          currentOffset={branch.pagination.offset}
          pageSize={branch.pagination.pageSize}
          total={branch.total}
          preserveParams={
            branch.kind === 'filtered' ? { date: branch.date } : undefined
          }
        />
      )}
    </section>
  );
}
