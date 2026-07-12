/**
 * Integration tests for the AUTH_REQUIRED=false synthetic local user.
 * Spec: .specs/fix-local-mode-synthetic-user-uuid.md (REQ-3, REQ-4, REQ-6).
 *
 * Proves that the manager/me dashboard queries — which bind
 * `session.user.id` against `uuid` columns — no longer 500 when the local
 * mode injects `LOCAL_USER_ID` (a real UUID) instead of the old non-UUID
 * string, and that FK-dependent writes for the local admin succeed against
 * the seeded `users` row.
 *
 * Postgres-backed via Testcontainers (shared globalSetup,
 * `tests/integration/setup-pg.ts`). Skipped when SKIP_PG_TESTS=1.
 *
 * The shared `public` schema is migrated through 0008, so the local
 * org/user rows already exist there; the seed inserts below are
 * `onConflictDoNothing` so the suite is self-contained either way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Session } from 'next-auth';

import { getDb } from '@/lib/db/client';
import {
  managerAlertAcks,
  managerDrilldownAudit,
  onboardingRedemptionLog,
  orgs,
  users,
} from '@/lib/db/schema';
import { LOCAL_ORG_ID, LOCAL_USER_ID } from '@/lib/auth/auth-required';
import { loadFirstAutoProvisionAlert } from '@/lib/queries/manager-alerts';
import { getMyDrilldownAudit } from '@/lib/queries/me-visibility';
import {
  getCheckInOpportunities,
  getDropOffCandidates,
  getKnowledgeSharingOpportunities,
} from '@/lib/queries/manager-v2';
import { loadDrilldownData } from '@/app/manager/_drilldown/render';
import type { NotificationChannel } from '@/lib/queries/notifications';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const EMAIL_HASH = 'abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Ensure the local org + user rows exist (idempotent). */
const ensureLocalSeed = async (): Promise<void> => {
  const db = getDb();
  await db.insert(orgs).values({ id: LOCAL_ORG_ID, name: 'Local Development Org' }).onConflictDoNothing();
  await db
    .insert(users)
    .values({
      id: LOCAL_USER_ID,
      orgId: LOCAL_ORG_ID,
      email: 'dev@localhost',
      role: 'admin',
      displayName: 'Local Dev',
    })
    .onConflictDoNothing();
};

/** Seed a redemption-log row and return its id (event id for acks). */
const seedRedemption = async (tokenPrefix: string): Promise<number> => {
  const db = getDb();
  const [row] = await db
    .insert(onboardingRedemptionLog)
    .values({
      tokenPrefix,
      machineId: null,
      emailDomain: 'localhost',
      emailHash: EMAIL_HASH,
      requestIp: null,
      outcome: 'accepted-sso-auto',
      method: 'sso-auto',
      ssoProvider: 'google',
    })
    .returning({ id: onboardingRedemptionLog.id });
  return row.id;
};

