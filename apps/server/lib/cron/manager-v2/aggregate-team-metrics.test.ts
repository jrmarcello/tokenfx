/**
 * Integration tests for `aggregateTeamMetrics` (TASK-CRON-AGG).
 *
 * Covers:
 *   REQ-21 → TC-I-03 (happy + idempotency)
 *   REQ-21 → TC-I-04 (edge — late reporter push only refreshes last 2 days)
 *   REQ-21 → TC-I-07 (infra — DB error path marks cron_runs.status='failed')
 *   REQ-21 → TC-I-49 (security — correct secret → 200)
 *   REQ-21 → TC-I-50 (security — wrong secret → 401)
 *   REQ-21 → TC-I-51 (security — missing header → 401)
 *   REQ-21 → TC-I-70 (concurrency — overlapping runs serialize via ON CONFLICT)
 *
 * Postgres-backed via Testcontainers (`globalSetup` boots the container once
 * for the whole `pnpm test` run). Skipped when `SKIP_PG_TESTS=1`.
 *
 * Test stubs are hand-written — no `vi.mock`, no sinon. The DB-error path
 * (TC-I-07) is exercised by passing a tiny stub that mimics enough of the
 * Drizzle surface to let `aggregateTeamMetrics` reach its error branch.
 */
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  cronRuns,
  orgs,
  sessionsAgg,
  teamMetricsDaily,
  teams,
  toolCountAgg,
  users,
} from '@/lib/db/schema';
import { aggregateTeamMetrics } from './aggregate-team-metrics';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// ---------- helpers ---------------------------------------------------------

const wipeAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
    manager_notifications, team_metrics_daily, cron_runs, org_settings,
    onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
    ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
    cost_calibration_per_user, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const insertSession = async (input: {
  userId: string;
  sessionId: string;
  startedAt: Date;
  totalCostUsd: number;
  cacheHitRatio: number | null;
  outputInputRatio: number | null;
  subagentUsageRatio: number | null;
  avgRating: number | null;
}): Promise<void> => {
  const db = getDb();
  const endedAt = new Date(input.startedAt.getTime() + 60_000);
  await db.insert(sessionsAgg).values({
    userId: input.userId,
    sessionId: input.sessionId,
    payloadHash: `hash-${input.sessionId}`,
    startedAt: input.startedAt,
    endedAt,
    projectSlug: `slug:${input.sessionId}`,
    gitBranch: null,
    ccVersion: null,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: input.totalCostUsd.toFixed(6),
    totalCostUsdOtel: null,
    turnCount: 1,
    toolCallCount: 0,
    avgRating: input.avgRating === null ? null : input.avgRating.toFixed(3),
    cacheHitRatio: input.cacheHitRatio === null ? null : input.cacheHitRatio.toFixed(3),
    outputInputRatio:
      input.outputInputRatio === null ? null : input.outputInputRatio.toFixed(4),
    subagentUsageRatio:
      input.subagentUsageRatio === null ? null : input.subagentUsageRatio.toFixed(3),
  });
};

const insertToolCount = async (
  userId: string,
  sessionId: string,
  toolName: string,
  count: number,
): Promise<void> => {
  const db = getDb();
  await db.insert(toolCountAgg).values({ userId, sessionId, toolName, count });
};

