/**
 * `/manager` overview page — REQ-18 (cost) + REQ-20 (adoption) + REQ-28
 * (empty state).
 *
 * Server-rendered. Reads `session.user.orgId` (set by NextAuth `session`
 * callback per REQ-16/17) and delegates to `getOrgOverview` for spend
 * windows, daily trend, team breakdown, DAU/WAU/MAU, total seats,
 * activation %, and source mix.
 *
 * Empty-state rule (REQ-28): if the org has zero seats AND zero pushed
 * sessions in 90 days, render `<OnboardingCard />` instead of a wall of
 * `$0.00 · 0 active`. Activation % is guaranteed `0` (not NaN) by the
 * query when `totalSeats === 0`.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { getOrgOverview } from '@/lib/queries/overview';
import { loadFirstAutoProvisionAlert } from '@/lib/queries/manager-alerts';
import { FirstAutoProvisionBanner } from '@/components/manager/first-auto-provision-banner';
import { KpiCard } from '@/components/manager/kpi-card';
import { OnboardingCard } from '@/components/manager/onboarding-card';
import { TeamBreakdownTable } from '@/components/manager/team-breakdown-table';
import { TrendChart, type TrendPoint } from '@/components/manager/trend-chart';

const formatUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatPct = (n: number): string =>
  `${(n * 100).toFixed(1)}%`;

const buildSourceMixSubtext = (mix: {
  otel: number;
  calibrated: number;
  list: number;
}): string =>
  `${mix.otel} otel · ${mix.calibrated} calibrated · ${mix.list} list`;

const totalMixCount = (mix: {
  otel: number;
  calibrated: number;
  list: number;
}): number => mix.otel + mix.calibrated + mix.list;

export default async function ManagerOverviewPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;
  const userId = session.user.id;
  const role = session.user.role;

  const db = getDb();
  const overview = await getOrgOverview(db, orgId);

  // REQ-1 (TASK-17): load the first-auto-provision banner state for
  // managers/admins only. Members never see the banner (defense-in-depth
  // on top of the `/manager/*` middleware gate). The query returns `null`
  // when there are zero unacknowledged events, in which case we skip the
  // render entirely — no empty banner shell.
  const firstAutoProvisionAlert =
    userId && (role === 'manager' || role === 'admin')
      ? await loadFirstAutoProvisionAlert(db, orgId, userId)
      : null;

  // REQ-28 trigger: no seats AND no recorded sessions anywhere in the 90d
  // window. Using sourceMix totals keeps this independent of the spend
  // numbers (which can be 0 even with sessions if all rows had 0 cost).
  const isEmptyOrg =
    overview.totalSeats === 0 && totalMixCount(overview.sourceMix) === 0;

  if (isEmptyOrg) {
    return (
      <div className="space-y-6">
        {firstAutoProvisionAlert ? (
          <FirstAutoProvisionBanner alert={firstAutoProvisionAlert} />
        ) : null}
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Overview
        </h1>
        <OnboardingCard />
      </div>
    );
  }

  const spendTrendPoints: TrendPoint[] = overview.spendTrend30d.map((p) => ({
    date: p.date,
    value: p.spend,
  }));

  return (
    <div className="space-y-8">
      {firstAutoProvisionAlert ? (
        <FirstAutoProvisionBanner alert={firstAutoProvisionAlert} />
      ) : null}
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Overview
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Org-wide spend and adoption (calibrated cost; cascade: otel →
          calibrated → list).
        </p>
      </div>

      <section aria-labelledby="spend-heading" className="space-y-3">
        <h2
          id="spend-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Spend
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="Spend (7d)"
            value={formatUsd(overview.spend7d)}
            testId="kpi-spend-7d"
          />
          <KpiCard
            label="Spend (30d)"
            value={formatUsd(overview.spend30d)}
            subtext={buildSourceMixSubtext(overview.sourceMix)}
            testId="kpi-spend-30d"
          />
          <KpiCard
            label="Spend (90d)"
            value={formatUsd(overview.spend90d)}
            testId="kpi-spend-90d"
          />
        </div>
      </section>

      <section aria-labelledby="adoption-heading" className="space-y-3">
        <h2
          id="adoption-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Adoption
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiCard
            label="DAU"
            value={overview.dau.toString()}
            testId="kpi-dau"
          />
          <KpiCard
            label="WAU"
            value={overview.wau.toString()}
            testId="kpi-wau"
          />
          <KpiCard
            label="MAU"
            value={overview.mau.toString()}
            subtext={`${overview.totalSeats} seat${overview.totalSeats === 1 ? '' : 's'}`}
            testId="kpi-mau"
          />
          <KpiCard
            label="Activation"
            value={formatPct(overview.activationPct)}
            subtext="MAU / seats"
            testId="kpi-activation"
          />
        </div>
      </section>

      <section aria-labelledby="trend-heading" className="space-y-3">
        <h2
          id="trend-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Daily spend (30d)
        </h2>
        <TrendChart
          data={spendTrendPoints}
          label="Daily spend (USD)"
          valueFormat="currency-usd"
          testId="trend-spend-30d"
        />
      </section>

      <section aria-labelledby="teams-heading" className="space-y-3">
        <h2
          id="teams-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Teams
        </h2>
        <TeamBreakdownTable teams={overview.teamBreakdown} />
      </section>
    </div>
  );
}
