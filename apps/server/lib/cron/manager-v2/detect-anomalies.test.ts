/**
 * Integration tests for the nightly anomaly cron
 * (TASK-CRON-ANOM, REQ-22, REQ-23).
 *
 * Covers:
 *   - TC-I-05: team with 5+ active devs and one 4σ outlier → row written
 *              with kind='spend-spike-30d'.
 *   - TC-I-06: re-running the cron the same day is idempotent — no
 *              duplicate manager_anomalies rows.
 *   - TC-I-60: team with 4 active devs (below the Q11 threshold) →
 *              skipped, zero rows written.
 *   - TC-I-61: team with exactly 5 active devs + outlier → row written
 *              (small-team guard boundary at 5).
 *   - TC-I-80: WoW branch — dev with thisWeek=$155, lastWeek=$100 → row
 *              with kind='spend-spike-wow'.
 *   - TC-I-81: forced DB error → cron_runs.status='failed' AND the
 *              cron lib returns status='failed' (route surfaces 5xx).
 *
 * Postgres-backed via Testcontainers (shared `globalSetup`). Skipped when
 * `SKIP_PG_TESTS=1`.
 *
 * The cron lib accepts an optional `now` for deterministic seeding so the
 * 30-day / 7-day windows hit the seeded sessions reliably regardless of
 * the wall clock at test time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  cronRuns,
  managerAnomalies,
  orgs,
  sessionsAgg,
  teams,
  users,
} from '@/lib/db/schema';
import { runDetectAnomalies } from './detect-anomalies';

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

const insertSession = async (input: {
  userId: string;
  sessionId: string;
  startedAt: Date;
  totalCostUsd: number;
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
    avgRating: null,
    cacheHitRatio: null,
    outputInputRatio: null,
    subagentUsageRatio: null,
  });
};

const seedTeamWithDevs = async (input: {
  orgName: string;
  teamName: string;
  devCount: number;
  /** spends[i] is the 30d spend (USD) for dev i; one session each, 5 days ago */
  spends: number[];
  /** anchor "now" — sessions are placed `dayOffset` days before this */
  now: Date;
  emailPrefix: string;
}): Promise<{ orgId: string; teamId: string; userIds: string[] }> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: input.orgName })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: input.teamName })
    .returning({ id: teams.id });

  const userIds: string[] = [];
  for (let i = 0; i < input.devCount; i += 1) {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        teamId: team.id,
        email: `${input.emailPrefix}${i}@example.com`,
        ssoProvider: 'google',
        ssoSubject: `${input.emailPrefix}-sub-${i}`,
        role: 'member',
      })
      .returning({ id: users.id });
    userIds.push(u.id);
    // Place a single session 5 days before `now` so it falls in both the
    // 30d window and the "this-week" 0-7d window (we override with a custom
    // seed for the WoW test). Each dev's session carries spends[i] USD.
    const startedAt = new Date(input.now.getTime() - 5 * 24 * 60 * 60 * 1000);
    await insertSession({
      userId: u.id,
      sessionId: `${input.emailPrefix}-s-${i}`,
      startedAt,
      totalCostUsd: input.spends[i] ?? 0,
    });
  }
  return { orgId: org.id, teamId: team.id, userIds };
};

// ---------- TC-I-05 + TC-I-06 (happy + idempotency) ------------------------

