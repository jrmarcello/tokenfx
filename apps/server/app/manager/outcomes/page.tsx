/**
 * `/manager/outcomes` — manager-dashboard-v3-outcomes spec REQ-13..15.
 *
 * Server-rendered. Composes 4 KPI tiles (cost-per-merged-LOC,
 * tokens-per-merged-LOC, revert rate, avg merged PRs per session-with-
 * outcome), a 30d cost-per-LOC trend line, and a per-team comparison
 * table (only rendered when the manager has 2+ teams — REQ-14).
 *
 * Empty state (REQ-15): when the org has 0 sessions with
 * `outcome_status='evaluated'`, render the locked microcopy "Outcome
 * data ainda não fluiu — devs precisam estar trabalhando em git repos
 * com user.email configurado." (REQ-15 verbatim — phrase locked to
 * avoid tone-word lint hits).
 *
 * Auth: `app/manager/layout.tsx` already enforces role ∈ {manager,
 * admin}. This file handles the happy path; defense-in-depth redirect
 * stays for direct test calls.
 *
 * Org-level rollup: computed in JS by averaging
 * `team_outcomes_daily` rows across the manager's teams (mirrors Fase
 * 4 effectiveness/page.tsx:239-265 pattern). NO org-level aggregate
 * row in the table (PG PK columns can't be NULL — locked decision).
 */
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { auth } from '@/lib/auth/auth';
import { KpiCard } from '@/components/manager/kpi-card';
import { PerTeamOutcomesTable } from '@/components/outcomes/per-team-outcomes-table';
import {
  TrendChart,
  type TrendPoint,
} from '@/components/manager/trend-chart';
import { getDb } from '@/lib/db/client';
import { teams } from '@/lib/db/schema';
import {
  aggregateOrgRollup,
  avgMergedPrsPerSessionWithOutcome,
  costPerMergedLoc,
  getTeamOutcomesForOrg,
  revertRate,
  tokensPerMergedLoc,
  type TeamOutcomesRollup,
} from '@/lib/queries/team-outcomes';

const formatCurrency4 = (n: number | null): string => {
  if (n === null) return '—';
  return `$${n.toFixed(4)}`;
};

