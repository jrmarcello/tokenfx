/**
 * `/manager/teams/[id]/effectiveness` — team-scoped effectiveness deep-dive
 * (REQ-7 + REQ-9, manager-dashboard-v2).
 *
 * Renders 4 KPIs (cache_hit, % good sessions, subagent adoption, composite)
 * for team `id` plus a 30-day trend per metric. Mirrors the per-org
 * `/manager/effectiveness` page but scoped to a single team.
 *
 * Auth + team-membership gate (REQ-9 + TC-I-16 + TC-I-36):
 *  1. Manager-role enforcement is handled by `app/manager/layout.tsx`
 *     (which renders `data-testid="manager-403"` on wrong role) and the
 *     root middleware.
 *  2. Team-membership and cross-org isolation are enforced HERE: we look
 *     up the manager's `(orgId, teamId)` pair via `users` and compare to
 *     the URL `params.id`. If they don't match, render a 403 page with
 *     `data-testid="team-effectiveness-403"`. The same code path covers
 *     both cross-team within the same org (REQ-9 / TC-I-16) and cross-org
 *     team enumeration (TC-I-36) — the URL team_id is NEVER queried
 *     directly against `team_metrics_daily`, so an attacker cannot probe
 *     existence of org B's teams via timing/data leaks.
 *
 * Anti-enumeration choice: per spec REQ-9 + TC-I-16, we return 403
 * (not 404). 404 would distinguish "team exists but not yours" from
 * "team doesn't exist at all" — both information leaks.
 *
 * Data sources (all org-scoped at the query layer — defense-in-depth):
 *  - `getTeamCacheHitTrend`     → REQ-1 trend + latest KPI
 *  - `getTeamGoodSessionPct`    → REQ-2 pct + trend
 *  - `getTeamSubagentAdoption`  → REQ-4 pct + trend
 *  - inline `team_metrics_daily.composite_avg` query → composite KPI + trend
 *
 * Server Component. The only client island is `<TrendChart>` (Recharts).
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { teams } from '@/lib/db/schema';
import { KpiCard } from '@/components/manager/kpi-card';
import { TrendChart, type TrendPoint } from '@/components/manager/trend-chart';
import {
  getTeamCacheHitTrend,
  getTeamCompositeTrend,
  getTeamGoodSessionPct,
  getTeamSubagentAdoption,
} from '@/lib/queries/manager-v2';

const WINDOW_DAYS = 30;

type Params = { id: string };

type ManagerTeamLookup = {
  teamId: string;
  teamName: string;
};

/**
 * Resolve the manager's `(teamId, teamName)` for the given `(managerId, orgId)`.
 *
 * Manager scope (spec lock, line 14): a manager-role user manages their
 * **entire org** — every team in their `org_id`. The team-effectiveness
 * deep-dive is therefore reachable for any team within the manager's org.
 *
 * Cross-team within the org → 200 with team data.
 * Cross-org URL or unknown team id → `Forbidden` (data-testid: `team-effectiveness-403`).
 *
 * Both `urlTeamId` and `orgId` are bind variables — the org filter is the
 * cross-org isolation point (REQ-19 + TC-I-36/37).
 */
