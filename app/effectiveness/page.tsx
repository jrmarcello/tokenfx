import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
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
  await ensureFreshIngest();
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
        <h1 className="text-2xl font-semibold">Efetividade</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Últimos 30 dias — heurísticas de eficiência de custo
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Score médio de efetividade"
          value={fmtScore(kpis.avgScore)}
          hint="0..100 composto"
          info={
            <>
              Métrica composta (0..100) combinando: razão output/input (40%),
              cache hit (20%), avaliação manual (30%), ausência de correções
              (10%). Quando algum sinal falta, os pesos se redistribuem
              proporcionalmente.
            </>
          }
        />
        <KpiCard
          title="Razão output/input média"
          value={fmtRatio(kpis.avgOutputInputRatio)}
          hint="Ponderada por tokens"
          info="Tokens gerados pelo assistente divididos pelos tokens consumidos. Sessões maiores pesam mais. Valores muito altos podem indicar respostas verbosas; muito baixos, respostas truncadas."
        />
        <KpiCard
          title="Cache hit médio"
          value={fmtPct(kpis.avgCacheHitRatio)}
          info="Média da taxa de cache hit por sessão. Cache quente reduz custo em prompts similares. Cai quando o prompt inicial muda muito ou o TTL expira."
        />
        <KpiCard
          title="Sessões avaliadas"
          value={kpis.ratedSessionCount}
          info="Quantas sessões têm ao menos um turno com avaliação manual (Bom / Neutro / Ruim). Quanto mais avaliações, mais confiável fica a entrada da avaliação no score composto."
        />
      </div>

      {hasData ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h2 className="text-lg font-medium mb-3">
              Distribuição de custo por turno
            </h2>
            <CostPerTurnHistogram data={histogram} />
          </section>
          <section>
            <h2 className="text-lg font-medium mb-3">
              Razão output/input semanal
            </h2>
            <RatioTrend data={weekly} />
          </section>
          <section className="lg:col-span-2">
            <h2 className="text-lg font-medium mb-3">Ferramentas mais usadas</h2>
            <ToolLeaderboard items={tools} />
          </section>
        </div>
      ) : (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400 text-sm">
          Sem dados ainda. Rode{' '}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">
            pnpm ingest
          </code>{' '}
          para popular.
        </div>
      )}
    </section>
  );
}
