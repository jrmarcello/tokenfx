/**
 * Integration tests for seedManagerV2 idempotency + ordering guard
 * (TASK-6, REQ-1; TC-I-01, TC-I-02 of `manager-dashboard-v2-followups.md`).
 *
 * These tests exercise the seed function that runs in Playwright's
 * `globalSetup` AFTER `seed-server.ts --e2e`. The function MUST:
 *
 *   1. Be idempotent — calling it twice in sequence leaves row counts
 *      unchanged (TC-I-01). Backed by `onConflictDoNothing`/`onConflictDoUpdate`
 *      in the seed.
 *   2. Fail fast with a deterministic error when `seed-server.ts --e2e`
 *      has NOT run first (TC-I-02). Without the guard, seedManagerV2 would
 *      silently insert rows referencing missing FK targets (org-alpha) and
 *      propagate confusing FK violations to Playwright.
 *
 * Postgres-backed via the shared Testcontainers instance (setup-pg.ts).
 * Skipped when `SKIP_PG_TESTS=1`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { stableUuid } from '@/lib/e2e/seed-ids';
import { seedManagerV2 } from '@/scripts/seed-manager-v2';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

/**
 * Shape returned by `db.execute<T>` — under node-postgres driver-adapter the
 * result is `{ rows: T[], … }`; we narrow defensively because some Drizzle
 * driver-adapter typings flatten this and the test must work either way.
 */
const rowsOf = <T>(result: unknown): readonly T[] => {
  if (Array.isArray(result)) return result as readonly T[];
  const r = (result as { rows?: readonly T[] }).rows;
  return r ?? [];
};

const truncateAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
    manager_notifications, team_metrics_daily, cron_runs, org_settings,
    onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
    ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
    cost_calibration_per_user, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const countOf = async (table: string): Promise<number> => {
  const db = getDb();
  const result = await db.execute<{ count: number }>(
    sql.raw(`SELECT COUNT(*)::int AS count FROM ${table}`),
  );
  const rows = rowsOf<{ count: number }>(result);
  return rows.length > 0 ? Number(rows[0].count) : 0;
};

/**
 * Minimal seed-server stand-in: inserts the orgs/teams that
 * `seed-server.ts --e2e` would have created, sufficient for
 * `seedManagerV2` to find `org-alpha` via the guard.
 *
 * We don't import `seed-server.ts` here because its `main()` runs the
 * full deterministic fixture (sessions_agg, model_breakdown_agg, etc.)
 * which is unnecessary for these targeted tests. The TC-I-01 idempotency
 * check only needs `org-alpha` to exist — same precondition the real
 * E2E flow guarantees.
 */
const seedAlphaShell = async (): Promise<void> => {
  const db = getDb();
  // Use the SAME deterministic UUID that `seed-server.ts --e2e` derives
  // for `org-alpha`, so TC-I-01's idempotency check measures from the
  // exact org count + identity the production seed leaves behind. Using
  // `gen_random_uuid()` here would let the test pass for the wrong
  // reason (orgs.count would be 2 → 2 instead of 1 → 1 after the v2
  // seed runs), and a future FK relationship hanging off
  // `stableUuid('org:org-alpha')` would silently miss the shell.
  // Self-review SHOULD-FIX (test-reviewer).
  const alphaId = stableUuid('org:org-alpha');
  await db.execute(sql`
    INSERT INTO orgs (id, name)
    VALUES (${alphaId}::uuid, 'Alpha Co')
    ON CONFLICT DO NOTHING
  `);
};

skipDescribe('seedManagerV2 (Postgres integration)', () => {
  beforeAll(async () => {
    // Touch the pool so the shared Testcontainers DB initializes.
    getDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-01: is idempotent — second call does not duplicate rows', async () => {
    await truncateAll();
    await seedAlphaShell();

    const db = getDb();

    await seedManagerV2(db);

    const teamsBefore = await countOf('teams');
    const usersBefore = await countOf('users');
    const tmdBefore = await countOf('team_metrics_daily');
    const orgsBefore = await countOf('orgs');

    // Guard: the first call should have actually written something. If
    // the seed silently no-ops the assertions below would still pass
    // vacuously. Asserting >0 makes the idempotency check meaningful.
    expect(teamsBefore).toBeGreaterThan(0);
    expect(usersBefore).toBeGreaterThan(0);
    expect(tmdBefore).toBeGreaterThan(0);

    // Re-run — must be a no-op on row counts.
    await seedManagerV2(db);

    expect(await countOf('teams')).toBe(teamsBefore);
    expect(await countOf('users')).toBe(usersBefore);
    expect(await countOf('team_metrics_daily')).toBe(tmdBefore);
    expect(await countOf('orgs')).toBe(orgsBefore);
  });

  it('TC-I-02: throws with a clear message when seed-server.ts --e2e has not run', async () => {
    await truncateAll();
    // Deliberately do NOT seed Alpha Co — the guard inside seedManagerV2
    // must fail before any writes happen.

    const db = getDb();

    await expect(seedManagerV2(db)).rejects.toThrow(
      /seed-server.*--e2e.*must run first/i,
    );

    // Confirm fail-fast: no partial state was written.
    expect(await countOf('teams')).toBe(0);
    expect(await countOf('users')).toBe(0);
    expect(await countOf('team_metrics_daily')).toBe(0);
  });
});
