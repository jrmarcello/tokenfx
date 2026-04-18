import { getDb } from '@/lib/db/client';
import { KpiCard } from '@/components/kpi-card';
import { CostPerTurnHistogram } from '@/components/effectiveness/cost-per-turn-histogram';
import { RatioTrend } from '@/components/effectiveness/ratio-trend';
import { ToolLeaderboard } from '@/components/effectiveness/tool-leaderboard';
import {
  getEffectivenessKpis,
  getWeeklyRatio,
  getCostPerTurnValues,
  getToolLeaderboard,
  getSessionScores,
} from '@/lib/queries/effectiveness';
import { bucketCostPerTurn } from '@/lib/analytics/scoring';
import { fmtScore, fmtRatio, fmtPct } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function EffectivenessPage() {
  const db = getDb();
  const kpis = getEffectivenessKpis(db, 30);
  const weekly = getWeeklyRatio(db, 12);
  const costs = getCostPerTurnValues(db, 30);
  const tools = getToolLeaderboard(db, 30, 10);
  const scores = getSessionScores(db, 30);
  const histogram = bucketCostPerTurn(costs, 8);

  const hasData = scores.length > 0 || costs.length > 0;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Effectiveness</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Last 30 days — cost efficiency heuristics
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Avg effectiveness score"
          value={fmtScore(kpis.avgScore)}
          hint="0..100 composite"
        />
        <KpiCard
          title="Avg output/input ratio"
          value={fmtRatio(kpis.avgOutputInputRatio)}
          hint="Weighted by tokens"
        />
        <KpiCard title="Avg cache hit" value={fmtPct(kpis.avgCacheHitRatio)} />
        <KpiCard title="Rated sessions" value={kpis.ratedSessionCount} />
      </div>

      {hasData ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h2 className="text-lg font-medium mb-3">
              Cost per turn distribution
            </h2>
            <CostPerTurnHistogram data={histogram} />
          </section>
          <section>
            <h2 className="text-lg font-medium mb-3">
              Weekly output/input ratio
            </h2>
            <RatioTrend data={weekly} />
          </section>
          <section className="lg:col-span-2">
            <h2 className="text-lg font-medium mb-3">Top tools</h2>
            <ToolLeaderboard items={tools} />
          </section>
        </div>
      ) : (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400 text-sm">
          No data yet. Run{' '}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">
            pnpm ingest
          </code>{' '}
          to populate.
        </div>
      )}
    </section>
  );
}
