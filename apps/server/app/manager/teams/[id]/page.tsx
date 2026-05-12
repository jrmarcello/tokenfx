/**
 * `/manager/teams/[id]` — team detail page (REQ-21 + REQ-26).
 *
 * Renders the team spend trend, DAU 30d, alphabetical members table, and
 * top 10 project slugs by spend (slugs only — they are non-reversible
 * HMAC-derived tokens, so a ranking exposes nothing about the developer
 * or the codebase content).
 *
 * Cross-org safety (REQ-26 spirit + tenant scoping): `getTeamDetail` returns
 * `null` when the team is in a different org than the caller's session,
 * which we surface as a Next.js `notFound()` (404) — never echoing the
 * other org's existence back to the user.
 *
 * Server-rendered.
 */
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import {
  getTeamDetail,
  type TeamMemberProvisionedViaFilter,
} from '@/lib/queries/teams';
import { KpiCard } from '@/components/manager/kpi-card';
import { TeamDetailMembers } from '@/components/manager/team-detail-members';
import { TrendChart, type TrendPoint } from '@/components/manager/trend-chart';

/**
 * Coerce the `?provisioned_via` query-string value to the typed enum
 * accepted by `getTeamDetail`. Invalid / missing values fall back to
 * `'all'` — REQ-9 + Decisão #18 (page-level guard before the query
 * layer, which trusts its typed input).
 */
const ALLOWED_FILTERS: ReadonlyArray<TeamMemberProvisionedViaFilter> = [
  'all',
  'token',
  'sso-auto',
];

const coerceProvisionedVia = (
  raw: string | string[] | undefined,
): TeamMemberProvisionedViaFilter => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return ALLOWED_FILTERS.includes(value as TeamMemberProvisionedViaFilter)
    ? (value as TeamMemberProvisionedViaFilter)
    : 'all';
};

const formatUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const sumSpend = (
  points: ReadonlyArray<{ spend: number }>,
): number => points.reduce((acc, p) => acc + p.spend, 0);

type Params = { id: string };
type SearchParams = Record<string, string | string[] | undefined>;

export default async function TeamDetailPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const provisionedVia = coerceProvisionedVia(sp.provisioned_via);

  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const detail = await getTeamDetail(db, id, orgId, { provisionedVia });
  if (!detail) {
    notFound();
  }

  const exportHref = `/manager/teams/${id}/export?provisioned_via=${provisionedVia}`;

  const spendPoints: TrendPoint[] = detail.spendTrend30d.map((p) => ({
    date: p.date,
    value: p.spend,
  }));
  const dauPoints: TrendPoint[] = detail.dau30d.map((p) => ({
    date: p.date,
    value: p.activeUsers,
  }));

  const teamSpend30d = sumSpend(detail.spendTrend30d);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1
            className="text-2xl font-bold text-neutral-900 dark:text-neutral-100"
            data-testid="team-detail-name"
          >
            {detail.teamName}
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Per-team spend, adoption, and members. Members are listed
            alphabetically — there is no ranking by spend.
          </p>
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center self-start rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          data-testid="team-export-csv-link"
        >
          Export CSV
        </a>
      </div>

      <section aria-labelledby="team-kpis-heading" className="space-y-3">
        <h2
          id="team-kpis-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          KPIs
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="Spend (30d)"
            value={formatUsd(teamSpend30d)}
            testId="kpi-team-spend-30d"
          />
          <KpiCard
            label="Members"
            value={detail.members.length.toString()}
            testId="kpi-team-members"
          />
          <KpiCard
            label="Top projects (30d)"
            value={detail.topProjects.length.toString()}
            subtext="By calibrated spend"
            testId="kpi-team-top-projects"
          />
        </div>
      </section>

      <section aria-labelledby="team-spend-trend-heading" className="space-y-3">
        <h2
          id="team-spend-trend-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Daily spend (30d)
        </h2>
        <TrendChart
          data={spendPoints}
          label="Daily spend (USD)"
          valueFormat="currency-usd"
          testId="trend-team-spend-30d"
        />
      </section>

      <section aria-labelledby="team-dau-heading" className="space-y-3">
        <h2
          id="team-dau-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Daily active users (30d)
        </h2>
        <TrendChart
          data={dauPoints}
          label="Active users"
          testId="trend-team-dau-30d"
        />
      </section>

      <section aria-labelledby="team-members-heading" className="space-y-3">
        <h2
          id="team-members-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Members (alphabetical)
        </h2>
        <form
          action=""
          method="get"
          className="flex flex-wrap items-center gap-4 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          data-testid="team-members-filter-form"
        >
          <fieldset className="flex flex-wrap items-center gap-4">
            <legend className="sr-only">Filter members by provisioning method</legend>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Provisioned via:
            </span>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="provisioned_via"
                value="all"
                defaultChecked={provisionedVia === 'all'}
              />
              <span>All</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="provisioned_via"
                value="token"
                defaultChecked={provisionedVia === 'token'}
              />
              <span>Token</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="provisioned_via"
                value="sso-auto"
                defaultChecked={provisionedVia === 'sso-auto'}
              />
              <span>SSO auto</span>
            </label>
          </fieldset>
          <button
            type="submit"
            className="inline-flex items-center rounded-md border border-neutral-300 bg-white px-3 py-1 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            Apply
          </button>
        </form>
        <TeamDetailMembers members={detail.members} />
      </section>

      <section aria-labelledby="team-top-projects-heading" className="space-y-3">
        <h2
          id="team-top-projects-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Top projects (30d)
        </h2>
        {detail.topProjects.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No project activity in the last 30 days.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table
              className="w-full text-sm"
              data-testid="team-top-projects-table"
            >
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Project slug</th>
                  <th className="px-4 py-2 text-right font-medium">Spend (30d)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
                {detail.topProjects.map((p) => (
                  <tr key={p.projectSlug}>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                      {p.projectSlug}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatUsd(p.spend30d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
