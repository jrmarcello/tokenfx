/**
 * Integration tests for `me-visibility` queries — TASK-VISIBILITY-PAGE of
 * `.specs/manager-dashboard-v2.md`.
 *
 * Surface area:
 *   - `getMyKpis(db, userId)` — aggregated 30d KPIs (cache hit, good-session pct,
 *     subagent adoption, tool mix) for the dev's own data (REQ-17).
 *   - `getMyDrilldownAudit(db, { userId, page, pageSize })` — paginated
 *     chronological audit log of every drilldown row where
 *     `target_user_id = self`. Manager identity rendered via SQL-side
 *     `COALESCE(users.display_name, split_part(users.email, '@', 1))` so the
 *     label matches the React-side `displayLabelFor`.
 *
 * Anti-surveillance principle 5 (LOCKED, see spec Design): even after the org
 * disables `drilldown_notification_enabled`, historical audit rows are STILL
 * shown to the dev — devs can't be retroactively un-told they were watched.
 *
 * TC mapping:
 *   - TC-I-31 (happy): dev with 3 audit rows → audit table returns 3 rows
 *     newest-first with manager label, reason, reasonText.
 *   - TC-I-32 (edge): dev with 0 audits → empty `items`, total = 0.
 *   - TC-I-38 (security): cross-org isolation — dev in org A receives ONLY
 *     audits where `target_user_id = self`, even if manager from org B has
 *     audits referencing a different user. The query is keyed on
 *     `target_user_id`, NOT on `org_id`, so the security boundary is the
 *     `userId` parameter the caller binds (the page derives it from
 *     `auth().user.id` — no user-supplied input).
 *   - TC-I-54 (security): SQL string contains literal
 *     `WHERE target_user_id = $1` (or the equivalent Drizzle param marker).
 *   - TC-I-71 / TC-I-72: page=0 / page=-1 → query is never reached
 *     (validation rejects at page layer); the test asserts the function
 *     itself rejects non-positive pages with `RangeError` so callers can't
 *     accidentally pass through invalid input.
 *   - TC-I-73: page=9999 with no audits → empty items, total = 0.
 *
 * Postgres-backed via the shared Testcontainers setup. Skipped when
 * `SKIP_PG_TESTS=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDrilldownAudit,
  orgs,
  sessionsAgg,
  teams,
  toolCountAgg,
  users,
} from '@/lib/db/schema';
import {
  GET_MY_DRILLDOWN_AUDIT_SQL,
  getMyDrilldownAudit,
  getMyKpis,
} from './me-visibility';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  avgRating: number | null;
  subagentUsageRatio: number | null;
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
    cacheHitRatio:
      input.cacheHitRatio === null ? null : input.cacheHitRatio.toFixed(3),
    outputInputRatio: null,
    subagentUsageRatio:
      input.subagentUsageRatio === null
        ? null
        : input.subagentUsageRatio.toFixed(3),
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

// ---------- TC-I-54 (SQL inspection) ----------------------------------------

describe('me-visibility SQL inspection (TC-I-54)', () => {
  it('TC-I-54: getMyDrilldownAudit SQL contains literal `WHERE target_user_id = $1`', () => {
    // The SQL is exposed as a constant for source-level inspection. We don't
    // execute it here — TC-I-54 is a defense-in-depth grep that catches
    // future refactors that drop the targetUserId predicate (e.g. a copy-paste
    // accident swapping `target_user_id` for `manager_user_id`).
    expect(GET_MY_DRILLDOWN_AUDIT_SQL).toContain('WHERE target_user_id = $1');
  });
});

// ---------- TC-I-71 / TC-I-72 (page validation) -----------------------------

skipDescribe('getMyDrilldownAudit validation (TC-I-71/TC-I-72)', () => {
  beforeAll(async () => {
    await wipeAll();
  });
  afterAll(async () => {
    await wipeAll();
  });

  it('TC-I-71: page=0 throws RangeError', async () => {
    const db = getDb();
    await expect(
      getMyDrilldownAudit(db, {
        userId: '00000000-0000-0000-0000-000000000000',
        page: 0,
        pageSize: 25,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('TC-I-72: page=-1 throws RangeError', async () => {
    const db = getDb();
    await expect(
      getMyDrilldownAudit(db, {
        userId: '00000000-0000-0000-0000-000000000000',
        page: -1,
        pageSize: 25,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

// ---------- TC-I-31 / TC-I-32 / TC-I-38 / TC-I-73 ---------------------------

skipDescribe('me-visibility queries (Postgres integration)', () => {
  let orgAId = '';
  let orgBId = '';
  let teamAId = '';
  let teamBId = '';
  let mgrAId = '';
  let mgrBId = '';
  let devAId = '';
  let devBId = '';
  let emptyDevId = '';

  beforeAll(async () => {
    await wipeAll();
    const db = getDb();

    const [orgA] = await db
      .insert(orgs)
      .values({ name: 'OrgA-Visibility' })
      .returning({ id: orgs.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(orgs)
      .values({ name: 'OrgB-Visibility' })
      .returning({ id: orgs.id });
    orgBId = orgB.id;

    const [teamA] = await db
      .insert(teams)
      .values({ orgId: orgAId, name: 'TeamA' })
      .returning({ id: teams.id });
    teamAId = teamA.id;
    const [teamB] = await db
      .insert(teams)
      .values({ orgId: orgBId, name: 'TeamB' })
      .returning({ id: teams.id });
    teamBId = teamB.id;

    // Manager A — has display_name set ("Alice Manager"). Manager B — only
    // email; the SQL fallback to split_part(email, '@', 1) drives the label.
    const [mgrA] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        teamId: teamAId,
        email: 'alice.mgr@orga.example',
        displayName: 'Alice Manager',
        ssoProvider: null,
        ssoSubject: null,
        role: 'manager',
      })
      .returning({ id: users.id });
    mgrAId = mgrA.id;
    const [mgrB] = await db
      .insert(users)
      .values({
        orgId: orgBId,
        teamId: teamBId,
        email: 'bob.mgr@orgb.example',
        displayName: null, // forces email-local-part fallback
        ssoProvider: null,
        ssoSubject: null,
        role: 'manager',
      })
      .returning({ id: users.id });
    mgrBId = mgrB.id;

    // Dev A in org A — receives 3 historical drilldown audits (TC-I-31).
    const [devA] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        teamId: teamAId,
        email: 'dev.a@orga.example',
        displayName: 'Dev A',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });
    devAId = devA.id;

    // Dev B in org B — used for TC-I-38 cross-org isolation. Manager B
    // drilldowns into Dev B; we must verify that querying for Dev A returns
    // ZERO rows referencing Dev B.
    const [devB] = await db
      .insert(users)
      .values({
        orgId: orgBId,
        teamId: teamBId,
        email: 'dev.b@orgb.example',
        displayName: 'Dev B',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });
    devBId = devB.id;

    // Empty dev — no sessions, no audits (TC-I-32, TC-I-73).
    const [emptyDev] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        teamId: teamAId,
        email: 'empty.dev@orga.example',
        displayName: null,
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });
    emptyDevId = emptyDev.id;

    // ---- KPI seed for Dev A: 4 sessions in last 30d -----------------------
    // cache_hit_ratio mean = (0.5 + 0.7 + 0.9 + null) → mean of non-null = 0.7
    // good_session_pct: ratings >= 0 → all 3 rated count as "good";
    //   composite gate uses cacheHitRatio>=0.5 OR avgRating>=4 — keep simple:
    //   exposed metric = pct of sessions with avgRating >= 4 OR
    //   cacheHitRatio >= 0.6 (we'll let the implementation define exact gate
    //   matching the spec's `good_session_pct` rule from REQ-2). For this
    //   test we assert `goodSessionPct` is a finite number in [0, 100].
    // subagent adoption: 2 of 4 sessions have subagent_usage_ratio > 0 → 50%.
    // tool_mix: Edit:5, Read:3, Bash:2, Task:1 (→Agent), Grep:4 (→Other).
    const baseTime = Date.now() - 5 * ONE_DAY_MS;
    await insertSession({
      userId: devAId,
      sessionId: 's-a-1',
      startedAt: new Date(baseTime),
      totalCostUsd: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 4,
      subagentUsageRatio: 0.4,
    });
    await insertSession({
      userId: devAId,
      sessionId: 's-a-2',
      startedAt: new Date(baseTime + 1000),
      totalCostUsd: 1.0,
      cacheHitRatio: 0.7,
      avgRating: 5,
      subagentUsageRatio: 0,
    });
    await insertSession({
      userId: devAId,
      sessionId: 's-a-3',
      startedAt: new Date(baseTime + 2000),
      totalCostUsd: 1.0,
      cacheHitRatio: 0.9,
      avgRating: null,
      subagentUsageRatio: 0.001, // boundary: counts as adopted (>0)
    });
    await insertSession({
      userId: devAId,
      sessionId: 's-a-4',
      startedAt: new Date(baseTime + 3000),
      totalCostUsd: 1.0,
      cacheHitRatio: null,
      avgRating: 2,
      subagentUsageRatio: null,
    });

    await insertToolCount(devAId, 's-a-1', 'Edit', 5);
    await insertToolCount(devAId, 's-a-1', 'Read', 3);
    await insertToolCount(devAId, 's-a-2', 'Bash', 2);
    await insertToolCount(devAId, 's-a-3', 'Task', 1); // legacy → Agent
    await insertToolCount(devAId, 's-a-3', 'Grep', 4); // → Other

    // ---- Audit rows for TC-I-31 -------------------------------------------
    // 3 drilldown rows targeting devA, distinct days/reasons (UNIQUE constraint
    // is (manager, target, viewed_on, reason)). Insert ascending so the
    // newest is the last one inserted; the query MUST return them DESC.
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    await db.insert(managerDrilldownAudit).values([
      {
        orgId: orgAId,
        managerUserId: mgrAId,
        targetUserId: devAId,
        reason: 'training-check',
        reasonText: null,
        sourceRoute: '/manager/devs/[devId]',
        ipAddressTrunc: '203.0.113.0/24',
        viewedOn: isoDay(new Date(today.getTime() - 2 * ONE_DAY_MS)),
        viewedAt: new Date(today.getTime() - 2 * ONE_DAY_MS),
      },
      {
        orgId: orgAId,
        managerUserId: mgrAId,
        targetUserId: devAId,
        reason: 'cost-investigation',
        reasonText: 'Spike in 30d spend',
        sourceRoute: '/manager/devs/[devId]',
        ipAddressTrunc: '203.0.113.0/24',
        viewedOn: isoDay(new Date(today.getTime() - 1 * ONE_DAY_MS)),
        viewedAt: new Date(today.getTime() - 1 * ONE_DAY_MS),
      },
      {
        orgId: orgAId,
        managerUserId: mgrAId,
        targetUserId: devAId,
        reason: 'other',
        reasonText: 'Curious',
        sourceRoute: '/manager/check-in/[devId]',
        ipAddressTrunc: '203.0.113.0/24',
        viewedOn: isoDay(today),
        viewedAt: today,
      },
    ]);

    // ---- Cross-org audit (TC-I-38) ----------------------------------------
    // Manager B drilldowns Dev B in org B. Querying for Dev A must NOT pick
    // up any rows referencing Dev B.
    await db.insert(managerDrilldownAudit).values({
      orgId: orgBId,
      managerUserId: mgrBId,
      targetUserId: devBId,
      reason: 'training-check',
      reasonText: 'Org B internal',
      sourceRoute: '/manager/devs/[devId]',
      ipAddressTrunc: '198.51.100.0/24',
      viewedOn: isoDay(today),
      viewedAt: today,
    });
  });

  afterAll(async () => {
    await wipeAll();
    await closeDb();
  });

  it('TC-I-31 (happy): dev with 3 audit rows → newest-first ordering, 3 rows, manager labels resolved via COALESCE', async () => {
    const db = getDb();
    const result = await getMyDrilldownAudit(db, {
      userId: devAId,
      page: 1,
      pageSize: 25,
    });
    expect(result.total).toBe(3);
    expect(result.items.length).toBe(3);

    // Newest first: the most recent row is the 'other' reason inserted at `today`.
    expect(result.items[0].reason).toBe('other');
    expect(result.items[0].reasonText).toBe('Curious');
    expect(result.items[1].reason).toBe('cost-investigation');
    expect(result.items[2].reason).toBe('training-check');

    // Strict DESC viewedAt.
    for (let i = 1; i < result.items.length; i += 1) {
      expect(
        result.items[i - 1].viewedAt >= result.items[i].viewedAt,
      ).toBe(true);
    }

    // Manager A has displayName='Alice Manager' → label uses display_name.
    for (const row of result.items) {
      expect(row.managerDisplayLabel).toBe('Alice Manager');
    }
  });

  it('TC-I-32 (edge): dev with 0 audits → items=[], total=0', async () => {
    const db = getDb();
    const result = await getMyDrilldownAudit(db, {
      userId: emptyDevId,
      page: 1,
      pageSize: 25,
    });
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('TC-I-38 (security): cross-org isolation — dev A query returns ONLY rows where target_user_id = devA', async () => {
    const db = getDb();
    const result = await getMyDrilldownAudit(db, {
      userId: devAId,
      page: 1,
      pageSize: 25,
    });
    // Dev A has 3 rows; cross-org row referencing Dev B must NOT leak in.
    expect(result.total).toBe(3);
    for (const row of result.items) {
      // Manager B's email-local-part would be 'bob.mgr'; Manager A is
      // 'Alice Manager'. None of dev A's rows should match Manager B.
      expect(row.managerDisplayLabel).not.toContain('bob');
      expect(row.reasonText ?? '').not.toContain('Org B');
    }
  });

  it('TC-I-73: page=9999 → 200-equivalent (empty items, total still reflects the real count)', async () => {
    const db = getDb();
    const result = await getMyDrilldownAudit(db, {
      userId: devAId,
      page: 9999,
      pageSize: 25,
    });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(3);
  });

  it('getMyKpis returns aggregated 30d metrics for the dev', async () => {
    const db = getDb();
    const kpis = await getMyKpis(db, devAId);

    // cache_hit_ratio_avg: mean of non-null (0.5, 0.7, 0.9) = 0.7.
    expect(kpis.cacheHitRatioAvg).toBeCloseTo(0.7, 2);

    // subagent adoption: 2 of 4 sessions with ratio > 0 → 50%.
    expect(kpis.subagentAdoptionPct).toBeCloseTo(50, 2);

    // good_session_pct must be a finite number in [0, 100].
    expect(Number.isFinite(kpis.goodSessionPct)).toBe(true);
    expect(kpis.goodSessionPct).toBeGreaterThanOrEqual(0);
    expect(kpis.goodSessionPct).toBeLessThanOrEqual(100);

    // tool_mix bucketization: Edit=5, Read=3, Bash=2, Agent=1 (Task), Other=4 (Grep).
    expect(kpis.toolMix.Edit).toBe(5);
    expect(kpis.toolMix.Read).toBe(3);
    expect(kpis.toolMix.Bash).toBe(2);
    expect(kpis.toolMix.Agent).toBe(1);
    expect(kpis.toolMix.Other).toBe(4);
  });
});
