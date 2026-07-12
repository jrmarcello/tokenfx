/**
 * Integration + unit tests for the machine-revocation query layer.
 * Spec: .specs/machine-revocation-ui.md (REQ-1, REQ-2, REQ-3, REQ-5, REQ-6).
 *
 * Postgres-backed via the shared Testcontainers setup (setup-pg.ts). Skipped
 * under SKIP_PG_TESTS=1. Hand-written stubs, no mocking framework.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { onboardingAuditLog, orgs, userMachines, users } from '@/lib/db/schema';
import {
  listOrgMachines,
  maskKeyId,
  revokeMachineCore,
  revokeMachineUpdateForTest,
} from '@/lib/queries/machines';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// Deterministic-but-unique key id: `k_` + 16 hex. Prefix = first 8 chars.
const makeKeyId = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `k_${hex}${hex}`.slice(0, 18);
};

describe('maskKeyId', () => {
  it('TC-U-02: returns the first 8 chars (k_ + 6 hex), satisfying the length-8 audit CHECK', () => {
    const keyId = 'k_0123456789abcdef';
    expect(maskKeyId(keyId)).toBe('k_012345');
    expect(maskKeyId(keyId)).toHaveLength(8);
  });
});

skipDescribe('machine-revocation query layer', () => {
  const db = getDb();

  const seedOrg = async (name: string): Promise<string> => {
    const [org] = await db.insert(orgs).values({ name }).returning({ id: orgs.id });
    return org.id;
  };
  const seedUser = async (orgId: string, email: string, role = 'member'): Promise<string> => {
    const [u] = await db
      .insert(users)
      .values({ orgId, email, role })
      .returning({ id: users.id });
    return u.id;
  };
  const seedMachine = async (
    userId: string,
    keyId: string,
    opts: { revoked?: boolean } = {},
  ): Promise<void> => {
    await db.insert(userMachines).values({
      userId,
      machineId: randomUUID(),
      keyId,
      secretHash: 'bcrypt$placeholder',
      revokedAt: opts.revoked ? new Date() : null,
    });
  };

  afterEach(async () => {
    // Clean per-test rows. FK children first.
    await db.delete(onboardingAuditLog).where(eq(onboardingAuditLog.action, 'machine-revoked'));
    // user_machines / users / orgs cascade on org delete via users FK.
    await db.delete(userMachines);
    await db.delete(users);
    await db.delete(orgs);
  });

  it('lists only the org machines, with owner email + status (TC-I-01)', async () => {
    const orgA = await seedOrg('MachOrgA');
    const admin = await seedUser(orgA, 'admin@a.example', 'admin');
    const dev = await seedUser(orgA, 'dev@a.example', 'member');
    await seedMachine(admin, makeKeyId('a-admin'));
    await seedMachine(dev, makeKeyId('a-dev')); // a different user's machine
    const orgB = await seedOrg('MachOrgB');
    const devB = await seedUser(orgB, 'dev@b.example', 'member');
    await seedMachine(devB, makeKeyId('b-dev'));

    const rows = await listOrgMachines(db, orgA);
    expect(rows).toHaveLength(2);
    const emails = rows.map((r) => r.userEmail).sort();
    expect(emails).toEqual(['admin@a.example', 'dev@a.example']);
    // Only the prefix is exposed — never the full key id.
    for (const r of rows) {
      expect(r.keyPrefix).toHaveLength(8);
      expect(r).not.toHaveProperty('keyId');
    }
  });

  it('returns [] for an org with no machines (TC-I-02)', async () => {
    const org = await seedOrg('EmptyOrg');
    expect(await listOrgMachines(db, org)).toEqual([]);
  });

  it('revokes an active machine belonging to another user in the org (TC-I-03)', async () => {
    const org = await seedOrg('RevOrg');
    const admin = await seedUser(org, 'admin@rev.example', 'admin');
    const dev = await seedUser(org, 'dev@rev.example', 'member');
    const keyId = makeKeyId('rev-dev');
    await seedMachine(dev, keyId);

    const res = await revokeMachineCore(db, {
      orgId: org,
      actorUserId: admin,
      keyPrefix: keyId.slice(0, 8),
    });
    expect(res.kind).toBe('revoked');
    const row = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyId));
    expect(row[0].revokedAt).not.toBeNull();
  });

  it('is idempotent — second revoke returns already-revoked, timestamp preserved (TC-I-04)', async () => {
    const org = await seedOrg('IdemOrg');
    const admin = await seedUser(org, 'admin@idem.example', 'admin');
    const keyId = makeKeyId('idem');
    await seedMachine(admin, keyId);
    const prefix = keyId.slice(0, 8);

    const first = await revokeMachineCore(db, { orgId: org, actorUserId: admin, keyPrefix: prefix });
    expect(first.kind).toBe('revoked');
    const afterFirst = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyId));
    const ts1 = afterFirst[0].revokedAt;

    const second = await revokeMachineCore(db, { orgId: org, actorUserId: admin, keyPrefix: prefix });
    expect(second.kind).toBe('already-revoked');
    const afterSecond = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyId));
    expect(afterSecond[0].revokedAt).toEqual(ts1);
  });

  it('cross-org revoke is not-found and leaves the foreign machine active (TC-I-05)', async () => {
    const orgA = await seedOrg('XOrgA');
    const adminA = await seedUser(orgA, 'admin@xa.example', 'admin');
    const orgB = await seedOrg('XOrgB');
    const devB = await seedUser(orgB, 'dev@xb.example', 'member');
    const keyIdB = makeKeyId('x-b');
    await seedMachine(devB, keyIdB);

    const res = await revokeMachineCore(db, {
      orgId: orgA,
      actorUserId: adminA,
      keyPrefix: keyIdB.slice(0, 8),
    });
    expect(res.kind).toBe('not-found');
    const row = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyIdB));
    expect(row[0].revokedAt).toBeNull();
  });

  it('the self-guarding UPDATE no-ops for a foreign org even if the resolve is bypassed (TC-I-05b)', async () => {
    const orgA = await seedOrg('SgOrgA');
    const orgB = await seedOrg('SgOrgB');
    const devB = await seedUser(orgB, 'dev@sgb.example', 'member');
    const keyIdB = makeKeyId('sg-b');
    await seedMachine(devB, keyIdB);

    // Call the exported UPDATE directly with orgA but a key resolved from orgB.
    const affected = await revokeMachineUpdateForTest(db, {
      orgId: orgA,
      keyId: keyIdB,
    });
    expect(affected).toBe(0);
    const row = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyIdB));
    expect(row[0].revokedAt).toBeNull();
  });

  it('returns not-found for a non-existent prefix (TC-I-06)', async () => {
    const org = await seedOrg('NfOrg');
    const admin = await seedUser(org, 'admin@nf.example', 'admin');
    const res = await revokeMachineCore(db, {
      orgId: org,
      actorUserId: admin,
      keyPrefix: 'k_ffffff',
    });
    expect(res.kind).toBe('not-found');
  });

  it('returns collision when two machines in the org share an 8-char prefix (TC-I-06b)', async () => {
    const org = await seedOrg('ColOrg');
    const admin = await seedUser(org, 'admin@col.example', 'admin');
    const dev = await seedUser(org, 'dev@col.example', 'member');
    // Two distinct key ids with identical first 8 chars.
    await seedMachine(admin, 'k_abcdef1111111111');
    await seedMachine(dev, 'k_abcdef2222222222');

    const res = await revokeMachineCore(db, {
      orgId: org,
      actorUserId: admin,
      keyPrefix: 'k_abcde f'.replace(' ', ''),
    });
    expect(res.kind).toBe('collision');
    // Neither revoked.
    const rows = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines);
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  it('writes exactly one prefix-only machine-revoked audit row (TC-I-07)', async () => {
    const org = await seedOrg('AudOrg');
    const admin = await seedUser(org, 'admin@aud.example', 'admin');
    const dev = await seedUser(org, 'dev@aud.example', 'member');
    const keyId = makeKeyId('aud');
    await seedMachine(dev, keyId);
    const prefix = keyId.slice(0, 8);

    await revokeMachineCore(db, { orgId: org, actorUserId: admin, keyPrefix: prefix });

    const audit = await db
      .select()
      .from(onboardingAuditLog)
      .where(eq(onboardingAuditLog.action, 'machine-revoked'));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(admin);
    expect(audit[0].targetTokenPrefix).toBe(prefix);
    const meta = JSON.stringify(audit[0].metadata);
    // Prefix-only: full key id must not appear.
    expect(meta).not.toContain(keyId);
    expect(meta).toContain(prefix);
    // TC-I-18 / REQ-4b: metadata carries userId, NOT a plaintext email — so an
    // offboarding sweep can anonymize it. Proves machines.ts passes userId.
    expect(meta).toContain(dev);
    expect(meta).not.toContain('@');
  });

  it('rolls back the revoke when the UPDATE throws — no partial state (TC-I-11a)', async () => {
    const org = await seedOrg('Rb1Org');
    const admin = await seedUser(org, 'admin@rb1.example', 'admin');
    const keyId = makeKeyId('rb1');
    await seedMachine(admin, keyId);

    await expect(
      revokeMachineCore(
        db,
        { orgId: org, actorUserId: admin, keyPrefix: keyId.slice(0, 8) },
        { runUpdate: async () => { throw new Error('boom-update'); } },
      ),
    ).rejects.toThrow(/boom-update/);
    const row = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyId));
    expect(row[0].revokedAt).toBeNull();
  });

  it('rolls back the revoke when the audit INSERT throws — never revoke without audit (TC-I-11b)', async () => {
    const org = await seedOrg('Rb2Org');
    const admin = await seedUser(org, 'admin@rb2.example', 'admin');
    const keyId = makeKeyId('rb2');
    await seedMachine(admin, keyId);

    await expect(
      revokeMachineCore(
        db,
        { orgId: org, actorUserId: admin, keyPrefix: keyId.slice(0, 8) },
        { writeAudit: async () => { throw new Error('boom-audit'); } },
      ),
    ).rejects.toThrow(/boom-audit/);
    const row = await db
      .select({ revokedAt: userMachines.revokedAt })
      .from(userMachines)
      .where(eq(userMachines.keyId, keyId));
    expect(row[0].revokedAt).toBeNull();
    const audit = await db
      .select()
      .from(onboardingAuditLog)
      .where(eq(onboardingAuditLog.action, 'machine-revoked'));
    expect(audit).toHaveLength(0);
  });

  it('propagates a DB error from listOrgMachines cleanly (TC-I-12)', async () => {
    // A poisoned db-like stub whose select() throws — proves the page error
    // boundary sees a real rejection, not a silent empty list.
    const poisoned = {
      select: () => {
        throw new Error('boom-select');
      },
    } as unknown as Parameters<typeof listOrgMachines>[0];
    await expect(listOrgMachines(poisoned, 'any-org')).rejects.toThrow(/boom-select/);
  });
});
