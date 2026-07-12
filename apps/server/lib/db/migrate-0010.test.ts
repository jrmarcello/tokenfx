/**
 * Integration tests for migration 0010 (user-offboarded audit action).
 *
 * Spec: .specs/data-retention-policy.md (REQ-7)
 * Migration: apps/server/lib/db/migrations/0010_user_offboarded_audit_action.sql
 *
 * The migration is applied by `tests/integration/setup-pg.ts` (journal +
 * orphan-apply) before the suite runs, so by test time the Postgres enum
 * `onboarding_audit_action` already carries 'user-offboarded'. These tests
 * prove both sides of the enum are in sync:
 *   - TC-I-15  — raw SQL INSERT with the new action value succeeds.
 *   - TC-I-15b — the Drizzle typed insert (onboardingAuditLog) accepts it,
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

const PREFIX = 'a1b2c3d4'; // 8 hex chars (user_id prefix), satisfies length=8

describe('migration 0010 — journal registration (REQ-7)', () => {
  it('registers the 0010 tag at idx 10 so the production runner applies it (TC-I-15 journal)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find(
      (e) => e.tag === '0010_user_offboarded_audit_action',
    );
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(10);
  });
});

skipDescribe('migration 0010 — user-offboarded enum value (REQ-7)', () => {
  const db = getDb();

  afterAll(() => {
    closeDb();
  });

  const seedOrgAndActor = async (): Promise<{ orgId: string; actorId: string }> => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `Migrate0010Org-${Math.floor(Date.now() % 1_000_000)}` })
      .returning({ id: orgs.id });
    const [actor] = await db
      .insert(users)
      .values({ orgId: org.id, email: `admin-${org.id}@example.com`, role: 'admin' })
      .returning({ id: users.id });
    return { orgId: org.id, actorId: actor.id };
  };

  it('accepts the user-offboarded action via raw SQL INSERT (TC-I-15)', async () => {
    const { orgId, actorId } = await seedOrgAndActor();
    await expect(
      db.execute(sql`
        INSERT INTO onboarding_audit_log (org_id, actor_user_id, action, target_token_prefix)
        VALUES (${orgId}, ${actorId}, 'user-offboarded', ${PREFIX})
      `),
    ).resolves.toBeDefined();
  });

  it('accepts the user-offboarded action via the Drizzle typed insert (TC-I-15b)', async () => {
    const { orgId, actorId } = await seedOrgAndActor();
    // If schema.ts's enum array were NOT updated, this line would fail to
    // typecheck — the assertion is that it both compiles and runs.
    await expect(
      db.insert(onboardingAuditLog).values({
        orgId,
        actorUserId: actorId,
        action: 'user-offboarded',
        targetTokenPrefix: PREFIX,
        metadata: { targetUserId: '00000000-0000-0000-0000-000000000009' },
      }),
    ).resolves.toBeDefined();
  });
});
