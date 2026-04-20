import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { KpiCard } from '@/components/kpi-card';
import { CostSourceBadge } from '@/components/cost-source-badge';
import { ActivityHeatmap } from '@/components/overview/activity-heatmap';
import { DailyConsumptionTrend } from '@/components/overview/daily-consumption-trend';
import { OverviewEmptyState } from '@/components/overview/empty-state';
import { TopSessions } from '@/components/overview/top-sessions';
import { SortModeSchema, type SortMode } from '@/lib/top-sessions-sort';
import { ScoreDistribution } from '@/components/effectiveness/score-distribution';
import { ModelBreakdownBar } from '@/components/effectiveness/model-breakdown-bar';
import { ToolLeaderboard } from '@/components/effectiveness/tool-leaderboard';
import { ToolSuccessTrend } from '@/components/effectiveness/tool-success-trend';
import {
  getOverviewKpis,
  getDailySpend,
  getTopSessions,
  getTopSessionsByScore,
  getTopSessionsByTurns,
  getDailyAcceptRate,
  getTokenBreakdown,
} from '@/lib/queries/overview';
import {
  getEffectivenessKpis,
  getCostPerTurnValues,
  getToolLeaderboard,
  getModelBreakdown,
  getToolErrorTrend,
  getSessionScoreDistribution,
  getSubagentUsage,
} from '@/lib/queries/effectiveness';
import { getOtelInsights } from '@/lib/queries/otel';
import { fmtUsd, fmtCompact, fmtPct, fmtScore, fmtUsdFine } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtDurationHours(seconds: number): string {
  if (seconds <= 0) return '0h';
  const hours = seconds / 3600;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
}

