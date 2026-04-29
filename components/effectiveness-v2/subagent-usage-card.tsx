import { InfoTooltip } from '@/components/info-tooltip';
import type { SubagentUsage } from '@/lib/queries/effectiveness';

/**
 * Mini-card que mostra a adoção de sub-agents (ferramenta `Agent`) na janela
 * vigente. Renderiza `null` quando não há sessões para evitar barulho — o
 * empty-state global da página cobre o caso de DB vazio.
 *
 * Server Component (sem `'use client'`): nenhuma interatividade, tudo é
 * derivado server-side.
 */
export function SubagentUsageCard({
  usage,
}: {
  usage: SubagentUsage;
}): React.JSX.Element | null {
  if (usage.sessionsTotal === 0) return null;
  const pct = Math.round(
    (usage.sessionsWithAgent / usage.sessionsTotal) * 100,
  );
  return (
    <section
      className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
      aria-labelledby="subagent-usage-heading"
    >
      <div className="flex items-center gap-2">
        <h3
          id="subagent-usage-heading"
          className="text-sm font-medium text-neutral-700 dark:text-neutral-300"
        >
          Sub-agents
        </h3>
        <InfoTooltip label="O que isso indica?">
          Sub-agents indicam que você está delegando trabalho em paralelo
          (ferramenta <code>Agent</code> com <code>subagent_type</code>).
          Adoção alta = workflow maduro, com paralelismo e separação de
          contexto.
        </InfoTooltip>
      </div>
      <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
        Sub-agents usados em{' '}
        <strong className="tabular-nums">{usage.sessionsWithAgent}</strong> de{' '}
        <strong className="tabular-nums">{usage.sessionsTotal}</strong>{' '}
        sessões (<strong className="tabular-nums">{pct}%</strong>)
      </p>
    </section>
  );
}
