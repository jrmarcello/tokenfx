/**
 * Integration tests for the central-server-onboarding schema migration
 * (TASK-1, REQ-1..4).
 *
 * Validates that migration 0001_onboarding produces the expected DB shape:
 *   TC-I-01 — 3 new tables + 2 new enums materialized
 *   TC-I-02 — users.sso_provider / users.sso_subject relaxed to NULLABLE
 *
 * Postgres-backed via Testcontainers (shared instance from setup-pg.ts).
 * Skipped when `SKIP_PG_TESTS=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

skipDescribe('schema onboarding migration (Postgres integration)', () => {
  beforeAll(async () => {
    // Touch the pool to ensure the shared Testcontainers DB is initialized;
    // no row mutations needed — this suite reads metadata only.
    getDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-01: creates the three onboarding tables', async () => {
    const db = getDb();
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'onboarding_invites',
          'onboarding_redemption_log',
          'onboarding_audit_log'
        )
      ORDER BY table_name
    `);
    const names = rows.rows.map((r) => r.table_name).sort();
    expect(names).toEqual([
      'onboarding_audit_log',
      'onboarding_invites',
      'onboarding_redemption_log',
    ]);
  });

  it('TC-I-01: creates the two onboarding enums', async () => {
    const db = getDb();
    const rows = await db.execute<{ typname: string }>(sql`
      SELECT typname
      FROM pg_type
      WHERE typname IN ('onboarding_outcome', 'onboarding_audit_action')
      ORDER BY typname
    `);
    const names = rows.rows.map((r) => r.typname).sort();
    expect(names).toEqual(['onboarding_audit_action', 'onboarding_outcome']);
  });

  it('TC-I-01: enum onboarding_outcome includes the 9 expected values', async () => {
    const db = getDb();
    const rows = await db.execute<{ enumlabel: string }>(sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'onboarding_outcome'
      ORDER BY e.enumsortorder
    `);
    expect(rows.rows.map((r) => r.enumlabel)).toEqual([
      'accepted',
      'token-invalid',
      'token-expired',
      'token-revoked',
      'token-exhausted',
      'email-mismatch',
      'rate-limited',
      'validation-error',
      'infra-error',
    ]);
  });

  it('TC-I-01: enum onboarding_audit_action includes invite-created and invite-revoked', async () => {
    const db = getDb();
    const rows = await db.execute<{ enumlabel: string }>(sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'onboarding_audit_action'
      ORDER BY e.enumsortorder
    `);
    expect(rows.rows.map((r) => r.enumlabel)).toEqual(['invite-created', 'invite-revoked']);
  });

  it('TC-I-01: idx_onboarding_invites_prefix index exists (functional, on left(token,8))', async () => {
    const db = getDb();
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'onboarding_invites'
        AND indexname = 'idx_onboarding_invites_prefix'
    `);
    expect(rows.rows.length).toBe(1);
    // Postgres normalizes the expression — verify it references left(token, 8).
    expect(rows.rows[0].indexdef.toLowerCase()).toContain('"left"(token, 8)');
  });

  it('TC-I-02: users.sso_provider is NULLABLE', async () => {
    const db = getDb();
    const rows = await db.execute<{ is_nullable: string }>(sql`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'sso_provider'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].is_nullable).toBe('YES');
  });

  it('TC-I-02: users.sso_subject is NULLABLE', async () => {
    const db = getDb();
    const rows = await db.execute<{ is_nullable: string }>(sql`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'sso_subject'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].is_nullable).toBe('YES');
  });
});
