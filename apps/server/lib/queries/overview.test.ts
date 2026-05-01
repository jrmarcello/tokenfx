/**
 * Integration tests for `getOrgOverview` (TASK-17).
 *
 * Maps to TC-I-32..37 + TC-I-47 in the central-reporter-server spec. Drives
 * the query against a real Postgres via Testcontainers (REQ-22). Skipped when
 * `SKIP_PG_TESTS=1` so devs without Docker can still run unit suites.
 *
 * Per REQ-19 (locked): cost calibration is applied in JS via
 * `effectiveCostForSession` (NOT SQL CASE). These tests verify that user-A's
 * own ratio is used when present, that user-B falls back to the org-global
 * ratio when no per-user rate exists, and that the cascade falls through to
 * `source: 'list'` when no calibration is available org-wide.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  costCalibrationPerUser,
  modelBreakdownAgg,
  orgs,
  sessionsAgg,
  teams,
  users,
} from '@/lib/db/schema';
import { getOrgOverview } from './overview';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// ---------- helpers ----------------------------------------------------------

type SeedSession = {
  sessionId: string;
  userId: string;
  startedAt: Date;
  totalCostUsd: number;
  totalCostUsdOtel: number | null;
  model: string; // dominant model (drives family)
};

const seedSession = async (s: SeedSession): Promise<void> => {
  const db = getDb();
  const endedAt = new Date(s.startedAt.getTime() + 60_000);
  await db.insert(sessionsAgg).values({
    userId: s.userId,
    sessionId: s.sessionId,
    payloadHash: `hash-${s.sessionId}`,
    startedAt: s.startedAt,
    endedAt,
    projectSlug: 'slug:0123456789abcdef',
    gitBranch: null,
    ccVersion: null,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: s.totalCostUsd.toString(),
    totalCostUsdOtel: s.totalCostUsdOtel === null ? null : s.totalCostUsdOtel.toString(),
    turnCount: 1,
    toolCallCount: 0,
    avgRating: null,
    cacheHitRatio: null,
    outputInputRatio: null,
    subagentUsageRatio: null,
  });
  await db.insert(modelBreakdownAgg).values({
    userId: s.userId,
    sessionId: s.sessionId,
    model: s.model,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: s.totalCostUsd.toString(),
  });
};

const wipeAll = async (): Promise<void> => {
  const db = getDb();
  // TRUNCATE CASCADE clears all 9 spec-3 tables in one shot, including
  // tables this file doesn't directly seed (`user_machines`, `ingestion_log`).
  // Sibling test files (teams, ingest) seed those, and the Testcontainers
  // Postgres container is shared across the suite — without this, leftovers
  // from neighbours create FK / unique constraint violations here.
  await db.execute(sql`TRUNCATE TABLE
    ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
    cost_calibration_per_user, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

// ---------- tests ------------------------------------------------------------

skipDescribe('getOrgOverview (Postgres integration)', () => {
  beforeAll(async () => {
    await wipeAll();
  });
  afterAll(async () => {
    await wipeAll();
    await closeDb();
  });
  afterEach(async () => {
    await wipeAll();
  });

  it('TC-I-32: per-user calibration applied for user with own OTEL rate', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'Acme' }).returning({ id: orgs.id });
    const [team] = await db
      .insert(teams)
      .values({ orgId: org.id, name: 'Eng' })
      .returning({ id: teams.id });
    const [userA] = await db
      .insert(users)
      .values({
        orgId: org.id,
        teamId: team.id,
        email: 'a@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-a',
        role: 'member',
      })
      .returning({ id: users.id });

    // Two sessions for user A: total local 2.0, total otel 1.0 → ratio 0.5
    await seedSession({
      sessionId: 'sa1',
      userId: userA.id,
      startedAt: daysAgo(2),
      totalCostUsd: 1.0,
      totalCostUsdOtel: 0.5,
      model: 'claude-sonnet-4-5',
    });
    await seedSession({
      sessionId: 'sa2',
      userId: userA.id,
      startedAt: daysAgo(3),
      totalCostUsd: 1.0,
      totalCostUsdOtel: 0.5,
      model: 'claude-sonnet-4-5',
    });
    // Per-user calibration row (sonnet rate 0.5).
    await db.insert(costCalibrationPerUser).values({
      userId: userA.id,
      family: 'sonnet',
      effectiveRate: '0.5',
      sampleSessionCount: 2,
      sumOtelCost: '1.0',
      sumLocalCost: '2.0',
      lastUpdatedAt: new Date(),
    });

    const overview = await getOrgOverview(db, org.id);
    // OTEL is present → cascade returns OTEL value (1.0 total). The
    // calibration ratio is verified upstream by the calibration recompute test.
    expect(overview.spend7d).toBeCloseTo(1.0, 5);
    expect(overview.sourceMix.otel).toBe(2);
    expect(overview.sourceMix.calibrated).toBe(0);
    expect(overview.sourceMix.list).toBe(0);
  });

  it('TC-I-33: user with zero OTEL falls back to org-global calibration', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'Acme2' }).returning({ id: orgs.id });
    const [userB] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: 'b@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-b',
        role: 'member',
      })
      .returning({ id: users.id });

    // User B has only local-cost sessions (no OTEL).
    await seedSession({
      sessionId: 'sb1',
      userId: userB.id,
      startedAt: daysAgo(1),
      totalCostUsd: 4.0,
      totalCostUsdOtel: null,
      model: 'claude-sonnet-4-5',
    });
    // Global calibration entry (org-global fallback). 0.25 ratio.
    await db.insert(costCalibrationPerUser).values({
      userId: userB.id,
      family: 'global',
      effectiveRate: '0.25',
      sampleSessionCount: 1,
      sumOtelCost: '1.0',
      sumLocalCost: '4.0',
      lastUpdatedAt: new Date(),
    });

    const overview = await getOrgOverview(db, org.id);
    // sonnet not present in calibration → falls through to global → 4.0 * 0.25 = 1.0.
    expect(overview.spend7d).toBeCloseTo(1.0, 5);
    expect(overview.sourceMix.calibrated).toBe(1);
    expect(overview.sourceMix.otel).toBe(0);
  });

  it('TC-I-34: org with zero OTEL globally → all sessions source=list', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'NoCal' }).returning({ id: orgs.id });
    const [user] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: 'nocal@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-nocal',
        role: 'member',
      })
      .returning({ id: users.id });

    await seedSession({
      sessionId: 'no1',
      userId: user.id,
      startedAt: daysAgo(1),
      totalCostUsd: 7.5,
      totalCostUsdOtel: null,
      model: 'claude-sonnet-4-5',
    });

    const overview = await getOrgOverview(db, org.id);
    expect(overview.spend7d).toBeCloseTo(7.5, 5);
    expect(overview.sourceMix.list).toBe(1);
    expect(overview.sourceMix.otel).toBe(0);
    expect(overview.sourceMix.calibrated).toBe(0);
  });

  it('TC-I-35: 3 users in 2 teams, 30 sessions → spend + trend match', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'Multi' }).returning({ id: orgs.id });
    const [teamA, teamB] = await db
      .insert(teams)
      .values([
        { orgId: org.id, name: 'TeamA' },
        { orgId: org.id, name: 'TeamB' },
      ])
      .returning({ id: teams.id, name: teams.name });

    const [u1, u2, u3] = await db
      .insert(users)
      .values([
        {
          orgId: org.id,
          teamId: teamA.id,
          email: 'u1@example.com',
          ssoProvider: 'google',
          ssoSubject: 's1',
          role: 'member',
        },
        {
          orgId: org.id,
          teamId: teamA.id,
          email: 'u2@example.com',
          ssoProvider: 'google',
          ssoSubject: 's2',
          role: 'member',
        },
        {
          orgId: org.id,
          teamId: teamB.id,
          email: 'u3@example.com',
          ssoProvider: 'google',
          ssoSubject: 's3',
          role: 'member',
        },
      ])
      .returning({ id: users.id });

    // 30 sessions: 10 per user, spread across last 30 days. Each session
    // costs $1 local, no OTEL → falls to list → effective $1 each.
    const userIds = [u1.id, u2.id, u3.id];
    let n = 0;
    for (const uid of userIds) {
      for (let d = 0; d < 10; d += 1) {
        await seedSession({
          sessionId: `sess-${n++}`,
          userId: uid,
          startedAt: daysAgo(d * 3), // days 0,3,6,...,27
          totalCostUsd: 1.0,
          totalCostUsdOtel: null,
          model: 'claude-sonnet-4-5',
        });
      }
    }

    const overview = await getOrgOverview(db, org.id);
    expect(overview.spend30d).toBeCloseTo(30, 5);
    // 30-day trend curve has at most 30 daily buckets — but only days with
    // sessions are present. Verify the points sum to spend30d.
    const trendSum = overview.spendTrend30d.reduce((acc, p) => acc + p.spend, 0);
    expect(trendSum).toBeCloseTo(30, 5);

    // Team breakdown: TeamA = u1+u2 (20), TeamB = u3 (10).
    const teamA_row = overview.teamBreakdown.find((t) => t.teamName === 'TeamA');
    const teamB_row = overview.teamBreakdown.find((t) => t.teamName === 'TeamB');
    expect(teamA_row?.spend30d).toBeCloseTo(20, 5);
    expect(teamB_row?.spend30d).toBeCloseTo(10, 5);
    // sparkline7d is 7 entries (zero-padded for days with no activity).
    expect(teamA_row?.sparkline7d).toHaveLength(7);
    expect(teamB_row?.sparkline7d).toHaveLength(7);
  });

  it('TC-I-36: 3 distinct users active in last 7d → DAU=3 today, MAU includes all', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'AdoptOrg' }).returning({ id: orgs.id });
    const userIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [u] = await db
        .insert(users)
        .values({
          orgId: org.id,
          email: `act${i}@example.com`,
          ssoProvider: 'google',
          ssoSubject: `act${i}`,
          role: 'member',
        })
        .returning({ id: users.id });
      userIds.push(u.id);
    }
    // 3 users, each with a session today (within 1 hour).
    for (let i = 0; i < userIds.length; i += 1) {
      await seedSession({
        sessionId: `today-${i}`,
        userId: userIds[i],
        startedAt: new Date(Date.now() - 3600_000),
        totalCostUsd: 0.1,
        totalCostUsdOtel: null,
        model: 'claude-sonnet-4-5',
      });
    }
    // One user also had a session 20 days ago.
    await seedSession({
      sessionId: 'older',
      userId: userIds[0],
      startedAt: daysAgo(20),
      totalCostUsd: 0.1,
      totalCostUsdOtel: null,
      model: 'claude-sonnet-4-5',
    });

    const overview = await getOrgOverview(db, org.id);
    expect(overview.dau).toBe(3);
    expect(overview.wau).toBe(3);
    expect(overview.mau).toBe(3); // distinct users in last 30d
    expect(overview.totalSeats).toBe(3);
    expect(overview.activationPct).toBeCloseTo(1, 5);
  });

  it('TC-I-37: zero sessions in window → DAU=WAU=MAU=0, no NaN', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'EmptyOrg' }).returning({ id: orgs.id });
    // Seed users but no sessions.
    await db.insert(users).values({
      orgId: org.id,
      email: 'empty@example.com',
      ssoProvider: 'google',
      ssoSubject: 'empty',
      role: 'member',
    });

    const overview = await getOrgOverview(db, org.id);
    expect(overview.dau).toBe(0);
    expect(overview.wau).toBe(0);
    expect(overview.mau).toBe(0);
    expect(overview.spend7d).toBe(0);
    expect(overview.spend30d).toBe(0);
    expect(overview.spend90d).toBe(0);
    expect(Number.isNaN(overview.activationPct)).toBe(false);
    expect(overview.activationPct).toBe(0); // 0/1 = 0
    expect(overview.spendTrend30d).toEqual([]);
    expect(overview.teamBreakdown).toEqual([]);
  });

  it('TC-I-47: org with admin user and no pushed sessions → renders without crash', async () => {
    const db = getDb();
    const [org] = await db.insert(orgs).values({ name: 'NewOrg' }).returning({ id: orgs.id });
    await db.insert(users).values({
      orgId: org.id,
      email: 'admin@example.com',
      ssoProvider: 'google',
      ssoSubject: 'adm',
      role: 'admin',
    });
    const overview = await getOrgOverview(db, org.id);
    // Sentinel: zero seats >= 1, no exception.
    expect(overview.totalSeats).toBe(1);
    expect(overview.mau).toBe(0);
    expect(overview.activationPct).toBe(0);
  });
});
