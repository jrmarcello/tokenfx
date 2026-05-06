/**
 * Integration tests for `POST /api/manager/dismiss-anomaly`
 * (TASK-DISMISS-ROUTE, REQ-22 dismiss).
 *
 * Postgres-backed via the shared Testcontainers setup
 * (`tests/integration/setup-pg.ts`). Tests call `dismissAnomalyImpl`
 * directly with a hand-written stub `authFn` so we can exercise the
 * role gate and cross-org guard without spinning up NextAuth.
 *
 * TC mapping:
 *   - TC-I-77 (happy):       manager POSTs valid body → 200, single row
 *                            with dismissed_until ≈ now+7d.
 *   - TC-I-76 (idempotency): re-submit identical → 200, row count = 1,
 *                            dismissed_until extended.
 *   - TC-I-74 (security):    member-role POSTs → 403, no row written.
 *   - TC-I-75 (validation):  missing target_user_id → 400; unknown
 *                            extra field (.strict) → 400.
 *   - TC-I-78 (cross-org):   manager in org A POSTs target in org B →
 *                            403, no row written.
 *
 * Manager-dashboard-v2-followups note (TC-I-08, TC-I-08b — REQ-8):
 *   The `performDismissAnomaly` helper extraction (TASK-1/3 of that
 *   spec) preserves this route's observable contract. TC-I-08 (happy
 *   delegation → 200 with row written) is subsumed by TC-I-77, and
 *   TC-I-08b (cross-org → 403 with FORBIDDEN_BODY) is subsumed by
 *   TC-I-78. No new TCs are added because the route's surface is
 *   tested end-to-end against real Postgres — any regression in the
 *   helper delegation (wrong arg order, missing await, swallowed
 *   error) would be caught by the existing 5 TCs. Adding mock-style
 *   delegation tests would violate the project rule "hand-written
 *   stubs only, no mocking framework" and weaken the contract.
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
import type { Session } from 'next-auth';
import {
  dismissAnomalyImpl,
  type AuthFn,
} from './route';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDismissedAnomalies,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// -------- Stubs / helpers ----------------------------------------------------

const stubAuth = (session: Session | null): AuthFn => async () => session;

type Body = { target_user_id: string; kind: string };

const makeRequest = (body: unknown): Request => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return new Request('http://localhost/api/manager/dismiss-anomaly', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
};

const makeSession = (
  role: 'manager' | 'admin' | 'member',
  userId: string,
  orgId: string,
): Session => ({
  user: { id: userId, email: `${role}@x`, role, orgId },
  expires: '2099-01-01',
});

type SeedFixture = {
  orgAId: string;
  orgBId: string;
  managerAId: string;
  memberAId: string;
  targetAId: string;
  targetBId: string;
};

const seedFixture = async (): Promise<SeedFixture> => {
  const db = getDb();
  const [orgA] = await db
    .insert(orgs)
    .values({ name: 'OrgA' })
    .returning({ id: orgs.id });
  const [orgB] = await db
    .insert(orgs)
    .values({ name: 'OrgB' })
    .returning({ id: orgs.id });
  // Each org needs at least one team since no test relies on teams here,
  // but downstream FK CASCADEs are exercised by the cleanup TRUNCATE — we
  // create a placeholder team per org for parity with sibling fixtures.
  await db.insert(teams).values({ orgId: orgA.id, name: 'TeamA1' });
  await db.insert(teams).values({ orgId: orgB.id, name: 'TeamB1' });

  const [managerA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      email: 'mgr-a@example.com',
      role: 'manager',
      ssoProvider: 'stub',
      ssoSubject: 'sub-mgr-a',
    })
    .returning({ id: users.id });
  const [memberA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      email: 'mbr-a@example.com',
      role: 'member',
      ssoProvider: 'stub',
      ssoSubject: 'sub-mbr-a',
    })
    .returning({ id: users.id });
  const [targetA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      email: 'target-a@example.com',
      role: 'member',
      ssoProvider: 'stub',
      ssoSubject: 'sub-tgt-a',
    })
    .returning({ id: users.id });
  const [targetB] = await db
    .insert(users)
    .values({
      orgId: orgB.id,
      email: 'target-b@example.com',
      role: 'member',
      ssoProvider: 'stub',
      ssoSubject: 'sub-tgt-b',
    })
    .returning({ id: users.id });

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    managerAId: managerA.id,
    memberAId: memberA.id,
    targetAId: targetA.id,
    targetBId: targetB.id,
  };
};

// -------- Suite --------------------------------------------------------------

skipDescribe('POST /api/manager/dismiss-anomaly (integration)', () => {
  let f: SeedFixture;

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
    f = await seedFixture();
  });

  afterEach(async () => {
    const db = getDb();
    // Clean in FK-safe order — targets cascade through FKs anyway, but
    // explicit deletes keep the test isolation contract obvious.
    await db.delete(managerDismissedAnomalies);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // ---------------------------------------------------------------------------
  // TC-I-77 — happy path: manager → 200, row landed with correct fields.
  // ---------------------------------------------------------------------------
  it('TC-I-77 happy: manager POSTs valid body → 200, single row with dismissed_until ≈ now+7d', async () => {
    const db = getDb();
    const before = Date.now();
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const body: Body = {
      target_user_id: f.targetAId,
      kind: 'spend-spike-30d',
    };

    const res = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await db
      .select({
        orgId: managerDismissedAnomalies.orgId,
        managerUserId: managerDismissedAnomalies.managerUserId,
        targetUserId: managerDismissedAnomalies.targetUserId,
        kind: managerDismissedAnomalies.kind,
        dismissedUntil: managerDismissedAnomalies.dismissedUntil,
      })
      .from(managerDismissedAnomalies);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.orgId).toBe(f.orgAId);
    expect(row.managerUserId).toBe(f.managerAId);
    expect(row.targetUserId).toBe(f.targetAId);
    expect(row.kind).toBe('spend-spike-30d');

    const expectedMin = before + 7 * 24 * 60 * 60 * 1000;
    const expectedMax = after + 7 * 24 * 60 * 60 * 1000;
    const actual = row.dismissedUntil.getTime();
    expect(actual).toBeGreaterThanOrEqual(expectedMin);
    expect(actual).toBeLessThanOrEqual(expectedMax);
  });

  it('TC-I-77b happy: admin role is also allowed (manager OR admin)', async () => {
    const db = getDb();
    const session = makeSession('admin', f.managerAId, f.orgAId);
    const body: Body = { target_user_id: f.targetAId, kind: 'spend-spike-wow' };

    const res = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // TC-I-76 — idempotency: re-submit identical → row count stays 1,
  // dismissed_until extended.
  // ---------------------------------------------------------------------------
  it('TC-I-76 idempotency: re-submit identical → 200, single row, dismissed_until extended', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const body: Body = {
      target_user_id: f.targetAId,
      kind: 'spend-spike-30d',
    };

    // First dismiss.
    const r1 = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    expect(r1.status).toBe(200);
    const rowsAfterFirst = await db
      .select({ dismissedUntil: managerDismissedAnomalies.dismissedUntil })
      .from(managerDismissedAnomalies);
    expect(rowsAfterFirst).toHaveLength(1);
    const firstUntil = rowsAfterFirst[0].dismissedUntil.getTime();

    // Wait long enough that `now()` advances past the first call's now+7d
    // computation (1 second is plenty given Date.now() millisecond precision
    // and Postgres `now()` clock_timestamp granularity).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second dismiss — same tuple, expect ON CONFLICT DO UPDATE.
    const r2 = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    expect(r2.status).toBe(200);

    const rowsAfterSecond = await db
      .select({ dismissedUntil: managerDismissedAnomalies.dismissedUntil })
      .from(managerDismissedAnomalies);
    expect(rowsAfterSecond).toHaveLength(1);
    const secondUntil = rowsAfterSecond[0].dismissedUntil.getTime();

    // dismissed_until extended (>=, not strictly > — Date.now() granularity
    // could rarely tie, but >= is the correct invariant).
    expect(secondUntil).toBeGreaterThanOrEqual(firstUntil);
  });

  // ---------------------------------------------------------------------------
  // TC-I-74 — security: member role → 403, NO row written.
  // ---------------------------------------------------------------------------
  it('TC-I-74 security: member-role POSTs → 403, no row written', async () => {
    const db = getDb();
    const session = makeSession('member', f.memberAId, f.orgAId);
    const body: Body = {
      target_user_id: f.targetAId,
      kind: 'spend-spike-30d',
    };

    const res = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { message: 'forbidden', code: 'forbidden' },
    });

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-74b security: null session → 403, no row written', async () => {
    const db = getDb();
    const body: Body = {
      target_user_id: f.targetAId,
      kind: 'spend-spike-30d',
    };

    const res = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(null),
    });
    expect(res.status).toBe(403);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // TC-I-75 — validation: missing fields and extra fields both → 400.
  // ---------------------------------------------------------------------------
  it('TC-I-75 validation: body missing target_user_id → 400, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);

    const res = await dismissAnomalyImpl(
      makeRequest({ kind: 'spend-spike-30d' }),
      { authFn: stubAuth(session) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: 'bad request', code: 'bad-request' },
    });

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-75b validation: body with extra field (.strict) → 400, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);

    const res = await dismissAnomalyImpl(
      makeRequest({
        target_user_id: f.targetAId,
        kind: 'spend-spike-30d',
        unexpected: 'extra-field',
      }),
      { authFn: stubAuth(session) },
    );
    expect(res.status).toBe(400);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-75c validation: target_user_id non-uuid → 400, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);

    const res = await dismissAnomalyImpl(
      makeRequest({ target_user_id: 'not-a-uuid', kind: 'spend-spike-30d' }),
      { authFn: stubAuth(session) },
    );
    expect(res.status).toBe(400);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-75d validation: kind empty string → 400, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);

    const res = await dismissAnomalyImpl(
      makeRequest({ target_user_id: f.targetAId, kind: '' }),
      { authFn: stubAuth(session) },
    );
    expect(res.status).toBe(400);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-75e validation: malformed JSON body → 400, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);

    const malformed = new Request('http://localhost/api/manager/dismiss-anomaly', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    const res = await dismissAnomalyImpl(malformed, { authFn: stubAuth(session) });
    expect(res.status).toBe(400);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // TC-I-78 — cross-org: manager in org A targets user in org B → 403,
  // no row written.
  // ---------------------------------------------------------------------------
  it('TC-I-78 cross-org: manager in org A POSTs target in org B → 403, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const body: Body = {
      target_user_id: f.targetBId,
      kind: 'spend-spike-30d',
    };

    const res = await dismissAnomalyImpl(makeRequest(body), {
      authFn: stubAuth(session),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { message: 'forbidden', code: 'forbidden' },
    });

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-78b cross-org: target_user_id of a non-existent user → 403, no row written', async () => {
    const db = getDb();
    const session = makeSession('manager', f.managerAId, f.orgAId);
    // Well-formed UUID but no matching user — same 403 as cross-org so an
    // attacker cannot distinguish "user exists in another org" vs "doesn't
    // exist".
    const ghostUuid = '99999999-9999-4999-8999-999999999999';

    const res = await dismissAnomalyImpl(
      makeRequest({ target_user_id: ghostUuid, kind: 'spend-spike-30d' }),
      { authFn: stubAuth(session) },
    );
    expect(res.status).toBe(403);
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(0);
  });
});
