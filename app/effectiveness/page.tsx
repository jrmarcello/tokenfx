import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { KpiCard } from '@/components/kpi-card';
import { CostPerTurnHistogram } from '@/components/effectiveness/cost-per-turn-histogram';
import { RatioTrend } from '@/components/effectiveness/ratio-trend';
import { ToolLeaderboard } from '@/components/effectiveness/tool-leaderboard';
import { AcceptRateTrend } from '@/components/effectiveness/accept-rate-trend';
import { ModelBreakdown } from '@/components/effectiveness/model-breakdown';
import {
  getEffectivenessKpis,
  getWeeklyRatio,
  getCostPerTurnValues,
  getToolLeaderboard,
  getSessionScores,
  getModelBreakdown,
} from '@/lib/queries/effectiveness';
import { getOtelInsights, getWeeklyAcceptRate } from '@/lib/queries/otel';
import { bucketCostPerTurn } from '@/lib/analytics/scoring';
import { fmtScore, fmtRatio, fmtPct, fmtCompact, fmtUsdFine } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtDurationHours(seconds: number): string {
  if (seconds <= 0) return '0h';
  const hours = seconds / 3600;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
}

export default async function EffectivenessPage() {
  await ensureFreshIngest();
  const db = getDb();
  const kpis = getEffectivenessKpis(db, 30);
  const weekly = getWeeklyRatio(db, 12);
  const costs = getCostPerTurnValues(db, 30);
  const tools = getToolLeaderboard(db, 30, 10);
  const scores = getSessionScores(db, 30);
  const models = getModelBreakdown(db, 30);
  const histogram = bucketCostPerTurn(costs, 8);

  const otel = getOtelInsights(db, 30);
  const weeklyAccept = otel.hasOtelData ? getWeeklyAcceptRate(db, 12) : [];

  const hasData = scores.length > 0 || costs.length > 0;

  return (
    <section className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Efetividade</h1>
        <p className="text-sm text-neutral-500">
          Últimos 30 dias — heurísticas de eficiência de custo
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Score médio de efetividade"
          value={fmtScore(kpis.avgScore)}
          hint="0..100 · top 50 por custo"
          info={
            <>
              Média dos scores compostos das <strong>50 sessões mais
              caras</strong> da janela (performance cap). Score (0..100)
              pondera: avaliação manual 30%, (1 − densidade de correção)
              20%, accept rate do OTEL 15%, (1 − taxa de erro de tool) 15%,
              cache hit 10%, razão output/input 10%. Sinais nulos são
              descartados e os pesos se redistribuem proporcionalmente.
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

      {otel.hasOtelData && (
        <section className="space-y-4">
          <header>
            <h2 className="text-lg font-medium">OTEL insights</h2>
            <p className="text-xs text-neutral-500">
              Métricas que só existem com o Claude Code exportando Prometheus.
            </p>
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Accept rate (Edit/Write)"
              value={fmtPct(otel.acceptRate)}
              hint={`${fmtCompact(otel.totalAccepts)} aceitas · ${fmtCompact(otel.totalRejects)} rejeitadas`}
              info="Proporção de propostas de Edit/Write/NotebookEdit que você aceitou vs rejeitou. Sinal direto de qualidade do código sugerido."
            />
            <KpiCard
              title="Linhas adicionadas"
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
            {/* Active time card omitido quando zero — Claude Code v2.1.114
                não emite mais `claude_code_active_time_total` (validado no
                endpoint Prometheus ao vivo). Se Anthropic re-habilitar,
                a KPI volta automaticamente. */}
            {otel.totalActiveSeconds > 0 && (
              <KpiCard
                title="Active time"
                value={fmtDurationHours(otel.totalActiveSeconds)}
                info="Tempo real de uso ativo (segundos de interação), não calendar time. Útil pra distinguir sessões de 30min reais vs 30min idle."
              />
            )}
          </div>
          {weeklyAccept.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-neutral-300 mb-3">
                Accept rate semanal
              </h3>
              <AcceptRateTrend data={weeklyAccept} />
            </section>
          )}
        </section>
      )}

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
          {models.length > 0 && (
            <section className="lg:col-span-2">
              <h2 className="text-lg font-medium mb-3">
                Distribuição de spend por modelo
              </h2>
              <ModelBreakdown items={models} />
            </section>
          )}
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
