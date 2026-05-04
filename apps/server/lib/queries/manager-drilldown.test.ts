/**
 * Integration tests for `manager-drilldown` queries — TASK-QUERIES-DRILLDOWN
 * of `.specs/manager-dashboard-v2.md`.
 *
 * Scope: dev-level queries gated by a TYPE-LEVEL `audit: AuditContext`
 * parameter. Calling these functions without an audit context is a
 * TypeScript compile error (anti-surveillance principle 1 of the spec
 * Design — "Aggregated by default. Individual data is opt-in for the
 * manager and gated by reason + audit + notification."). The audit
 * parameter does NOT change query behavior — the route is responsible
 * for `writeAudit(tx, audit)` BEFORE calling these queries (atomically
 * in the same transaction). The audit param is simply a compile-time
 * gate to prevent callers from forgetting the audit step.
 *
 * Cross-team / cross-org enforcement is the ROUTE's responsibility (not
 * this lib). This module faithfully returns data for any user id passed
 * in (TC-I-28: lib does NOT enforce cross-team gate — route is the gate).
 *
 * Postgres-backed via the shared Testcontainers setup
 * (`tests/integration/setup-pg.ts`). Skipped when `SKIP_PG_TESTS=1`.
 *
 * TC mapping (per spec Test Plan):
 *   - TC-I-26: TS compile-time enforcement — calling without an audit
 *     context is a TypeScript error (assertion via `// @ts-expect-error`).
 *   - TC-I-28: Lib does NOT enforce cross-team gate — query returns data
 *     for any user when audit ctx is passed. (Route is gate.)
 *   - TC-I-29 (happy spendDetail): seeded sessions for a user → spend
 *     aggregation correct (30d total, 7d total, daily trend).
 *   - TC-I-30 (happy sessionList): 5 seeded sessions → list contains all
 *     5 in date-DESC order.
 *   - TC-I-31 (happy toolUsage): seeded tool counts → bucketized to the
 *     5-element shape (Edit/Read/Bash/Agent/Other) — Task and Agent both
 *     map to the Agent bucket.
 *   - TC-I-32 (empty data): spendDetail returns null for a user with no
 *     sessions (locked contract); session list returns []; tool usage
 *     returns all zeros.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  modelBreakdownAgg,
  orgs,
  sessionsAgg,
  teams,
  toolCountAgg,
  users,
} from '@/lib/db/schema';
import type { AuditContext } from '@/lib/audit/drilldown-audit';
import {
  getDevSessionList,
  getDevSpendDetail,
  getDevToolUsage,
} from './manager-drilldown';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type Seeded = {
  orgId: string;
  teamId: string;
  managerId: string;
  devId: string;
  emptyDevId: string;
};

const seedFixtures = async (): Promise<Seeded> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'DrilldownOrg' })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'DrilldownTeam' })
    .returning({ id: teams.id });
  const [manager] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'mgr@drilldown.example',
      displayName: 'Manager Person',
      ssoProvider: null,
      ssoSubject: null,
      role: 'manager',
    })
    .returning({ id: users.id });
  const [dev] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'dev@drilldown.example',
      displayName: 'Dev Person',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  const [emptyDev] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'empty@drilldown.example',
      displayName: null,
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return {
    orgId: org.id,
    teamId: team.id,
    managerId: manager.id,
    devId: dev.id,
    emptyDevId: emptyDev.id,
  };
};

const insertSession = async (params: {
  userId: string;
  sessionId: string;
  startedAt: Date;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitRatio?: number | null;
  manualRating?: number | null;
  toolCounts?: ReadonlyArray<{ toolName: string; count: number }>;
}): Promise<void> => {
  const db = getDb();
  await db.insert(sessionsAgg).values({
    userId: params.userId,
    sessionId: params.sessionId,
    payloadHash: `hash-${params.sessionId}`,
    startedAt: params.startedAt,
    endedAt: new Date(params.startedAt.getTime() + 60_000),
    projectSlug: 'slug:drilldown',
    gitBranch: null,
    ccVersion: null,
    totalInputTokens: params.inputTokens ?? 1000,
    totalOutputTokens: params.outputTokens ?? 500,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: params.costUsd.toFixed(6),
    totalCostUsdOtel: null,
    turnCount: 1,
    toolCallCount: 0,
    avgRating: params.manualRating == null ? null : params.manualRating.toFixed(3),
    cacheHitRatio: params.cacheHitRatio == null ? null : params.cacheHitRatio.toFixed(3),
    outputInputRatio: null,
    subagentUsageRatio: null,
  });
  await db.insert(modelBreakdownAgg).values({
    userId: params.userId,
    sessionId: params.sessionId,
    model: 'claude-sonnet-4-5',
    inputTokens: params.inputTokens ?? 1000,
    outputTokens: params.outputTokens ?? 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: params.costUsd.toFixed(6),
  });
  for (const t of params.toolCounts ?? []) {
    await db.insert(toolCountAgg).values({
      userId: params.userId,
      sessionId: params.sessionId,
      toolName: t.toolName,
      count: t.count,
    });
  }
};

const baseAudit = (s: Seeded, overrides: Partial<AuditContext> = {}): AuditContext => ({
  orgId: s.orgId,
  managerUserId: s.managerId,
  targetUserId: s.devId,
  reason: 'training-check',
  reasonText: null,
  sourceRoute: '/manager/devs/[devId]',
  ipAddressTrunc: '203.0.113.0/24',
  viewedOn: '2026-04-30',
  ...overrides,
});

skipDescribe('manager-drilldown queries (Postgres integration)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    seeded = await seedFixtures();
  });

  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      tool_count_agg, model_breakdown_agg, sessions_agg,
      users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  // ---------------------------------------------------------------------
  // TC-I-26: TYPE-LEVEL ENFORCEMENT — calling without an AuditContext is
  // a TypeScript compile error. The `// @ts-expect-error` comment will
  // FAIL the build if the call is somehow allowed (i.e. the audit param
  // becomes optional). This is the load-bearing assertion of REQ-15
  // anti-surveillance principle 1: dev-level queries are gated at the
  // TYPE level, not just runtime.
  // ---------------------------------------------------------------------
  it('TC-I-26: type-level audit gate — omitting audit ctx is a TypeScript error', async () => {
    const db = getDb();

    // The bad-shape calls below are STATICALLY checked by `tsc` via the
    // `@ts-expect-error` comment: if the audit parameter ever becomes
    // optional, these comments report "Unused @ts-expect-error" and the
    // build fails. The calls are wrapped in an `if (false)` so they never
    // execute at runtime — runtime behavior of the wrong call shape is
    // not what TC-I-26 pins; the COMPILE-TIME behavior is.
    if ((false as boolean)) {
      // @ts-expect-error — audit context is REQUIRED at the type level.
      await getDevSpendDetail(db, { userId: seeded.devId, days: 30 });
      // @ts-expect-error — audit context is REQUIRED at the type level.
      await getDevSessionList(db, { userId: seeded.devId, days: 30 });
      // @ts-expect-error — audit context is REQUIRED at the type level.
      await getDevToolUsage(db, { userId: seeded.devId, days: 30 });
    }

    // Sanity: the same calls WITH audit ctx compile and run fine. If this
    // fails to compile, the @ts-expect-error above is hiding a real bug.
    const audit = baseAudit(seeded);
    await getDevSpendDetail(db, audit, { userId: seeded.devId, days: 30 });
    await getDevSessionList(db, audit, { userId: seeded.devId, days: 30 });
    await getDevToolUsage(db, audit, { userId: seeded.devId, days: 30 });
  });

  // ---------------------------------------------------------------------
  // TC-I-28: Lib does NOT enforce cross-team / cross-org gate — query
  // returns data for ANY user id when audit ctx is passed. The route is
  // the gate (per REQ-15 / Design §1). This locks the contract: a future
  // refactor that adds defensive-but-incomplete row-filtering at the
  // lib layer is a CHANGE, not a hardening — fail loudly.
  // ---------------------------------------------------------------------
  it('TC-I-28: lib returns data for any userId — cross-team gate is the route, not this lib', async () => {
    const db = getDb();
    // Seed a foreign org/team/dev — has no relation to seeded.managerId.
    const [foreignOrg] = await db
      .insert(orgs)
      .values({ name: 'ForeignDrilldownOrg' })
      .returning({ id: orgs.id });
    const [foreignTeam] = await db
      .insert(teams)
      .values({ orgId: foreignOrg.id, name: 'ForeignDrilldownTeam' })
      .returning({ id: teams.id });
    const [foreignDev] = await db
      .insert(users)
      .values({
        orgId: foreignOrg.id,
        teamId: foreignTeam.id,
        email: 'foreign-dev@drilldown.example',
        displayName: 'Foreign Person',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });

    await insertSession({
      userId: foreignDev.id,
      sessionId: 'foreign-sess-1',
      startedAt: new Date(Date.now() - ONE_DAY_MS),
      costUsd: 7.5,
    });

    // Audit ctx names manager from another org — lib does NOT validate this.
    const audit = baseAudit(seeded, { targetUserId: foreignDev.id });
    const detail = await getDevSpendDetail(db, audit, {
      userId: foreignDev.id,
      days: 30,
    });
    expect(detail).not.toBeNull();
    if (detail !== null) {
      expect(detail.userId).toBe(foreignDev.id);
      expect(detail.thirtyDaySpendUsd).toBeCloseTo(7.5, 5);
    }
  });

  // ---------------------------------------------------------------------
  // TC-I-29 — happy: getDevSpendDetail aggregates per-day spend correctly,
  // splits 30d / 7d totals, and orders the trend by day ASC.
  // ---------------------------------------------------------------------
  it('TC-I-29: getDevSpendDetail returns aggregated 30d / 7d spend + per-day trend', async () => {
    const db = getDb();
    const now = Date.now();

    // 3 sessions: 2 in last 7d (5 + 3 = 8), 1 outside 7d but within 30d (10).
    // Total 30d = 18.
    await insertSession({
      userId: seeded.devId,
      sessionId: 's-recent-1',
      startedAt: new Date(now - 1 * ONE_DAY_MS),
      costUsd: 5.0,
    });
    await insertSession({
      userId: seeded.devId,
      sessionId: 's-recent-2',
      startedAt: new Date(now - 3 * ONE_DAY_MS),
      costUsd: 3.0,
    });
    await insertSession({
      userId: seeded.devId,
      sessionId: 's-older',
      startedAt: new Date(now - 15 * ONE_DAY_MS),
      costUsd: 10.0,
    });

    // 1 session outside the 30d window — must NOT be counted.
    await insertSession({
      userId: seeded.devId,
      sessionId: 's-ancient',
      startedAt: new Date(now - 45 * ONE_DAY_MS),
      costUsd: 99.0,
    });

    const audit = baseAudit(seeded);
    const detail = await getDevSpendDetail(db, audit, {
      userId: seeded.devId,
      days: 30,
    });
    expect(detail).not.toBeNull();
    if (detail === null) return;

    expect(detail.userId).toBe(seeded.devId);
    expect(detail.email).toBe('dev@drilldown.example');
    expect(detail.displayLabel).toBe('Dev Person');
    expect(detail.thirtyDaySpendUsd).toBeCloseTo(18.0, 5);
    expect(detail.sevenDaySpendUsd).toBeCloseTo(8.0, 5);

    // Trend has at most 30 daily buckets, ASC by day, all numeric.
    expect(detail.trend.length).toBeGreaterThan(0);
    expect(detail.trend.length).toBeLessThanOrEqual(30);
    for (let i = 1; i < detail.trend.length; i += 1) {
      expect(
        detail.trend[i - 1].day.localeCompare(detail.trend[i].day),
      ).toBeLessThanOrEqual(0);
    }
    const trendTotal = detail.trend.reduce((acc, p) => acc + p.spendUsd, 0);
    expect(trendTotal).toBeCloseTo(18.0, 5);
  });

  it('TC-I-29: displayLabel falls back to email local-part when display_name is null', async () => {
    const db = getDb();
    await insertSession({
      userId: seeded.emptyDevId,
      sessionId: 'empty-display-1',
      startedAt: new Date(Date.now() - ONE_DAY_MS),
      costUsd: 1.0,
    });
    const audit = baseAudit(seeded, { targetUserId: seeded.emptyDevId });
    const detail = await getDevSpendDetail(db, audit, {
      userId: seeded.emptyDevId,
      days: 30,
    });
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.displayLabel).toBe('empty');
  });

  // ---------------------------------------------------------------------
  // TC-I-30 — happy: getDevSessionList returns all 5 sessions in
  // started_at DESC order with full per-session fields.
  // ---------------------------------------------------------------------
  it('TC-I-30: getDevSessionList returns 5 sessions in date-DESC order', async () => {
    const db = getDb();
    const now = Date.now();

    // Seed in non-monotonic insertion order so any ORDER BY bug surfaces.
    const insertOrder = [3, 1, 4, 0, 2];
    for (const offset of insertOrder) {
      await insertSession({
        userId: seeded.devId,
        sessionId: `sess-${offset}`,
        startedAt: new Date(now - offset * ONE_DAY_MS),
        costUsd: 1 + offset,
        inputTokens: 100 + offset * 10,
        outputTokens: 50 + offset * 5,
        cacheHitRatio: 0.5,
        manualRating: 0.5,
      });
    }

    const audit = baseAudit(seeded);
    const sessions = await getDevSessionList(db, audit, {
      userId: seeded.devId,
      days: 30,
    });
    expect(sessions).toHaveLength(5);

    // Verify date-DESC ordering (newest first).
    for (let i = 1; i < sessions.length; i += 1) {
      expect(
        sessions[i - 1].startedAt.localeCompare(sessions[i].startedAt),
      ).toBeGreaterThanOrEqual(0);
    }

    // Spot-check shape on the newest row.
    const newest = sessions[0];
    expect(newest.sessionId).toBe('sess-0');
    expect(newest.totalCostUsd).toBeCloseTo(1, 5);
    expect(newest.totalInputTokens).toBe(100);
    expect(newest.totalOutputTokens).toBe(50);
    expect(newest.cacheHitRatio).toBeCloseTo(0.5, 3);
    expect(newest.manualRating).toBeCloseTo(0.5, 3);
    expect(newest.endedAt).not.toBeNull();
  });

  it('TC-I-30: getDevSessionList honors `limit` parameter', async () => {
    const db = getDb();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await insertSession({
        userId: seeded.devId,
        sessionId: `lim-${i}`,
        startedAt: new Date(now - i * ONE_DAY_MS),
        costUsd: 1,
      });
    }
    const audit = baseAudit(seeded);
    const sessions = await getDevSessionList(db, audit, {
      userId: seeded.devId,
      days: 30,
      limit: 2,
    });
    expect(sessions).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // TC-I-31 — happy: getDevToolUsage rolls per-tool counts into the
  // closed 5-element bucket shape. `Task` and `Agent` both land in the
  // `Agent` bucket (tool was renamed Task → Agent without a schema bump
  // — both names appear in historical data).
  // ---------------------------------------------------------------------
  it('TC-I-31: getDevToolUsage bucketizes tool counts into the 5-element shape', async () => {
    const db = getDb();
    const now = Date.now();

    await insertSession({
      userId: seeded.devId,
      sessionId: 'tools-1',
      startedAt: new Date(now - 1 * ONE_DAY_MS),
      costUsd: 1,
      toolCounts: [
        { toolName: 'Edit', count: 3 },
        { toolName: 'Read', count: 5 },
        { toolName: 'Bash', count: 2 },
        { toolName: 'Task', count: 4 }, // legacy name → Agent bucket
        { toolName: 'Grep', count: 7 }, // unknown → Other bucket
      ],
    });
    await insertSession({
      userId: seeded.devId,
      sessionId: 'tools-2',
      startedAt: new Date(now - 2 * ONE_DAY_MS),
      costUsd: 1,
      toolCounts: [
        { toolName: 'Agent', count: 6 }, // current name → Agent bucket (4 + 6 = 10)
        { toolName: 'WebFetch', count: 1 }, // unknown → Other (7 + 1 = 8)
      ],
    });

    const audit = baseAudit(seeded);
    const usage = await getDevToolUsage(db, audit, {
      userId: seeded.devId,
      days: 30,
    });
    expect(usage).toEqual({
      Edit: 3,
      Read: 5,
      Bash: 2,
      Agent: 10, // 4 (Task) + 6 (Agent)
      Other: 8, // 7 (Grep) + 1 (WebFetch)
    });
  });

  // ---------------------------------------------------------------------
  // TC-I-32 — empty data contracts. spendDetail returns null (no
  // sessions); session list returns []; tool usage returns all zeros.
  // ---------------------------------------------------------------------
  it('TC-I-32: getDevSpendDetail returns null when the dev has no sessions', async () => {
    const db = getDb();
    const audit = baseAudit(seeded, { targetUserId: seeded.emptyDevId });
    const detail = await getDevSpendDetail(db, audit, {
      userId: seeded.emptyDevId,
      days: 30,
    });
    expect(detail).toBeNull();
  });

  it('TC-I-32: getDevSessionList returns [] when the dev has no sessions', async () => {
    const db = getDb();
    const audit = baseAudit(seeded, { targetUserId: seeded.emptyDevId });
    const sessions = await getDevSessionList(db, audit, {
      userId: seeded.emptyDevId,
      days: 30,
    });
    expect(sessions).toEqual([]);
  });

  it('TC-I-32: getDevToolUsage returns all zeros when the dev has no sessions', async () => {
    const db = getDb();
    const audit = baseAudit(seeded, { targetUserId: seeded.emptyDevId });
    const usage = await getDevToolUsage(db, audit, {
      userId: seeded.emptyDevId,
      days: 30,
    });
    expect(usage).toEqual({ Edit: 0, Read: 0, Bash: 0, Agent: 0, Other: 0 });
  });

  it('TC-I-32: getDevSpendDetail returns null when the userId does not exist', async () => {
    const db = getDb();
    const audit = baseAudit(seeded, {
      targetUserId: '00000000-0000-4000-8000-000000000099',
    });
    const detail = await getDevSpendDetail(db, audit, {
      userId: '00000000-0000-4000-8000-000000000099',
      days: 30,
    });
    expect(detail).toBeNull();
  });
});
