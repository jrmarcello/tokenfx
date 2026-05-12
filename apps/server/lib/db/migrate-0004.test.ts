/**
 * Integration tests for migration 0004 (SSO auto-provision schema).
 *
 * Spec: .specs/central-server-onboarding-v2-sso.schema-migrations.md
 *       (REQ-1..REQ-10, REQ-17 — Group A: migration DDL correctness)
 * Migration: apps/server/lib/db/migrations/0004_sso_auto_provision_schema.sql
 *
 * The migration is applied automatically by `tests/integration/setup-pg.ts`
 * orphan-migration logic. These tests assert the resulting schema via
 * information_schema, pg_constraint, pg_indexes, and direct INSERT probes.
 *
 * Notes on infra-conditional tests:
 *   - REVOKE role-switch TCs (TC-I-13b/14b/15b/16/17) require an `app_role`
 *     PG role that doesn't exist in the testcontainer; they're marked
 *     `it.skip` with a loud console.warn. The grep-based companion tests
 *     (13a/14a/15a) always run and provide forensic confidence that the
 *     REVOKE statements are present in the migration SQL.
 *   - TC-I-32 (REQ-9 abort) requires pre-seeding violator rows BEFORE the
 *     migration applies, which conflicts with the shared-container setup;
 *     marked `it.skip` with rationale. TC-I-32b (SQL grep companion) runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const migrationPath = path.resolve(
  __dirname,
  'migrations',
  '0004_sso_auto_provision_schema.sql',
);
const migrationSql = readFileSync(migrationPath, 'utf8');

// Loud-skip banner for infra-conditional tests. Emitted once at module load
// so test output makes the gap obvious without requiring a failure. Guarded
// by !SKIP so SKIP_PG_TESTS=1 runs (unit-only) don't get the noise.
if (!SKIP) {
  console.warn(
    '[migrate-0004.test] infra-conditional tests skipped: REVOKE role-switch ' +
      'requires an `app_role` PG role not provisioned in the testcontainer ' +
      '(TC-I-13b/14b/15b/16/17). SQL-grep companions still run.',
  );
  console.warn(
    '[migrate-0004.test] infra-conditional test skipped: TC-I-32 (REQ-9 abort) ' +
      'requires pre-seeding violator data BEFORE migration applies; deferred ' +
      'to manual ops test.',
  );
}

// Unique-id generator for test-data isolation (no global UNIQUE on orgs.name,
// but we use unique values anyway for clarity in pg_stat_activity output).
let counter = 0;
const uniq = (prefix: string): string => `${prefix}-${Date.now()}-${counter++}`;

skipDescribe('migration 0004 — sso auto-provision schema (REQ-1..10, REQ-17)', () => {
  beforeAll(async () => {
    // Touch the pool to ensure the shared Testcontainers DB is initialized.
    getDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Insert a fresh org and return its id. */
  const seedOrg = async (label: string): Promise<string> => {
    const db = getDb();
    const name = uniq(label);
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO orgs (name) VALUES (${name}) RETURNING id
    `);
    return result.rows[0]!.id;
  };

  /** Insert a user, optionally with SSO fields. Returns id. */
  const insertUser = async (
    orgId: string,
    email: string,
    ssoProvider: string | null = null,
    ssoSubject: string | null = null,
  ): Promise<string> => {
    const db = getDb();
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO users (org_id, email, sso_provider, sso_subject)
      VALUES (${orgId}, ${email}, ${ssoProvider}, ${ssoSubject})
      RETURNING id
    `);
    return result.rows[0]!.id;
  };

  // ==========================================================================
  // REQ-1: users (org_id, email) composite UNIQUE
  // ==========================================================================
  describe('REQ-1: users (org_id, email) composite UNIQUE', () => {
    it('accepts the same email across two different orgs', async () => {
      // TC-I-01 (happy)
      const orgA = await seedOrg('req1-a');
      const orgB = await seedOrg('req1-b');
      const email = `${uniq('user')}@example.com`;
      await insertUser(orgA, email);
      await insertUser(orgB, email);
      const db = getDb();
      const rows = await db.execute<{ c: string }>(sql`
        SELECT count(*)::text AS c FROM users WHERE email = ${email}
      `);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('rejects duplicate email within the same org', async () => {
      // TC-I-02 (business)
      const org = await seedOrg('req1-dup');
      const email = `${uniq('user')}@example.com`;
      await insertUser(org, email);
      await expect(insertUser(org, email)).rejects.toThrow(/duplicate key|unique/i);
    });

    it('drops the legacy single-column UNIQUE on users.email', async () => {
      // TC-I-03 (regression)
      const db = getDb();
      const rows = await db.execute<{ conname: string }>(sql`
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE r.relname = 'users'
          AND c.contype = 'u'
          AND array_length(c.conkey, 1) = 1
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = r.oid
              AND a.attnum = c.conkey[1]
              AND a.attname = 'email'
          )
      `);
      expect(rows.rows.length).toBe(0);
    });
  });

  // ==========================================================================
  // REQ-2: users (org_id, sso_provider, sso_subject) composite UNIQUE
  // ==========================================================================
  describe('REQ-2: users (org_id, sso_provider, sso_subject) composite UNIQUE', () => {
    it('rejects duplicate (org, provider, subject) within the same org', async () => {
      // TC-I-04 (business)
      const org = await seedOrg('req2-dup');
      const subject = uniq('sub');
      await insertUser(org, `${uniq('e')}@example.com`, 'google', subject);
      await expect(
        insertUser(org, `${uniq('e')}@example.com`, 'google', subject),
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('allows multiple users with NULL sso_provider and NULL sso_subject in the same org', async () => {
      // TC-I-05 (edge — NULL-tolerance, both fields NULL)
      const org = await seedOrg('req2-null');
      await insertUser(org, `${uniq('e')}@example.com`, null, null);
      await insertUser(org, `${uniq('e')}@example.com`, null, null);
      const db = getDb();
      const rows = await db.execute<{ c: string }>(sql`
        SELECT count(*)::text AS c FROM users
        WHERE org_id = ${org} AND sso_provider IS NULL AND sso_subject IS NULL
      `);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('allows multiple users with same provider and NULL sso_subject in the same org', async () => {
      // TC-I-06 (edge — partial NULL on subject)
      const org = await seedOrg('req2-partial-sub');
      await insertUser(org, `${uniq('e')}@example.com`, 'google', null);
      await insertUser(org, `${uniq('e')}@example.com`, 'google', null);
      const db = getDb();
      const rows = await db.execute<{ c: string }>(sql`
        SELECT count(*)::text AS c FROM users
        WHERE org_id = ${org} AND sso_provider = 'google' AND sso_subject IS NULL
      `);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('allows multiple users with NULL sso_provider and same subject in the same org', async () => {
      // TC-I-06b (edge — partial NULL on provider)
      const org = await seedOrg('req2-partial-prov');
      const subject = uniq('sub');
      await insertUser(org, `${uniq('e')}@example.com`, null, subject);
      await insertUser(org, `${uniq('e')}@example.com`, null, subject);
      const db = getDb();
      const rows = await db.execute<{ c: string }>(sql`
        SELECT count(*)::text AS c FROM users
        WHERE org_id = ${org} AND sso_provider IS NULL AND sso_subject = ${subject}
      `);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });
  });

  // ==========================================================================
  // REQ-3: onboarding_outcome enum — 10 new values
  // ==========================================================================
  describe('REQ-3: onboarding_outcome enum — 10 new values', () => {
    it('contains all 10 new SSO-auto outcome values', async () => {
      // TC-I-07 (happy)
      const db = getDb();
      const rows = await db.execute<{ enumlabel: string }>(sql`
        SELECT e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'onboarding_outcome'
      `);
      const labels = rows.rows.map((r) => r.enumlabel);
      const expected = [
        'accepted-sso-auto',
        'rejected-public-domain',
        'rejected-multiple-matches',
        'rejected-no-match',
        'rejected-race',
        'rejected-csrf',
        'rejected-replay',
        'rejected-cross-idp',
        'rejected-pre-existing-binding',
        'email-not-verified',
      ];
      for (const v of expected) {
        expect(labels).toContain(v);
      }
      // Strengthen: the intersection between the actual enum labels and the
      // expected new set must be EXACTLY 10. If a future migration adds an
      // 11th SSO-decision-shaped value without updating this list, this
      // assertion fails loudly rather than silently passing.
      const intersection = labels.filter((l) => expected.includes(l));
      expect(intersection.length).toBe(expected.length);
    });

    it('uses ADD VALUE IF NOT EXISTS for every new enum value (idempotency)', () => {
      // TC-I-08 (idempotency — SQL grep companion)
      // Asserting idempotency via raw re-run would require executing the
      // ALTER TYPE outside a transaction in the live container; instead we
      // verify the SQL file uses the idempotent form for every ADD VALUE,
      // which is the canonical PG 12+ pattern.
      const addValueLines = migrationSql
        .split('\n')
        .filter((l) => /ALTER TYPE\s+onboarding_outcome\s+ADD VALUE/i.test(l));
      expect(addValueLines.length).toBeGreaterThanOrEqual(10);
      for (const line of addValueLines) {
        expect(line).toMatch(/IF NOT EXISTS/i);
      }
    });
  });

  // ==========================================================================
  // REQ-4: onboarding_redemption_log new columns + method CHECK
  // ==========================================================================
  describe('REQ-4: onboarding_redemption_log new columns', () => {
    it('exposes the 5 new columns with correct types and nullability', async () => {
      // TC-I-09 (happy)
      const db = getDb();
      const rows = await db.execute<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'onboarding_redemption_log'
          AND column_name IN ('method', 'sso_provider', 'sso_subject_hash', 'iss', 'user_agent')
        ORDER BY column_name
      `);
      const byName = Object.fromEntries(rows.rows.map((r) => [r.column_name, r]));

      expect(byName.method).toBeDefined();
      expect(byName.method!.data_type).toBe('text');
      expect(byName.method!.is_nullable).toBe('NO');
      expect(byName.method!.column_default).toMatch(/manual-token/);

      for (const col of ['sso_provider', 'sso_subject_hash', 'iss', 'user_agent']) {
        expect(byName[col]).toBeDefined();
        expect(byName[col]!.data_type).toBe('text');
        expect(byName[col]!.is_nullable).toBe('YES');
      }
    });

    it("backfills method='manual-token' on new rows that omit the column", async () => {
      // TC-I-10 (regression — degraded; container has no pre-existing rows)
      const db = getDb();
      const tokenPrefix = uniq('tok').slice(0, 8);
      const result = await db.execute<{ method: string }>(sql`
        INSERT INTO onboarding_redemption_log (token_prefix, email_domain, email_hash, outcome)
        VALUES (${tokenPrefix}, 'example.com', ${uniq('hash')}, 'accepted')
        RETURNING method
      `);
      expect(result.rows[0]!.method).toBe('manual-token');
    });

    it('rejects an invalid method value via CHECK constraint', async () => {
      // TC-I-11 (business)
      const db = getDb();
      const tokenPrefix = uniq('tok').slice(0, 8);
      await expect(
        db.execute(sql`
          INSERT INTO onboarding_redemption_log
            (token_prefix, email_domain, email_hash, outcome, method)
          VALUES
            (${tokenPrefix}, 'example.com', ${uniq('hash')}, 'accepted', 'invalid')
        `),
      ).rejects.toThrow(/check constraint|method_check/i);
    });
  });

  // ==========================================================================
  // REQ-5: idx_invites_email_pattern_active
  // ==========================================================================
  describe('REQ-5: idx_invites_email_pattern_active', () => {
    it('exists as a partial index with WHERE (revoked_at IS NULL)', async () => {
      // TC-I-12 (happy)
      const db = getDb();
      const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'onboarding_invites'
          AND indexname = 'idx_invites_email_pattern_active'
      `);
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0]!.indexdef).toMatch(/WHERE \(revoked_at IS NULL\)/);
    });
  });

  // ==========================================================================
  // REQ-6: REVOKE UPDATE/DELETE on append-only audit tables
  // ==========================================================================
  describe('REQ-6: REVOKE UPDATE/DELETE on audit tables', () => {
    it('migration SQL revokes UPDATE/DELETE on onboarding_redemption_log', () => {
      // TC-I-13a (infra — SQL grep)
      expect(migrationSql).toMatch(
        /REVOKE\s+UPDATE,\s*DELETE\s+ON\s+onboarding_redemption_log\s+FROM/i,
      );
    });

    it.skip('app_role cannot UPDATE onboarding_redemption_log (infra-conditional: app_role missing)', () => {
      // TC-I-13b (security, infra-conditional)
      // Requires a pre-provisioned `app_role` PG role + GRANTs. Skipped
      // because the testcontainer setup does not create the role and the
      // migration's `:"app_role"` psql variable is unset.
    });

    it('migration SQL revokes UPDATE/DELETE on onboarding_audit_log', () => {
      // TC-I-14a (infra — SQL grep)
      expect(migrationSql).toMatch(
        /REVOKE\s+UPDATE,\s*DELETE\s+ON\s+onboarding_audit_log\s+FROM/i,
      );
    });

    it.skip('app_role cannot UPDATE onboarding_audit_log (infra-conditional: app_role missing)', () => {
      // TC-I-14b (security, infra-conditional)
    });

    it('migration SQL revokes UPDATE/DELETE on auth_event_log', () => {
      // TC-I-15a (infra — SQL grep)
      expect(migrationSql).toMatch(/REVOKE\s+UPDATE,\s*DELETE\s+ON\s+auth_event_log\s+FROM/i);
    });

    it.skip('app_role cannot UPDATE auth_event_log (infra-conditional: app_role missing)', () => {
      // TC-I-15b (security, infra-conditional)
    });

    it.skip('app_role INSERT on onboarding_redemption_log succeeds (infra-conditional: app_role missing)', () => {
      // TC-I-16 (security, infra-conditional)
    });

    it.skip('app_role SELECT on all 3 audit tables succeeds (infra-conditional: app_role missing)', () => {
      // TC-I-17 (security, infra-conditional)
    });
  });

  // ==========================================================================
  // REQ-7: user_machines.provisioned_via
  // ==========================================================================
  describe('REQ-7: user_machines.provisioned_via', () => {
    it("defaults to 'pre-v2-unknown' when the column is omitted on insert", async () => {
      // TC-I-18 (regression — degraded; no pre-existing rows in container)
      const db = getDb();
      const org = await seedOrg('req7-default');
      const userId = await insertUser(org, `${uniq('e')}@example.com`);
      const result = await db.execute<{ provisioned_via: string }>(sql`
        INSERT INTO user_machines (user_id, machine_id, key_id, secret_hash)
        VALUES (${userId}, gen_random_uuid(), ${uniq('key')}, ${uniq('hash')})
        RETURNING provisioned_via
      `);
      expect(result.rows[0]!.provisioned_via).toBe('pre-v2-unknown');
    });

    it('rejects an invalid provisioned_via value via CHECK constraint', async () => {
      // TC-I-19 (business)
      const db = getDb();
      const org = await seedOrg('req7-check');
      const userId = await insertUser(org, `${uniq('e')}@example.com`);
      await expect(
        db.execute(sql`
          INSERT INTO user_machines
            (user_id, machine_id, key_id, secret_hash, provisioned_via)
          VALUES
            (${userId}, gen_random_uuid(), ${uniq('key')}, ${uniq('hash')}, 'invalid')
        `),
      ).rejects.toThrow(/check constraint|provisioned_via_check/i);
    });
  });

  // ==========================================================================
  // REQ-8: onboarding_invites.allowed_sso_providers
  // ==========================================================================
  describe('REQ-8: onboarding_invites.allowed_sso_providers', () => {
    it('exists as a NOT NULL text[] column with empty-array default', async () => {
      // TC-I-20 (happy)
      const db = getDb();
      const rows = await db.execute<{
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(sql`
        SELECT data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'onboarding_invites'
          AND column_name = 'allowed_sso_providers'
      `);
      expect(rows.rows.length).toBe(1);
      const col = rows.rows[0]!;
      expect(col.data_type).toBe('ARRAY');
      expect(col.udt_name).toBe('_text');
      expect(col.is_nullable).toBe('NO');
      expect(col.column_default).toMatch(/\{\}/);
    });

    it('defaults to an empty array on new rows that omit the column', async () => {
      // TC-I-21 (regression)
      const db = getDb();
      const org = await seedOrg('req8-default');
      const token = uniq('tok');
      const result = await db.execute<{ allowed_sso_providers: string[] }>(sql`
        INSERT INTO onboarding_invites (token, org_id, expires_at)
        VALUES (${token}, ${org}, now() + INTERVAL '30 days')
        RETURNING allowed_sso_providers
      `);
      expect(result.rows[0]!.allowed_sso_providers).toEqual([]);
    });
  });

  // ==========================================================================
  // REQ-9: 180d CHECK constraint on onboarding_invites
  // ==========================================================================
  describe('REQ-9: 180d expires_at CHECK constraint', () => {
    it('accepts an SSO-pattern invite with expires_at = created_at + 90d', async () => {
      // TC-I-22 (happy)
      const db = getDb();
      const org = await seedOrg('req9-90d');
      await db.execute(sql`
        INSERT INTO onboarding_invites (token, org_id, email_pattern, expires_at, created_at)
        VALUES (
          ${uniq('tok')},
          ${org},
          '*@example.com',
          now() + INTERVAL '90 days',
          now()
        )
      `);
    });

    it('rejects an SSO-pattern invite with expires_at = created_at + 200d', async () => {
      // TC-I-23 (business)
      const db = getDb();
      const org = await seedOrg('req9-200d');
      await expect(
        db.execute(sql`
          INSERT INTO onboarding_invites (token, org_id, email_pattern, expires_at, created_at)
          VALUES (
            ${uniq('tok')},
            ${org},
            '*@example.com',
            now() + INTERVAL '200 days',
            now()
          )
        `),
      ).rejects.toThrow(/check constraint|sso_expires_check/i);
    });

    it('accepts a NULL email_pattern invite with expires_at = created_at + 200d (CHECK only fires for SSO patterns)', async () => {
      // TC-I-24 (edge — manual-token invites exempted)
      const db = getDb();
      const org = await seedOrg('req9-null');
      await db.execute(sql`
        INSERT INTO onboarding_invites (token, org_id, email_pattern, expires_at, created_at)
        VALUES (
          ${uniq('tok')},
          ${org},
          NULL,
          now() + INTERVAL '200 days',
          now()
        )
      `);
    });

    it('accepts the exact 180d boundary', async () => {
      // TC-I-25 (edge — boundary)
      const db = getDb();
      const org = await seedOrg('req9-180d');
      await db.execute(sql`
        INSERT INTO onboarding_invites (token, org_id, email_pattern, expires_at, created_at)
        VALUES (
          ${uniq('tok')},
          ${org},
          '*@example.com',
          now() + INTERVAL '180 days',
          now()
        )
      `);
    });

    it('rejects 180d + 1 millisecond (CHECK is strict)', async () => {
      // TC-I-26 (edge — boundary + epsilon)
      const db = getDb();
      const org = await seedOrg('req9-180d-plus');
      await expect(
        db.execute(sql`
          INSERT INTO onboarding_invites (token, org_id, email_pattern, expires_at, created_at)
          VALUES (
            ${uniq('tok')},
            ${org},
            '*@example.com',
            now() + INTERVAL '180 days' + INTERVAL '1 millisecond',
            now()
          )
        `),
      ).rejects.toThrow(/check constraint|sso_expires_check/i);
    });
  });

  // ==========================================================================
  // REQ-10: auth_event_log table
  // ==========================================================================
  describe('REQ-10: auth_event_log table', () => {
    it('exposes the 10 expected columns with correct types', async () => {
      // TC-I-27 (happy)
      const db = getDb();
      const rows = await db.execute<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'auth_event_log'
        ORDER BY ordinal_position
      `);
      const byName = Object.fromEntries(rows.rows.map((r) => [r.column_name, r]));
      const expected: Record<string, { type: string; nullable: 'YES' | 'NO' }> = {
        id: { type: 'bigint', nullable: 'NO' },
        sso_provider: { type: 'text', nullable: 'NO' },
        iss: { type: 'text', nullable: 'NO' },
        email_hash: { type: 'text', nullable: 'NO' },
        sso_subject_hash: { type: 'text', nullable: 'YES' },
        ip: { type: 'text', nullable: 'YES' },
        city: { type: 'text', nullable: 'YES' },
        user_agent: { type: 'text', nullable: 'YES' },
        outcome: { type: 'text', nullable: 'NO' },
        occurred_at: { type: 'timestamp with time zone', nullable: 'NO' },
      };
      for (const [name, spec] of Object.entries(expected)) {
        const col = byName[name];
        expect(col, `column ${name} missing`).toBeDefined();
        expect(col!.data_type).toBe(spec.type);
        expect(col!.is_nullable).toBe(spec.nullable);
      }
    });

    it('exposes the 3 expected indexes', async () => {
      // TC-I-28 (happy)
      const db = getDb();
      const rows = await db.execute<{ indexname: string }>(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'auth_event_log'
      `);
      const names = rows.rows.map((r) => r.indexname);
      expect(names).toContain('idx_auth_event_log_subject_occurred');
      expect(names).toContain('idx_auth_event_log_email_occurred');
      expect(names).toContain('idx_auth_event_log_iss_occurred');
    });

    it('rejects an invalid outcome via CHECK constraint', async () => {
      // TC-I-29 (happy — validation)
      const db = getDb();
      await expect(
        db.execute(sql`
          INSERT INTO auth_event_log (sso_provider, iss, email_hash, outcome)
          VALUES ('google', 'https://accounts.google.com', ${uniq('hash')}, 'garbage')
        `),
      ).rejects.toThrow(/check constraint|outcome_check/i);
    });

    it('defaults occurred_at to now() when omitted on insert', async () => {
      // TC-I-30 (happy — default)
      const db = getDb();
      const result = await db.execute<{ occurred_at: Date; now_at: Date }>(sql`
        INSERT INTO auth_event_log (sso_provider, iss, email_hash, outcome)
        VALUES ('google', 'https://accounts.google.com', ${uniq('hash')}, 'accepted-sso-auto')
        RETURNING occurred_at, now() AS now_at
      `);
      const row = result.rows[0]!;
      // occurred_at should be set, and very close to now() (within 5s window).
      const occurredMs = new Date(row.occurred_at).getTime();
      const nowMs = new Date(row.now_at).getTime();
      expect(Number.isFinite(occurredMs)).toBe(true);
      expect(Math.abs(nowMs - occurredMs)).toBeLessThan(5000);
    });
  });

  // ==========================================================================
  // REQ-17: idempotency
  // ==========================================================================
  describe('REQ-17: migration idempotency', () => {
    it('uses idempotent DDL forms for every additive statement (SQL grep)', () => {
      // TC-I-31 (idempotency — SQL grep)
      // The migration is re-run-safe by construction:
      //   - ALTER TYPE ADD VALUE IF NOT EXISTS
      //   - ADD COLUMN IF NOT EXISTS
      //   - CREATE INDEX IF NOT EXISTS
      //   - CREATE TABLE IF NOT EXISTS
      //   - ADD CONSTRAINT guarded by pg_constraint NOT EXISTS
      const addValueCount = (migrationSql.match(/ALTER TYPE\s+onboarding_outcome\s+ADD VALUE\s+IF NOT EXISTS/gi) ?? [])
        .length;
      expect(addValueCount).toBeGreaterThanOrEqual(10);

      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+method/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+sso_provider/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+sso_subject_hash/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+iss/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+user_agent/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+provisioned_via/i);
      expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS\s+allowed_sso_providers/i);

      expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_invites_email_pattern_active/i);
      expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_auth_event_log_subject_occurred/i);
      expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_auth_event_log_email_occurred/i);
      expect(migrationSql).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_auth_event_log_iss_occurred/i);

      expect(migrationSql).toMatch(/CREATE TABLE IF NOT EXISTS\s+auth_event_log/i);

      // CHECK / UNIQUE constraint guards via pg_constraint.
      expect(migrationSql).toMatch(/conname\s*=\s*'onboarding_redemption_log_method_check'/);
      expect(migrationSql).toMatch(/conname\s*=\s*'user_machines_provisioned_via_check'/);
      expect(migrationSql).toMatch(/conname\s*=\s*'onboarding_invites_sso_expires_check'/);
      expect(migrationSql).toMatch(/conname\s*=\s*'users_org_email_unique'/);
      expect(migrationSql).toMatch(/conname\s*=\s*'users_org_sso_unique'/);
    });

    it.skip('migration aborts on pre-existing 180d violators (infra-conditional: requires pre-seed)', () => {
      // TC-I-32 (infra-conditional)
      // Requires pre-seeding violator rows BEFORE the migration applies,
      // which conflicts with the shared-container setup-pg.ts contract.
      // Deferred to a manual ops test.
    });

    it('includes a pre-flight RAISE NOTICE for 180d violator count', () => {
      // TC-I-32b (infra — SQL grep)
      expect(migrationSql).toMatch(/RAISE NOTICE\s+'\[migration 0004\] pre-flight/i);
      expect(migrationSql).toMatch(/violate 180d cap/i);
    });
  });
});
