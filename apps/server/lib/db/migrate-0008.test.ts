/**
 * Integration tests for migration 0008 (local-user seed).
 *
 * Spec: .specs/fix-local-mode-synthetic-user-uuid.md (REQ-2, REQ-5)
 * Migration: apps/server/lib/db/migrations/0008_local_user_seed.sql
 *
 * TC-I-01/02/03/11 exercise the migration against a THROWAWAY Postgres
 * database, not the shared `public` schema (which setup-pg has already
 * migrated past 0008, so the pre→post seed transition can no longer be
 * observed there). A fresh database gives fully-isolated catalogs, so
 * migrations 0000-0007 apply EXACTLY as in production. A scratch *schema*
 * would be lighter but fragile: 0004's unqualified `pg_class` / `pg_constraint`
 * lookups resolve across schemas and would collide with the already-migrated
 * `public` schema. A separate database sidesteps that entirely. (Same
 * rationale as migrate-0007.test.ts.)
 *
 * TC-I-09 is a pure filesystem check (no Postgres) and runs even under
 * SKIP_PG_TESTS=1. It guards the "forgot the _journal.json entry" bug that
 * has shipped twice in this repo: setup-pg's orphan-apply masks a missing
 * journal entry, so a dedicated assertion that the tag is registered is the
 * only real guard that the PRODUCTION drizzle runner applies 0008.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000001';
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000002';

const migrationsDir = path.resolve(__dirname, 'migrations');
const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

// Migrations that build the pre-0008 schema, in application order.
const MIGRATIONS_TO_0007 = [
  '0000_init.sql',
  '0001_onboarding.sql',
  '0002_manager_v2.sql',
  '0003_manager_v3_outcomes.sql',
  '0004_sso_auto_provision_schema.sql',
  '0005_manager_alert_acks.sql',
  '0006_local_org_seed.sql',
  '0007_invite_token_hash.sql',
] as const;

/**
 * Split a migration .sql into executable chunks on the drizzle
 * `--> statement-breakpoint` marker — same contract as
 * `tests/integration/setup-pg.ts` and migrate-0007.test.ts.
 */
const splitStatements = (sql: string): string[] =>
  sql
    .split(/^[ \t]*-->[ \t]+statement-breakpoint[ \t]*$/m)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length === 0) return false;
      const stripped = s
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('--'))
        .join('\n');
      if (stripped.length === 0) return false;
      if (/:"[A-Za-z_][A-Za-z0-9_]*"/.test(stripped)) return false;
      return true;
    });

const applyMigrationFile = async (client: Client, file: string): Promise<void> => {
  const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
  for (const stmt of splitStatements(sql)) {
    await client.query(stmt);
  }
};

// TC-I-09 — journal registration. Pure filesystem; runs regardless of Postgres.
describe('migration 0008 — journal registration (REQ-2)', () => {
  it('registers the 0008 tag in meta/_journal.json so the production runner applies it (TC-I-09)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0008_local_user_seed');
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(8);
  });
});

skipDescribe('migration 0008 — local-user seed (REQ-2, REQ-5)', () => {
  let admin: Client | undefined;

  const makeScratchDb = async (): Promise<{ db: Client; name: string }> => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — setup-pg globalSetup should provide it');
    const name = `scratch_0008_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing unsafe scratch db name: ${name}`);
    if (!admin) {
      admin = new Client({ connectionString: url });
      await admin.connect();
    }
    await admin.query(`CREATE DATABASE ${name}`);
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    const db = new Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    return { db, name };
  };

  const scratchDbs: { db: Client; name: string }[] = [];

  const freshDbTo0007 = async (): Promise<Client> => {
    const { db, name } = await makeScratchDb();
    scratchDbs.push({ db, name });
    for (const file of MIGRATIONS_TO_0007) {
      await applyMigrationFile(db, file);
    }
    return db;
  };

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    admin = new Client({ connectionString: url });
    await admin.connect();
  }, 30_000);

  afterAll(async () => {
    for (const { db } of scratchDbs) await db.end();
    if (admin) {
      for (const { name } of scratchDbs) {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.end();
    }
  }, 60_000);

  it('seeds the synthetic local-user row with the right org/role/email (TC-I-01)', async () => {
    const db = await freshDbTo0007();
    await applyMigrationFile(db, '0008_local_user_seed.sql');

    const res = await db.query<{
      org_id: string;
      role: string;
      email: string;
    }>(`SELECT org_id, role, email FROM users WHERE id = $1`, [LOCAL_USER_ID]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.org_id).toBe(LOCAL_ORG_ID);
    expect(res.rows[0]?.role).toBe('admin');
    expect(res.rows[0]?.email).toBe('dev@localhost');
  }, 30_000);

  it('re-applying the entire 0008 file is a no-op — one row, no error (idempotent) (TC-I-02)', async () => {
    const db = await freshDbTo0007();
    await applyMigrationFile(db, '0008_local_user_seed.sql');
    await expect(
      applyMigrationFile(db, '0008_local_user_seed.sql'),
    ).resolves.not.toThrow();

    const res = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE id = $1`,
      [LOCAL_USER_ID],
    );
    expect(res.rows[0]?.count).toBe('1');
  }, 30_000);

  it('ON CONFLICT DO NOTHING preserves a pre-existing row — does not overwrite (TC-I-03)', async () => {
    const db = await freshDbTo0007();
    // Pre-seed the row with a DIFFERENT display_name before running 0008.
    await db.query(
      `INSERT INTO users (id, org_id, email, role, display_name)
       VALUES ($1, $2, 'dev@localhost', 'admin', 'CHANGED')`,
      [LOCAL_USER_ID, LOCAL_ORG_ID],
    );
    await applyMigrationFile(db, '0008_local_user_seed.sql');

    const res = await db.query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`,
      [LOCAL_USER_ID],
    );
    expect(res.rows[0]?.display_name).toBe('CHANGED');
  }, 30_000);

  it('fails loudly when the local-org row is absent — asserts the 0006→0008 ordering dependency (TC-I-11)', async () => {
    const db = await freshDbTo0007();
    // Remove the local org seeded by 0006 so the users.org_id FK has no target.
    await db.query(`DELETE FROM orgs WHERE id = $1`, [LOCAL_ORG_ID]);
    await expect(
      applyMigrationFile(db, '0008_local_user_seed.sql'),
    ).rejects.toThrow(/foreign key|violates/i);
  }, 30_000);
});
