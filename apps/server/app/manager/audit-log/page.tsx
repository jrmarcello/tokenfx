/**
 * `/manager/audit-log` — auth-event audit log surface (REQ-4 + REQ-5).
 *
 * Server Component. Reads `auth_event_log` rows scoped to users of the
 * acting manager's org via `loadAuditLogPage` (see `lib/queries/audit-log.ts`).
 *
 * Anti-leaderboard: the table has **static text headers** with no sort
 * controls. Order is fixed `ORDER BY occurred_at DESC` at the query layer.
 *
 * Privacy: only the first 8 chars of the peppered `email_hash` are surfaced
 * (already projected by the query as `emailHashPrefix`). The plaintext email
 * NEVER leaves the database for this page or its CSV export sibling.
 *
 * Auth: the parent `app/manager/layout.tsx` already enforces role
 * (manager|admin) — we re-read the session here to grab `orgId` for the
 * query (defense-in-depth, same pattern as other manager pages).
 *
 * `searchParams` Zod-parsing (spec TASK-18 §Page):
 *  - `page` → clamped non-negative integer; out-of-range / NaN / negative
 *    fall back to `0` (the page rendering NEVER 4xx-s on a bad query string;
 *    we render the first page silently).
 *  - `outcome` → enum membership check; invalid values fall back to
 *    `undefined` (filter unset).
 *  - `iss`, `city`, `browser` → max-length 200; longer values truncated.
 *  - `from`, `to` → ISO-8601 parse; invalid → `undefined`.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import {
  loadAuditLogPage,
  type AuditLogFilters,
} from '@/lib/queries/audit-log';
import { AuditLogFilters as AuditLogFiltersForm } from './audit-log-filters';

/** Mirrors the `auth_event_log_outcome_check` CHECK constraint in schema.ts. */
const OUTCOME_VALUES = [
  'accepted-sso-auto',
  'rejected-public-domain',
  'rejected-multiple-matches',
  'rejected-no-match',
  'rejected-race',
  'rejected-csrf',
  'rejected-replay',
  'rejected-cross-idp',
  'rejected-pre-existing-binding',
  'email-not-verified',
] as const;

export type AuditLogOutcome = (typeof OUTCOME_VALUES)[number];

const MAX_TEXT_LEN = 200;
const MAX_PAGE = 10_000;
const PAGE_SIZE = 50;

/**
 * Single source of truth for query-string parsing. `.catch(undefined)` /
 * `.catch(0)` makes every field bullet-proof against malformed input: the
 * page renders the first results page silently rather than surfacing a 4xx.
 */
const searchParamsSchema = z.object({
  page: z
    .coerce.number()
    .int()
    .min(0)
    .max(MAX_PAGE)
    .catch(0),
  outcome: z
    .enum(OUTCOME_VALUES)
    .optional()
    .catch(undefined),
  iss: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  city: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  browser: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
});

/**
 * Trim the URL down to `?key=value` pairs the user actively set. Empty
 * strings and `undefined` are dropped so the CSV export href is clean
 * (and so the back-button history doesn't accumulate noise).
 */
const buildExportHref = (
  parsed: z.infer<typeof searchParamsSchema>,
): string => {
  const params = new URLSearchParams();
  if (parsed.outcome) params.set('outcome', parsed.outcome);
  if (parsed.iss) params.set('iss', parsed.iss);
  if (parsed.city) params.set('city', parsed.city);
  if (parsed.browser) params.set('browser', parsed.browser);
  if (parsed.from) params.set('from', parsed.from);
  if (parsed.to) params.set('to', parsed.to);
  const qs = params.toString();
  return qs.length > 0 ? `/manager/audit-log/export?${qs}` : '/manager/audit-log/export';
};

const formatTimestamp = (d: Date): string =>
  d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

type SearchParams = Record<string, string | string[] | undefined>;

const normalizeSingle = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
};

const flattenSearchParams = (sp: SearchParams): Record<string, string | undefined> => ({
  page: normalizeSingle(sp.page),
  outcome: normalizeSingle(sp.outcome),
  iss: normalizeSingle(sp.iss),
  city: normalizeSingle(sp.city),
  browser: normalizeSingle(sp.browser),
  from: normalizeSingle(sp.from),
  to: normalizeSingle(sp.to),
});