skipDescribe('local-mode synthetic user — dashboard queries + FK writes', () => {
  afterEach(async () => {
    const db = getDb();
    // Full teardown: every test re-establishes what it needs via
    // `ensureLocalSeed()`, so we delete the local user row and all its
    // dependents here (FK children first). This keeps the suite hermetic
    // rather than relying on a persistent seed row — the migration seed in
    // the shared `public` schema is re-created on demand by the tests.
    await db.delete(managerAlertAcks).where(eq(managerAlertAcks.managerUserId, LOCAL_USER_ID));
    await db.delete(managerDrilldownAudit).where(eq(managerDrilldownAudit.managerUserId, LOCAL_USER_ID));
    await db.delete(onboardingRedemptionLog).where(eq(onboardingRedemptionLog.emailDomain, 'localhost'));
    // Any 'dev@localhost' user in any org (local seed + the collision test's copy).
    await db.delete(users).where(eq(users.email, 'dev@localhost'));
    // Drilldown target dev + the non-local org created for the collision test.
    await db.delete(users).where(eq(users.email, 'drilldown-dev@localhost'));
    await db.delete(orgs).where(eq(orgs.name, 'OtherOrg-collision'));
  });

  it('loadFirstAutoProvisionAlert returns null for the local admin with no events (TC-I-04)', async () => {
    await ensureLocalSeed();
    const db = getDb();
    await expect(
      loadFirstAutoProvisionAlert(db, LOCAL_ORG_ID, LOCAL_USER_ID),
    ).resolves.toBeNull();
  });

  it('getMyDrilldownAudit returns an empty page for the local user with no audit rows (TC-I-05)', async () => {
    await ensureLocalSeed();
    const db = getDb();
    const page = await getMyDrilldownAudit(db, { userId: LOCAL_USER_ID, page: 1 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('regression: the old non-UUID id makes Postgres reject the query with code 22P02 (TC-I-06)', async () => {
    const db = getDb();
    // The pre-fix value fed to a uuid-typed bind parameter.
    await expect(
      getMyDrilldownAudit(db, { userId: 'local-dev', page: 1 }),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('an FK-dependent ack write succeeds for the seeded local admin (TC-I-07)', async () => {
    await ensureLocalSeed();
    const db = getDb();
    const eventId = await seedRedemption('loc07pre');
    await expect(
      db.insert(managerAlertAcks).values({
        managerUserId: LOCAL_USER_ID,
        alertKind: 'first-auto-provision',
        eventId,
      }),
    ).resolves.not.toThrow();
  });

  it('the same ack write with a non-seeded random uuid violates the users FK (TC-I-08)', async () => {
    await ensureLocalSeed();
    const db = getDb();
    const eventId = await seedRedemption('loc08pre');
    const RANDOM_UUID = '11111111-2222-3333-4444-555555555555';
    await expect(
      db.insert(managerAlertAcks).values({
        managerUserId: RANDOM_UUID,
        alertKind: 'first-auto-provision',
        eventId,
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('health + drilldown queries run for the local admin on an empty org without throwing (TC-I-10)', async () => {
    await ensureLocalSeed();
    const db = getDb();
    const params = { managerId: LOCAL_USER_ID, orgId: LOCAL_ORG_ID };
    // No manager teams seeded → each returns an empty result, never a 500.
    await expect(getCheckInOpportunities(db, params)).resolves.toEqual([]);
    await expect(getDropOffCandidates(db, params)).resolves.toEqual([]);
    await expect(getKnowledgeSharingOpportunities(db, params)).resolves.toEqual([]);
  });

  it('the manager drilldown resolves + writes an audit row for the local admin (TC-I-13, REQ-6)', async () => {
    // The drilldown RSC does its OWN `SELECT ... FROM users WHERE id = managerUserId`
    // and inserts into `manager_drilldown_audit` with `managerUserId = session.user.id`
    // — both bind against `uuid` columns and would 500 pre-fix. Drive it through
    // the `authFn` DI seam carrying LOCAL_USER_ID and assert an audit row lands.
    await ensureLocalSeed();
    const db = getDb();
    // Target dev in the same (local) org.
    const [dev] = await db
      .insert(users)
      .values({
        orgId: LOCAL_ORG_ID,
        email: 'drilldown-dev@localhost',
        role: 'member',
        displayName: 'Drilldown Dev',
      })
      .returning({ id: users.id });

    const authFn = async (): Promise<Session> =>
      ({
        user: {
          id: LOCAL_USER_ID,
          orgId: LOCAL_ORG_ID,
          email: 'dev@localhost',
          role: 'admin',
        },
        expires: new Date(Date.now() + 60_000).toISOString(),
      }) as unknown as Session;

    // Notification enqueue is a best-effort side effect — stub it so no
    // manager_notifications rows are written and `after()` runs inline.
    const notifyChannel: NotificationChannel = { enqueue: async () => {} };
    const afterFn = ((cb: unknown) => {
      if (typeof cb === 'function') void (cb as () => unknown)();
    }) as Parameters<typeof loadDrilldownData>[2]['afterFn'];

    await expect(
      loadDrilldownData(
        dev.id,
        { reason: 'training-check' },
        { sourceRoute: '/manager/devs/[devId]', authFn, notifyChannel, afterFn },
      ),
    ).resolves.toBeDefined();

    const audit = await db
      .select({ managerUserId: managerDrilldownAudit.managerUserId })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.managerUserId, LOCAL_USER_ID));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('the seeded local user cannot interfere with another org provisioning the same email (TC-I-12)', async () => {
    // The non-collision invariant: `users_org_email_unique` is scoped by
    // org_id, so 'dev@localhost' in a DIFFERENT org — exactly what SSO
    // auto-provision would insert — is unaffected by the seeded local row.
    await ensureLocalSeed();
    const db = getDb();
    const [other] = await db
      .insert(orgs)
      .values({ name: 'OtherOrg-collision' })
      .returning({ id: orgs.id });

    await expect(
      db.insert(users).values({
        orgId: other.id,
        email: 'dev@localhost',
        role: 'member',
      }),
    ).resolves.not.toThrow();

    // And a second insert into the LOCAL org DOES collide — proving the
    // constraint is real and org-scoped, not merely absent.
    await expect(
      db.insert(users).values({
        id: '00000000-0000-0000-0000-0000000000ff',
        orgId: LOCAL_ORG_ID,
        email: 'dev@localhost',
        role: 'member',
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
