import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRightIcon } from '@/components/icons';
import { InfoTooltip } from '@/components/info-tooltip';
import { getDb } from '@/lib/db/client';
import {
  getCostPerLoc,
  getRevertRate,
  getHighCostNoOutputSessions,
} from '@/lib/queries/outcomes';
import { fmtPct, fmtUsd, fmtUsdFine } from '@/lib/fmt';

/**
 * Overview "Outcomes" card — surfaces git-derived outcome metrics for the
 * last 30 days. Server Component: fetches via prepared statements and renders
 * static markup. Hidden entirely (returns `null`) when no sessions have
 * evaluated outcome rows yet (cold-start case) — UI shows nothing rather than
 * a card full of dashes.
 *
 * Sections:
 * 1. Cost per LOC (30d) — total effective cost / sum(loc_added). `—` when LOC=0.
 * 2. Revert rate (30d) — sessions with reverts / sessions with commits, plus
 *    the "N sessions / M with commits" denominator subtext.
 * 3. High-cost no-output top 3 — sessions ordered by effective cost DESC where
 *    `commit_count = 0`. Each links to `/sessions/<id>` (the existing detail
 *    route).
 */
export function OutcomesCard() {
  const db = getDb();
  const costPerLoc = getCostPerLoc(db, { days: 30 });
  const revertRate = getRevertRate(db, { days: 30 });
  const highCostNoOutput = getHighCostNoOutputSessions(db, {
    days: 30,
    limit: 3,
  });

  // Cold-start: no sessions have been evaluated → hide the entire section,
  // including the heading. Mirrors the spec REQ-16 hint: when no LOC was
  // added in the window AND no session has commits, there's nothing
  // meaningful to show. (A session_outcomes row with `commit_count = 0` and
  // `loc_added = 0` — e.g. cwd not a git repo — falls through here too;
  // surfacing it on Overview would just be noise.)
  const hasAnyOutcome =
    costPerLoc.totalLoc > 0 || revertRate.sessionsWithCommits > 0;
  if (!hasAnyOutcome) return null;

  return (
    <section
      id="outcomes"
      aria-labelledby="outcomes-heading"
      className="space-y-6 scroll-mt-20"
    >
      <h2
        id="outcomes-heading"
        className="text-xl font-semibold tracking-tight"
      >
        Outcomes
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
          <CardContent className="p-6 space-y-2">
            <div className="text-sm font-normal text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
              <span>Cost per LOC (30d)</span>
              <InfoTooltip label="O que é Cost per LOC?">
                Custo efetivo total (calibrado, mesma cascata do dashboard)
                dividido por <code>SUM(loc_added)</code> dos session_outcomes
                avaliados na janela. Linhas removidas não contam — métrica
                espelha a convenção GitHub &quot;lines contributed&quot;.
                Quando nenhuma sessão na janela teve LOC adicionado, mostra
                <code> —</code> em vez de divisão por zero.
              </InfoTooltip>
            </div>
            <div className="text-3xl font-semibold tabular-nums tracking-tight">
              {costPerLoc.ratio === null ? '—' : `${fmtUsdFine(costPerLoc.ratio)} / LOC`}
            </div>
            <div className="text-xs text-neutral-500">
              {fmtUsd(costPerLoc.totalCost)} · {costPerLoc.totalLoc.toLocaleString('en-US')} LOC adicionadas
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
          <CardContent className="p-6 space-y-2">
            <div className="text-sm font-normal text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
              <span>Revert rate (30d)</span>
              <InfoTooltip label="O que é revert rate?">
                Proporção de sessões com ≥1 commit que tiveram pelo menos um{' '}
                <code>Revert.*&lt;short-sha&gt;</code> em até 7 dias.
                Heurística — perde reverts manuais sem o short-sha,
                cherry-picks e rebases que dropam commits. Denominador são
                sessões com commit_count &gt; 0 (não faz sentido medir revert
                rate em sessões que não shipparam nada).
              </InfoTooltip>
            </div>
            <div className="text-3xl font-semibold tabular-nums tracking-tight">
              {fmtPct(revertRate.ratio)}
            </div>
            <div className="text-xs text-neutral-500">
              {revertRate.sessionsWithReverts} sessões / {revertRate.sessionsWithCommits} com commits
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
          <CardContent className="p-6 space-y-3">
            <div className="text-sm font-normal text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
              <span>High-cost no-output (top 3)</span>
              <InfoTooltip label="O que é high-cost no-output?">
                Sessões nos últimos 30 dias que queimaram tokens (alto custo
                efetivo) mas não atribuíram nenhum commit ao seu{' '}
                <code>git config user.email</code>. Bom alvo de revisão — ou o
                trabalho ficou em outro repo / branch, ou a sessão não rendeu.
              </InfoTooltip>
            </div>
            {highCostNoOutput.length === 0 ? (
              <div className="text-sm text-neutral-500">
                Nenhuma sessão sem output na janela. 🎉
              </div>
            ) : (
              <ul
                aria-label="Sessões high-cost sem commits"
                className="divide-y divide-neutral-200 dark:divide-neutral-800 -mx-2"
              >
                {highCostNoOutput.map((s) => (
                  <li key={s.sessionId}>
                    <Link
                      href={`/sessions/${s.sessionId}`}
                      className="group flex items-center gap-3 px-2 py-2 transition hover:bg-neutral-100 dark:hover:bg-neutral-800/50 rounded"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {s.project}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
                          {s.sessionId}
                        </div>
                      </div>
                      <span className="tabular-nums text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {fmtUsd(s.totalCostUsd)}
                      </span>
                      <ChevronRightIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-600 transition-colors group-hover:text-neutral-700 dark:group-hover:text-neutral-300" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
