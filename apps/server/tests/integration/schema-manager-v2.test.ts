/**
 * Integration tests for the manager-dashboard-v2 schema migration
 * (TASK-MIGRATIONS, REQ-15..23).
 *
 * Validates that migration 0002_manager_v2 produces the expected DB shape:
 *   TC-I-01  — 7 new tables exist with expected indexes
 *   TC-I-02  — re-running the migration is a no-op (Drizzle's __drizzle_migrations
 *              tracking + IF NOT EXISTS guards in the .sql)
 *   TC-I-67  — RLS column GRANTs on manager_drilldown_audit (skipped on
 *              managed-Postgres deployments via SKIP_RLS_TESTS=1)
 *   TC-I-68  — users.display_name column exists, NULLABLE, type text
 *
 * Postgres-backed via Testcontainers (shared instance from setup-pg.ts).
 * Skipped when `SKIP_PG_TESTS=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { closeDb, getDb } from '@/lib/db/client';

const SKIP_PG = process.env.SKIP_PG_TESTS === '1';
const SKIP_RLS = process.env.SKIP_RLS_TESTS === '1';
const skipDescribe = SKIP_PG ? describe.skip : describe;

const NEW_TABLES = [
  'cron_runs',
  'manager_anomalies',
  'manager_dismissed_anomalies',
  'manager_drilldown_audit',
  'manager_notifications',
  'org_settings',
  'team_metrics_daily',
] as const;

const REQUIRED_INDEXES = [
  'idx_tmd_team_day',
  'idx_mda_target_viewed',
  'idx_mda_manager_viewed',
  'idx_mda_dismiss_until',
  'idx_cron_runs_job_started',
  'idx_mn_target_enqueued',
  'idx_mn_pending',
] as const;

skipDescribe('schema manager-v2 migration (Postgres integration)', () => {
  beforeAll(async () => {
    // Touch the pool to ensure the shared Testcontainers DB is initialized.
    getDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-01: creates the seven manager-v2 tables', async () => {
    const db = getDb();
    // Postgres array literal — Drizzle's sql template binds JS arrays as
    // text (which Postgres rejects on `= ANY(...)`); cast explicitly to
    // text[] so the bound value is unambiguous.
    const namesArr = `{${NEW_TABLES.join(',')}}`;
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${namesArr}::text[])
      ORDER BY table_name
    `);
    expect(rows.rows.map((r) => r.table_name).sort()).toEqual([...NEW_TABLES]);
  });

  it('TC-I-01: creates all required indexes (including partial indexes)', async () => {
    const db = getDb();
    const namesArr = `{${REQUIRED_INDEXES.join(',')}}`;
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY(${namesArr}::text[])
      ORDER BY indexname
    `);
    expect(rows.rows.map((r) => r.indexname).sort()).toEqual([...REQUIRED_INDEXES].sort());
  });

  it('TC-I-01: idx_mda_dismiss_until exists on (manager_user_id, dismissed_until)', async () => {
    // Spec called for a partial index `WHERE dismissed_until > now()`, but
    // Postgres rejects non-IMMUTABLE functions in index predicates. Migration
    // creates the regular non-partial index instead — query-time
    // `WHERE dismissed_until > now()` still benefits from the column order.
    const db = getDb();
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_mda_dismiss_until'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].indexdef.toLowerCase()).toContain('manager_user_id');
    expect(rows.rows[0].indexdef.toLowerCase()).toContain('dismissed_until');
  });

  it('TC-I-01: idx_mn_pending is a partial index with WHERE status = pending', async () => {
    const db = getDb();
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_mn_pending'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].indexdef.toLowerCase()).toContain('where');
    expect(rows.rows[0].indexdef.toLowerCase()).toContain("'pending'");
  });

  it('TC-I-01: team_metrics_daily PK is (org_id, team_id, day)', async () => {
    const db = getDb();
    const rows = await db.execute<{ column_name: string; ordinal_position: number }>(sql`
      SELECT kcu.column_name, kcu.ordinal_position
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'team_metrics_daily'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);
    expect(rows.rows.map((r) => r.column_name)).toEqual(['org_id', 'team_id', 'day']);
  });

  it('TC-I-01: manager_drilldown_audit has UNIQUE (manager_user_id, target_user_id, viewed_on, reason)', async () => {
    const db = getDb();
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'manager_drilldown_audit'
        AND tc.constraint_type = 'UNIQUE'
      ORDER BY kcu.ordinal_position
    `);
    expect(rows.rows.map((r) => r.column_name)).toEqual([
      'manager_user_id',
      'target_user_id',
      'viewed_on',
      'reason',
    ]);
  });

  it('TC-I-02: re-running the migration is idempotent (no-op)', async () => {
    // Re-run all migrations against the SAME shared DB. Drizzle's migrator
    // skips already-applied migrations via __drizzle_migrations bookkeeping;
    // the IF NOT EXISTS guards in the .sql file are a defense-in-depth in
    // case the bookkeeping table is reset.
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeTruthy();
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const drizzleDb = drizzle(pool);
      const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations');
      // Should not throw.
      await migrate(drizzleDb, { migrationsFolder });
    } finally {
      await pool.end();
    }
    // Verify the tables still exist after the no-op re-run.
    const db = getDb();
    const namesArr = `{${NEW_TABLES.join(',')}}`;
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${namesArr}::text[])
    `);
    expect(rows.rows.length).toBe(NEW_TABLES.length);
  });

  it('TC-I-68: users.display_name column exists, is NULLABLE, type text', async () => {
    const db = getDb();
    const rows = await db.execute<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'display_name'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].is_nullable).toBe('YES');
    expect(rows.rows[0].data_type).toBe('text');
  });

  // TC-I-67 — RLS column grants. Skipped on managed-Postgres deployments
  // where the test connection lacks SUPERUSER (CREATE ROLE failed silently
  // in the migration; code-level enforcement in writeAudit() is the active
  // defense). Set SKIP_RLS_TESTS=1 to skip explicitly.
  const rlsIt = SKIP_RLS ? it.skip : it;
  rlsIt(
    'TC-I-67: app_runtime has SELECT/INSERT on all columns of manager_drilldown_audit',
    async () => {
      const db = getDb();
      const rows = await db.execute<{ privilege_type: string }>(sql`
        SELECT DISTINCT privilege_type
        FROM information_schema.table_privileges
        WHERE grantee = 'app_runtime'
          AND table_schema = 'public'
          AND table_name = 'manager_drilldown_audit'
        ORDER BY privilege_type
      `);
      const privs = rows.rows.map((r) => r.privilege_type);
      expect(privs).toContain('SELECT');
      expect(privs).toContain('INSERT');
    },
  );

  rlsIt(
    'TC-I-67: app_runtime UPDATE grant is column-scoped to viewed_at + ip_address_trunc only',
    async () => {
      const db = getDb();
      const rows = await db.execute<{ column_name: string }>(sql`
        SELECT column_name
        FROM information_schema.column_privileges
        WHERE grantee = 'app_runtime'
          AND table_schema = 'public'
          AND table_name = 'manager_drilldown_audit'
          AND privilege_type = 'UPDATE'
        ORDER BY column_name
      `);
      expect(rows.rows.map((r) => r.column_name).sort()).toEqual([
        'ip_address_trunc',
        'viewed_at',
      ]);
    },
  );

  rlsIt('TC-I-67: app_runtime has NO DELETE on manager_drilldown_audit', async () => {
    const db = getDb();
    const rows = await db.execute<{ privilege_type: string }>(sql`
      SELECT privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = 'app_runtime'
        AND table_schema = 'public'
        AND table_name = 'manager_drilldown_audit'
        AND privilege_type = 'DELETE'
    `);
    expect(rows.rows.length).toBe(0);
  });

  // TC-I-55, TC-I-56 — live DML rejection under `app_runtime`.
  //
  // Metadata grants (TC-I-67) verify the column GRANTs are present, but they
  // can't catch a future regression where the GRANT is correct yet a DDL
  // change accidentally lets app_runtime mutate forbidden columns. The only
  // way to lock the contract is to actually attempt the DML and assert
  // Postgres error code 42501 (insufficient_privilege).
  //
  // We open a fresh pg.Pool (separate from the test app's pool) and run
  // `SET LOCAL ROLE app_runtime` before the offending statement. The
  // superuser pool used by getDb() bypasses GRANTs, so the role switch is
  // mandatory for this test to be meaningful.
  // Helper: seed org+user+audit row for the live-DML tests below. Uses
  // unique slugs per call so the two tests don't collide.
  const seedAuditRow = async (slug: string): Promise<string> => {
    const db = getDb();
    const orgRows = await db.execute<{ id: string }>(
      sql`INSERT INTO orgs (name) VALUES (${`rls-${slug}-org`}) RETURNING id`,
    );
    const orgId = orgRows.rows[0].id;
    const teamRows = await db.execute<{ id: string }>(
      sql`INSERT INTO teams (org_id, name) VALUES (${orgId}, ${`rls-${slug}-team`}) RETURNING id`,
    );
    const teamId = teamRows.rows[0].id;
    const userRows = await db.execute<{ id: string }>(
      sql`INSERT INTO users (org_id, team_id, email, sso_provider, sso_subject, role)
          VALUES (${orgId}, ${teamId}, ${`rls-${slug}@example.com`}, 'e2e', ${`rls-${slug}-sub`}, 'manager')
          RETURNING id`,
    );
    const userId = userRows.rows[0].id;
    const auditRows = await db.execute<{ id: string }>(
      sql`INSERT INTO manager_drilldown_audit
            (org_id, manager_user_id, target_user_id, reason, source_route, viewed_on)
          VALUES (${orgId}, ${userId}, ${userId}, 'training-check', ${`/test/rls-${slug}`}, CURRENT_DATE)
          RETURNING id`,
    );
    return auditRows.rows[0].id;
  };

  rlsIt(
    'TC-I-55: UPDATE manager_drilldown_audit.reason as app_runtime → 42501',
    async () => {
      const auditId = await seedAuditRow('update');

      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL not set');
      const pool = new Pool({ connectionString: url });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_runtime');
          let pgErrCode: string | undefined;
          try {
            await client.query(
              `UPDATE manager_drilldown_audit SET reason = 'tampered' WHERE id = $1`,
              [auditId],
            );
          } catch (err: unknown) {
            pgErrCode = (err as { code?: string }).code;
          }
          await client.query('ROLLBACK');
          expect(pgErrCode).toBe('42501');
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }

      // Cleanup the seed row using superuser.
      await getDb().execute(
        sql`DELETE FROM manager_drilldown_audit WHERE id = ${auditId}`,
      );
    },
  );

  rlsIt(
    'TC-I-56: DELETE manager_drilldown_audit as app_runtime → 42501',
    async () => {
      const auditId = await seedAuditRow('delete');

      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL not set');
      const pool = new Pool({ connectionString: url });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_runtime');
          let pgErrCode: string | undefined;
          try {
            await client.query(
              `DELETE FROM manager_drilldown_audit WHERE id = $1`,
              [auditId],
            );
          } catch (err: unknown) {
            pgErrCode = (err as { code?: string }).code;
          }
          await client.query('ROLLBACK');
          expect(pgErrCode).toBe('42501');
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }

      await getDb().execute(
        sql`DELETE FROM manager_drilldown_audit WHERE id = ${auditId}`,
      );
    },
  );
});
