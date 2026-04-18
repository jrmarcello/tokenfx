import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { getSession, getTurns } from '@/lib/queries/session';
import { TranscriptViewer } from '@/components/transcript-viewer';
import { KpiCard } from '@/components/kpi-card';
import { BranchIcon } from '@/components/icons';
import { fmtUsd, fmtDateTime, fmtPct, fmtRating } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await ensureFreshIngest();
  const db = getDb();
  const session = getSession(db, id);
  if (!session) notFound();
  const turns = getTurns(db, id);

  return (
    <section className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {session.project}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-neutral-500">
          <code className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
            {session.id}
          </code>
          <span className="text-neutral-700">•</span>
          <span>
            {fmtDateTime(session.startedAt)}
            <span className="mx-1.5 text-neutral-700">→</span>
            {fmtDateTime(session.endedAt)}
          </span>
          {session.gitBranch && (
            <>
              <span className="text-neutral-700">•</span>
              <span className="inline-flex items-center gap-1.5">
                <BranchIcon className="size-3.5 text-neutral-600" />
                <code className="font-mono text-neutral-400">
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
          value={fmtUsd(session.totalCostUsd)}
          info="Soma dos custos de cada turno desta sessão, calculado via tabela de preços por modelo."
        />
        <KpiCard
          title="Turnos"
          value={session.turnCount}
          info="Número de ciclos usuário → assistente na sessão. Cada resposta do assistente conta como um turno."
        />
        <KpiCard
          title="Cache hit"
          value={fmtPct(session.cacheHitRatio)}
          info="Taxa de reaproveitamento de cache nesta sessão. Baixo significa prompts muito diferentes entre si ou TTL de cache expirado."
        />
        <KpiCard
          title="Avaliação média"
          value={fmtRating(session.avgRating)}
          info="Média das avaliações manuais dos turnos (-1 a +1). Nulo quando nenhum turno foi avaliado. Cada turno tem botões Bom / Neutro / Ruim no viewer abaixo."
        />
      </div>

      <TranscriptViewer turns={turns} />
    </section>
  );
}
