import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { KpiCard } from '@/components/kpi-card';
import { TrendChart } from '@/components/overview/trend-chart';
import { TopSessions } from '@/components/overview/top-sessions';
import { OverviewEmptyState } from '@/components/overview/empty-state';
import {
  getOverviewKpis,
  getDailySpend,
  getTopSessions,
} from '@/lib/queries/overview';
import { fmtUsd, fmtCompact, fmtPct } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Home() {
  await ensureFreshIngest();
  const db = getDb();
  const kpis = getOverviewKpis(db);
  const daily = getDailySpend(db, 30);
  const top = getTopSessions(db, 5, 30);

  const hasData = kpis.sessionCount30d > 0;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Visão geral</h1>
        <p className="text-sm text-neutral-400 mt-1">Últimos 30 dias</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Custo total (30d)"
          value={fmtUsd(kpis.spend30d)}
          hint={`Hoje: ${fmtUsd(kpis.spendToday)} — 7d: ${fmtUsd(kpis.spend7d)}`}
          info="Soma dos custos de todas as sessões nos últimos 30 dias. Calculado por turno via tabela de preços por modelo (lib/analytics/pricing.ts)."
        />
        <KpiCard
          title="Tokens (30d)"
          value={fmtCompact(kpis.tokens30d)}
          info="Total de tokens processados (entrada + saída + cache read + cache creation) nos últimos 30 dias."
        />
        <KpiCard
          title="Taxa de cache hit"
          value={fmtPct(kpis.cacheHitRatio30d)}
          info="Razão entre tokens lidos do cache e (entrada + cache). Quanto maior, mais barato — prompts similares reaproveitam o contexto."
        />
        <KpiCard
          title="Sessões (30d)"
          value={kpis.sessionCount30d}
          info="Número de sessões distintas do Claude Code ingeridas nos últimos 30 dias. Uma sessão = um arquivo .jsonl em ~/.claude/projects/."
        />
      </div>

      {hasData ? (
        <>
          <section>
            <h2 className="text-lg font-medium mb-3">Custo diário</h2>
            <TrendChart data={daily} />
          </section>
          <section>
            <h2 className="text-lg font-medium mb-3">Sessões mais caras</h2>
            <TopSessions items={top} />
          </section>
        </>
      ) : (
        <OverviewEmptyState />
      )}
    </section>
  );
}
