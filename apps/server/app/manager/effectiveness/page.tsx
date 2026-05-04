/**
 * `/manager/effectiveness` — manager-dashboard-v2 REQ-1..4 + REQ-6 (Q2-C).
 *
 * Server-rendered. Composes 4 KPI tiles (cache hit, good session %, subagent
 * adoption %, composite avg), a stacked-bar tool-mix chart over 30 days, a
 * subagent-adoption trend line, and a radar comparison polygon across the
 * manager's accessible teams.
 *
 * **Manager scope (locked spec — line 14)**: a `manager` role user manages
 * their **entire org** — every team in their `org_id`. The `users.team_id`
 * on the manager's own row is irrelevant for this page; we list teams via
 * `teams.org_id = orgId`. (The pre-spec-3 v1 model where a manager scoped
 * to their single team is captured by the private `loadManagerTeams` helper
 * in `lib/queries/manager-v2.ts` — that helper is wired into the per-dev
 * health surfaces; the team-aggregated dashboard uses the org-wide team set
 * per the locked spec.)
 *
 * **Aggregation across teams** (REQ-1..4 are per-team; the dashboard summary
 * row aggregates across the manager's teams):
 *  - `cacheHit`            — simple mean of per-team 30d means (treats teams
 *                            as equal units; manager view, not
 *                            session-weighted, by design — small/young teams
 *                            still surface).
 *  - `goodSessionPct`      — simple mean of per-team session-weighted pcts.
 *  - `subagentAdoptionPct` — simple mean of per-team 30d pcts.
 *  - `compositeAvg`        — simple mean of the per-team `goodSessionPct`
 *                            (placeholder until TASK-COMPOSITE wires the
 *                            real `computeCompositeScore` average — REQ-2
 *                            "good sessions" already encodes the composite
 *                            >= 60 threshold, so this is a faithful proxy
 *                            for the team-aggregated composite signal).
 *
 * **Q13 (TC-I-59 / TC-E2E-13)**: the radar section is **absent from the
 * DOM** when `getRadarComparison` returns null (manager has < 2 teams).
 * Both the page and the leaf component guard so the section is dropped
 * entirely, not merely hidden via CSS.
 *
 * **Auth**: `app/manager/layout.tsx` already enforces `role ∈ {manager, admin}`
 * (REQ-8). This page assumes that gate has fired; an unauthenticated request
 * is redirected to sign-in by the layout, a wrong-role request renders the
 * 403 banner there, so this file only handles the happy path.
 */
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { teams } from '@/lib/db/schema';
import {
  getRadarComparison,
  getTeamCacheHitTrend,
  getTeamCompositeTrend,
  getTeamGoodSessionPct,
  getTeamSubagentAdoption,
  getTeamToolMix30d,
  type TeamCacheHitTrendPoint,
  type TeamToolMixPoint,
} from '@/lib/queries/manager-v2';
import { EffectivenessKpiRow } from '@/components/manager/effectiveness-kpi-row';
import { RadarComparison } from '@/components/manager/radar-comparison';
import { SubagentTrendChart } from '@/components/manager/subagent-trend-chart';
import { ToolMixChart } from '@/components/manager/tool-mix-chart';
import { TrendChart, type TrendPoint } from '@/components/manager/trend-chart';

const formatPct = (n: number, fractionDigits = 1): string =>
  `${n.toFixed(fractionDigits)}%`;

const formatComposite = (n: number): string => Math.round(n).toString();

/** Average over an array of `number | null`, ignoring nulls. NaN-safe. */
const meanIgnoringNull = (values: ReadonlyArray<number | null>): number => {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    sum += v;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
};

/**
 * Cross-team mean of a daily trend. Each input series may be sparse (a day
 * with no data is absent or `null`). The output covers every day that
 * appears in ANY input and averages the non-null values for that day.
 *
 * Used to combine per-team `cacheHit` / `subagent` daily series into a
 * single org-wide trend the user sees on the dashboard.
 */
