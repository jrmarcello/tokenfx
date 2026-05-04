/**
 * Integration tests for `writeAudit()` — manager-dashboard-v2 TASK-AUDIT-LIB.
 *
 * Scope (REQ-15, REQ-16):
 *   - Idempotent INSERT ... ON CONFLICT DO UPDATE keyed on
 *     (manager_user_id, target_user_id, viewed_on, reason).
 *   - Returns `{ inserted: boolean }` derived from `RETURNING (xmax = 0)`
 *     so the route layer can gate the REQ-16 notification enqueue (only
 *     a real INSERT — first view of the day for that reason — triggers
 *     a notification; ON CONFLICT no-op same-day refresh is silent).
 *
 * Postgres-backed via the shared Testcontainers setup (see
 * `tests/integration/setup-pg.ts`). Skipped under `SKIP_PG_TESTS=1`.
 *
 * TC mapping (per spec Test Plan):
 *   - TC-I-26: happy path — row written, `inserted=true`, all fields mapped.
 *   - TC-I-27: DB error (FK violation) → throws; no row persisted.
 *   - TC-I-28: lib does NOT enforce cross-team gate (route is the gate);
 *     writeAudit faithfully writes whatever ctx the caller hands it.
 *   - TC-I-44: 2 identical calls same day → 1 row, second `inserted=false`,
 *     `viewed_at` and `ip_address_trunc` updated to the second call.
 *   - TC-I-45: notification gate — second identical call returns
 *     `inserted=false` so the caller knows not to enqueue.
 *   - TC-I-46: same manager+target+day, DIFFERENT reason → 2 rows.
 *   - TC-I-47: same manager+target+reason, NEXT day → 2 rows.
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
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDrilldownAudit,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';
import { writeAudit, type AuditContext } from './drilldown-audit';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

type Seeded = {
  orgId: string;
  teamId: string;
  managerId: string;
  devId: string;
};

const seedOrgManagerDev = async (): Promise<Seeded> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'AuditOrg' })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'AuditTeam' })
    .returning({ id: teams.id });
  const [manager] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'manager@audit.example',
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
      email: 'dev@audit.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return { orgId: org.id, teamId: team.id, managerId: manager.id, devId: dev.id };
};

const baseCtx = (s: Seeded, overrides: Partial<AuditContext> = {}): AuditContext => ({
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

skipDescribe('writeAudit (Postgres integration)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    const db = getDb();
    // Wipe the same set of tables every other integration test wipes — keeps
    // sibling files coherent when sharing one Testcontainers instance.
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
    seeded = await seedOrgManagerDev();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(managerDrilldownAudit);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  it('TC-I-26: writes a row with all fields mapped and inserted=true', async () => {
    const db = getDb();
    const ctx = baseCtx(seeded, {
      reason: 'cost-investigation',
      reasonText: null,
      ipAddressTrunc: '198.51.100.0/24',
    });

    const result = await writeAudit(db, ctx);
    expect(result.inserted).toBe(true);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.orgId).toBe(seeded.orgId);
    expect(row.managerUserId).toBe(seeded.managerId);
    expect(row.targetUserId).toBe(seeded.devId);
    expect(row.reason).toBe('cost-investigation');
    expect(row.reasonText).toBeNull();
    expect(row.sourceRoute).toBe('/manager/devs/[devId]');
    expect(row.ipAddressTrunc).toBe('198.51.100.0/24');
    // `date` columns deserialize as 'YYYY-MM-DD' string in node-postgres.
    expect(String(row.viewedOn)).toBe('2026-04-30');
    expect(row.viewedAt).toBeInstanceOf(Date);
  });

  it('TC-I-27: throws on DB error (bogus FK org_id) and writes no row', async () => {
    const db = getDb();
    const ctx = baseCtx(seeded, {
      // Random UUID that doesn't exist in `orgs` → FK violation.
      orgId: '00000000-0000-4000-8000-000000000099',
    });

    await expect(writeAudit(db, ctx)).rejects.toThrow();

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-28: lib does NOT enforce cross-team gate — route is the gate', async () => {
    // The lib writes whatever ctx is passed, even a target_user_id from a
    // different team. Cross-team / cross-org rejection is enforced UPSTREAM
    // by the drilldown route handler before writeAudit is ever called.
    const db = getDb();

    // Seed a foreign org + dev.
    const [foreignOrg] = await db
      .insert(orgs)
      .values({ name: 'ForeignOrg' })
      .returning({ id: orgs.id });
    const [foreignTeam] = await db
      .insert(teams)
      .values({ orgId: foreignOrg.id, name: 'ForeignTeam' })
      .returning({ id: teams.id });
    const [foreignDev] = await db
      .insert(users)
      .values({
        orgId: foreignOrg.id,
        teamId: foreignTeam.id,
        email: 'foreign-dev@audit.example',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });

    const ctx = baseCtx(seeded, { targetUserId: foreignDev.id });
    const result = await writeAudit(db, ctx);
    expect(result.inserted).toBe(true);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetUserId).toBe(foreignDev.id);
  });

  it('TC-I-44: identical second call same day → 1 row, inserted=false, viewed_at and ip updated', async () => {
    const db = getDb();
    const ctx1 = baseCtx(seeded, {
      reason: 'training-check',
      ipAddressTrunc: '203.0.113.0/24',
    });

    const r1 = await writeAudit(db, ctx1);
    expect(r1.inserted).toBe(true);

    const [first] = await db
      .select()
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.managerUserId, seeded.managerId));
    const firstViewedAt = first.viewedAt;
    expect(first.ipAddressTrunc).toBe('203.0.113.0/24');

    // Sleep 5ms to guarantee a strictly-greater `viewed_at` after the UPSERT.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ctx2 = baseCtx(seeded, {
      reason: 'training-check',
      ipAddressTrunc: '198.51.100.0/24',
    });
    const r2 = await writeAudit(db, ctx2);
    expect(r2.inserted).toBe(false);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(1);
    expect(rows[0].ipAddressTrunc).toBe('198.51.100.0/24');
    expect(rows[0].viewedAt.getTime()).toBeGreaterThan(firstViewedAt.getTime());
  });

  it('TC-I-45: notification gate — second identical same-day call returns inserted=false', async () => {
    // REQ-16 behavior at the lib layer: caller uses `inserted` to decide
    // whether to enqueue a notification. This TC pins the contract: a
    // duplicate same-day same-reason call MUST surface `inserted=false`.
    const db = getDb();
    const ctx = baseCtx(seeded);

    const r1 = await writeAudit(db, ctx);
    expect(r1.inserted).toBe(true);

    const r2 = await writeAudit(db, ctx);
    expect(r2.inserted).toBe(false);
  });

  it('TC-I-46: same manager+target+day, DIFFERENT reason → 2 rows', async () => {
    const db = getDb();

    const r1 = await writeAudit(db, baseCtx(seeded, { reason: 'training-check' }));
    const r2 = await writeAudit(db, baseCtx(seeded, { reason: 'cost-investigation' }));

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(2);
    const reasons = rows.map((r) => r.reason).sort();
    expect(reasons).toEqual(['cost-investigation', 'training-check']);
  });

  it('TC-I-66: two different managers, same target+day+reason → 2 rows (manager_user_id is part of the UNIQUE key)', async () => {
    const db = getDb();

    // Seed a second manager in the same org/team. The UNIQUE key on
    // manager_drilldown_audit is `(manager_user_id, target_user_id,
    // viewed_on, reason)` — a second manager drilling the same dev on the
    // same day for the same reason MUST produce a distinct row.
    const [managerB] = await db
      .insert(users)
      .values({
        orgId: seeded.orgId,
        teamId: seeded.teamId,
        email: 'managerB@audit.example',
        ssoProvider: null,
        ssoSubject: null,
        role: 'manager',
      })
      .returning({ id: users.id });

    const r1 = await writeAudit(
      db,
      baseCtx(seeded, { managerUserId: seeded.managerId, reason: 'cost-investigation' }),
    );
    const r2 = await writeAudit(
      db,
      baseCtx(seeded, { managerUserId: managerB.id, reason: 'cost-investigation' }),
    );

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(2);
    const managerIds = rows.map((r) => r.managerUserId).sort();
    expect(managerIds).toEqual([seeded.managerId, managerB.id].sort());
  });

  it('TC-I-47: same manager+target+reason, NEXT day → 2 rows', async () => {
    const db = getDb();

    const r1 = await writeAudit(db, baseCtx(seeded, { viewedOn: '2026-04-30' }));
    const r2 = await writeAudit(db, baseCtx(seeded, { viewedOn: '2026-05-01' }));

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);

    const rows = await db.select().from(managerDrilldownAudit);
    expect(rows).toHaveLength(2);
    const days = rows.map((r) => String(r.viewedOn)).sort();
    expect(days).toEqual(['2026-04-30', '2026-05-01']);
  });
});