const dayBefore = (d: Date, days: number): Date =>
  new Date(d.getTime() - days * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// TC-I-03: happy + idempotency
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-03 (happy + idempotency)', () => {
  let orgId = '';
  let teamAId = '';
  let teamBId = '';
  let userA = '';
  let userB = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-Agg-Happy' })
      .returning({ id: orgs.id });
    orgId = org.id;
    const teamRows = await db
      .insert(teams)
      .values([
        { orgId, name: 'TeamAlpha' },
        { orgId, name: 'TeamBeta' },
      ])
      .returning({ id: teams.id, name: teams.name });
    teamAId = teamRows.find((t) => t.name === 'TeamAlpha')!.id;
    teamBId = teamRows.find((t) => t.name === 'TeamBeta')!.id;

    const userRows = await db
      .insert(users)
      .values([
        {
          orgId,
          teamId: teamAId,
          email: 'alpha@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-alpha',
          role: 'member',
        },
        {
          orgId,
          teamId: teamBId,
          email: 'beta@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-beta',
          role: 'member',
        },
      ])
      .returning({ id: users.id, email: users.email });
    userA = userRows.find((r) => r.email === 'alpha@example.com')!.id;
    userB = userRows.find((r) => r.email === 'beta@example.com')!.id;

    // Today 12:00 UTC for stability across runs.
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    // Team A — 2 sessions today, 1 yesterday. cache_hit varies per session.
    await insertSession({
      userId: userA,
      sessionId: 'a-1',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.6,
      outputInputRatio: 2.5,
      subagentUsageRatio: 0.2,
      avgRating: 1,
    });
    await insertSession({
      userId: userA,
      sessionId: 'a-2',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.8,
      outputInputRatio: 3,
      subagentUsageRatio: 0,
      avgRating: null,
    });
    await insertSession({
      userId: userA,
      sessionId: 'a-3',
      startedAt: dayBefore(today, 1),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: 0.4,
      avgRating: 0,
    });
    await insertToolCount(userA, 'a-1', 'Edit', 3);
    await insertToolCount(userA, 'a-1', 'Read', 2);
    await insertToolCount(userA, 'a-2', 'Bash', 1);
    await insertToolCount(userA, 'a-3', 'Task', 1); // legacy → Agent bucket

    // Team B — 1 session today.
    await insertSession({
      userId: userB,
      sessionId: 'b-1',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.3,
      outputInputRatio: 1.5,
      subagentUsageRatio: null,
      avgRating: -1,
    });
    await insertToolCount(userB, 'b-1', 'Read', 5);
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-03: first run populates team_metrics_daily; second run is idempotent (no duplicates, values stable)', async () => {
    const db = getDb();

    const r1 = await aggregateTeamMetrics(db);
    expect(r1.status).toBe('ok');
    expect(r1.rowsWritten).toBeGreaterThan(0);

    // Snapshot rows after first run.
    const after1 = await db
      .select({
        orgId: teamMetricsDaily.orgId,
        teamId: teamMetricsDaily.teamId,
        day: teamMetricsDaily.day,
        cacheHit: teamMetricsDaily.cacheHitRatioAvg,
        totalSessions: teamMetricsDaily.totalSessions,
        totalDevs: teamMetricsDaily.totalDevs,
        toolMix: teamMetricsDaily.toolMixJson,
      })
      .from(teamMetricsDaily);

    // 2 days × 1 team-A row + 1 day × 1 team-B row = 3 rows.
    expect(after1.length).toBe(3);
    const teamADays = after1.filter((r) => r.teamId === teamAId);
    expect(teamADays.length).toBe(2);
    const teamBDays = after1.filter((r) => r.teamId === teamBId);
    expect(teamBDays.length).toBe(1);

    // Today's team-A row: 2 sessions, 1 dev, cache_hit avg = (0.6 + 0.8)/2 = 0.7.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayKey = isoDay(today);
    const teamAToday = teamADays.find((r) => r.day === todayKey);
    expect(teamAToday).toBeDefined();
    if (teamAToday) {
      expect(teamAToday.totalSessions).toBe(2);
      expect(teamAToday.totalDevs).toBe(1);
      expect(teamAToday.cacheHit).not.toBeNull();
      if (teamAToday.cacheHit !== null) {
        expect(Number(teamAToday.cacheHit)).toBeCloseTo(0.7, 2);
      }
      // tool_mix_json present (Edit:3, Read:2, Bash:1 today for team A).
      expect(teamAToday.toolMix).not.toBeNull();
    }

    // Run again — idempotent.
    const r2 = await aggregateTeamMetrics(db);
    expect(r2.status).toBe('ok');

    const after2 = await db
      .select({
        orgId: teamMetricsDaily.orgId,
        teamId: teamMetricsDaily.teamId,
        day: teamMetricsDaily.day,
      })
      .from(teamMetricsDaily);
    // No new rows on second run.
    expect(after2.length).toBe(after1.length);

    // Two cron_runs entries, both 'ok'.
    const runs = await db
      .select({ status: cronRuns.status, jobName: cronRuns.jobName })
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'aggregate-team-metrics'`);
    expect(runs.length).toBe(2);
    for (const r of runs) {
      expect(r.status).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------
// TC-I-04: late-reporter edge — only last 2 days re-aggregated
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-04 (late reporter; window=last 2 days)', () => {
  let orgId = '';
  let teamId = '';
  let userId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-Agg-Late' })
      .returning({ id: orgs.id });
    orgId = org.id;
    const [team] = await db
      .insert(teams)
      .values({ orgId, name: 'TeamLate' })
      .returning({ id: teams.id });
    teamId = team.id;
    const [user] = await db
      .insert(users)
      .values({
        orgId,
        teamId,
        email: 'late@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-late',
        role: 'member',
      })
      .returning({ id: users.id });
    userId = user.id;

    // Seed 2 sessions today + 1 yesterday + 1 ten days ago.
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSession({
      userId,
      sessionId: 'late-today',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
    await insertSession({
      userId,
      sessionId: 'late-yesterday',
      startedAt: dayBefore(today, 1),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
    await insertSession({
      userId,
      sessionId: 'late-10d',
      startedAt: dayBefore(today, 10),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-04: re-run after late session push for day-1 only refreshes last 2 days; older rows untouched', async () => {
    const db = getDb();

    // First run — backfill 90 days. All 3 days populated.
    const r1 = await aggregateTeamMetrics(db);
    expect(r1.status).toBe('ok');

    const oldDay = isoDay(dayBefore(new Date(), 10));
    const before = await db
      .select({
        day: teamMetricsDaily.day,
        sessions: teamMetricsDaily.totalSessions,
        computedAt: teamMetricsDaily.computedAt,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.teamId} = ${teamId}`);
    const oldRow = before.find((r) => r.day === oldDay);
    expect(oldRow).toBeDefined();
    const oldComputedAt = oldRow!.computedAt;
    expect(oldRow!.sessions).toBe(1);

    // Late reporter pushes a *yesterday* session.
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSession({
      userId,
      sessionId: 'late-yesterday-2',
      startedAt: dayBefore(today, 1),
      totalCostUsd: 1,
      cacheHitRatio: 0.9,
      outputInputRatio: 4,
      subagentUsageRatio: null,
      avgRating: null,
    });

    // 2nd run — default window only refreshes last 2 days.
    const r2 = await aggregateTeamMetrics(db);
    expect(r2.status).toBe('ok');

    const after = await db
      .select({
        day: teamMetricsDaily.day,
        sessions: teamMetricsDaily.totalSessions,
        computedAt: teamMetricsDaily.computedAt,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.teamId} = ${teamId}`);

    // Yesterday now has 2 sessions (refreshed).
    const yesterdayKey = isoDay(dayBefore(today, 1));
    const yesterdayRow = after.find((r) => r.day === yesterdayKey);
    expect(yesterdayRow).toBeDefined();
    expect(yesterdayRow!.sessions).toBe(2);

    // Old row from 10d ago is unchanged: same session count, same computed_at.
    const oldRowAfter = after.find((r) => r.day === oldDay);
    expect(oldRowAfter).toBeDefined();
    expect(oldRowAfter!.sessions).toBe(1);
    expect(oldRowAfter!.computedAt.getTime()).toBe(oldComputedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// TC-I-07: DB error → cron_runs.status='failed' with error_message
// ---------------------------------------------------------------------------
// Hand-written stub mimics enough of the Drizzle surface for the function to
// reach its error branch. We accept the trade-off that this test does not
// exercise the real SQL — TC-I-03 / TC-I-04 cover the happy path against the
// real Postgres. The point of TC-I-07 is the cron_runs lifecycle on failure.

type StubDb = {
  insert: (table: unknown) => {
    values: (rows: unknown) => {
      returning: (cols: unknown) => Promise<{ id: number }[]>;
    };
  };
  execute: (q: unknown) => Promise<unknown>;
  update: (table: unknown) => {
    set: (vals: unknown) => { where: (cond: unknown) => Promise<unknown> };
  };
};

skipDescribe('aggregateTeamMetrics — TC-I-07 (infra: DB error path)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-07: when the aggregation query throws, cron_runs row is updated to status=failed with error_message', async () => {
    const db = getDb();

    // Seed a real cron_runs row up front via the real DB so we can verify
    // the function updates it. We pass a wrapper that delegates everything
    // *except* the aggregation `execute` to the real DB; the aggregation
    // execute throws synchronously to drive the error branch.
    let aggExecuteCount = 0;
    const stub: StubDb = {
      insert: (table) => db.insert(table as never) as never,
      update: (table) => db.update(table as never) as never,
      execute: async (q) => {
        // First execute call is the aggregation INSERT; throw on it.
        aggExecuteCount += 1;
        if (aggExecuteCount === 1) {
          throw new Error('simulated aggregation failure');
        }
        return db.execute(q as never);
      },
    };

    const result = await aggregateTeamMetrics(stub as never);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('simulated aggregation failure');

    const runs = await db
      .select({
        status: cronRuns.status,
        errorMessage: cronRuns.errorMessage,
        finishedAt: cronRuns.finishedAt,
      })
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'aggregate-team-metrics'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).toContain('simulated aggregation failure');
    expect(runs[0].finishedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TC-I-49 / TC-I-50 / TC-I-51: route auth
// ---------------------------------------------------------------------------

skipDescribe('POST /api/internal/cron/aggregate-team-metrics — auth (TC-I-49/50/51)', () => {
  const ORIG_SECRET = process.env.INTERNAL_CRON_SECRET;
  const ORIG_NODE_ENV = process.env.NODE_ENV;
  const SECRET = 'test-internal-cron-secret-aggregate';

  beforeAll(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = SECRET;
  });

  afterAll(async () => {
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = ORIG_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_NODE_ENV;
    await wipeAll();
  });

  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-49: correct secret → 200 with run summary JSON', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-metrics/route'
    );
    const req = new Request('http://localhost/api/internal/cron/aggregate-team-metrics', {
      method: 'POST',
      headers: { 'x-internal-cron-secret': SECRET },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('started_at');
    expect(body).toHaveProperty('finished_at');
    expect(body).toHaveProperty('rows_written');
  });

  it('TC-I-50: wrong secret → 401', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-metrics/route'
    );
    const req = new Request('http://localhost/api/internal/cron/aggregate-team-metrics', {
      method: 'POST',
      headers: { 'x-internal-cron-secret': 'wrong-secret-same-len-pad-pad' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('TC-I-51: missing header → 401', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-metrics/route'
    );
    const req = new Request('http://localhost/api/internal/cron/aggregate-team-metrics', {
      method: 'POST',
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// TC-I-70: concurrency — overlapping runs serialize via ON CONFLICT
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-70 (concurrency)', () => {
  let orgId = '';
  let teamId = '';
  let userId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-Agg-Conc' })
      .returning({ id: orgs.id });
    orgId = org.id;
    const [team] = await db
      .insert(teams)
      .values({ orgId, name: 'TeamConc' })
      .returning({ id: teams.id });
    teamId = team.id;
    const [user] = await db
      .insert(users)
      .values({
        orgId,
        teamId,
        email: 'conc@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-conc',
        role: 'member',
      })
      .returning({ id: users.id });
    userId = user.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSession({
      userId,
      sessionId: 'conc-1',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-70: two overlapping invocations both succeed; final state has no duplicate rows', async () => {
    const db = getDb();
    const [r1, r2] = await Promise.all([
      aggregateTeamMetrics(db),
      aggregateTeamMetrics(db),
    ]);
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');

    const rows = await db
      .select({
        teamId: teamMetricsDaily.teamId,
        day: teamMetricsDaily.day,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.teamId} = ${teamId}`);
    // ON CONFLICT (org_id, team_id, day) — at most one row per day.
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.teamId}|${r.day}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TC-I-09: per-org probe — populated org keeps rolling 2d window;
//          empty org gets 90d backfill; both in same invocation
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-09 (per-org probe: mixed orgs)', () => {
  let orgAId = '';
  let orgBId = '';
  let teamAId = '';
  let teamBId = '';
  let userAId = '';
  let userBId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const orgRows = await db
      .insert(orgs)
      .values([{ name: 'Org-PerOrg-A' }, { name: 'Org-PerOrg-B' }])
      .returning({ id: orgs.id, name: orgs.name });
    orgAId = orgRows.find((r) => r.name === 'Org-PerOrg-A')!.id;
    orgBId = orgRows.find((r) => r.name === 'Org-PerOrg-B')!.id;

    const teamRows = await db
      .insert(teams)
      .values([
        { orgId: orgAId, name: 'TeamA' },
        { orgId: orgBId, name: 'TeamB' },
      ])
      .returning({ id: teams.id, name: teams.name });
    teamAId = teamRows.find((r) => r.name === 'TeamA')!.id;
    teamBId = teamRows.find((r) => r.name === 'TeamB')!.id;

    const userRows = await db
      .insert(users)
      .values([
        {
          orgId: orgAId,
          teamId: teamAId,
          email: 'perorg-a@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-perorg-a',
          role: 'member',
        },
        {
          orgId: orgBId,
          teamId: teamBId,
          email: 'perorg-b@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-perorg-b',
          role: 'member',
        },
      ])
      .returning({ id: users.id, email: users.email });
    userAId = userRows.find((r) => r.email === 'perorg-a@example.com')!.id;
    userBId = userRows.find((r) => r.email === 'perorg-b@example.com')!.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    // Org A: 5 pre-existing rows in team_metrics_daily for days 30..26 ago
    // (well outside the 2-day rolling window). Direct INSERT to bypass
    // aggregator and lock `computed_at` to a known past timestamp.
    const oldComputedAt = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      const day = new Date(today);
      day.setUTCDate(day.getUTCDate() - (30 - i));
      await db.insert(teamMetricsDaily).values({
        orgId: orgAId,
        teamId: teamAId,
        day: isoDay(day),
        cacheHitRatioAvg: '0.5',
        goodSessionPct: '50.0',
        subagentAdoptionPct: '0.0',
        compositeAvg: '50.0',
        totalSessions: 1,
        totalDevs: 1,
        toolMixJson: { Edit: 1 },
        computedAt: oldComputedAt,
      });
    }

    // Org A: 1 session today (within 2d rolling window).
    await insertSession({
      userId: userAId,
      sessionId: 'pa-today',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.7,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
    // Org B: 1 session 5 days ago (only seen if 90d backfill kicks in).
    await insertSession({
      userId: userBId,
      sessionId: 'pb-5d',
      startedAt: dayBefore(today, 5),
      totalCostUsd: 1,
      cacheHitRatio: 0.4,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-09: org-A old rows untouched (rolling 2d window); org-B (empty) gets 90d backfill', async () => {
    const db = getDb();

    // Snapshot org-A's old computed_at values BEFORE the run.
    const beforeA = await db
      .select({
        day: teamMetricsDaily.day,
        computedAt: teamMetricsDaily.computedAt,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgAId}`);
    expect(beforeA.length).toBe(5);
    const oldComputedAtMs = beforeA.map((r) => r.computedAt.getTime());

    const result = await aggregateTeamMetrics(db);
    expect(result.status).toBe('ok');

    // Org A: the 5 historical rows must be UNCHANGED (computed_at frozen)
    // because the rolling 2d window does not include them.
    const afterA = await db
      .select({
        day: teamMetricsDaily.day,
        computedAt: teamMetricsDaily.computedAt,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgAId}`);
    const todayKey = isoDay(
      (() => {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
      })(),
    );
    // Old rows (day < today) keep their computed_at.
    for (const row of afterA) {
      if (row.day < todayKey) {
        expect(oldComputedAtMs).toContain(row.computedAt.getTime());
      }
    }
    // Today's session triggered a new row for Org A.
    const todayRowA = afterA.find((r) => r.day === todayKey);
    expect(todayRowA).toBeDefined();

    // Org B: empty before, so 90d backfill applied. The 5-day-ago session
    // becomes a row.
    const afterB = await db
      .select({
        day: teamMetricsDaily.day,
      })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgBId}`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const fiveDaysAgoKey = isoDay(dayBefore(today, 5));
    expect(afterB.find((r) => r.day === fiveDaysAgoKey)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TC-I-10: fresh DB — every org gets 90d backfill
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-10 (fresh DB, all orgs backfill)', () => {
  let orgAId = '';
  let orgBId = '';
  let userAId = '';
  let userBId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const orgRows = await db
      .insert(orgs)
      .values([{ name: 'Org-Fresh-A' }, { name: 'Org-Fresh-B' }])
      .returning({ id: orgs.id, name: orgs.name });
    orgAId = orgRows.find((r) => r.name === 'Org-Fresh-A')!.id;
    orgBId = orgRows.find((r) => r.name === 'Org-Fresh-B')!.id;

    const teamRows = await db
      .insert(teams)
      .values([
        { orgId: orgAId, name: 'TF-A' },
        { orgId: orgBId, name: 'TF-B' },
      ])
      .returning({ id: teams.id, name: teams.name });
    const teamAId = teamRows.find((r) => r.name === 'TF-A')!.id;
    const teamBId = teamRows.find((r) => r.name === 'TF-B')!.id;

    const userRows = await db
      .insert(users)
      .values([
        {
          orgId: orgAId,
          teamId: teamAId,
          email: 'fresh-a@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-fresh-a',
          role: 'member',
        },
        {
          orgId: orgBId,
          teamId: teamBId,
          email: 'fresh-b@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-fresh-b',
          role: 'member',
        },
      ])
      .returning({ id: users.id, email: users.email });
    userAId = userRows.find((r) => r.email === 'fresh-a@example.com')!.id;
    userBId = userRows.find((r) => r.email === 'fresh-b@example.com')!.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    // Each org gets 1 session 30 days back — only reachable via 90d backfill.
    await insertSession({
      userId: userAId,
      sessionId: 'fa-30d',
      startedAt: dayBefore(today, 30),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
    await insertSession({
      userId: userBId,
      sessionId: 'fb-30d',
      startedAt: dayBefore(today, 30),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-10: with team_metrics_daily empty across all orgs, both orgs get 90d backfill', async () => {
    const db = getDb();
    const result = await aggregateTeamMetrics(db);
    expect(result.status).toBe('ok');

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const thirtyDaysAgoKey = isoDay(dayBefore(today, 30));

    const rowsA = await db
      .select({ day: teamMetricsDaily.day })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgAId}`);
    expect(rowsA.find((r) => r.day === thirtyDaysAgoKey)).toBeDefined();

    const rowsB = await db
      .select({ day: teamMetricsDaily.day })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgBId}`);
    expect(rowsB.find((r) => r.day === thirtyDaysAgoKey)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TC-I-11: explicit `since` overrides per-org probe uniformly
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-11 (explicit since override)', () => {
  let orgAId = '';
  let orgBId = '';
  let teamAId = '';
  let teamBId = '';
  let userAId = '';
  let userBId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const orgRows = await db
      .insert(orgs)
      .values([{ name: 'Org-Override-A' }, { name: 'Org-Override-B' }])
      .returning({ id: orgs.id, name: orgs.name });
    orgAId = orgRows.find((r) => r.name === 'Org-Override-A')!.id;
    orgBId = orgRows.find((r) => r.name === 'Org-Override-B')!.id;

    const teamRows = await db
      .insert(teams)
      .values([
        { orgId: orgAId, name: 'TO-A' },
        { orgId: orgBId, name: 'TO-B' },
      ])
      .returning({ id: teams.id, name: teams.name });
    teamAId = teamRows.find((r) => r.name === 'TO-A')!.id;
    teamBId = teamRows.find((r) => r.name === 'TO-B')!.id;

    const userRows = await db
      .insert(users)
      .values([
        {
          orgId: orgAId,
          teamId: teamAId,
          email: 'over-a@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-over-a',
          role: 'member',
        },
        {
          orgId: orgBId,
          teamId: teamBId,
          email: 'over-b@example.com',
          ssoProvider: 'google',
          ssoSubject: 'sub-over-b',
          role: 'member',
        },
      ])
      .returning({ id: users.id, email: users.email });
    userAId = userRows.find((r) => r.email === 'over-a@example.com')!.id;
    userBId = userRows.find((r) => r.email === 'over-b@example.com')!.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    // Org A is "populated" — pre-existing TMD row (so default would be 2d).
    await db.insert(teamMetricsDaily).values({
      orgId: orgAId,
      teamId: teamAId,
      day: isoDay(dayBefore(today, 30)),
      cacheHitRatioAvg: '0.5',
      goodSessionPct: '50.0',
      subagentAdoptionPct: '0.0',
      compositeAvg: '50.0',
      totalSessions: 1,
      totalDevs: 1,
      toolMixJson: { Edit: 1 },
    });

    // Org A: session 5 days ago (would be skipped under default 2d window
    // for Org A; covered by override 7d window).
    await insertSession({
      userId: userAId,
      sessionId: 'oa-5d',
      startedAt: dayBefore(today, 5),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });

    // Org B (empty): session 30 days ago (would be picked up by 90d default
    // backfill, but should NOT under 7d override).
    await insertSession({
      userId: userBId,
      sessionId: 'ob-30d',
      startedAt: dayBefore(today, 30),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
    // Org B: session 3 days ago (within 7d override).
    await insertSession({
      userId: userBId,
      sessionId: 'ob-3d',
      startedAt: dayBefore(today, 3),
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-11: explicit since=now-7d applies uniformly; org-B does NOT get 90d backfill', async () => {
    const db = getDb();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const since = dayBefore(today, 7);

    const result = await aggregateTeamMetrics(db, { since });
    expect(result.status).toBe('ok');

    // Org A: session at 5d ago should now be aggregated (override expanded
    // its window from 2d to 7d).
    const fiveDaysAgoKey = isoDay(dayBefore(today, 5));
    const rowsA = await db
      .select({ day: teamMetricsDaily.day })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgAId}`);
    expect(rowsA.find((r) => r.day === fiveDaysAgoKey)).toBeDefined();

    // Org B: 3d-ago session aggregated; 30d-ago session NOT (override
    // narrowed the window from 90d to 7d).
    const threeDaysAgoKey = isoDay(dayBefore(today, 3));
    const thirtyDaysAgoKey = isoDay(dayBefore(today, 30));
    const rowsB = await db
      .select({ day: teamMetricsDaily.day })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgBId}`);
    expect(rowsB.find((r) => r.day === threeDaysAgoKey)).toBeDefined();
    expect(rowsB.find((r) => r.day === thirtyDaysAgoKey)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-I-12: org with 0 users in `users` is excluded from the universe
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-12 (org with no users)', () => {
  let orgXId = '';
  let orgYId = '';
  let userYId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const orgRows = await db
      .insert(orgs)
      .values([{ name: 'Org-NoUsers-X' }, { name: 'Org-Pop-Y' }])
      .returning({ id: orgs.id, name: orgs.name });
    orgXId = orgRows.find((r) => r.name === 'Org-NoUsers-X')!.id;
    orgYId = orgRows.find((r) => r.name === 'Org-Pop-Y')!.id;

    // Org X: NO team, NO user — should be skipped entirely.
    const [teamY] = await db
      .insert(teams)
      .values({ orgId: orgYId, name: 'TY' })
      .returning({ id: teams.id });
    const [uY] = await db
      .insert(users)
      .values({
        orgId: orgYId,
        teamId: teamY.id,
        email: 'no-users-y@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-no-users-y',
        role: 'member',
      })
      .returning({ id: users.id });
    userYId = uY.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSession({
      userId: userYId,
      sessionId: 'y-today',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-12: org X (0 users) does not appear in result; aggregator does not error', async () => {
    const db = getDb();
    const result = await aggregateTeamMetrics(db);
    expect(result.status).toBe('ok');

    const rowsX = await db
      .select({ id: teamMetricsDaily.orgId })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgXId}`);
    expect(rowsX.length).toBe(0);

    const rowsY = await db
      .select({ id: teamMetricsDaily.orgId })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgYId}`);
    expect(rowsY.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TC-I-18: probe DB error → cron_runs marked failed; team_metrics_daily intact
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-18 (probe DB failure)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-18: when the per-org probe execute throws, run is marked failed and team_metrics_daily is unchanged', async () => {
    const db = getDb();
    // Seed a populated baseline so we can prove team_metrics_daily was
    // not mutated by the failed run.
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-Probe-Fail' })
      .returning({ id: orgs.id });
    const [team] = await db
      .insert(teams)
      .values({ orgId: org.id, name: 'TPF' })
      .returning({ id: teams.id });
    await db.insert(teamMetricsDaily).values({
      orgId: org.id,
      teamId: team.id,
      day: '2024-01-01',
      cacheHitRatioAvg: '0.5',
      goodSessionPct: '50.0',
      subagentAdoptionPct: '0.0',
      compositeAvg: '50.0',
      totalSessions: 1,
      totalDevs: 1,
      toolMixJson: { Edit: 1 },
    });

    const beforeRows = await db.select({ day: teamMetricsDaily.day }).from(teamMetricsDaily);
    const beforeCount = beforeRows.length;

    // Stub: forward everything to real db EXCEPT the first `execute` call —
    // which is the probe SELECT in resolveWindowStartsByOrg — throws.
    let execCount = 0;
    const stub: StubDb = {
      insert: (table) => db.insert(table as never) as never,
      update: (table) => db.update(table as never) as never,
      execute: async (q) => {
        execCount += 1;
        if (execCount === 1) {
          throw new Error('simulated probe failure');
        }
        return db.execute(q as never);
      },
    };

    const result = await aggregateTeamMetrics(stub as never);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('simulated probe failure');

    const runs = await db
      .select({
        status: cronRuns.status,
        errorMessage: cronRuns.errorMessage,
        finishedAt: cronRuns.finishedAt,
      })
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'aggregate-team-metrics'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).toContain('simulated probe failure');
    expect(runs[0].finishedAt).not.toBeNull();

    const afterRows = await db.select({ day: teamMetricsDaily.day }).from(teamMetricsDaily);
    expect(afterRows.length).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// TC-I-19: org with users but 0 sessions → 0 rows written, no error
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamMetrics — TC-I-19 (org with users but no sessions)', () => {
  let orgYId = '';
  let orgZId = '';
  let userZId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const orgRows = await db
      .insert(orgs)
      .values([{ name: 'Org-NoSess-Y' }, { name: 'Org-Sess-Z' }])
      .returning({ id: orgs.id, name: orgs.name });
    orgYId = orgRows.find((r) => r.name === 'Org-NoSess-Y')!.id;
    orgZId = orgRows.find((r) => r.name === 'Org-Sess-Z')!.id;

    const teamRows = await db
      .insert(teams)
      .values([
        { orgId: orgYId, name: 'TNS-Y' },
        { orgId: orgZId, name: 'TNS-Z' },
      ])
      .returning({ id: teams.id, name: teams.name });
    const teamYId = teamRows.find((r) => r.name === 'TNS-Y')!.id;
    const teamZId = teamRows.find((r) => r.name === 'TNS-Z')!.id;

    // Org Y: user exists, NO session.
    await db.insert(users).values({
      orgId: orgYId,
      teamId: teamYId,
      email: 'nosess-y@example.com',
      ssoProvider: 'google',
      ssoSubject: 'sub-nosess-y',
      role: 'member',
    });

    // Org Z: user + 1 session today.
    const [uZ] = await db
      .insert(users)
      .values({
        orgId: orgZId,
        teamId: teamZId,
        email: 'sess-z@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-sess-z',
        role: 'member',
      })
      .returning({ id: users.id });
    userZId = uZ.id;

    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSession({
      userId: userZId,
      sessionId: 'z-today',
      startedAt: today,
      totalCostUsd: 1,
      cacheHitRatio: 0.5,
      outputInputRatio: 2,
      subagentUsageRatio: null,
      avgRating: null,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-19: 0 rows written for Y; Z processed normally; cron status=ok', async () => {
    const db = getDb();
    const result = await aggregateTeamMetrics(db);
    expect(result.status).toBe('ok');

    const rowsY = await db
      .select({ id: teamMetricsDaily.orgId })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgYId}`);
    expect(rowsY.length).toBe(0);

    const rowsZ = await db
      .select({ id: teamMetricsDaily.orgId })
      .from(teamMetricsDaily)
      .where(sql`${teamMetricsDaily.orgId} = ${orgZId}`);
    expect(rowsZ.length).toBeGreaterThan(0);

    const runs = await db
      .select({ status: cronRuns.status })
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'aggregate-team-metrics'`);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[runs.length - 1].status).toBe('ok');
  });
});

// ---------- Lifecycle: shut down the DB connection -------------------------

skipDescribe('aggregate-team-metrics (Postgres lifecycle)', () => {
  it('keeps the test DB connection clean', async () => {
    await closeDb();
    expect(true).toBe(true);
  });
});