const aggregateDailyTrend = (
  perTeamTrends: ReadonlyArray<ReadonlyArray<{ day: string; value: number | null }>>,
): TrendPoint[] => {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const trend of perTeamTrends) {
    for (const point of trend) {
      if (point.value === null || !Number.isFinite(point.value)) continue;
      const acc = byDay.get(point.day) ?? { sum: 0, count: 0 };
      acc.sum += point.value;
      acc.count += 1;
      byDay.set(point.day, acc);
    }
  }
  return Array.from(byDay.entries())
    .map(([date, { sum, count }]) => ({
      date,
      value: count === 0 ? 0 : sum / count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * Sum tool-mix bars day-by-day across teams. Each segment is summed
 * (Edit/Read/Bash/Agent/Other) so the resulting bar still represents an
 * actual count of tool invocations that day, just rolled up across the
 * manager's accessible teams.
 */
const aggregateToolMix = (
  perTeam: ReadonlyArray<ReadonlyArray<TeamToolMixPoint>>,
): TeamToolMixPoint[] => {
  const byDay = new Map<string, TeamToolMixPoint>();
  for (const team of perTeam) {
    for (const point of team) {
      const acc =
        byDay.get(point.day) ??
        ({ day: point.day, Edit: 0, Read: 0, Bash: 0, Agent: 0, Other: 0 } as
          TeamToolMixPoint);
      acc.Edit += point.Edit;
      acc.Read += point.Read;
      acc.Bash += point.Bash;
      acc.Agent += point.Agent;
      acc.Other += point.Other;
      byDay.set(point.day, acc);
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
};

const aggregateSubagentTrend = (
  perTeam: ReadonlyArray<ReadonlyArray<{ day: string; pct: number | null }>>,
): { day: string; pct: number | null }[] => {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const team of perTeam) {
    for (const p of team) {
      if (p.pct === null || !Number.isFinite(p.pct)) continue;
      const acc = byDay.get(p.day) ?? { sum: 0, count: 0 };
      acc.sum += p.pct;
      acc.count += 1;
      byDay.set(p.day, acc);
    }
  }
  return Array.from(byDay.entries())
    .map(([day, { sum, count }]) => ({
      day,
      pct: count === 0 ? null : sum / count,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
};

const cacheHitTrendToTrendPoints = (
  rows: ReadonlyArray<TeamCacheHitTrendPoint>,
): { day: string; value: number | null }[] =>
  rows.map((r) => ({ day: r.day, value: r.cacheHitRatio }));

export default async function ManagerEffectivenessPage() {
  const session = await auth();
  // Defense-in-depth: layout already gates auth + role, but a thin redirect
  // here makes the page robust to direct calls in tests / future routing.
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();

  // Manager scope = every team in the org (locked spec). Read team ids +
  // names once; reuse for queries below + radar legend labels.
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.orgId, orgId));
  const teamIds = teamRows.map((t) => t.id);
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name] as const));

  // Empty-org safety: nothing to aggregate. Render the chrome with zeroes
  // so the layout remains and managers see "no data yet" instead of a
  // crash; matches spec 3's REQ-28 onboarding tone for the overview page.
  if (teamIds.length === 0) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Effectiveness
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Team-aggregated effectiveness across the last 30 days.
          </p>
        </div>
        <EffectivenessKpiRow
          cacheHitPct={formatPct(0)}
          goodSessionPct={formatPct(0)}
          subagentAdoptionPct={formatPct(0)}
          compositeAvg={formatComposite(0)}
          subtext="No teams in org"
        />
      </div>
    );
  }

  // Fan out per-team queries in parallel — each is org-scoped at the SQL
  // layer (REQ-19) so this is safe even with N teams.
  const cacheHitTrendsPerTeam = await Promise.all(
    teamIds.map((teamId) =>
      getTeamCacheHitTrend(db, { orgId, teamId, days: 30 }),
    ),
  );
  const goodSessionPerTeam = await Promise.all(
    teamIds.map((teamId) =>
      getTeamGoodSessionPct(db, { orgId, teamId, days: 30 }),
    ),
  );
  const toolMixPerTeam = await Promise.all(
    teamIds.map((teamId) => getTeamToolMix30d(db, { orgId, teamId })),
  );
  const subagentPerTeam = await Promise.all(
    teamIds.map((teamId) =>
      getTeamSubagentAdoption(db, { orgId, teamId, days: 30 }),
    ),
  );
  const compositeTrendsPerTeam = await Promise.all(
    teamIds.map((teamId) =>
      getTeamCompositeTrend(db, { orgId, teamId, days: 30 }),
    ),
  );
  // Q13: returns null when teamIds.length < 2 → radar section absent.
  const radarComparison = await getRadarComparison(db, { orgId, teamIds });

  // ---- KPI aggregates -----------------------------------------------------
  // For cache hit, average each team's 30d trend down to one number first,
  // then take the simple mean across teams (small teams not drowned out).
  const perTeamCacheHitMeans = cacheHitTrendsPerTeam.map((trend) =>
    meanIgnoringNull(trend.map((p) => p.cacheHitRatio)),
  );
  const cacheHitMean = meanIgnoringNull(perTeamCacheHitMeans);

  const goodSessionMean = meanIgnoringNull(
    goodSessionPerTeam.map((g) => g.pct),
  );
  const subagentAdoptionMean = meanIgnoringNull(
    subagentPerTeam.map((s) => s.pct),
  );
  // Composite KPI: per-team latest `composite_avg` from `team_metrics_daily`
  // (populated by the 15-min cron), then simple mean across teams. Falls
  // back to `goodSessionMean` only when no team has any composite data
  // (e.g. fresh org before the first cron run) so the tile never shows NaN.
  const perTeamLatestComposite = compositeTrendsPerTeam.map((trend) => {
    for (let i = trend.length - 1; i >= 0; i -= 1) {
      const v = trend[i].compositeAvg;
      if (v !== null) return v;
    }
    return null;
  });
  const compositeMeanFromRollup = meanIgnoringNull(perTeamLatestComposite);
  const compositeAvg =
    perTeamLatestComposite.every((v) => v === null)
      ? goodSessionMean
      : compositeMeanFromRollup;

  // ---- Trend / chart aggregates ------------------------------------------
  const cacheHitDailyTrend = aggregateDailyTrend(
    cacheHitTrendsPerTeam.map(cacheHitTrendToTrendPoints),
  );
  const toolMixData = aggregateToolMix(toolMixPerTeam);
  const subagentTrendData = aggregateSubagentTrend(
    subagentPerTeam.map((s) => s.trend),
  );

  const teamSubtext =
    teamIds.length === 1
      ? `1 team`
      : `across ${teamIds.length} teams`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Effectiveness
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Team-aggregated effectiveness across the last 30 days. Numbers are
          mean values across the manager&apos;s teams; small teams are not
          drowned out by larger ones.
        </p>
      </div>

      <section
        aria-labelledby="kpi-heading"
        className="space-y-3"
        data-testid="effectiveness-kpis"
      >
        <h2
          id="kpi-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Headline KPIs
        </h2>
        <EffectivenessKpiRow
          cacheHitPct={formatPct(cacheHitMean)}
          goodSessionPct={formatPct(goodSessionMean)}
          subagentAdoptionPct={formatPct(subagentAdoptionMean)}
          compositeAvg={formatComposite(compositeAvg)}
          subtext={teamSubtext}
        />
      </section>

      {/* Q13: radar section ABSENT from DOM when getRadarComparison
          returned null (manager with 1 team). TC-I-59 / TC-E2E-13. */}
      {radarComparison !== null ? (
        <section
          aria-labelledby="radar-heading"
          className="space-y-3"
          data-testid="effectiveness-radar"
        >
          <h2
            id="radar-heading"
            className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
          >
            Team comparison
          </h2>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Each axis normalized to the min/max of your teams (relative
            standing, not absolute values).
          </p>
          <RadarComparison
            comparison={radarComparison}
            teamNameById={teamNameById}
            testId="radar-comparison"
          />
        </section>
      ) : null}

      <section
        aria-labelledby="cache-trend-heading"
        className="space-y-3"
      >
        <h2
          id="cache-trend-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Cache hit ratio (30d trend)
        </h2>
        <TrendChart
          data={cacheHitDailyTrend}
          label="Cache hit ratio"
          valueFormat="count"
          testId="trend-cache-hit-30d"
        />
      </section>

      <section
        aria-labelledby="tool-mix-heading"
        className="space-y-3"
      >
        <h2
          id="tool-mix-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Tool mix (30d)
        </h2>
        <ToolMixChart data={toolMixData} testId="chart-tool-mix-30d" />
      </section>

      <section
        aria-labelledby="subagent-trend-heading"
        className="space-y-3"
      >
        <h2
          id="subagent-trend-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Subagent adoption (30d trend)
        </h2>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Subagent usage is a signal of devs adopting parallelism — high here
          is good.
        </p>
        <SubagentTrendChart
          data={subagentTrendData}
          testId="trend-subagent-30d"
        />
      </section>
    </div>
  );
}