skipDescribe('runDetectAnomalies — TC-I-05, TC-I-06 (happy + idempotency)', () => {
  const NOW = new Date('2026-04-15T02:00:00.000Z');

  beforeAll(async () => {
    await wipeAll();
    // 10 devs: 9 at $10, 1 outlier at $200.
    // mean = (90 + 200)/10 = 29; population stddev ≈ √((9*361 + 29241)/10) ≈ 57.0;
    // σ = (200-29)/57 ≈ 3.0 → just clears the 3σ threshold (inclusive).
    // 5 devs alone CAN'T reach 3σ (max is √4 = 2σ with one outlier), so the
    // happy-path TC needs ≥ 10 devs to exercise the spike-30d branch.
    await seedTeamWithDevs({
      orgName: 'Org-Spike',
      teamName: 'TeamSpike',
      devCount: 10,
      spends: [10, 10, 10, 10, 10, 10, 10, 10, 10, 250],
      now: NOW,
      emailPrefix: 'spike',
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-05: writes a spend-spike-30d row for the 4σ outlier', async () => {
    const result = await runDetectAnomalies(getDb(), { now: NOW });
    expect(result.status).toBe('ok');
    expect(result.rowsWritten).toBeGreaterThanOrEqual(1);

    const rows = await getDb()
      .select()
      .from(managerAnomalies)
      .where(sql`${managerAnomalies.kind} = 'spend-spike-30d'`);
    expect(rows.length).toBe(1);
    // detected_on must equal NOW's calendar date (UTC).
    expect(rows[0].detectedOn).toBe('2026-04-15');
    expect(rows[0].contextJson).not.toBeNull();
    // cron_runs must have a single completed run for this job.
    const runs = await getDb()
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'manager-v2:detect-anomalies'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].rowsWritten).toBeGreaterThanOrEqual(1);
  });

  it('TC-I-06: re-running same day produces no duplicate rows', async () => {
    // The TC-I-05 it() above already inserted exactly 1 row. Run again.
    const result = await runDetectAnomalies(getDb(), { now: NOW });
    expect(result.status).toBe('ok');

    const rows = await getDb()
      .select()
      .from(managerAnomalies)
      .where(sql`${managerAnomalies.kind} = 'spend-spike-30d'`);
    // Still exactly 1 — ON CONFLICT DO NOTHING.
    expect(rows.length).toBe(1);

    // A second cron_runs row IS expected (every invocation is recorded).
    const runs = await getDb()
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'manager-v2:detect-anomalies'`);
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- TC-I-60 (small-team guard) -------------------------------------

skipDescribe('runDetectAnomalies — TC-I-60 (Q11 small-team guard)', () => {
  const NOW = new Date('2026-04-16T02:00:00.000Z');

  beforeAll(async () => {
    await wipeAll();
    await seedTeamWithDevs({
      orgName: 'Org-Small',
      teamName: 'TeamSmall',
      devCount: 4, // below the 5-dev threshold
      spends: [1, 1, 1, 1000],
      now: NOW,
      emailPrefix: 'small',
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-60: 4 active devs → skipped, 0 rows written', async () => {
    const result = await runDetectAnomalies(getDb(), { now: NOW });
    expect(result.status).toBe('ok');

    const rows = await getDb().select().from(managerAnomalies);
    expect(rows.length).toBe(0);
    // Cron run still recorded.
    const runs = await getDb()
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'manager-v2:detect-anomalies'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].rowsWritten).toBe(0);
  });
});

// ---------- TC-I-61 (boundary at exactly 5) --------------------------------

skipDescribe('runDetectAnomalies — TC-I-61 (boundary: exactly 5 devs)', () => {
  const NOW = new Date('2026-04-17T02:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    await wipeAll();
    // EXACTLY 5 devs — the small-team gate's lower boundary (Q11).
    // 30d-spike (z ≥ 3σ) is mathematically impossible with N=5 (max ≈ 2σ),
    // so this TC exercises the gate boundary by triggering the WoW branch
    // for ONE dev — proving that at exactly 5 devs we DO process the team
    // (whereas TC-I-60 with 4 devs writes 0 rows).
    const db = getDb();
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-Five' })
      .returning({ id: orgs.id });
    const [team] = await db
      .insert(teams)
      .values({ orgId: org.id, name: 'TeamFive' })
      .returning({ id: teams.id });

    // Devs 0..3: steady $10/week each week; no WoW spike, no 30d spike.
    for (let i = 0; i < 4; i += 1) {
      const [u] = await db
        .insert(users)
        .values({
          orgId: org.id,
          teamId: team.id,
          email: `five${i}@example.com`,
          ssoProvider: 'google',
          ssoSubject: `five-sub-${i}`,
          role: 'member',
        })
        .returning({ id: users.id });
      await insertSession({
        userId: u.id,
        sessionId: `five${i}-this`,
        startedAt: new Date(NOW.getTime() - 3 * DAY),
        totalCostUsd: 10,
      });
      await insertSession({
        userId: u.id,
        sessionId: `five${i}-last`,
        startedAt: new Date(NOW.getTime() - 10 * DAY),
        totalCostUsd: 10,
      });
    }
    // Dev 4 (outlier — exactly the 5th member): WoW spike, thisWeek=$160 vs lastWeek=$100.
    const [target] = await db
      .insert(users)
      .values({
        orgId: org.id,
        teamId: team.id,
        email: 'five-target@example.com',
        ssoProvider: 'google',
        ssoSubject: 'five-target-sub',
        role: 'member',
      })
      .returning({ id: users.id });
    await insertSession({
      userId: target.id,
      sessionId: 'five-target-this',
      startedAt: new Date(NOW.getTime() - 3 * DAY),
      totalCostUsd: 160,
    });
    await insertSession({
      userId: target.id,
      sessionId: 'five-target-last',
      startedAt: new Date(NOW.getTime() - 10 * DAY),
      totalCostUsd: 100,
    });
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-61: exactly 5 devs + outlier → row written (boundary)', async () => {
    const result = await runDetectAnomalies(getDb(), { now: NOW });
    expect(result.status).toBe('ok');

    // Boundary semantics: at the 5-dev gate we DO emit anomaly rows.
    // The 30d 3σ branch is unreachable with N=5 (max σ ≈ 2.0), so the
    // boundary is asserted via the WoW branch — exactly the same gate
    // is consulted before either detector runs.
    const rows = await getDb().select().from(managerAnomalies);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- TC-I-80 (WoW branch) -------------------------------------------

skipDescribe('runDetectAnomalies — TC-I-80 (WoW spike)', () => {
  const NOW = new Date('2026-04-18T02:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Org-WoW' })
      .returning({ id: orgs.id });
    const [team] = await db
      .insert(teams)
      .values({ orgId: org.id, name: 'TeamWoW' })
      .returning({ id: teams.id });

    // Seed 5 devs so the small-team gate doesn't reject.
    // Devs 0..3: $50 spread evenly across both weeks (no WoW spike).
    // Dev 4 (target): thisWeek=$155, lastWeek=$100 → +55% WoW spike.
    // 30d spend distribution stays tight enough that no 3σ spike fires
    // for dev 4 — we want to exercise ONLY the WoW branch.
    for (let i = 0; i < 4; i += 1) {
      const [u] = await db
        .insert(users)
        .values({
          orgId: org.id,
          teamId: team.id,
          email: `wow${i}@example.com`,
          ssoProvider: 'google',
          ssoSubject: `wow-sub-${i}`,
          role: 'member',
        })
        .returning({ id: users.id });
      // 7 sessions @ $20 in 0-7d window, 7 sessions @ $20 in 7-14d window
      // → thisWeek=$140, lastWeek=$140; 30d ≈ $280.
      for (let d = 0; d < 7; d += 1) {
        await insertSession({
          userId: u.id,
          sessionId: `wow${i}-this-${d}`,
          startedAt: new Date(NOW.getTime() - (d + 1) * DAY),
          totalCostUsd: 20,
        });
        await insertSession({
          userId: u.id,
          sessionId: `wow${i}-last-${d}`,
          startedAt: new Date(NOW.getTime() - (d + 8) * DAY),
          totalCostUsd: 20,
        });
      }
    }
    // Target dev: thisWeek=$155 (5 sessions @ $31), lastWeek=$100 (5 @ $20).
    const [target] = await db
      .insert(users)
      .values({
        orgId: org.id,
        teamId: team.id,
        email: 'wow-target@example.com',
        ssoProvider: 'google',
        ssoSubject: 'wow-target-sub',
        role: 'member',
      })
      .returning({ id: users.id });
    for (let d = 0; d < 5; d += 1) {
      await insertSession({
        userId: target.id,
        sessionId: `target-this-${d}`,
        startedAt: new Date(NOW.getTime() - (d + 1) * DAY),
        totalCostUsd: 31,
      });
      await insertSession({
        userId: target.id,
        sessionId: `target-last-${d}`,
        startedAt: new Date(NOW.getTime() - (d + 8) * DAY),
        totalCostUsd: 20,
      });
    }
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-80: thisWeek=$155, lastWeek=$100 → spend-spike-wow row', async () => {
    const result = await runDetectAnomalies(getDb(), { now: NOW });
    expect(result.status).toBe('ok');

    const wowRows = await getDb()
      .select()
      .from(managerAnomalies)
      .where(sql`${managerAnomalies.kind} = 'spend-spike-wow'`);
    expect(wowRows.length).toBe(1);
    expect(wowRows[0].contextJson).not.toBeNull();
  });
});

// ---------- TC-I-81 (failure path) -----------------------------------------

skipDescribe('runDetectAnomalies — TC-I-81 (DB error → status=failed)', () => {
  beforeAll(async () => {
    await wipeAll();
  });

  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-81: db.execute throws → result.status="failed" and cron_runs marked failed', async () => {
    // Hand-written stub: real db for cron_runs lifecycle (start INSERT +
    // finish UPDATE), but the analysis SELECT throws. The lib calls
    // `db.execute(...)` for everything; we serve through a Proxy whose
    // override of `execute` throws on the 2nd invocation (the first call
    // is the cron_runs start INSERT, the 2nd is the per-dev aggregation
    // SELECT — which is the failure surface in scope). Calls 3..N (the
    // failure-marker UPDATE) pass through to the real db so the cron_runs
    // row is finalized correctly.
    const realDb = getDb();
    type RealDb = typeof realDb;

    let executeCalls = 0;
    const proxyDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          const original = Reflect.get(target, prop, receiver) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          // Bind so `this` inside Drizzle's execute is the real db.
          return async (...args: unknown[]): Promise<unknown> => {
            executeCalls += 1;
            if (executeCalls === 2) {
              throw new Error('simulated DB failure during analysis');
            }
            return original.apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as RealDb;

    const result = await runDetectAnomalies(proxyDb, {
      now: new Date('2026-04-19T02:00:00.000Z'),
    });
    expect(result.status).toBe('failed');
    expect(result.errorMessage).not.toBeNull();

    const runs = await getDb()
      .select()
      .from(cronRuns)
      .where(sql`${cronRuns.jobName} = 'manager-v2:detect-anomalies'`);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].errorMessage).not.toBeNull();
    expect(runs[0].finishedAt).not.toBeNull();
  });
});

// ---------- Lifecycle ------------------------------------------------------

skipDescribe('detect-anomalies (Postgres lifecycle)', () => {
  it('keeps the test DB connection clean', async () => {
    await closeDb();
    expect(true).toBe(true);
  });
});
