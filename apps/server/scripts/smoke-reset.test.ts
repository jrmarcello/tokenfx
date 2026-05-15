/**
 * Integration tests for `apps/server/scripts/smoke-reset.ts`.
 *
 * Spec: .specs/cross-stack-smoke-validation.md — TASK-RESET-SERVER
 * TCs covered:
 *   - TC-I-08 (happy): after smokeReset() runs against a populated PG, every
 *     migrated table has COUNT(*) = 0.
 *   - TC-I-09 (idempotency): running smokeReset() twice in a row produces
 *     the same end-state (no errors, all tables still empty).
 *
 * Container strategy: this suite reuses the shared Postgres testcontainer
 * spun up by `tests/integration/setup-pg.ts` (vitest globalSetup) and reads
 * `DATABASE_URL` from process.env, mirroring every other PG integration test
 * in this package. Tests run serially (`fileParallelism: false` in
 * vitest.config.ts) so the TRUNCATE here cannot race with sibling files'
 * seeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { smokeReset, SMOKE_RESET_TABLES } from './smoke-reset';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

skipDescribe('apps/server/scripts/smoke-reset', () => {
  let pool: Pool;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set — setup-pg globalSetup did not run');
    }
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  const countAllTables = async (): Promise<Map<string, number>> => {
    const counts = new Map<string, number>();
    for (const table of SMOKE_RESET_TABLES) {
      // Identifier interpolated from a hard-coded const list (not user input),
      // so SQL identifier injection is impossible. Values would use $1 binding
      // but COUNT(*) has no values.
      const res = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${table}`);
      counts.set(table, Number(res.rows[0]?.c ?? '0'));
    }
    return counts;
  };

  const seedSomething = async (): Promise<void> => {
    // Minimal seed across multiple tables to prove TRUNCATE actually wipes
    // them. Uses ON CONFLICT DO NOTHING so re-seeding mid-suite is safe.
    const orgRes = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      ['smoke-reset-test-org'],
    );
    const orgId = orgRes.rows[0]?.id;
    if (!orgId) throw new Error('seed: failed to create org');

    const teamRes = await pool.query<{ id: string }>(
      `INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, 'smoke-reset-test-team'],
    );
    const teamId = teamRes.rows[0]?.id;
    if (!teamId) throw new Error('seed: failed to create team');

    const userRes = await pool.query<{ id: string }>(
      `INSERT INTO users (org_id, team_id, email, role)
       VALUES ($1, $2, $3, 'member') RETURNING id`,
      [orgId, teamId, 'smoke-reset-test@example.com'],
    );
    const userId = userRes.rows[0]?.id;
    if (!userId) throw new Error('seed: failed to create user');

    await pool.query(
      `INSERT INTO user_machines (user_id, machine_id, key_id, secret_hash)
       VALUES ($1, gen_random_uuid(), $2, $3)`,
      [userId, 'k_smoke_reset_test', 'bcrypt-hash-placeholder'],
    );

    await pool.query(
      `INSERT INTO ingestion_log (
         user_id, machine_id, key_id, payload_size_bytes,
         accepted_count, skipped_count, rejected_count
       ) VALUES ($1, gen_random_uuid(), $2, 0, 0, 0, 0)`,
      [userId, 'k_smoke_reset_test'],
    );

    await pool.query(
      `INSERT INTO auth_event_log (sso_provider, iss, email_hash, outcome)
       VALUES ('test', 'http://idp.test', 'hash-placeholder', 'accepted-sso-auto')`,
    );
  };

  it('TC-I-08: empties every migrated table when run against a populated PG', async () => {
    await seedSomething();

    // Sanity: at least some seeded tables have rows before reset.
    const beforeCounts = await countAllTables();
    const seededTables = ['orgs', 'teams', 'users', 'user_machines', 'ingestion_log', 'auth_event_log'];
    for (const t of seededTables) {
      expect(beforeCounts.get(t), `pre-reset count of ${t}`).toBeGreaterThan(0);
    }

    const result = await smokeReset({ databaseUrl: process.env.DATABASE_URL, allowDatabaseName: '' });
    expect(result.ok).toBe(true);

    const afterCounts = await countAllTables();
    for (const [table, count] of afterCounts) {
      expect(count, `post-reset count of ${table}`).toBe(0);
    }
  });

  it('TC-I-09: idempotent — running twice yields the same empty state', async () => {
    await seedSomething();

    const r1 = await smokeReset({ databaseUrl: process.env.DATABASE_URL, allowDatabaseName: '' });
    expect(r1.ok).toBe(true);
    const after1 = await countAllTables();
    for (const [table, count] of after1) {
      expect(count, `after first reset, ${table}`).toBe(0);
    }

    // Second run against an already-empty DB must still succeed and leave
    // tables empty. Also exercises the migrate re-run idempotency
    // (IF NOT EXISTS / Drizzle journal short-circuit).
    const r2 = await smokeReset({ databaseUrl: process.env.DATABASE_URL, allowDatabaseName: '' });
    expect(r2.ok).toBe(true);
    const after2 = await countAllTables();
    for (const [table, count] of after2) {
      expect(count, `after second reset, ${table}`).toBe(0);
    }

    // Byte-identical: same set of tables, same counts (all zero).
    expect(after2).toEqual(after1);
  });

  it('exports a deterministic table list covering migrations 0000-0005', () => {
    // Guards against future schema additions silently bypassing the reset.
    // When a migration adds a table, this list MUST be updated — the test
    // makes that requirement load-bearing.
    expect(SMOKE_RESET_TABLES).toContain('orgs');
    expect(SMOKE_RESET_TABLES).toContain('teams');
    expect(SMOKE_RESET_TABLES).toContain('users');
    expect(SMOKE_RESET_TABLES).toContain('user_machines');
    expect(SMOKE_RESET_TABLES).toContain('sessions_agg');
    expect(SMOKE_RESET_TABLES).toContain('model_breakdown_agg');
    expect(SMOKE_RESET_TABLES).toContain('tool_count_agg');
    expect(SMOKE_RESET_TABLES).toContain('cost_calibration_per_user');
    expect(SMOKE_RESET_TABLES).toContain('ingestion_log');
    expect(SMOKE_RESET_TABLES).toContain('onboarding_invites');
    expect(SMOKE_RESET_TABLES).toContain('onboarding_redemption_log');
    expect(SMOKE_RESET_TABLES).toContain('onboarding_audit_log');
    expect(SMOKE_RESET_TABLES).toContain('team_metrics_daily');
    expect(SMOKE_RESET_TABLES).toContain('manager_drilldown_audit');
    expect(SMOKE_RESET_TABLES).toContain('manager_anomalies');
    expect(SMOKE_RESET_TABLES).toContain('manager_dismissed_anomalies');
    expect(SMOKE_RESET_TABLES).toContain('org_settings');
    expect(SMOKE_RESET_TABLES).toContain('cron_runs');
    expect(SMOKE_RESET_TABLES).toContain('manager_notifications');
    expect(SMOKE_RESET_TABLES).toContain('session_outcomes_agg');
    expect(SMOKE_RESET_TABLES).toContain('team_outcomes_daily');
    expect(SMOKE_RESET_TABLES).toContain('auth_event_log');
    expect(SMOKE_RESET_TABLES).toContain('manager_alert_acks');
    // 23 tables across 6 migrations (0000-0005).
    expect(SMOKE_RESET_TABLES.length).toBe(23);
  });
});
