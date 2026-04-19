import type { TurnDetail } from '@/lib/queries/session';
import { RatingWidget } from '@/components/rating-widget';
import { SparkleIcon, UserIcon, WrenchIcon } from '@/components/icons';
import { TurnScrollTo } from '@/components/turn-scroll-to';
import { fmtNum, fmtTime, fmtUsdFine } from '@/lib/fmt';

export function TranscriptViewer({
  turns,
  turnCount,
}: {
  turns: TurnDetail[];
  // Total declared by the session (from sessions.turn_count) so we can tell
  // apart "sessão genuinamente vazia" (turnCount === 0) from "turnos
  // declarados mas não ingeridos" (turnCount > 0 && turns.length === 0).
  turnCount: number;
}) {
  if (turns.length === 0) {
    if (turnCount > 0) {
      return (
        <div
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-200"
        >
          Esta sessão declara {turnCount}{' '}
          {turnCount === 1 ? 'turno' : 'turnos'} mas nenhum foi ingerido. Rode{' '}
          <code className="font-mono">pnpm ingest</code> pra carregar o
          transcript.
        </div>
      );
    }
    return (
      <p className="text-sm text-neutral-500">Sem turnos nesta sessão.</p>
    );
  }
  return (
    <>
      <h2 className="sr-only">Transcript</h2>
      <TurnScrollTo />
      <p
        className="mb-3 text-[11px] text-neutral-500"
        title="Calibração e OTEL agregam no total da sessão; per-turn continua list price porque OTEL não tem granularidade de turno."
      >
        Custos por turno abaixo são <strong>list price</strong> (tabela de
        preços local). OTEL e calibração são aplicados só no total da
        sessão.
      </p>
      <ol className="space-y-4">
      {turns.map((t) => (
        <li
          key={t.id}
          id={`turn-${t.id}`}
          className="scroll-mt-24 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 transition-shadow"
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 px-4 py-2.5 text-xs text-neutral-600 dark:text-neutral-400">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-6 items-center justify-center rounded-md bg-neutral-100 dark:bg-neutral-800 font-mono text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
                {t.sequence}
              </span>
              <span className="font-mono text-neutral-600 dark:text-neutral-400">{t.model}</span>
              <span className="text-neutral-400 dark:text-neutral-600">{fmtTime(t.timestamp)}</span>
            </div>
            <div className="flex items-center gap-4 tabular-nums">
              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                {fmtUsdFine(t.costUsd)}
              </span>
              <span className="text-neutral-500">
                <span className="text-neutral-700 dark:text-neutral-300">{fmtNum(t.inputTokens)}</span>{' '}
                ent.{' '}·{' '}
                <span className="text-neutral-700 dark:text-neutral-300">
                  {fmtNum(t.outputTokens)}
                </span>{' '}
                saída ·{' '}
                <span className="text-neutral-700 dark:text-neutral-300">
                  {fmtNum(t.cacheReadTokens)}
                </span>{' '}
                cache
              </span>
            </div>
          </header>
          <div className="space-y-4 p-4 text-sm">
            {t.userPrompt && (
              <TurnBlock
                icon={<UserIcon className="size-3.5" />}
                label="Usuário"
                tone="user"
              >
                {t.userPrompt}
              </TurnBlock>
            )}
            {t.assistantText && (
              <TurnBlock
                icon={<SparkleIcon className="size-3.5" />}
                label="Assistente"
                tone="assistant"
              >
                {t.assistantText}
              </TurnBlock>
            )}
            {t.toolCalls.length > 0 && (
              <div className="space-y-2">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  <WrenchIcon className="size-3.5" />
                  Chamadas de ferramentas
                </div>
                <ul className="space-y-2">
                  {t.toolCalls.map((tc) => (
                    <li
                      key={tc.id}
                      className={
                        tc.resultIsError
                          ? 'border-l-2 border-red-500 pl-3'
                          : 'border-l-2 border-neutral-300 dark:border-neutral-700 pl-3'
                      }
                    >
                      <details className="group">
                        <summary className="cursor-pointer list-none text-neutral-700 dark:text-neutral-300 transition-colors hover:text-neutral-900 dark:hover:text-neutral-100">
                          <span className="font-mono text-xs">
                            {tc.toolName}
                          </span>
                          <span className="ml-2 text-[10px] text-neutral-400 dark:text-neutral-600 group-open:hidden">
                            clique para expandir
                          </span>
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                              Entrada
                            </div>
                            <pre className="whitespace-pre-wrap rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2 text-xs text-neutral-700 dark:text-neutral-300">
                              {tc.inputJson}
                            </pre>
                          </div>
                          {tc.resultJson !== null && (
                            <div>
                              <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">
                                Resultado{' '}
                                {tc.resultIsError && (
                                  <span className="text-red-600 dark:text-red-400">(erro)</span>
                                )}
                              </div>
                              <pre className="whitespace-pre-wrap rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2 text-xs text-neutral-700 dark:text-neutral-300">
                                {tc.resultJson}
                              </pre>
                            </div>
                          )}
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3">
              <RatingWidget turnId={t.id} initial={t.rating?.value ?? null} />
            </div>
          </div>
        </li>
      ))}
      </ol>
    </>
  );
}

function TurnBlock({
  icon,
  label,
  tone,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'user' | 'assistant';
  children: React.ReactNode;
}) {
  const bodyClass =
    tone === 'assistant'
      ? 'border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100'
      : 'border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/60 text-neutral-800 dark:text-neutral-200';
  return (
    <div>
      <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {icon}
        {label}
      </div>
      <pre
        className={`whitespace-pre-wrap rounded border p-3 font-sans ${bodyClass}`}
      >
        {children}
      </pre>
    </div>
  );
}