function firstString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await ensureFreshIngest();
  const params = await searchParams;
  const mode: SortMode = SortModeSchema.parse(firstString(params.sort));

  const db = getDb();

  // better-sqlite3 is synchronous, so Promise.all is cosmético aqui — mas
  // mantém o padrão idiomático e legível, e permite queries async futuras
  // sem refactor.
  const [
    kpis,
    daily,
    yearly,
    topCost,
    topScore,
    topTurns,
    effKpis,
    costPerTurn,
    tools,
    models,
    toolTrend,
    scoreDist,
    otel,
    dailyAccept,
    tokenBreakdown,
    subagentUsage,
  ] = await Promise.all([
    Promise.resolve(getOverviewKpis(db)),
    Promise.resolve(getDailySpend(db, 30)),
    Promise.resolve(getDailySpend(db, 365)),
    Promise.resolve(getTopSessions(db, 10, 30)),
    Promise.resolve(getTopSessionsByScore(db, 10, 30)),
    Promise.resolve(getTopSessionsByTurns(db, 10, 30)),
    Promise.resolve(getEffectivenessKpis(db, 30)),
    Promise.resolve(getCostPerTurnValues(db, 30)),
    Promise.resolve(getToolLeaderboard(db, 30, 10)),
    Promise.resolve(getModelBreakdown(db, 30)),
    Promise.resolve(getToolErrorTrend(db, { days: 30, topN: 5 })),
    Promise.resolve(getSessionScoreDistribution(db, 30)),
    Promise.resolve(getOtelInsights(db, 30)),
    Promise.resolve(getDailyAcceptRate(db, 30)),
    Promise.resolve(getTokenBreakdown(db, 30)),
    Promise.resolve(getSubagentUsage(db, 30)),
  ]);

  const hasData = kpis.sessionCount30d > 0;

  if (!hasData) {
    return (
      <section className="space-y-8">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Visão geral</h1>
          <p className="text-sm text-neutral-500">Últimos 30 dias</p>
        </header>
        <OverviewEmptyState />
      </section>
    );
  }

  const avgCostPerTurn =
    costPerTurn.length > 0
      ? costPerTurn.reduce((sum, c) => sum + c, 0) / costPerTurn.length
      : null;

  return (
    <section className="space-y-12">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Visão geral</h1>
        <p className="text-sm text-neutral-500">
          Últimos 30 dias — quanto gastou, valeu o preço, sessões pra abrir
        </p>
      </header>

      {/* ======================== #consumo ======================== */}
      <section id="consumo" className="space-y-6 scroll-mt-20">
        <h2 className="text-xl font-semibold tracking-tight">Consumo</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Custo total (30d)"
            value={
              <span className="inline-flex items-center gap-2">
                {fmtUsd(kpis.spend30d)}
                <CostSourceBadge counts={kpis.spend30dCostSources} />
              </span>
            }
            hint={`Hoje: ${fmtUsd(kpis.spendToday)} — 7d: ${fmtUsd(kpis.spend7d)}`}
            info={
              <>
                Soma dos custos de todas as sessões nos últimos 30 dias.
                Cascata por sessão: <strong>OTEL</strong> (autoritativo, via{' '}
                <code>claude_code_cost_usage_total</code>) →{' '}
                <strong>calibrado</strong> (list × ratio aprendido OTEL/local)
                → <strong>list price</strong> (tabela local em{' '}
                <code>lib/analytics/pricing.ts</code>). Nesse período:{' '}
                {kpis.spend30dCostSources.otel} via OTEL,{' '}
                {kpis.spend30dCostSources.calibrated} calibradas,{' '}
                {kpis.spend30dCostSources.list} via tabela local.
              </>
            }
          />
          <KpiCard
            title="Tokens (30d)"
            value={fmtCompact(kpis.tokens30d)}
            info={
              <>
                Total de tokens processados nos últimos 30 dias. Breakdown:
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    Input + output: <strong>{fmtCompact(tokenBreakdown.inputOutput)}</strong>{' '}
                    (o que ferramentas externas como <code>ccusage</code> contam)
                  </li>
                  <li>
                    Cache creation: <strong>{fmtCompact(tokenBreakdown.cacheCreation)}</strong>{' '}
                    (cria novas entradas de cache — contam pra billing de cache write)
                  </li>
                  <li>
                    Cache read: <strong>{fmtCompact(tokenBreakdown.cacheRead)}</strong>{' '}
                    (reutilização de cache — 10% do custo de input)
                  </li>
                </ul>
              </>
            }
          />
          <KpiCard
            title="Taxa de cache hit"
            value={fmtPct(kpis.cacheHitRatio30d)}
            info="Razão entre tokens lidos do cache e o total de tokens de prompt. Quanto maior, mais barato — prompts similares reaproveitam o contexto."
          />
          <KpiCard
            title="Sessões (30d)"
            value={kpis.sessionCount30d}
            info="Número de sessões distintas do Claude Code ingeridas nos últimos 30 dias."
          />
        </div>

        <section>
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
            Atividade do último ano
          </h3>
          <ActivityHeatmap data={yearly} />
        </section>

        <section>
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
            Custo diário{otel.hasOtelData && ' + accept rate'}
          </h3>
          <DailyConsumptionTrend
            daily={daily}
            acceptRateDaily={otel.hasOtelData ? dailyAccept : null}
          />
        </section>

        {otel.hasOtelData && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              OTEL — entrega no código
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <KpiCard
                title="Accept rate"
                value={fmtPct(otel.acceptRate)}
                hint={`${fmtCompact(otel.totalAccepts)} aceitas · ${fmtCompact(otel.totalRejects)} rejeitadas`}
                info="Proporção de propostas de Edit/Write/NotebookEdit aceitas vs rejeitadas. Sinal direto de qualidade do código sugerido."
              />
              <KpiCard
                title="Linhas +"
                value={fmtCompact(otel.totalLinesAdded)}
                hint={`${fmtCompact(otel.totalLinesRemoved)} removidas`}
                info="Linhas de código adicionadas/removidas pelo Claude Code. Inclui apenas mudanças aplicadas (accept) — rejects não contam."
              />
              <KpiCard
                title="Cost per line"
                value={
                  otel.costPerLineOfCode !== null
                    ? fmtUsdFine(otel.costPerLineOfCode)
                    : '—'
                }
                hint="Custo total / linhas tocadas"
                info="Total de spend dividido pelo total de linhas adicionadas + removidas na janela. Métrica bruta de ROI — compare entre períodos."
              />
              <KpiCard
                title="Commits / PRs"
                value={`${otel.totalCommits} / ${otel.totalPullRequests}`}
                info="Commits e PRs criados via Claude Code na janela de 30 dias. Boa proxy de entrega concreta."
              />
              {otel.totalActiveSeconds > 0 && (
                <KpiCard
                  title="Active time"
                  value={fmtDurationHours(otel.totalActiveSeconds)}
                  info="Tempo real de uso ativo (segundos de interação), não calendar time. Útil pra distinguir sessões de 30min reais vs 30min idle."
                />
              )}
            </div>
          </section>
        )}
      </section>

      {/* ======================== #efetividade ======================== */}
      <section id="efetividade" className="space-y-6 scroll-mt-20">
        <h2 className="text-xl font-semibold tracking-tight">Efetividade</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Score médio"
            value={fmtScore(effKpis.avgScore)}
            hint="0..100 · top 50 por custo"
            info={
              <>
                Média dos scores compostos das <strong>50 sessões mais caras</strong>{' '}
                da janela (performance cap). Score (0..100) pondera: avaliação
                manual 30%, (1 − densidade de correção) 20%, accept rate do
                OTEL 15%, (1 − taxa de erro de tool) 15%, cache hit 10%, razão
                output/input 10%. Sinais nulos são descartados e os pesos se
                redistribuem proporcionalmente.
              </>
            }
          />
          <KpiCard
            title="Cost per turn médio"
            value={avgCostPerTurn !== null ? fmtUsdFine(avgCostPerTurn) : '—'}
            info="Média de custo por turno entre as sessões com ≥1 turno (30d). Sinal bruto de eficiência: turnos mais longos tendem a ter custo maior, mas produzem mais valor por trade."
          />
          <KpiCard
            title="Sessões avaliadas"
            value={effKpis.ratedSessionCount}
            info="Quantas sessões têm ao menos um turno com avaliação manual (Bom / Neutro / Ruim). Quanto mais avaliações, mais confiável a entrada manual no score."
          />
          {subagentUsage.sessionsTotal > 0 && (
            <KpiCard
              title="Delegação a subagents"
              value={`${subagentUsage.sessionsWithAgent}/${subagentUsage.sessionsTotal} sessões`}
              hint={`${fmtPct(
                subagentUsage.tokensTotal > 0
                  ? subagentUsage.tokensFromAgentSessions / subagentUsage.tokensTotal
                  : 0,
              )} dos tokens`}
              info="Proporção de sessões (últimos 30d) em que você delegou pra um subagent via a ferramenta Agent. Indicador de quão orquestrado é seu workflow. Tokens excluem cache reads pra comparabilidade com ferramentas externas como ccusage."
            />
          )}
        </div>

        <section>
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
            Distribuição de score
          </h3>
          <ScoreDistribution buckets={scoreDist} />
        </section>

        {models.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
              Custo por família de modelo
            </h3>
            <ModelBreakdownBar items={models} />
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
              Ferramentas mais usadas
            </h3>
            <ToolLeaderboard items={tools} />
          </section>
          {toolTrend.tools.length > 0 && toolTrend.points.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
                Tendência de erro por ferramenta
              </h3>
              <ToolSuccessTrend data={toolTrend} />
            </section>
          )}
        </div>
      </section>

      {/* ======================== #drill-downs ======================== */}
      <section id="drill-downs" className="space-y-4 scroll-mt-20">
        <h2 className="text-xl font-semibold tracking-tight">
          Sessões pra abrir
        </h2>
        <p className="text-sm text-neutral-500">
          Toggle entre &quot;mais caras&quot; (custo desc), &quot;piores&quot;
          (score asc) e &quot;mais longas&quot; (turnos desc).
        </p>
        <TopSessions
          itemsByMode={{
            cost: topCost,
            score: topScore,
            turns: topTurns,
          }}
          mode={mode}
        />
      </section>
    </section>
  );
}
