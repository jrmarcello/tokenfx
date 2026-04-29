import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { KpiCard } from '@/components/kpi-card';
import { OverviewEmptyState } from '@/components/overview/empty-state';
import { ScoreDistribution } from '@/components/effectiveness/score-distribution';
import { ToolSuccessTrend } from '@/components/effectiveness/tool-success-trend';
import { EffectivenessHeatmap } from '@/components/effectiveness-v2/effectiveness-heatmap';
import { EffectivenessFunnel } from '@/components/effectiveness-v2/effectiveness-funnel';
import { CostRatingScatter } from '@/components/effectiveness-v2/cost-rating-scatter';
import { EffectivenessInsightPanel } from '@/components/effectiveness-v2/effectiveness-insight-panel';
import { SubagentUsageCard } from '@/components/effectiveness-v2/subagent-usage-card';
import {
  getEffectivenessKpis,
  getSessionScoreDistribution,
  getSubagentUsage,
  getToolErrorTrend,
} from '@/lib/queries/effectiveness';
import {
  getCostRatingScatter,
  getDailyEffectivenessHeatmap,
  getEffectivenessFunnel,
  getPersonalEffectivenessAggregates,
  getQuartileComparison,
} from '@/lib/queries/effectiveness-v2';
import { fmtPct, fmtScore } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Página `/effectiveness` — análise profunda de "estou usando bem o Claude
 * Code?". Coexiste com `/` (overview de consumo); ordenação das seções e
 * empty-state global locked em REQ-26 / REQ-27 da spec
 * effectiveness-personal-v2.
 *
 * Cada seção decide sozinha se renderiza ou retorna `null` (componentes
 * v2 já fazem isso); a página só fornece dados e a moldura.
 */
export default async function EffectivenessPage() {
  await ensureFreshIngest();
  const db = getDb();

  // better-sqlite3 é síncrono — `Promise.all` é cosmético, mas mantém
  // padrão idiomático e abre porta pra queries async no futuro sem refactor
  // (mesmo critério usado em `app/page.tsx`).
  const [
    kpis,
    aggregates,
    heatmapData,
    funnelData,
    scatterData,
    quartiles,
    scoreDist,
    toolTrend,
    subagentUsage,
  ] = await Promise.all([
    Promise.resolve(getEffectivenessKpis(db, 30)),
    Promise.resolve(getPersonalEffectivenessAggregates(db, 30)),
    Promise.resolve(getDailyEffectivenessHeatmap(db, 365)),
    Promise.resolve(getEffectivenessFunnel(db, 30)),
    Promise.resolve(getCostRatingScatter(db, 30)),
    Promise.resolve(getQuartileComparison(db, 30)),
    Promise.resolve(getSessionScoreDistribution(db, 30)),
    Promise.resolve(getToolErrorTrend(db, { days: 30, topN: 5 })),
    Promise.resolve(getSubagentUsage(db, 30)),
  ]);

  // Empty-state global (REQ-27): sem sessões na janela, mostra apenas o
  // placeholder + microcopy. `aggregates.totalSessions` é a contagem
  // direta de sessões na janela de 30d — sinal mais claro que `ratedSessionCount`
  // (que excluiria sessões não avaliadas) ou `subagentUsage.sessionsTotal`
  // (computado via subquery em outra árvore SQL).
  if (aggregates.totalSessions === 0) {
    return (
      <section className="space-y-8">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            Efetividade pessoal
          </h1>
          <p className="text-sm text-neutral-500">Últimos 30 dias</p>
        </header>
        <OverviewEmptyState />
        <p className="text-sm text-neutral-500">
          Sem sessões ainda — execute{' '}
          <code className="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
            pnpm ingest
          </code>{' '}
          ou abra o Claude Code para começar.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-12">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">
          Efetividade pessoal
        </h1>
        <p className="text-sm text-neutral-500">
          Últimos 30 dias — estou usando bem? estou melhorando?
        </p>
      </header>

      {/* (1) KPIs — reuso de `getEffectivenessKpis` (overview já usa). */}
      <section aria-labelledby="kpis-heading" className="space-y-6">
        <h2
          id="kpis-heading"
          className="text-xl font-semibold tracking-tight"
        >
          KPIs
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Score médio"
            value={fmtScore(kpis.avgScore)}
            hint="0..100 · top 50 por custo"
            info={
              <>
                Média dos scores compostos das{' '}
                <strong>50 sessões mais caras</strong> da janela. Score (0..100)
                pondera avaliação manual, accept rate, taxa de erro de tool,
                cache hit, output/input ratio e densidade de correção.
              </>
            }
          />
          <KpiCard
            title="Sessões avaliadas"
            value={kpis.ratedSessionCount}
            info="Quantas sessões têm ao menos um turno com avaliação manual (Bom / Neutro / Ruim) na janela."
          />
          <KpiCard
            title="Cache hit médio"
            value={fmtPct(kpis.avgCacheHitRatio ?? 0)}
            info="Razão entre tokens lidos do cache e total de tokens de prompt — quanto maior, mais contexto reaproveitado."
          />
          <KpiCard
            title="Output/Input ratio"
            value={
              kpis.avgOutputInputRatio !== null
                ? kpis.avgOutputInputRatio.toFixed(2)
                : '—'
            }
            info="Tokens gerados pelo modelo dividido por tokens enviados no prompt — proxy de densidade de resposta."
          />
        </div>
      </section>

      {/* (2) Heatmap por effectiveness — janela 365d locked Q1. */}
      <section aria-labelledby="heatmap-heading" className="space-y-3">
        <h2
          id="heatmap-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Efetividade do último ano
        </h2>
        <EffectivenessHeatmap data={heatmapData} />
      </section>

      {/* (3) Funnel — REQ-20..22. */}
      <section aria-labelledby="funnel-heading" className="space-y-3">
        <h2
          id="funnel-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Funil de execução (30d)
        </h2>
        <EffectivenessFunnel data={funnelData} />
      </section>

      {/* (4) Cost × Rating scatter — REQ-16..17. */}
      <section aria-labelledby="scatter-heading" className="space-y-3">
        <h2
          id="scatter-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Custo × avaliação manual (30d)
        </h2>
        <CostRatingScatter data={scatterData} />
      </section>

      {/* (5) Insight panel (top vs bottom quartile) — REQ-18..19. */}
      <section aria-labelledby="insight-heading" className="space-y-3">
        <h2
          id="insight-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Top vs bottom quartile (30d)
        </h2>
        <EffectivenessInsightPanel quartiles={quartiles} />
      </section>

      {/* (6) Score distribution — reuso de `<ScoreDistribution />`. */}
      <section aria-labelledby="score-dist-heading" className="space-y-3">
        <h2
          id="score-dist-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Distribuição de score (30d)
        </h2>
        <ScoreDistribution buckets={scoreDist} />
      </section>

      {/* (7) Tool success trend — reuso de `<ToolSuccessTrend />`. */}
      {toolTrend.tools.length > 0 && toolTrend.points.length > 0 && (
        <section aria-labelledby="tool-trend-heading" className="space-y-3">
          <h2
            id="tool-trend-heading"
            className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
          >
            Tendência de erro por ferramenta (30d)
          </h2>
          <ToolSuccessTrend data={toolTrend} />
        </section>
      )}

      {/* (8) Subagent usage card — novo nesta task (Q2 LOCKED). */}
      <SubagentUsageCard usage={subagentUsage} />
    </section>
  );
}
