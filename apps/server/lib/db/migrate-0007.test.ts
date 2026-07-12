/**
 * Integration tests for migration 0007 (invite token hash-at-rest).
 *
 * Spec: .specs/security-hardening-lowsev.md (REQ-1)
 * Migration: apps/server/lib/db/migrations/0007_invite_token_hash.sql
 *
 * TC-I-04 / TC-I-05 exercise the migration against a THROWAWAY Postgres
 * database, not the shared `public` schema (which setup-pg has already migrated
 * past 0007, so the pre→post backfill transition can no longer be observed
 * there). A fresh database gives fully-isolated catalogs, so migrations
 * 0000-0006 apply EXACTLY as in production. A scratch *schema* would be lighter
 * but fragile: 0004's unqualified `pg_class WHERE relname='users'` and
 * `pg_constraint WHERE conname = ...` lookups resolve across schemas and would
 * collide with the already-migrated `public` schema. A separate database
 * sidesteps that entirely.
 *
 * TC-I-13 is a pure filesystem check (no Postgres) and runs even under
 * SKIP_PG_TESTS=1. It guards the "forgot the _journal.json entry" bug that has
 * shipped twice in this repo: setup-pg's orphan-apply masks a missing journal
 * entry, so a dedicated assertion that the tag is registered is the only real
 * guard that the PRODUCTION drizzle runner (`runMigrations`) will apply 0007.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const migrationsDir = path.resolve(__dirname, 'migrations');
const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

// Migrations that build the pre-0007 schema, in application order.
const MIGRATIONS_TO_0006 = [
  '0000_init.sql',
  '0001_onboarding.sql',
  '0002_manager_v2.sql',
  '0003_manager_v3_outcomes.sql',
  '0004_sso_auto_provision_schema.sql',
  '0005_manager_alert_acks.sql',
  '0006_local_org_seed.sql',
] as const;

/**
 * Split a migration .sql into executable chunks on the drizzle
 * `--> statement-breakpoint` marker — same contract as
 * `tests/integration/setup-pg.ts`. Drops empty / comment-only chunks and any
 * chunk using psql client-side `:"var"` substitution (unparseable by pg's
 * simple-query protocol). A retained chunk may still carry leading `--`
 * comments; Postgres ignores those.
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

// TC-I-13 — journal registration. Pure filesystem; runs regardless of Postgres.
describe('migration 0007 — journal registration (REQ-1)', () => {
  it('registers the 0007 tag in meta/_journal.json so the production runner applies it (TC-I-13)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain('0007_invite_token_hash');
  });
});

skipDescribe('migration 0007 — invite token hash-at-rest (REQ-1)', () => {
  // 64-hex deterministic "plaintext" invite token seeded before the migration.
  const PLAINTEXT = 'a'.repeat(64);
  const EXPECTED_HASH = createHash('sha256').update(PLAINTEXT).digest('hex');
  const EXPECTED_PREFIX = PLAINTEXT.slice(0, 8);

  let admin: Client | undefined;
  let scratch: Client | undefined;
  let scratchDbName = '';

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set — tests/integration/setup-pg.ts globalSetup should provide it',
      );
    }

    // Internal-only identifier (no external input). A database name cannot be a
    // bound parameter in CREATE/DROP DATABASE, so assert the safe charset
    // before interpolating it into DDL.
    scratchDbName = `scratch_0007_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    if (!/^[a-z0-9_]+$/.test(scratchDbName)) {
      throw new Error(`refusing unsafe scratch db name: ${scratchDbName}`);
    }

    // Admin connection (container's default DB) → create the throwaway DB.
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratchDbName}`);

    // Scratch connection → the throwaway DB with fully-isolated catalogs.
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${scratchDbName}`;
    scratch = new Client({ connectionString: scratchUrl.toString() });
    await scratch.connect();

    // Build the pre-0007 schema exactly as production does.
    for (const file of MIGRATIONS_TO_0006) {
      await applyMigrationFile(scratch, file);
    }

    // Seed a PRE-migration invite: the `token` column still holds the plaintext.
    const org = await scratch.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ('scratch-0007-org') RETURNING id`,
    );
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error('seed org insert returned no id');
    await scratch.query(
      `INSERT INTO onboarding_invites (token, org_id, expires_at)
       VALUES ($1, $2, now() + INTERVAL '30 days')`,
      [PLAINTEXT, orgId],
    );

    // Apply the migration under test.
    await applyMigrationFile(scratch, '0007_invite_token_hash.sql');
  }, 30_000);

  afterAll(async () => {
    if (scratch) await scratch.end();
    if (admin) {
      // FORCE (PG13+) terminates any stragglers; `scratch` is already ended.
      await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  it('migrates a pre-existing plaintext invite in place to sha256 hash + plaintext prefix (TC-I-04)', async () => {
    const db = scratch;
    if (!db) throw new Error('scratch client not initialized');

    const res = await db.query<{ token_hash: string; token_prefix: string }>(
      `SELECT token_hash, token_prefix FROM onboarding_invites WHERE token_prefix = $1`,
      [EXPECTED_PREFIX],
    );
    expect(res.rows.length).toBe(1);
    const row = res.rows[0];
    if (!row) throw new Error('migrated invite row not found');

    // token_hash is the SHA-256 of the plaintext — NOT the plaintext itself.
    expect(row.token_hash).toBe(EXPECTED_HASH);
    expect(row.token_hash).not.toBe(PLAINTEXT);
    // token_prefix is the first 8 chars of the PLAINTEXT (for UI/audit
    // correlation with onboarding_redemption_log.token_prefix).
    expect(row.token_prefix).toBe(EXPECTED_PREFIX);

    // Still redeemable BY HASH: hashing the original plaintext resolves the row
    // via PK equality — the exact lookup redeem.ts performs. A DB dump (which
    // holds only the hash) is NOT a usable credential.
    const byHash = await db.query<{ present: number }>(
      `SELECT 1 AS present FROM onboarding_invites WHERE token_hash = $1`,
      [EXPECTED_HASH],
    );
    expect(byHash.rows.length).toBe(1);

    // The old plaintext `token` column no longer exists (renamed to token_hash).
    const oldCol = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'onboarding_invites' AND column_name = 'token'`,
    );
    expect(oldCol.rows.length).toBe(0);

    // token_prefix is enforced NOT NULL (migration step 4).
    const nullable = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'onboarding_invites' AND column_name = 'token_prefix'`,
    );
    expect(nullable.rows[0]?.is_nullable).toBe('NO');

    // The prefix index now targets the physical token_prefix column (step 5).
    const idx = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'onboarding_invites' AND indexname = 'idx_onboarding_invites_prefix'`,
    );
    expect(idx.rows.length).toBe(1);
    expect(idx.rows[0]?.indexdef).toMatch(/\(token_prefix\)/);
  });

  it('re-applying the ENTIRE 0007 file is a no-op — does not double-hash token_hash (idempotent) (TC-I-05)', async () => {
    const db = scratch;
    if (!db) throw new Error('scratch client not initialized');

    // REQ-1: "idempotente sob re-execução do SQL cru". Every DDL step in 0007
    // is guarded (ADD COLUMN IF NOT EXISTS, RENAME inside a column-exists DO
    // block, backfill WHERE token_prefix IS NULL, CREATE INDEX IF NOT EXISTS),
    // so a manual raw re-apply of the whole file must succeed without error
    // and leave token_hash as the single SHA-256 (never sha256(sha256(...))).
    await expect(
      applyMigrationFile(db, '0007_invite_token_hash.sql'),
    ).resolves.not.toThrow();

    const res = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM onboarding_invites WHERE token_prefix = $1`,
      [EXPECTED_PREFIX],
    );
    expect(res.rows.length).toBe(1);
    // Unchanged — still the single sha256(plaintext), NOT the double hash.
    expect(res.rows[0]?.token_hash).toBe(EXPECTED_HASH);
    expect(res.rows[0]?.token_hash).not.toBe(
      createHash('sha256').update(EXPECTED_HASH).digest('hex'),
    );
  });
});
