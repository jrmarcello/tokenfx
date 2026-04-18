import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { KpiCard } from '@/components/kpi-card';
import { TrendChart } from '@/components/overview/trend-chart';
import { TopSessions } from '@/components/overview/top-sessions';
import { OverviewEmptyState } from '@/components/overview/empty-state';
import {
  getOverviewKpis,
  getDailySpend,
  getTopSessions,
} from '@/lib/queries/overview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCompact(n: number): string {
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default async function Home() {
  const db = getDb();
  migrate(db);
  const kpis = getOverviewKpis(db);
  const daily = getDailySpend(db, 30);
  const top = getTopSessions(db, 5, 30);

  const hasData = kpis.sessionCount30d > 0;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-neutral-400 mt-1">Last 30 days</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total spend (30d)"
          value={fmtUsd(kpis.spend30d)}
          hint={`Today: ${fmtUsd(kpis.spendToday)} — 7d: ${fmtUsd(kpis.spend7d)}`}
        />
        <KpiCard title="Tokens (30d)" value={fmtCompact(kpis.tokens30d)} />
        <KpiCard title="Cache hit ratio" value={fmtPct(kpis.cacheHitRatio30d)} />
        <KpiCard title="Sessions (30d)" value={kpis.sessionCount30d} />
      </div>

      {hasData ? (
        <>
          <section>
            <h2 className="text-lg font-medium mb-3">Daily spend</h2>
            <TrendChart data={daily} />
          </section>
          <section>
            <h2 className="text-lg font-medium mb-3">Top sessions</h2>
            <TopSessions items={top} />
          </section>
        </>
      ) : (
        <OverviewEmptyState />
      )}
    </section>
  );
}