const formatTokens = (n: number | null): string => {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatPct = (n: number | null): string => {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
};

const formatRatio2 = (n: number | null): string => {
  if (n === null) return '—';
  return n.toFixed(2);
};

/** ISO YYYY-MM-DD helper. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export default async function ManagerOutcomesPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();

  // Manager scope = every team in the org (locked spec, mirrors Fase 4).
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.orgId, orgId));
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name] as const));

  // 30-day window — matches Fase 4 `team_metrics_daily` queries.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const sinceDate = new Date(today);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 29);

  const allRows = await getTeamOutcomesForOrg(db, {
    orgId,
    sinceDay: isoDay(sinceDate),
    untilDay: isoDay(today),
  });

  // REQ-15: empty state — 0 evaluated sessions in the window.
  if (allRows.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Outcomes
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Cost + tokens per merged line of code, by team. 30 days.
          </p>
        </div>
        <div
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="outcomes-empty-state"
        >
          Outcome data ainda não fluiu — devs precisam estar trabalhando
          em git repos com user.email configurado.
        </div>
      </div>
    );
  }

  // Org-level rollup: sum across all teams in JS.
  const orgRollup = aggregateOrgRollup(allRows);
  const orgCostPerLoc = costPerMergedLoc({
    totalCostUsd: orgRollup.totalCostUsd,
    totalLocAdded: orgRollup.totalLocAdded,
  });
  const orgTokensPerLoc = tokensPerMergedLoc({
    totalInputTokens: orgRollup.totalInputTokens,
    totalOutputTokens: orgRollup.totalOutputTokens,
    totalLocAdded: orgRollup.totalLocAdded,
  });
  const orgRevertRate = revertRate({
    totalReverts: orgRollup.totalRevertsWithin7d,
    totalCommits: orgRollup.totalCommits,
  });
  const orgAvgPrs = avgMergedPrsPerSessionWithOutcome({
    totalMergedPrCount: orgRollup.totalMergedPrCount,
    sessionsWithOutcome: orgRollup.sessionsWithOutcome,
  });

  // Daily trend: cost-per-merged-LOC per day across all teams.
  const trendByDay = new Map<string, { cost: number; loc: number }>();
  for (const r of allRows) {
    const acc = trendByDay.get(r.day) ?? { cost: 0, loc: 0 };
    acc.cost += r.totalCostUsd;
    acc.loc += r.totalLocAdded;
    trendByDay.set(r.day, acc);
  }
  const trendPoints: TrendPoint[] = Array.from(trendByDay.entries())
    .map(([date, { cost, loc }]) => ({
      date,
      // null becomes 0 in TrendChart (the chart's `value` is non-null);
      // we filter days with no LOC to keep the line meaningful.
      value: loc === 0 ? 0 : cost / loc,
    }))
    .filter((p) => p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Per-team rollup: aggregate across days within each team.
  const byTeam = new Map<string, TeamOutcomesRollup[]>();
  for (const r of allRows) {
    const arr = byTeam.get(r.teamId) ?? [];
    arr.push(r);
    byTeam.set(r.teamId, arr);
  }
  const perTeamRows = Array.from(byTeam.entries()).map(([teamId, rows]) => {
    const agg = aggregateOrgRollup(rows);
    return {
      teamId,
      teamName: teamNameById.get(teamId) ?? '(unknown team)',
      costPerMergedLoc: costPerMergedLoc({
        totalCostUsd: agg.totalCostUsd,
        totalLocAdded: agg.totalLocAdded,
      }),
      tokensPerMergedLoc: tokensPerMergedLoc({
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
        totalLocAdded: agg.totalLocAdded,
      }),
      revertRate: revertRate({
        totalReverts: agg.totalRevertsWithin7d,
        totalCommits: agg.totalCommits,
      }),
      totalLocAdded: agg.totalLocAdded,
      totalCommits: agg.totalCommits,
    };
  });

  // REQ-14: per-team comparison hidden when manager has 1 team only.
  const showPerTeamTable = perTeamRows.length >= 2;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Outcomes
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Cost + tokens per merged line of code, by team. 30 days.
        </p>
      </div>

      {/* 4 KPI tiles. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Cost / merged LOC"
          value={formatCurrency4(orgCostPerLoc)}
          testId="kpi-cost-per-merged-loc"
          subtext={`${orgRollup.totalLocAdded.toLocaleString()} LOC added`}
        />
        <KpiCard
          label="Tokens / merged LOC"
          value={formatTokens(orgTokensPerLoc)}
          testId="kpi-tokens-per-merged-loc"
          subtext={`${(orgRollup.totalInputTokens + orgRollup.totalOutputTokens).toLocaleString()} tokens`}
        />
        <KpiCard
          label="Revert rate (7d)"
          value={formatPct(orgRevertRate)}
          testId="kpi-revert-rate"
          subtext={`${orgRollup.totalRevertsWithin7d} of ${orgRollup.totalCommits} commits`}
        />
        <KpiCard
          label="Avg merged PRs / session"
          value={formatRatio2(orgAvgPrs)}
          testId="kpi-avg-merged-prs"
          subtext={`${orgRollup.sessionsWithOutcome} session(s) with outcome`}
        />
      </div>

      {/* Cost-per-LOC trend chart, 30d. */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Cost per merged LOC — 30d
        </h2>
        <TrendChart
          data={trendPoints}
          label="Cost per merged LOC"
          valueFormat="currency-usd"
          testId="outcomes-trend-chart"
        />
      </div>

      {/* Per-team comparison — only when manager has 2+ teams (REQ-14). */}
      {showPerTeamTable ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            By team
          </h2>
          <PerTeamOutcomesTable rows={perTeamRows} />
        </div>
      ) : null}
    </div>
  );
}
