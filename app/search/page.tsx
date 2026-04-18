import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { searchTurns } from '@/lib/search/queries';
import { SearchForm } from '@/components/search/search-form';
import { SearchHit } from '@/components/search/search-hit';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAGE_SIZE = 25;

const ParamSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  days: z.coerce.number().int().min(0).max(3650).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type RawParams = Record<string, string | string[] | undefined>;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  await ensureFreshIngest();
  const raw = await searchParams;
  const parsed = ParamSchema.safeParse({
    q: firstString(raw.q),
    days: firstString(raw.days),
    offset: firstString(raw.offset),
  });

  const query = parsed.success ? parsed.data.q ?? '' : '';
  const days = parsed.success ? parsed.data.days : undefined;
  const offset = parsed.success ? parsed.data.offset ?? 0 : 0;
  const overflow =
    !parsed.success &&
    typeof raw.q === 'string' &&
    raw.q.trim().length > 200;

  const db = getDb();
  const { items, total } = query
    ? searchTurns(db, { query, days, limit: PAGE_SIZE, offset })
    : { items: [], total: 0 };

  const hasMorePrev = offset > 0;
  const hasMoreNext = offset + items.length < total;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Busca</h1>
        <p className="text-sm text-neutral-500">
          Full-text nos prompts e respostas dos seus transcripts.
        </p>
      </header>

      <SearchForm
        initialQuery={query}
        initialDays={days !== undefined ? String(days) : ''}
      />

      {overflow && (
        <p className="text-sm text-amber-400">
          Consulta muito longa (máx. 200 caracteres).
        </p>
      )}

      {!query && !overflow && (
        <p className="text-sm text-neutral-500">
          Digite um termo acima para começar a buscar.
        </p>
      )}

      {query && (
        <>
          <p className="text-xs text-neutral-500">
            {total === 0
              ? 'Nenhum resultado.'
              : `${total} ${total === 1 ? 'resultado' : 'resultados'}${total > PAGE_SIZE ? ` · exibindo ${offset + 1}–${Math.min(offset + items.length, total)}` : ''}`}
          </p>

          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((hit) => (
                <li key={hit.turnId}>
                  <SearchHit hit={hit} />
                </li>
              ))}
            </ul>
          )}

          {(hasMorePrev || hasMoreNext) && (
            <nav className="flex items-center justify-between pt-2 text-sm">
              <PaginationLink
                query={query}
                days={days}
                offset={Math.max(0, offset - PAGE_SIZE)}
                disabled={!hasMorePrev}
                label="← Anterior"
              />
              <PaginationLink
                query={query}
                days={days}
                offset={offset + PAGE_SIZE}
                disabled={!hasMoreNext}
                label="Próxima →"
              />
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function PaginationLink({
  query,
  days,
  offset,
  disabled,
  label,
}: {
  query: string;
  days: number | undefined;
  offset: number;
  disabled: boolean;
  label: string;
}) {
  const sp = new URLSearchParams();
  sp.set('q', query);
  if (days !== undefined) sp.set('days', String(days));
  if (offset > 0) sp.set('offset', String(offset));
  const cls =
    'rounded border border-neutral-800 px-3 py-1.5 text-neutral-300 transition';
  if (disabled) {
    return <span className={`${cls} opacity-40`}>{label}</span>;
  }
  return (
    <Link href={`/search?${sp.toString()}`} className={`${cls} hover:border-neutral-600`}>
      {label}
    </Link>
  );
}
