import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import { getSession, getTurns } from '@/lib/queries/session';
import { TranscriptViewer } from '@/components/transcript-viewer';
import { Card, CardContent } from '@/components/ui/card';
import { InfoTooltip } from '@/components/info-tooltip';
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
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{session.project}</h1>
        <p className="text-sm text-neutral-500 mt-1">{session.id}</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs flex items-center gap-1.5">
              <span>Custo</span>
              <InfoTooltip label="O que é Custo?">
                Soma dos custos de cada turno desta sessão, calculado via
                tabela de preços por modelo.
              </InfoTooltip>
            </div>
            <div className="text-xl font-semibold tabular-nums">
              {fmtUsd(session.totalCostUsd)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs flex items-center gap-1.5">
              <span>Turnos</span>
              <InfoTooltip label="O que é Turnos?">
                Número de ciclos usuário → assistente na sessão. Cada
                resposta do assistente conta como um turno.
              </InfoTooltip>
            </div>
            <div className="text-xl font-semibold">{session.turnCount}</div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs flex items-center gap-1.5">
              <span>Cache hit</span>
              <InfoTooltip label="O que é Cache hit?">
                Taxa de reaproveitamento de cache nesta sessão. Baixo significa
                prompts muito diferentes entre si ou TTL de cache expirado.
              </InfoTooltip>
            </div>
            <div className="text-xl font-semibold">
              {fmtPct(session.cacheHitRatio)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs flex items-center gap-1.5">
              <span>Avaliação média</span>
              <InfoTooltip label="O que é Avaliação média?">
                Média das avaliações manuais dos turnos (-1 a +1). Nulo quando
                nenhum turno foi avaliado. Cada turno tem botões Bom / Neutro /
                Ruim no viewer abaixo.
              </InfoTooltip>
            </div>
            <div className="text-xl font-semibold">
              {fmtRating(session.avgRating)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="text-xs text-neutral-500 space-x-4">
        <span>Início: {fmtDateTime(session.startedAt)}</span>
        <span>Fim: {fmtDateTime(session.endedAt)}</span>
        {session.gitBranch && (
          <span>
            Branch: <code className="text-neutral-400">{session.gitBranch}</code>
          </span>
        )}
      </div>

      <TranscriptViewer turns={turns} />
    </section>
  );
}
