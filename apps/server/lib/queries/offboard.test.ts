/**
 * Tests for admin offboarding (identity anonymization).
 * Spec: .specs/data-retention-policy.md (REQ-4, REQ-5, REQ-6).
 *
 * Postgres-backed via the shared Testcontainers setup; skipped under
 * SKIP_PG_TESTS=1. Hand-written stubs (deps seams), no mocking framework.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDrilldownAudit,
  onboardingAuditLog,
  orgs,
  userMachines,
  users,
} from '@/lib/db/schema';
import {
  anonymizedEmailFor,
  offboardAnonymizeUpdateForTest,
  offboardUserCore,
} from './offboard';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

describe('anonymizedEmailFor (TC-U-02)', () => {
  it('produces a deterministic, unique .invalid address from the full UUID', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(anonymizedEmailFor(id)).toBe(`departed-${id}@anonymized.invalid`);
  });
});

skipDescribe('offboardUserCore (Postgres integration)', () => {
  const db = getDb();
  let orgId: string;
  let adminId: string;
  let devId: string;

  const wipe = async (): Promise<void> => {
    await db.execute(sql`TRUNCATE TABLE
      manager_drilldown_audit, onboarding_audit_log, user_machines,
      sessions_agg, users, teams, orgs RESTART IDENTITY CASCADE`);
  };

  beforeEach(async () => {
    await wipe();
    const [org] = await db.insert(orgs).values({ name: 'OffOrg' }).returning({ id: orgs.id });
    orgId = org.id;
    const [admin] = await db.insert(users).values({ orgId, email: 'admin@off.example', role: 'admin' }).returning({ id: users.id });
    adminId = admin.id;
    const [dev] = await db.insert(users).values({
      orgId, email: 'dev@off.example', displayName: 'Dev Person',
      ssoProvider: 'google', ssoSubject: 'sub-dev', role: 'member',
    }).returning({ id: users.id });
    devId = dev.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  const seedMachine = async (userId: string, revoked = false): Promise<string> => {
    const machineId = randomUUID();
    await db.insert(userMachines).values({
      userId, machineId, keyId: `k_${randomUUID().slice(0, 12)}`,
      secretHash: 'bcrypt$x', revokedAt: revoked ? new Date() : null,
    });
    return machineId;
  };

  it('anonymizes identity, revokes machines, and writes an email-free audit row (TC-I-07)', async () => {
    await seedMachine(devId);
    await seedMachine(devId);
    const res = await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    expect(res.kind).toBe('offboarded');

    const [u] = await db.select().from(users).where(eq(users.id, devId));
    expect(u.email).toBe(anonymizedEmailFor(devId));
    expect(u.displayName).toBeNull();
    expect(u.ssoProvider).toBeNull();
    expect(u.ssoSubject).toBeNull();
    expect(u.role).toBe('member');

    const machines = await db.select().from(userMachines).where(eq(userMachines.userId, devId));
    expect(machines.every((m) => m.revokedAt !== null)).toBe(true);

    const audit = await db.select().from(onboardingAuditLog).where(eq(onboardingAuditLog.action, 'user-offboarded'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain('@');
    expect(JSON.stringify(audit[0].metadata)).toContain(devId);
  });

  it('is idempotent — a second offboard returns already-offboarded (TC-I-08)', async () => {
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    const second = await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    expect(second.kind).toBe('already-offboarded');
  });

  it('cross-org offboard is not-found and leaves the foreign dev intact (TC-I-09)', async () => {
    const [otherOrg] = await db.insert(orgs).values({ name: 'OtherOffOrg' }).returning({ id: orgs.id });
    const [otherDev] = await db.insert(users).values({ orgId: otherOrg.id, email: 'x@other.example', role: 'member' }).returning({ id: users.id });
    const res = await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: otherDev.id });
    expect(res.kind).toBe('not-found');
    const [u] = await db.select().from(users).where(eq(users.id, otherDev.id));
    expect(u.email).toBe('x@other.example');
  });

  it('the self-guarding UPDATE no-ops for a foreign org even if the resolve is bypassed (TC-I-09b)', async () => {
    const [otherOrg] = await db.insert(orgs).values({ name: 'SgOffOrg' }).returning({ id: orgs.id });
    const [otherDev] = await db.insert(users).values({ orgId: otherOrg.id, email: 'sg@other.example', role: 'member' }).returning({ id: users.id });
    const affected = await offboardAnonymizeUpdateForTest(db, { orgId, userId: otherDev.id });
    expect(affected).toBe(0);
    const [u] = await db.select().from(users).where(eq(users.id, otherDev.id));
    expect(u.email).toBe('sg@other.example');
  });

  it('an admin cannot offboard themselves (TC-I-10)', async () => {
    const res = await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: adminId });
    expect(res.kind).toBe('self-offboard-blocked');
    const [u] = await db.select().from(users).where(eq(users.id, adminId));
    expect(u.email).toBe('admin@off.example');
  });

  it('rolls back the whole offboard when machine revocation throws (TC-I-12)', async () => {
    await seedMachine(devId);
    await expect(
      offboardUserCore(
        db,
        { orgId, actorUserId: adminId, targetUserId: devId },
        { revokeMachines: async () => { throw new Error('boom-revoke'); } },
      ),
    ).rejects.toThrow(/boom-revoke/);
    const [u] = await db.select().from(users).where(eq(users.id, devId));
    expect(u.email).toBe('dev@off.example'); // original preserved
    const machines = await db.select().from(userMachines).where(eq(userMachines.userId, devId));
    expect(machines.every((m) => m.revokedAt === null)).toBe(true);
    const audit = await db.select().from(onboardingAuditLog).where(eq(onboardingAuditLog.action, 'user-offboarded'));
    expect(audit).toHaveLength(0);
  });

  it('the anonymized dev renders as a departed fallback label with no old email (TC-I-13)', async () => {
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    const [u] = await db
      .select({ label: sql<string>`COALESCE(${users.displayName}, split_part(${users.email}, '@', 1))` })
      .from(users)
      .where(eq(users.id, devId));
    expect(u.label).toBe(`departed-${devId}`);
    expect(u.label).not.toContain('dev@off.example');
  });

  it('SSO cannot relink the anonymized account via the old email (TC-I-14)', async () => {
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    // SSO auto-provision resolves a pre-existing user by (org_id, email) — the
    // exact query the resolver runs. After offboard the old email matches no
    // row, so a returning SSO login provisions a NEW user instead of relinking.
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, 'dev@off.example')));
    expect(found).toHaveLength(0);
  });

  it('scrubs userEmail from legacy machine-revoked audit metadata (TC-I-16)', async () => {
    const machineId = await seedMachine(devId);
    // A legacy audit row that still carries the plaintext email in metadata.
    await db.insert(onboardingAuditLog).values({
      orgId, actorUserId: adminId, action: 'machine-revoked', targetTokenPrefix: 'k_legacy',
      metadata: { keyPrefix: 'k_legacy', machineId, userEmail: 'dev@off.example' },
    });
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    const [row] = await db.select().from(onboardingAuditLog).where(eq(onboardingAuditLog.action, 'machine-revoked'));
    expect(JSON.stringify(row.metadata)).not.toContain('dev@off.example');
    expect(JSON.stringify(row.metadata)).toContain('k_legacy'); // other keys preserved
  });

  it('scrubs userEmail from a legacy audit row that has NO machineId (matched by email) (TC-I-16b)', async () => {
    // Defense-in-depth: a legacy row whose metadata lacks machineId is scrubbed
    // via the email predicate, using the pre-anonymization email.
    await db.insert(onboardingAuditLog).values({
      orgId, actorUserId: adminId, action: 'machine-revoked', targetTokenPrefix: 'k_nomach',
      metadata: { keyPrefix: 'k_nomach', userEmail: 'dev@off.example' },
    });
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    const rows = await db.select().from(onboardingAuditLog).where(eq(onboardingAuditLog.action, 'machine-revoked'));
    for (const r of rows) {
      expect(JSON.stringify(r.metadata)).not.toContain('dev@off.example');
    }
  });

  it('nulls reason_text on the target drilldown-audit rows (TC-I-17)', async () => {
    await db.insert(managerDrilldownAudit).values({
      orgId, managerUserId: adminId, targetUserId: devId, reason: 'other', reasonText: 'contains dev@off.example',
      sourceRoute: '/manager/devs/[devId]', viewedOn: '2026-01-01', viewedAt: new Date(),
    });
    await offboardUserCore(db, { orgId, actorUserId: adminId, targetUserId: devId });
    const [row] = await db.select().from(managerDrilldownAudit).where(eq(managerDrilldownAudit.targetUserId, devId));
    expect(row.reasonText).toBeNull();
  });
});