export default async function ManagerAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const rawParams = await searchParams;
  const parsed = searchParamsSchema.parse(flattenSearchParams(rawParams));

  const filters: AuditLogFilters = {
    outcome: parsed.outcome,
    iss: parsed.iss,
    city: parsed.city,
    browser: parsed.browser,
    from: parsed.from ? new Date(parsed.from) : undefined,
    to: parsed.to ? new Date(parsed.to) : undefined,
  };

  const db = getDb();
  const result = await loadAuditLogPage(db, orgId, filters, parsed.page, PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(result.totalCount / result.pageSize));
  const hasPrev = result.page > 0;
  const hasNext = result.page + 1 < totalPages;

  const buildPageHref = (nextPage: number): string => {
    const params = new URLSearchParams();
    if (parsed.outcome) params.set('outcome', parsed.outcome);
    if (parsed.iss) params.set('iss', parsed.iss);
    if (parsed.city) params.set('city', parsed.city);
    if (parsed.browser) params.set('browser', parsed.browser);
    if (parsed.from) params.set('from', parsed.from);
    if (parsed.to) params.set('to', parsed.to);
    if (nextPage > 0) params.set('page', String(nextPage));
    const qs = params.toString();
    return qs.length > 0 ? `/manager/audit-log?${qs}` : '/manager/audit-log';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <nav
            className="mb-1 text-xs text-neutral-500 dark:text-neutral-400"
            aria-label="Breadcrumb"
          >
            <Link
              href="/manager"
              className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
            >
              Manager
            </Link>
            <span className="mx-1.5">/</span>
            <span>Audit log</span>
          </nav>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Audit log
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Auth events scoped to this org. Email addresses are stored as
            peppered hashes — only the first 8 hex characters are shown.
          </p>
        </div>
        <Link
          href={buildExportHref(parsed)}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 shadow-sm transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          data-testid="audit-log-export-link"
          prefetch={false}
        >
          Export CSV
        </Link>
      </div>

      <AuditLogFiltersForm
        outcomeOptions={OUTCOME_VALUES}
        initialFilters={{
          outcome: parsed.outcome ?? '',
          iss: parsed.iss ?? '',
          city: parsed.city ?? '',
          browser: parsed.browser ?? '',
          from: parsed.from ?? '',
          to: parsed.to ?? '',
        }}
      />

      {result.rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="audit-log-empty"
        >
          No events match the current filters.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table
            className="w-full text-sm"
            data-testid="audit-log-table"
          >
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-800/50 dark:text-neutral-400">
              <tr>
                {/* Static headers — no sort controls. Anti-leaderboard. */}
                <th scope="col" className="px-4 py-2 font-medium">
                  Occurred at (UTC)
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Outcome
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Email hash
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Issuer
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  City
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Browser
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {result.rows.map((row, idx) => (
                <tr key={`${row.occurredAt.toISOString()}-${row.emailHashPrefix}-${idx}`}>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300 tabular-nums">
                    {formatTimestamp(row.occurredAt)}
                  </td>
                  <td className="px-4 py-2 text-neutral-900 dark:text-neutral-100">
                    {row.outcome}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                    {row.emailHashPrefix}
                  </td>
                  <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">
                    {row.iss}
                  </td>
                  <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">
                    {row.city ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">
                    {row.browser ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="flex items-center justify-between gap-4 text-sm"
        data-testid="audit-log-pagination"
      >
        <p className="text-neutral-600 dark:text-neutral-400">
          Page {result.page + 1} of {totalPages} · {result.totalCount} event
          {result.totalCount === 1 ? '' : 's'}
        </p>
        <div className="flex gap-2">
          {hasPrev ? (
            <Link
              href={buildPageHref(result.page - 1)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
              data-testid="audit-log-prev"
            >
              ← Previous
            </Link>
          ) : (
            <span
              className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-200 px-3 text-sm font-medium text-neutral-400 dark:border-neutral-800 dark:text-neutral-600"
              aria-disabled="true"
            >
              ← Previous
            </span>
          )}
          {hasNext ? (
            <Link
              href={buildPageHref(result.page + 1)}
              className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
              data-testid="audit-log-next"
            >
              Next →
            </Link>
          ) : (
            <span
              className="inline-flex h-9 items-center justify-center rounded-md border border-neutral-200 px-3 text-sm font-medium text-neutral-400 dark:border-neutral-800 dark:text-neutral-600"
              aria-disabled="true"
            >
              Next →
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
