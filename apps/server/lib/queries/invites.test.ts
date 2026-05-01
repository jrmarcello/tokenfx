/**
 * Integration tests for invite queries (TASK-7, REQ-18..20).
 *
 * Postgres-backed via Testcontainers. Skipped when SKIP_PG_TESTS=1.
 *
 * TC mappings:
 *   - TC-I-10  — happy create: row inserted, token + prefix returned, audit row.
 *   - TC-I-23  — revoke active invite: revoked_at set, kind='revoked'.
 *   - TC-I-24  — idempotent revoke: already-revoked → kind='already-revoked'.
 *   - TC-I-25  — org scope: org A's manager can't revoke org B's invite.
 *   - TC-I-26  — prefix collision: forced via direct INSERT → kind='collision'.
 *   - TC-I-27  — list orders by created_at DESC.
 *   - TC-I-28  — list scoped to org.
 *   - TC-I-29  — status derivation: 4 invites with each status.
 *   - TC-I-30  — list response only ever exposes the 8-char prefix.
 *   - TC-I-21  — createInviteCore idempotency cache hit (1 row in DB).
 *   - TC-I-21b — different actor + same key → 2 rows.
 *   - TC-I-21c — same key after TTL → 2 rows.
 *   - TC-I-22  — different keys → 2 rows.
 *   - TC-I-60  — audit row written on create.
 *   - TC-I-60c — audit metadata JSONB shape exact match.
 *   - TC-I-60d — actor_user_id matches creator (manager OR admin).
 *   - TC-I-60b — audit org-scope: org A's audit query doesn't see org B's row.
 *   - TC-I-61  — audit row written on revoke.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  onboardingAuditLog,
  onboardingInvites,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';
import {
  __resetIdempotencyCache,
  createInviteCore,
  createInviteRow,
  deriveInviteStatus,
  listInvitesForOrg,
  revokeInviteByPrefix,
  revokeInviteCore,
} from './invites';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// Org/team/user state shared across the file. `beforeAll` wipes + seeds it
// once; `afterEach` clears the invite + audit rows so individual tests start
// with an empty invite table while preserving the parent FKs.
let orgAId = '';
let orgBId = '';
let teamId = '';
let managerAId = '';
let managerBId = '';
let adminAId = '';

skipDescribe('invite queries (Postgres integration)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);

    const [a] = await db
      .insert(orgs)
      .values({ name: 'OrgA' })
      .returning({ id: orgs.id });
    const [b] = await db
      .insert(orgs)
      .values({ name: 'OrgB' })
      .returning({ id: orgs.id });
    orgAId = a.id;
    orgBId = b.id;

    const [t] = await db
      .insert(teams)
      .values({ orgId: orgAId, name: 'Engineering' })
      .returning({ id: teams.id });
    teamId = t.id;

    const [mgrA] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'manager-a@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-mgrA',
        role: 'manager',
      })
      .returning({ id: users.id });
    managerAId = mgrA.id;

    const [mgrB] = await db
      .insert(users)
      .values({
        orgId: orgBId,
        email: 'manager-b@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-mgrB',
        role: 'manager',
      })
      .returning({ id: users.id });
    managerBId = mgrB.id;

    const [admA] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'admin-a@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-admA',
        role: 'admin',
      })
      .returning({ id: users.id });
    adminAId = admA.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    __resetIdempotencyCache();
  });

  afterEach(async () => {
    const db = getDb();
    // Order matters: audit_log has no FK to invites but both reference orgs.
    // Delete invites first to keep things tidy regardless.
    await db.delete(onboardingInvites);
    await db.delete(onboardingAuditLog);
  });

  // -------------------------------------------------------------------------
  // createInviteRow — TC-I-10 happy path.
  // -------------------------------------------------------------------------

  describe('createInviteRow', () => {
    it('TC-I-10: inserts a row and returns token + 8-char prefix', async () => {
      const db = getDb();
      const expiresAt = new Date(Date.now() + 8 * 3600 * 1000);
      const result = await createInviteRow(db, {
        orgId: orgAId,
        teamId,
        emailPattern: '*@example.com',
        maxUses: 1,
        expiresAt,
        createdBy: managerAId,
      });

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.tokenPrefix).toBe(result.token.slice(0, 8));
      expect(result.expiresAt.getTime()).toBe(expiresAt.getTime());

      const [row] = await db
        .select()
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, result.token));
      expect(row).toBeDefined();
      expect(row.orgId).toBe(orgAId);
      expect(row.maxUses).toBe(1);
      expect(row.usedCount).toBe(0);
      expect(row.revokedAt).toBeNull();
      expect(row.createdBy).toBe(managerAId);
    });

    it('accepts null teamId / emailPattern / createdBy', async () => {
      const db = getDb();
      const result = await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 5,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: null,
      });
      const [row] = await db
        .select()
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, result.token));
      expect(row.teamId).toBeNull();
      expect(row.emailPattern).toBeNull();
      expect(row.createdBy).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // revokeInviteByPrefix — TC-I-23..26.
  // -------------------------------------------------------------------------

  describe('revokeInviteByPrefix', () => {
    it('TC-I-23: revokes an active invite and returns kind="revoked"', async () => {
      const db = getDb();
      const created = await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      const result = await revokeInviteByPrefix(db, {
        prefix: created.tokenPrefix,
        orgId: orgAId,
      });
      expect(result).toEqual({ kind: 'revoked', tokenPrefix: created.tokenPrefix });

      const [row] = await db
        .select({ revokedAt: onboardingInvites.revokedAt })
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, created.token));
      expect(row.revokedAt).not.toBeNull();
    });

    it('TC-I-24: revoking an already-revoked invite is idempotent (kind="already-revoked")', async () => {
      const db = getDb();
      const created = await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      const first = await revokeInviteByPrefix(db, {
        prefix: created.tokenPrefix,
        orgId: orgAId,
      });
      expect(first.kind).toBe('revoked');

      const [beforeSecond] = await db
        .select({ revokedAt: onboardingInvites.revokedAt })
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, created.token));
      const initialRevokedAt = beforeSecond.revokedAt?.getTime();

      // Sleep briefly so a buggy implementation that updates the timestamp
      // again would produce a measurable diff.
      await new Promise((r) => setTimeout(r, 5));

      const second = await revokeInviteByPrefix(db, {
        prefix: created.tokenPrefix,
        orgId: orgAId,
      });
      expect(second).toEqual({
        kind: 'already-revoked',
        tokenPrefix: created.tokenPrefix,
      });

      const [afterSecond] = await db
        .select({ revokedAt: onboardingInvites.revokedAt })
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, created.token));
      expect(afterSecond.revokedAt?.getTime()).toBe(initialRevokedAt);
    });

    it('TC-I-25: cross-org revoke returns "not-found" (tenant scope, no existence leak)', async () => {
      const db = getDb();
      // Org A creates an invite; org B's manager attempts to revoke.
      const created = await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      const result = await revokeInviteByPrefix(db, {
        prefix: created.tokenPrefix,
        orgId: orgBId, // different org
      });
      expect(result).toEqual({ kind: 'not-found' });

      // Original row still active (defense-in-depth — confirm the cross-org
      // call did not silently revoke).
      const [row] = await db
        .select({ revokedAt: onboardingInvites.revokedAt })
        .from(onboardingInvites)
        .where(eq(onboardingInvites.token, created.token));
      expect(row.revokedAt).toBeNull();
    });

    it('TC-I-26: prefix collision (2 active invites with same 8-char prefix) → kind="collision"', async () => {
      const db = getDb();
      // Force the collision by inserting two rows with hand-crafted tokens
      // that share the first 8 chars. The PRIMARY KEY is on the full 64-char
      // token, so two distinct full tokens with a shared prefix are legal.
      const sharedPrefix = 'cafef00d';
      const tokenA = sharedPrefix + 'a'.repeat(56);
      const tokenB = sharedPrefix + 'b'.repeat(56);
      await db.insert(onboardingInvites).values({
        token: tokenA,
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      await db.insert(onboardingInvites).values({
        token: tokenB,
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });

      const result = await revokeInviteByPrefix(db, {
        prefix: sharedPrefix,
        orgId: orgAId,
      });
      expect(result.kind).toBe('collision');
      if (result.kind === 'collision') {
        expect(result.matchCount).toBeGreaterThanOrEqual(2);
      }

      // Neither row should have been revoked.
      const rows = await db
        .select({ token: onboardingInvites.token, revokedAt: onboardingInvites.revokedAt })
        .from(onboardingInvites)
        .where(
          and(
            sql`left(${onboardingInvites.token}, 8) = ${sharedPrefix}`,
            eq(onboardingInvites.orgId, orgAId),
          ),
        );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.revokedAt).toBeNull();
    });

    it('returns "not-found" when prefix has the wrong length (defense-in-depth)', async () => {
      const db = getDb();
      const result = await revokeInviteByPrefix(db, {
        prefix: 'tooshort', // 8 chars actually, so use 7 below
        orgId: orgAId,
      });
      // 'tooshort' is exactly 8 chars — this exercises a non-matching prefix.
      expect(result.kind).toBe('not-found');

      const result7 = await revokeInviteByPrefix(db, {
        prefix: 'short7c',
        orgId: orgAId,
      });
      expect(result7.kind).toBe('not-found');
    });
  });

  // -------------------------------------------------------------------------
  // listInvitesForOrg — TC-I-27..30.
  // -------------------------------------------------------------------------

  describe('listInvitesForOrg', () => {
    it('TC-I-27: returns rows for the org sorted by created_at DESC', async () => {
      const db = getDb();
      // Insert with explicit createdAt so the test isn't time-dependent.
      const now = Date.now();
      const tokens = [
        'a'.repeat(64), // 1st created (oldest)
        'b'.repeat(64), // 2nd
        'c'.repeat(64), // 3rd (newest)
      ];
      for (let i = 0; i < tokens.length; i++) {
        await db.insert(onboardingInvites).values({
          token: tokens[i],
          orgId: orgAId,
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresAt: new Date(now + 60_000),
          createdBy: managerAId,
          createdAt: new Date(now - (tokens.length - 1 - i) * 10_000),
        });
      }

      const list = await listInvitesForOrg(db, orgAId);
      expect(list).toHaveLength(3);
      // Newest first.
      expect(list[0].tokenPrefix).toBe('cccccccc');
      expect(list[1].tokenPrefix).toBe('bbbbbbbb');
      expect(list[2].tokenPrefix).toBe('aaaaaaaa');
    });

    it('TC-I-28: scoped to org — only returns the org\'s own invites', async () => {
      const db = getDb();
      // Org A: 1 invite, Org B: 2 invites.
      await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      await createInviteRow(db, {
        orgId: orgBId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerBId,
      });
      await createInviteRow(db, {
        orgId: orgBId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerBId,
      });

      const aList = await listInvitesForOrg(db, orgAId);
      const bList = await listInvitesForOrg(db, orgBId);
      expect(aList).toHaveLength(1);
      expect(bList).toHaveLength(2);
    });

    it.each([
      {
        scenario: 'active',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        usedCount: 0,
        maxUses: 5,
        expected: 'active' as const,
      },
      {
        scenario: 'revoked (priority over expired/exhausted)',
        revokedAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 1000), // also expired, but revoked wins
        usedCount: 5,
        maxUses: 5, // also exhausted, but revoked wins
        expected: 'revoked' as const,
      },
      {
        scenario: 'expired',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        usedCount: 0,
        maxUses: 5,
        expected: 'expired' as const,
      },
      {
        scenario: 'exhausted',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        usedCount: 5,
        maxUses: 5,
        expected: 'exhausted' as const,
      },
    ])(
      'TC-I-29: status derivation — $scenario → $expected',
      async ({ revokedAt, expiresAt, usedCount, maxUses, expected }) => {
        const db = getDb();
        // Use a unique token per case so the DB inserts don't collide.
        const token = (expected + '_').padEnd(8, 'x') + 'x'.repeat(56);
        await db.insert(onboardingInvites).values({
          token: token.slice(0, 64),
          orgId: orgAId,
          teamId: null,
          emailPattern: null,
          maxUses,
          usedCount,
          expiresAt,
          revokedAt,
          createdBy: managerAId,
        });

        const list = await listInvitesForOrg(db, orgAId);
        expect(list).toHaveLength(1);
        expect(list[0].status).toBe(expected);
      },
    );

    it('TC-I-30: list response only ever exposes the 8-char prefix (no full token)', async () => {
      const db = getDb();
      const created = await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      const list = await listInvitesForOrg(db, orgAId);
      expect(list).toHaveLength(1);
      const row = list[0];
      // The exact prefix is exposed.
      expect(row.tokenPrefix).toBe(created.tokenPrefix);
      expect(row.tokenPrefix.length).toBe(8);
      // The full token is NEVER on the row — strict structural check.
      const json = JSON.stringify(row);
      expect(json).not.toContain(created.token);
      // No key on the row holds 64 hex chars.
      for (const v of Object.values(row)) {
        if (typeof v === 'string') {
          expect(/^[0-9a-f]{64}$/.test(v)).toBe(false);
        }
      }
    });

    it('joins team name + creator email; both null when references are gone', async () => {
      const db = getDb();
      // Invite with team + creator → both names visible.
      await createInviteRow(db, {
        orgId: orgAId,
        teamId,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      // Invite with no team and null creator.
      await createInviteRow(db, {
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: null,
      });

      const list = await listInvitesForOrg(db, orgAId);
      expect(list).toHaveLength(2);
      // Find both shapes — order is by created_at DESC; we just look up.
      const withTeam = list.find((r) => r.teamName !== null);
      const withoutTeam = list.find((r) => r.teamName === null);
      expect(withTeam?.teamName).toBe('Engineering');
      expect(withTeam?.createdByEmail).toBe('manager-a@example.com');
      expect(withoutTeam).toBeDefined();
      expect(withoutTeam?.createdByEmail).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createInviteCore — idempotency cache + audit metadata.
  // -------------------------------------------------------------------------

  describe('createInviteCore', () => {
    it('TC-I-10 + TC-I-60: writes a row + audit row with the spec metadata shape', async () => {
      const db = getDb();
      const result = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'idemp-1',
          teamId,
          emailPattern: '*@example.com',
          maxUses: 5,
          expiresInHours: 8,
        },
      );
      expect(result.cached).toBe(false);

      const [auditRow] = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.targetTokenPrefix, result.tokenPrefix));
      expect(auditRow).toBeDefined();
      expect(auditRow.action).toBe('invite-created');
      expect(auditRow.orgId).toBe(orgAId);
      expect(auditRow.actorUserId).toBe(managerAId);
      // TC-I-60c: metadata exact JSON shape (4 keys).
      expect(auditRow.metadata).toEqual({
        max_uses: 5,
        expires_at: result.expiresAt.toISOString(),
        email_pattern: '*@example.com',
        team_id: teamId,
      });
    });

    it('TC-I-21: same idempotency_key within TTL → cached token, single DB row', async () => {
      const db = getDb();
      const fixedNow = new Date('2026-04-30T10:00:00Z');
      const r1 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'idemp-2',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
          now: fixedNow,
        },
      );
      const r2 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'idemp-2',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
          now: new Date(fixedNow.getTime() + 60_000), // 1 min later, still in TTL
        },
      );
      expect(r1.cached).toBe(false);
      expect(r2.cached).toBe(true);
      expect(r2.token).toBe(r1.token);
      expect(r2.tokenPrefix).toBe(r1.tokenPrefix);

      const rows = await db
        .select({ id: onboardingInvites.token })
        .from(onboardingInvites);
      expect(rows).toHaveLength(1);

      // Audit row only written once.
      const auditRows = await db.select().from(onboardingAuditLog);
      expect(auditRows).toHaveLength(1);
    });

    it('TC-I-21b: different actor + same key → 2 distinct tokens (key tuple is (actor, key))', async () => {
      const db = getDb();
      const r1 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'shared-key',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      // Admin in same org submits using the same client-generated UUID.
      const r2 = await createInviteCore(
        { db },
        {
          actorUserId: adminAId,
          orgId: orgAId,
          idempotencyKey: 'shared-key',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      expect(r1.cached).toBe(false);
      expect(r2.cached).toBe(false);
      expect(r2.token).not.toBe(r1.token);

      const rows = await db.select().from(onboardingInvites);
      expect(rows).toHaveLength(2);
    });

    it('TC-I-21c: same idempotency_key after TTL → new token (no cache hit)', async () => {
      const db = getDb();
      const fixedNow = new Date('2026-04-30T10:00:00Z');
      const r1 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'idemp-3',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
          now: fixedNow,
        },
      );
      // 6 minutes later — past 5-min TTL.
      const r2 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'idemp-3',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
          now: new Date(fixedNow.getTime() + 6 * 60 * 1000),
        },
      );
      expect(r2.cached).toBe(false);
      expect(r2.token).not.toBe(r1.token);

      const rows = await db.select().from(onboardingInvites);
      expect(rows).toHaveLength(2);
    });

    it('TC-I-22: different idempotency_key → 2 distinct tokens', async () => {
      const db = getDb();
      const r1 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'key-A',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      const r2 = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'key-B',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      expect(r1.token).not.toBe(r2.token);
      const rows = await db.select().from(onboardingInvites);
      expect(rows).toHaveLength(2);
    });

    it('TC-I-60d: actor_user_id matches creator regardless of role (manager OR admin)', async () => {
      const db = getDb();
      const mgrInvite = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'mgr-1',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      const admInvite = await createInviteCore(
        { db },
        {
          actorUserId: adminAId,
          orgId: orgAId,
          idempotencyKey: 'adm-1',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );

      const [mgrAudit] = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.targetTokenPrefix, mgrInvite.tokenPrefix));
      const [admAudit] = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.targetTokenPrefix, admInvite.tokenPrefix));

      expect(mgrAudit.actorUserId).toBe(managerAId);
      expect(admAudit.actorUserId).toBe(adminAId);
    });

    it('TC-I-60b: org A audit query returns 0 rows for org B\'s create', async () => {
      const db = getDb();
      await createInviteCore(
        { db },
        {
          actorUserId: managerBId,
          orgId: orgBId,
          idempotencyKey: 'b-1',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      const aRows = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.orgId, orgAId));
      expect(aRows).toHaveLength(0);

      const bRows = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.orgId, orgBId));
      expect(bRows).toHaveLength(1);
    });

    it('returns full token (only) on the result so the Server Action can put it in the flash cookie', async () => {
      const db = getDb();
      const result = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'tok-shape',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.tokenPrefix).toBe(result.token.slice(0, 8));
    });
  });

  // -------------------------------------------------------------------------
  // revokeInviteCore — TC-I-23 wrapper + TC-I-61 audit.
  // -------------------------------------------------------------------------

  describe('revokeInviteCore', () => {
    it('TC-I-61: writes audit row on revoke (action=invite-revoked, metadata=null)', async () => {
      const db = getDb();
      const created = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'rev-1',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      const result = await revokeInviteCore(
        { db },
        { actorUserId: managerAId, orgId: orgAId, prefix: created.tokenPrefix },
      );
      expect(result).toEqual({ ok: true, kind: 'revoked', tokenPrefix: created.tokenPrefix });

      const auditRows = await db
        .select()
        .from(onboardingAuditLog)
        .where(
          and(
            eq(onboardingAuditLog.targetTokenPrefix, created.tokenPrefix),
            eq(onboardingAuditLog.action, 'invite-revoked'),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata).toBeNull();
      expect(auditRows[0].actorUserId).toBe(managerAId);
    });

    it('does NOT write a duplicate audit row on already-revoked replay', async () => {
      const db = getDb();
      const created = await createInviteCore(
        { db },
        {
          actorUserId: managerAId,
          orgId: orgAId,
          idempotencyKey: 'rev-2',
          teamId: null,
          emailPattern: null,
          maxUses: 1,
          expiresInHours: 8,
        },
      );
      await revokeInviteCore(
        { db },
        { actorUserId: managerAId, orgId: orgAId, prefix: created.tokenPrefix },
      );
      const second = await revokeInviteCore(
        { db },
        { actorUserId: managerAId, orgId: orgAId, prefix: created.tokenPrefix },
      );
      expect(second).toEqual({
        ok: true,
        kind: 'already-revoked',
        tokenPrefix: created.tokenPrefix,
      });

      const auditRows = await db
        .select()
        .from(onboardingAuditLog)
        .where(eq(onboardingAuditLog.action, 'invite-revoked'));
      // Exactly ONE revoke audit row, despite two calls — no double-counting.
      expect(auditRows).toHaveLength(1);
    });

    it('not-found and collision do not write any audit row', async () => {
      const db = getDb();
      // not-found
      const nf = await revokeInviteCore(
        { db },
        { actorUserId: managerAId, orgId: orgAId, prefix: '00000000' },
      );
      expect(nf).toEqual({ ok: false, kind: 'not-found' });

      // collision
      const sharedPrefix = 'deadbeef';
      await db.insert(onboardingInvites).values({
        token: sharedPrefix + '1'.repeat(56),
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      await db.insert(onboardingInvites).values({
        token: sharedPrefix + '2'.repeat(56),
        orgId: orgAId,
        teamId: null,
        emailPattern: null,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: managerAId,
      });
      const col = await revokeInviteCore(
        { db },
        { actorUserId: managerAId, orgId: orgAId, prefix: sharedPrefix },
      );
      expect(col).toEqual({ ok: false, kind: 'collision' });

      const auditRows = await db.select().from(onboardingAuditLog);
      expect(auditRows).toHaveLength(0);
    });
  });
});

// -------------------------------------------------------------------------
// deriveInviteStatus — pure unit tests (no Postgres needed). Run unconditionally.
// -------------------------------------------------------------------------

describe('deriveInviteStatus (pure)', () => {
  const NOW = new Date('2026-04-30T12:00:00Z');

  it.each([
    {
      desc: 'active when no terminal flags',
      input: {
        revokedAt: null,
        expiresAt: new Date('2026-05-01T12:00:00Z'),
        usedCount: 0,
        maxUses: 5,
      },
      expected: 'active' as const,
    },
    {
      desc: 'revoked beats every other flag',
      input: {
        revokedAt: new Date('2026-04-30T11:00:00Z'),
        expiresAt: new Date('2025-01-01T00:00:00Z'),
        usedCount: 5,
        maxUses: 5,
      },
      expected: 'revoked' as const,
    },
    {
      desc: 'expired beats exhausted',
      input: {
        revokedAt: null,
        expiresAt: new Date('2025-01-01T00:00:00Z'),
        usedCount: 5,
        maxUses: 5,
      },
      expected: 'expired' as const,
    },
    {
      desc: 'exhausted when used_count >= max_uses and not expired/revoked',
      input: {
        revokedAt: null,
        expiresAt: new Date('2026-05-01T12:00:00Z'),
        usedCount: 5,
        maxUses: 5,
      },
      expected: 'exhausted' as const,
    },
    {
      desc: 'expired exactly at expiresAt boundary',
      input: {
        revokedAt: null,
        expiresAt: NOW,
        usedCount: 0,
        maxUses: 5,
      },
      expected: 'expired' as const,
    },
  ])('$desc', ({ input, expected }) => {
    expect(deriveInviteStatus({ ...input, now: NOW })).toBe(expected);
  });
});

// Drizzle import-only assertion for ts-unused-imports tooling — `asc` is
// used implicitly by the SQL builder elsewhere.
void asc;
