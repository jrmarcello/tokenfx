/**
 * `/me/visibility` — manager-dashboard-v2 REQ-17.
 *
 * Server-rendered. Shows the dev viewing the page:
 *   (a) the SAME aggregated KPIs their manager sees about them
 *       (cache hit, good-session %, subagent adoption %, tool mix — 30d);
 *   (b) the chronological log of every drilldown row in
 *       `manager_drilldown_audit` where `target_user_id = self`, paginated
 *       25/page, newest-first.
 *
 * # Anti-surveillance principle 5 (LOCKED — see spec Design)
 *
 * "Devs see what their manager sees." Even if the org later flips
 * `drilldown_notification_enabled = false`, the historical audit log on this
 * page keeps showing past views. This page does NOT read
 * `org_settings.drilldown_notification_enabled` — devs can't be retroactively
 * un-told they were watched (TC-I-32 + TC-E2E-11).
 *
 * # Auth
 *
 * `apps/server/middleware.ts` matcher includes `/me/:path*`, so an
 * unauthenticated request never reaches this handler. We additionally
 * defend in depth via `auth()` and redirect to sign-in if the session is
 * missing.
 *
 * # Pagination contract
 *
 * `?page=N` (1-based, default 1). Validated via Zod
 * `z.coerce.number().int().min(1)`. Invalid input renders a 400-equivalent
 * panel with `data-testid="me-visibility-400"` (TC-I-71/TC-I-72). A
 * legitimate-but-overshooting page (e.g. `?page=9999` when the dev has 0
 * audits — TC-I-73) renders the normal page with an empty audit table —
 * NOT a 400 — because the URL is well-formed.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { KpiCard } from '@/components/manager/kpi-card';
import { AuditLogTable } from '@/components/me/audit-log-table';
import {
  DEFAULT_AUDIT_PAGE_SIZE,
  getMyDrilldownAudit,
  getMyKpis,
} from '@/lib/queries/me-visibility';

// `page` is the only knob — `pageSize` is fixed at 25 per spec REQ-17.
const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

const formatPct = (n: number, fractionDigits = 1): string =>
  `${n.toFixed(fractionDigits)}%`;

const formatRatio = (n: number | null): string => {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
};

const formatToolCount = (n: number): string => n.toLocaleString('en-US');

// Next 15: `searchParams` is a Promise that resolves to a record of strings
// or string arrays. We await it before passing to Zod.
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function MyVisibilityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/api/auth/signin');
  }
  const userId = session.user.id;

  const resolvedSearchParams = await searchParams;
  const parsed = PageQuerySchema.safeParse({
    page: resolvedSearchParams.page,
  });

  if (!parsed.success) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 p-8" data-testid="me-visibility-400">
        <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
          400 — Invalid page parameter
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          The <code>?page</code> query parameter must be a positive integer.
          Try{' '}
          <Link href="/me/visibility" className="underline">
            page 1
          </Link>
          .
        </p>
      </main>
    );
  }

  const page = parsed.data.page;
  const pageSize = DEFAULT_AUDIT_PAGE_SIZE;

  const db = getDb();

  const [kpis, auditPage] = await Promise.all([
    getMyKpis(db, userId),
    getMyDrilldownAudit(db, { userId, page, pageSize }),
  ]);

  const totalPages = Math.max(1, Math.ceil(auditPage.total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8" data-testid="me-visibility-page">
      <header>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          My visibility
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          What your manager sees about you in aggregate, plus a chronological
          log of every drilldown into your individual data. Historical entries
          remain visible even if the org disables notifications.
        </p>
      </header>

      <section
        aria-labelledby="my-kpis-heading"
        className="space-y-3"
        data-testid="me-visibility-kpis"
      >
        <h2
          id="my-kpis-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Your effectiveness (last 30 days)
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiCard
            label="Cache hit"
            value={formatRatio(kpis.cacheHitRatioAvg)}
            testId="kpi-cache-hit"
          />
          <KpiCard
            label="Good sessions"
            value={formatPct(kpis.goodSessionPct)}
            testId="kpi-good-session"
          />
          <KpiCard
            label="Subagent adoption"
            value={formatPct(kpis.subagentAdoptionPct)}
            testId="kpi-subagent-adoption"
          />
          <KpiCard
            label="Total tool calls"
            value={formatToolCount(
              kpis.toolMix.Edit +
                kpis.toolMix.Read +
                kpis.toolMix.Bash +
                kpis.toolMix.Agent +
                kpis.toolMix.Other,
            )}
            subtext={`${formatToolCount(kpis.toolMix.Edit)} Edit · ${formatToolCount(
              kpis.toolMix.Read,
            )} Read · ${formatToolCount(kpis.toolMix.Bash)} Bash · ${formatToolCount(
              kpis.toolMix.Agent,
            )} Agent · ${formatToolCount(kpis.toolMix.Other)} Other`}
            testId="kpi-tool-mix"
          />
        </div>
      </section>

      <section
        aria-labelledby="audit-heading"
        className="space-y-3"
        data-testid="me-visibility-audit"
      >
        <h2
          id="audit-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Drilldown audit log
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Every time a manager opens your individual data, a row appears here.
          Newest first.
        </p>
        <AuditLogTable items={auditPage.items} />

        <nav
          className="flex items-center justify-between text-sm text-neutral-700 dark:text-neutral-300"
          aria-label="Audit log pagination"
          data-testid="audit-pagination"
        >
          <span>
            Page {page} of {totalPages} ({auditPage.total}{' '}
            {auditPage.total === 1 ? 'entry' : 'entries'})
          </span>
          <span className="flex items-center gap-3">
            {hasPrev ? (
              <Link
                href={`/me/visibility?page=${page - 1}`}
                className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
                data-testid="audit-prev"
              >
                Previous
              </Link>
            ) : (
              <span
                className="text-neutral-400 dark:text-neutral-600"
                aria-disabled="true"
              >
                Previous
              </span>
            )}
            {hasNext ? (
              <Link
                href={`/me/visibility?page=${page + 1}`}
                className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
                data-testid="audit-next"
              >
                Next
              </Link>
            ) : (
              <span
                className="text-neutral-400 dark:text-neutral-600"
                aria-disabled="true"
              >
                Next
              </span>
            )}
          </span>
        </nav>
      </section>
    </main>
  );
}