const resolveTeamInOrg = async (
  db: ReturnType<typeof getDb>,
  urlTeamId: string,
  orgId: string,
): Promise<ManagerTeamLookup | null> => {
  const rows = await db
    .select({
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(teams)
    .where(and(eq(teams.id, urlTeamId), eq(teams.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  return row ? { teamId: row.teamId, teamName: row.teamName } : null;
};

const formatPct = (n: number | null): string => {
  if (n === null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
};

const formatComposite = (n: number | null): string => {
  if (n === null || Number.isNaN(n)) return '—';
  return n.toFixed(1);
};

/**
 * Cache hit ratio is stored as a 0..1 fraction; surface as a 0..100% number
 * for KPI / trend display. NULL days are preserved as `0` in the trend
 * series (TrendChart cannot render gaps without a separate dashed-line
 * component, and `0` is visually unambiguous given the metric domain is
 * non-negative).
 */
const cacheHitToPct = (n: number | null): number | null => {
  if (n === null || Number.isNaN(n)) return null;
  return n * 100;
};

const Forbidden = () => (
  <main className="p-8" data-testid="team-effectiveness-403">
    <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
      403 — not your team
    </h1>
    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
      This team is outside the scope of your manager role.
    </p>
    <p className="mt-4 text-sm">
      <Link
        href="/manager/effectiveness"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to org effectiveness
      </Link>
    </p>
  </main>
);

export default async function TeamEffectivenessPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id: urlTeamId } = await params;

  const session = await auth();
  if (!session?.user?.id || !session.user.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();

  // Cross-org gate. Manager scope is org-wide (spec lock, line 14) — any
  // team within the manager's org is reachable. Cross-org / unknown team id
  // → 403 to prevent enumeration. The team-scoped queries are also
  // org-bounded by their `orgId` parameter (defense-in-depth).
  const team = await resolveTeamInOrg(db, urlTeamId, orgId);
  if (!team) {
    return <Forbidden />;
  }
  const { teamId, teamName } = team;

  const [cacheHit, goodSession, subagent, compositeTrend] = await Promise.all([
    getTeamCacheHitTrend(db, { orgId, teamId, days: WINDOW_DAYS }),
    getTeamGoodSessionPct(db, { orgId, teamId, days: WINDOW_DAYS }),
    getTeamSubagentAdoption(db, { orgId, teamId, days: WINDOW_DAYS }),
    getTeamCompositeTrend(db, { orgId, teamId, days: WINDOW_DAYS }),
  ]);

  // Latest KPI values. For cache_hit and composite we take the last point
  // (the trend is ASC by day); for good_session_pct and subagent_adoption_pct
  // the helper already exposes a session-weighted single number.
  const latestCacheHit =
    cacheHit.length > 0 ? cacheHit[cacheHit.length - 1].cacheHitRatio : null;
  const latestComposite =
    compositeTrend.length > 0
      ? compositeTrend[compositeTrend.length - 1].compositeAvg
      : null;

  const cacheHitTrend: TrendPoint[] = cacheHit.map((p) => ({
    date: p.day,
    value: cacheHitToPct(p.cacheHitRatio) ?? 0,
  }));
  const goodSessionTrend: TrendPoint[] = goodSession.trend.map((p) => ({
    date: p.day,
    value: p.pct ?? 0,
  }));
  const subagentTrend: TrendPoint[] = subagent.trend.map((p) => ({
    date: p.day,
    value: p.pct ?? 0,
  }));
  const compositePoints: TrendPoint[] = compositeTrend.map((p) => ({
    date: p.day,
    value: p.compositeAvg ?? 0,
  }));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm">
          <Link
            href="/manager/effectiveness"
            className="text-blue-600 hover:underline dark:text-blue-400"
            data-testid="breadcrumb-effectiveness"
          >
            ← Effectiveness (org)
          </Link>
        </p>
        <h1
          className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100"
          data-testid="team-effectiveness-name"
        >
          {teamName} — effectiveness
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Cache utilization, session quality, parallelism adoption, and
          composite score for this team over the last {WINDOW_DAYS} days.
        </p>
      </div>

      <section
        aria-labelledby="team-effectiveness-kpis-heading"
        className="space-y-3"
      >
        <h2
          id="team-effectiveness-kpis-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          KPIs (latest day)
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Cache hit ratio"
            value={formatPct(cacheHitToPct(latestCacheHit))}
            subtext="Avg of session cache_hit_ratio"
            testId="kpi-team-cache-hit"
          />
          <KpiCard
            label="% good sessions"
            value={formatPct(goodSession.pct)}
            subtext="composite ≥ 60 OR rating ≥ 0"
            testId="kpi-team-good-session-pct"
          />
          <KpiCard
            label="Subagent adoption"
            value={formatPct(subagent.pct)}
            subtext="% sessions with subagent_usage_ratio > 0"
            testId="kpi-team-subagent-adoption"
          />
          <KpiCard
            label="Composite score"
            value={formatComposite(latestComposite)}
            subtext="0..100 weighted blend"
            testId="kpi-team-composite"
          />
        </div>
      </section>

      <section
        aria-labelledby="team-effectiveness-cache-heading"
        className="space-y-3"
      >
        <h2
          id="team-effectiveness-cache-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Cache hit ratio (30d)
        </h2>
        <TrendChart
          data={cacheHitTrend}
          label="Cache hit ratio (%)"
          testId="trend-team-cache-hit-30d"
        />
      </section>

      <section
        aria-labelledby="team-effectiveness-good-heading"
        className="space-y-3"
      >
        <h2
          id="team-effectiveness-good-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          % good sessions (30d)
        </h2>
        <TrendChart
          data={goodSessionTrend}
          label="% good sessions"
          testId="trend-team-good-session-30d"
        />
      </section>

      <section
        aria-labelledby="team-effectiveness-subagent-heading"
        className="space-y-3"
      >
        <h2
          id="team-effectiveness-subagent-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Subagent adoption (30d)
        </h2>
        <TrendChart
          data={subagentTrend}
          label="% sessions with subagent usage"
          testId="trend-team-subagent-30d"
        />
      </section>

      <section
        aria-labelledby="team-effectiveness-composite-heading"
        className="space-y-3"
      >
        <h2
          id="team-effectiveness-composite-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Composite score (30d)
        </h2>
        <TrendChart
          data={compositePoints}
          label="Composite score (0..100)"
          testId="trend-team-composite-30d"
        />
      </section>
    </div>
  );
}
