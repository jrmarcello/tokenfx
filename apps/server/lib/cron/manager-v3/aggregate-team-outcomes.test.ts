/**
 * Integration tests for `aggregateTeamOutcomes` (manager-dashboard-v3-outcomes
 * spec REQ-11). Mirrors `manager-v2/aggregate-team-metrics.test.ts` patterns.
 *
 * Postgres-backed via Testcontainers (`globalSetup` boots once for the
 * whole `pnpm test` run). Skipped when `SKIP_PG_TESTS=1`.
 *
 * Test stubs hand-written — no `vi.mock`, no sinon. The DB-error path
 * (TC-I-04b) uses a tiny stub that mimics enough of the Drizzle surface
 * to drive `aggregateTeamOutcomes` to its error branch.
 */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, getDb } from '@/lib/db/client';
import {
  cronRuns,
  orgs,
  sessionOutcomesAgg,
  sessionsAgg,
  teamOutcomesDaily,
  teams,
  users,
} from '@/lib/db/schema';

import { aggregateTeamOutcomes } from './aggregate-team-outcomes';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// ---------- helpers --------------------------------------------------------

const wipeAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
    manager_notifications, team_outcomes_daily, team_metrics_daily, cron_runs,
    org_settings, onboarding_redemption_log, onboarding_audit_log,
    onboarding_invites, ingestion_log, model_breakdown_agg, tool_count_agg,
    session_outcomes_agg, sessions_agg, cost_calibration_per_user,
    user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const insertSessionAndOutcome = async (input: {
  userId: string;
  sessionId: string;
  startedAt: Date;
  totalCostUsd: number;
  commitCount: number;
  locAdded: number;
  locRemoved: number;
  filesChanged: number;
  revertsWithin7d: number;
  mergedPrCount: number | null;
  outcomeStatus: 'evaluated' | 'cwd-missing' | 'not-a-git-repo' | 'no-user-email';
}): Promise<void> => {
  const db = getDb();
  const endedAt = new Date(input.startedAt.getTime() + 60_000);
  await db.insert(sessionsAgg).values({
    userId: input.userId,
    sessionId: input.sessionId,
    payloadHash: `hash-${input.sessionId}`,
    startedAt: input.startedAt,
    endedAt,
    projectSlug: `slug:${input.sessionId.slice(0, 16).padEnd(16, '0')}`,
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
    avgRating: null,
    cacheHitRatio: null,
    outputInputRatio: null,
    subagentUsageRatio: null,
  });
  await db.insert(sessionOutcomesAgg).values({
    userId: input.userId,
    sessionId: input.sessionId,
    commitCount: input.commitCount,
    locAdded: input.locAdded,
    locRemoved: input.locRemoved,
    filesChanged: input.filesChanged,
    revertsWithin7d: input.revertsWithin7d,
    mergedPrCount: input.mergedPrCount,
    outcomeStatus: input.outcomeStatus,
  });
};

const dayBefore = (d: Date, days: number): Date =>
  new Date(d.getTime() - days * 24 * 60 * 60 * 1000);

const seedOrgWithTeam = async (
  orgName: string,
  teamName: string,
): Promise<{ orgId: string; teamId: string; userId: string }> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: orgName })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: teamName })
    .returning({ id: teams.id });
  const [user] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: `${orgName.toLowerCase()}-${teamName.toLowerCase()}@example.com`,
      ssoProvider: 'google',
      ssoSubject: `sub-${orgName}-${teamName}`,
      role: 'member',
    })
    .returning({ id: users.id });
  return { orgId: org.id, teamId: team.id, userId: user.id };
};

