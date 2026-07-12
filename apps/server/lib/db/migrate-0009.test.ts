/**
 * Integration tests for migration 0009 (machine-revoked audit action).
 *
 * Spec: .specs/machine-revocation-ui.md (REQ-6)
 * Migration: apps/server/lib/db/migrations/0009_machine_revoked_audit_action.sql
 *
 * The migration is applied by `tests/integration/setup-pg.ts` (journal +
 * orphan-apply) before the suite runs, so by test time the Postgres enum
 * `onboarding_audit_action` already carries 'machine-revoked'. These tests
 * prove both sides of the enum are in sync:
 *   - TC-I-08  — raw SQL INSERT with the new action value succeeds.
 *   - TC-I-08b — the Drizzle typed insert (onboardingAuditLog) accepts it,
 *     proving lib/db/schema.ts was updated in lockstep (no TS↔Postgres drift).
 *
 * The journal-registration check is a pure filesystem assertion and runs even
 * under SKIP_PG_TESTS=1.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { onboardingAuditLog, orgs, users } from '@/lib/db/schema';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const journalPath = path.resolve(
  __dirname,
  'migrations',
  'meta',
  '_journal.json',
);

const PREFIX = 'k_a1b2c3'; // 8 chars, satisfies length(target_token_prefix)=8

describe('migration 0009 — journal registration (REQ-6)', () => {
  it('registers the 0009 tag at idx 9 so the production runner applies it (TC-I-08 journal)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find(
      (e) => e.tag === '0009_machine_revoked_audit_action',
    );
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(9);
  });
});

skipDescribe('migration 0009 — machine-revoked enum value (REQ-6)', () => {
  const db = getDb();

  afterAll(() => {
    closeDb();
  });

  const seedOrgAndActor = async (): Promise<{ orgId: string; actorId: string }> => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `Migrate0009Org-${Math.floor(Date.now() % 1_000_000)}` })
      .returning({ id: orgs.id });
    const [actor] = await db
      .insert(users)
      .values({ orgId: org.id, email: `admin-${org.id}@example.com`, role: 'admin' })
      .returning({ id: users.id });
    return { orgId: org.id, actorId: actor.id };
  };

  it('accepts the machine-revoked action via raw SQL INSERT (TC-I-08)', async () => {
    const { orgId, actorId } = await seedOrgAndActor();
    await expect(
      db.execute(sql`
        INSERT INTO onboarding_audit_log (org_id, actor_user_id, action, target_token_prefix)
        VALUES (${orgId}, ${actorId}, 'machine-revoked', ${PREFIX})
      `),
    ).resolves.toBeDefined();
  });

  it('accepts the machine-revoked action via the Drizzle typed insert (TC-I-08b)', async () => {
    const { orgId, actorId } = await seedOrgAndActor();
    // If schema.ts's enum array were NOT updated, this line would fail to
    // typecheck — the assertion is that it both compiles and runs.
    await expect(
      db.insert(onboardingAuditLog).values({
        orgId,
        actorUserId: actorId,
        action: 'machine-revoked',
        targetTokenPrefix: PREFIX,
        metadata: { keyPrefix: PREFIX, machineId: null, userEmail: 'x@example.com' },
      }),
    ).resolves.toBeDefined();
  });
});
