import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { getSession, getTurns } from '@/lib/queries/session';
import { getSessionOtelStats } from '@/lib/queries/otel';
import { getSubagentBreakdown } from '@/lib/queries/subagent';
import { getSessionOutcome } from '@/lib/queries/outcomes';
import { TranscriptViewer } from '@/components/transcript-viewer';
import { SubagentBreakdown } from '@/components/subagent-breakdown';
import { KpiCard } from '@/components/kpi-card';
import { CostSourceBadge } from '@/components/cost-source-badge';
import { BranchIcon } from '@/components/icons';
import { ShareActions } from '@/components/session/share-actions';
import { SessionOutcomePanel } from '@/components/session/session-outcome-panel';
import {
  fmtUsd,
  fmtDateTime,
  fmtPct,
  fmtRating,
  fmtCompact,
} from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Deduplicates the existence lookup between generateMetadata and the page
// body within a single request (React per-request cache).
const getCachedSession = cache((id: string) => getSession(getDb(), id));

/**
 * Existence check BEFORE streaming: with a loading.tsx in this segment, Next
 * streams the shell with HTTP 200 before the body runs, so a notFound() in
 * the body becomes a soft-404. generateMetadata runs before the response
 * status is committed, making the 404 a real HTTP 404 (REQ-6).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  // Required: a brand-new session may not be ingested yet — without this a
  // fresh session would false-404. Coalesced via the in-flight promise in
  // lib/ingest/auto.ts, so the body's call below is effectively free.
  await ensureFreshIngest();
  const session = getCachedSession(id);
  if (!session) notFound();
  return { title: `${session.project} — TokenFx` };
}

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await ensureFreshIngest();
  const db = getDb();
  // Defense in depth: generateMetadata already 404s pre-streaming; the cache
  // makes this a no-op re-read within the same request.
  const session = getCachedSession(id);
  if (!session) notFound();
  const turns = getTurns(db, id);
  const otel = getSessionOtelStats(db, id);
  const subagentBreakdown = getSubagentBreakdown(db, id);
  const outcome = getSessionOutcome(db, id);

  const fmtDurationShort = (s: number): string => {
    if (s <= 0) return '0s';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  return (
    <section className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {session.project}
          </h1>
          {turns.length > 0 && <ShareActions sessionId={session.id} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-neutral-500">
          <code className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
            {session.id}
          </code>
          <span className="text-neutral-300 dark:text-neutral-700">•</span>
          <span>
            {fmtDateTime(session.startedAt)}
            <span className="mx-1.5 text-neutral-300 dark:text-neutral-700">→</span>
            {fmtDateTime(session.endedAt)}
          </span>
          {session.gitBranch && (
            <>
              <span className="text-neutral-300 dark:text-neutral-700">•</span>
              <span className="inline-flex items-center gap-1.5">
                <BranchIcon className="size-3.5 text-neutral-400 dark:text-neutral-600" />
                <code className="font-mono text-neutral-600 dark:text-neutral-400">
                  {session.gitBranch}
                </code>
              </span>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          title="Custo"
          value={
            <span className="inline-flex items-center gap-2">
              {fmtUsd(session.totalCostUsd)}
              <CostSourceBadge source={session.costSource} />
            </span>
          }
          hint={
            session.costSource === 'otel' &&
            Math.abs(session.totalCostUsd - session.totalCostUsdLocal) /
              Math.max(
                session.totalCostUsd,
                session.totalCostUsdLocal,
                1e-9,
              ) >
              0.01
              ? `estimado local: ${fmtUsd(session.totalCostUsdLocal)}`
              : session.costSource === 'calibrated'
                ? `list: ${fmtUsd(session.totalCostUsdLocal)}`
                : undefined
          }
          info={
            session.costSource === 'otel'
              ? 'Custo autoritativo via OTEL (claude_code_cost_usage_total). O valor local (soma de turns via tabela de preços) aparece no hint quando diverge >1%.'
              : session.costSource === 'calibrated'
                ? 'Custo calibrado: list price multiplicado pela razão aprendida OTEL/local das suas sessões. Precisão depende de quantas sessões OTEL já foram capturadas. Veja /effectiveness → "Fonte dos custos" pra ratio e contagem.'
                : 'Custo estimado via tabela de preços local (lib/analytics/pricing.ts). Ative OTEL no Claude Code pra custos autoritativos e calibração.'
          }
        />
        <KpiCard
          title="Turnos"
          value={session.turnCount}
          info="Número de ciclos usuário → assistente na sessão. Cada resposta do assistente conta como um turno."
        />
        <KpiCard
          title="Taxa de cache hit"
          value={fmtPct(session.cacheHitRatio)}
          info="Taxa de reaproveitamento de cache nesta sessão. Baixo significa prompts muito diferentes entre si ou TTL de cache expirado."
        />
        <KpiCard
          title="Avaliação média"
          value={fmtRating(session.avgRating)}
          info="Média das avaliações manuais dos turnos (-1 a +1). Nulo quando nenhum turno foi avaliado. Cada turno tem botões Bom / Neutro / Ruim no viewer abaixo."
        />
      </div>

      {otel.hasData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            title="Taxa de aceitação (OTEL)"
            value={fmtPct(otel.acceptRate)}
            hint={`${fmtCompact(otel.accepts)} aceitas · ${fmtCompact(otel.rejects)} rejeitadas`}
            info="Proporção de Edit/Write/NotebookEdit aceitos nesta sessão. Só aparece quando o Claude Code está exportando Prometheus."
          />
          <KpiCard
            title="Linhas +"
            value={fmtCompact(otel.linesAdded)}
            info="Linhas de código adicionadas pelo Claude Code nesta sessão (apenas via edits aceitos)."
          />
          <KpiCard
            title="Linhas −"
            value={fmtCompact(otel.linesRemoved)}
            info="Linhas de código removidas pelo Claude Code nesta sessão."
          />
          {/* Active time só aparece quando Claude Code emitir o counter.
              v2.1.114 não emite — card fica oculto até a telemetria
              reaparecer. */}
          {otel.activeSeconds > 0 && (
            <KpiCard
              title="Tempo ativo"
              value={fmtDurationShort(otel.activeSeconds)}
              hint={otel.commits > 0 ? `${otel.commits} commits` : undefined}
              info="Tempo real de uso ativo nesta sessão (não calendar time). Útil pra ver se a sessão foi densa ou teve muitas pausas."
            />
          )}
        </div>
      )}

      <SessionOutcomePanel outcome={outcome} />

      <SubagentBreakdown items={subagentBreakdown} />

      <TranscriptViewer turns={turns} turnCount={session.turnCount} />
    </section>
  );
}