// ---------------------------------------------------------------------------
// TC-I-04: happy path — 5 sessions × 3 days × 1 team, all evaluated
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamOutcomes — TC-I-04 (happy)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-04: 5 sessions × 3 days × 1 team — produces 3 daily rows with summed metrics', async () => {
    const { orgId, teamId, userId } = await seedOrgWithTeam('OrgA', 'TeamA');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
      const day = dayBefore(today, dayOffset);
      for (let i = 0; i < 5; i += 1) {
        await insertSessionAndOutcome({
          userId,
          sessionId: `sess-d${dayOffset}-i${i}`,
          startedAt: new Date(day.getTime() + i * 60_000),
          totalCostUsd: 0.5,
          commitCount: 2,
          locAdded: 30,
          locRemoved: 10,
          filesChanged: 4,
          revertsWithin7d: 0,
          mergedPrCount: 1,
          outcomeStatus: 'evaluated',
        });
      }
    }

    const result = await aggregateTeamOutcomes(getDb());
    expect(result.status).toBe('ok');

    const db = getDb();
    const rows = await db
      .select({
        day: teamOutcomesDaily.day,
        totalCommits: teamOutcomesDaily.totalCommits,
        totalLocAdded: teamOutcomesDaily.totalLocAdded,
        totalMergedPrCount: teamOutcomesDaily.totalMergedPrCount,
        sessionsWithOutcome: teamOutcomesDaily.sessionsWithOutcome,
      })
      .from(teamOutcomesDaily)
      .where(sql`${teamOutcomesDaily.orgId} = ${orgId} AND ${teamOutcomesDaily.teamId} = ${teamId}`);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.totalCommits).toBe(10); // 5 sessions × commit_count=2
      expect(r.totalLocAdded).toBe(150); // 5 × 30
      expect(r.totalMergedPrCount).toBe(5); // 5 × 1
      expect(r.sessionsWithOutcome).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// TC-I-04b: infra failure — DB stub throws on aggregation INSERT
// ---------------------------------------------------------------------------

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

skipDescribe('aggregateTeamOutcomes — TC-I-04b (infra: DB error path)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-04b: when the aggregation INSERT throws, cron_runs row is updated to status=failed with error_message', async () => {
    const db = getDb();
    let aggExecuteCount = 0;
    const stub: StubDb = {
      insert: (table) => db.insert(table as never) as never,
      update: (table) => db.update(table as never) as never,
      execute: async (q) => {
        // First execute is the org-probe query; let it through.
        // Second execute is the aggregation INSERT; throw.
        aggExecuteCount += 1;
        if (aggExecuteCount === 2) {
          throw new Error('simulated outcome aggregation failure');
        }
        return db.execute(q as never);
      },
    };

    const result = await aggregateTeamOutcomes(stub as never);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('simulated outcome aggregation failure');

    const runs = await db
      .select({
        status: cronRuns.status,
        errorMessage: cronRuns.errorMessage,
        finishedAt: cronRuns.finishedAt,
      })
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'aggregate-team-outcomes'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).toContain('simulated outcome aggregation failure');
    expect(runs[0].finishedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TC-I-05: edge — non-evaluated sessions excluded; 0 evaluated → 0 rows
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamOutcomes — TC-I-05 (edge: non-evaluated excluded)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-05: outcome_status != "evaluated" rows excluded; 0 evaluated → 0 rollup rows', async () => {
    const { userId } = await seedOrgWithTeam('OrgA', 'TeamA');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    // Seed 3 sessions, all non-evaluated. Cron must not produce any rows.
    for (const [i, status] of (
      ['cwd-missing', 'not-a-git-repo', 'no-user-email'] as const
    ).entries()) {
      await insertSessionAndOutcome({
        userId,
        sessionId: `sess-skipped-${i}`,
        startedAt: today,
        totalCostUsd: 0,
        commitCount: 0,
        locAdded: 0,
        locRemoved: 0,
        filesChanged: 0,
        revertsWithin7d: 0,
        mergedPrCount: null,
        outcomeStatus: status,
      });
    }

    const result = await aggregateTeamOutcomes(getDb());
    expect(result.status).toBe('ok');

    const db = getDb();
    const rows = await db.select().from(teamOutcomesDaily);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TC-I-06: per-org probe — org A has data, org B doesn't
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamOutcomes — TC-I-06 (per-org probe)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-06: per-org probe processes only orgs with evaluated outcome data', async () => {
    const orgA = await seedOrgWithTeam('OrgA', 'TeamA');
    const orgB = await seedOrgWithTeam('OrgB', 'TeamB');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    // Only org A has any evaluated outcome data.
    await insertSessionAndOutcome({
      userId: orgA.userId,
      sessionId: 'sess-orgA',
      startedAt: today,
      totalCostUsd: 0.25,
      commitCount: 1,
      locAdded: 20,
      locRemoved: 5,
      filesChanged: 2,
      revertsWithin7d: 0,
      mergedPrCount: 0,
      outcomeStatus: 'evaluated',
    });

    const result = await aggregateTeamOutcomes(getDb());
    expect(result.status).toBe('ok');

    const db = getDb();
    const orgARows = await db
      .select()
      .from(teamOutcomesDaily)
      .where(sql`${teamOutcomesDaily.orgId} = ${orgA.orgId}`);
    expect(orgARows).toHaveLength(1);

    const orgBRows = await db
      .select()
      .from(teamOutcomesDaily)
      .where(sql`${teamOutcomesDaily.orgId} = ${orgB.orgId}`);
    expect(orgBRows).toHaveLength(0); // org B never appeared in rollup
  });
});

// ---------------------------------------------------------------------------
// TC-I-07: idempotency — running twice yields same rows, no duplicates
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamOutcomes — TC-I-07 (idempotency)', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('TC-I-07: two consecutive runs leave one row per (org, team, day) — ON CONFLICT DO UPDATE', async () => {
    const { orgId, teamId, userId } = await seedOrgWithTeam('OrgA', 'TeamA');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    await insertSessionAndOutcome({
      userId,
      sessionId: 'sess-idem',
      startedAt: today,
      totalCostUsd: 0.5,
      commitCount: 3,
      locAdded: 100,
      locRemoved: 25,
      filesChanged: 5,
      revertsWithin7d: 0,
      mergedPrCount: 1,
      outcomeStatus: 'evaluated',
    });

    const r1 = await aggregateTeamOutcomes(getDb());
    expect(r1.status).toBe('ok');
    const r2 = await aggregateTeamOutcomes(getDb());
    expect(r2.status).toBe('ok');

    const db = getDb();
    const rows = await db
      .select()
      .from(teamOutcomesDaily)
      .where(sql`${teamOutcomesDaily.orgId} = ${orgId} AND ${teamOutcomesDaily.teamId} = ${teamId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalCommits).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Bonus: total_merged_pr_count NULL preservation when ALL contributing
// rows had merged_pr_count = NULL (REQ-10 contract, REQ-11 cron impl).
// ---------------------------------------------------------------------------

skipDescribe('aggregateTeamOutcomes — total_merged_pr_count NULL preservation', () => {
  beforeEach(async () => {
    if (SKIP) return;
    await wipeAll();
  });

  it('total_merged_pr_count is NULL when all contributing sessions had merged_pr_count=NULL', async () => {
    const { userId } = await seedOrgWithTeam('OrgA', 'TeamA');
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      await insertSessionAndOutcome({
        userId,
        sessionId: `sess-no-pr-${i}`,
        startedAt: today,
        totalCostUsd: 0.1,
        commitCount: 1,
        locAdded: 10,
        locRemoved: 0,
        filesChanged: 1,
        revertsWithin7d: 0,
        mergedPrCount: null, // PR lookup off / all rate-limited
        outcomeStatus: 'evaluated',
      });
    }

    const result = await aggregateTeamOutcomes(getDb());
    expect(result.status).toBe('ok');

    const db = getDb();
    const rows = await db.select().from(teamOutcomesDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalMergedPrCount).toBeNull();
    expect(rows[0].totalCommits).toBe(3); // other metrics still summed
  });
});
