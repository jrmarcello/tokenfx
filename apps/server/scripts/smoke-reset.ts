#!/usr/bin/env tsx
/**
 * apps/server/scripts/smoke-reset.ts
 *
 * Spec: .specs/cross-stack-smoke-validation.md — TASK-RESET-SERVER (REQ-6).
 *
 * Runs INSIDE the `tokenfx-server` container (invoked via `docker exec` by
 * the host-side `scripts/smoke-reset.ts` orchestrator). Wipes every table
 * created by migrations 0000-0005 via TRUNCATE ... RESTART IDENTITY CASCADE
 * inside a single transaction so the dataset is reset atomically. Then
 * re-runs the migrate pipeline (idempotent thanks to `IF NOT EXISTS` in the
 * hand-crafted SQL plus Drizzle's journal short-circuit) to guarantee the
 * post-reset schema is in lockstep with the codebase even if the migrate
 * pipeline grew new statements between resets.
 *
 * Compiled by the Dockerfile builder stage to `dist/scripts/smoke-reset.js`
 * (`tsc --module commonjs --target es2022 --outDir dist`) so the runner
 * image can execute it without `tsx`. Local dev / tests import the .ts
 * file directly through tsx + vitest.
 *
 * The exported `smokeReset()` function is unit-tested via TC-I-08 / TC-I-09
 * against the shared Postgres testcontainer (`tests/integration/setup-pg.ts`).
 * The CLI tail at the bottom of the file is exercised in the Docker runtime
 * via the runbook + the integration TASK-RESET-ROOT script.
 */
import { Pool } from 'pg';

import type { Result } from '../lib/result';

/**
 * Exhaustive, deterministic list of every PG table created by migrations
 * `0000_init.sql` through `0005_manager_alert_acks.sql`. The order is
 * irrelevant to TRUNCATE ... CASCADE (PG resolves dependencies internally),
 * but we keep the list grouped by migration for forensic clarity and so
 * future schema additions land next to their migration source.
 *
 * Coverage rule (from spec REQ-6): the list MUST include every table the
 * migrate pipeline creates. `smoke-reset.test.ts` enforces the count + key
 * names so a forgotten table in a future migration trips CI before it
 * silently leaks state between smoke runs.
 */
export const SMOKE_RESET_TABLES = [
  // 0000_init.sql
  'orgs',
  'teams',
  'users',
  'user_machines',
  'sessions_agg',
  'model_breakdown_agg',
  'tool_count_agg',
  'cost_calibration_per_user',
  'ingestion_log',
  // 0001_onboarding.sql
  'onboarding_invites',
  'onboarding_redemption_log',
  'onboarding_audit_log',
  // 0002_manager_v2.sql
  'team_metrics_daily',
  'manager_drilldown_audit',
  'manager_anomalies',
  'manager_dismissed_anomalies',
  'org_settings',
  'cron_runs',
  'manager_notifications',
  // 0003_manager_v3_outcomes.sql
  'session_outcomes_agg',
  'team_outcomes_daily',
  // 0004_sso_auto_provision_schema.sql
  'auth_event_log',
  // 0005_manager_alert_acks.sql
  'manager_alert_acks',
] as const;

export interface SmokeResetOptions {
  /**
   * Override the connection string. Defaults to `process.env.DATABASE_URL`.
   * The Dockerized runtime injects this via the compose `environment:`
   * block; tests pass it explicitly from the testcontainer URI.
   */
  readonly databaseUrl?: string;
  /**
   * Optional re-migrate hook. Defaults to the production `runMigrations()`
   * import from `lib/db/migrate.ts`. Exposed as a seam so the unit test can
   * skip the re-migrate step (the testcontainer is already migrated by
   * setup-pg globalSetup; re-running drizzle migrate against the same DB
   * is idempotent but adds ~1s per assertion).
   */
  readonly remigrate?: (databaseUrl: string) => Promise<void>;
  /**
   * Override the DB-name whitelist substring. Default `'tokenfx_smoke'` —
   * the compose stack's DB name. Tests using testcontainer-generated DBs
   * (random names) pass an explicit value here.
   */
  readonly allowDatabaseName?: string;
}

/**
 * TRUNCATE every migrated table inside a single transaction, then re-run
 * the migrate pipeline. Returns a `Result` so callers can branch on failure
 * without exception plumbing — matches the project's module-boundary
 * convention (`.claude/rules/ts-conventions.md`).
 *
 * Invariants:
 *  - All TRUNCATEs run inside `BEGIN; ... COMMIT;`. Partial wipes are
 *    impossible: if any statement fails, the transaction rolls back and
 *    the database returns to the pre-reset state.
 *  - `RESTART IDENTITY` resets every `bigserial` / `serial` sequence so
 *    re-runs of the seed script produce identical IDs.
 *  - `CASCADE` is required because `users → user_machines → ingestion_log`
 *    (and similar) have FK chains; without CASCADE TRUNCATE fails with
 *    `cannot truncate a table referenced in a foreign key constraint`.
 *  - The table identifiers are interpolated from a hard-coded const list
 *    (not user input), so SQL identifier injection is impossible. The
 *    parameter-binding rule still applies to values (none here).
 */
export const smokeReset = async (
  options: SmokeResetOptions = {},
): Promise<Result<void>> => {
  // Defense-in-depth fail-safes (self-review Security LOW-2): refuse to wipe
  // a database that doesn't look like the smoke fixture. Three checks must
  // ALL pass before any TRUNCATE executes. None can be silently bypassed
  // by an operator who sources the wrong .env or invokes the compiled
  // dist/scripts/smoke-reset.js against a misconfigured DATABASE_URL.
  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      error: new Error(
        'smoke-reset refuses to run under NODE_ENV=production. ' +
          'This script TRUNCATEs all tables — never safe in production.',
      ),
    };
  }

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      ok: false,
      error: new Error(
        'smoke-reset: DATABASE_URL not set. Provide via env or SmokeResetOptions.databaseUrl.',
      ),
    };
  }

  // Whitelist: the smoke compose stack provisions `tokenfx_smoke`. Any other
  // DB name is treated as not-smoke and refuses TRUNCATE. Override via
  // explicit `options.allowDatabaseName` for tests using testcontainer DBs
  // (which generate random names per container).
  const allowedName = options.allowDatabaseName ?? 'tokenfx_smoke';
  if (!databaseUrl.includes(allowedName)) {
    return {
      ok: false,
      error: new Error(
        `smoke-reset refuses: DATABASE_URL does not target the expected smoke DB ` +
          `(expected substring "${allowedName}"). Pass options.allowDatabaseName ` +
          `to override (only for test fixtures with generated DB names).`,
      ),
    };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Single TRUNCATE statement covering every table. PG TRUNCATE accepts
    // a comma-separated list and resolves the CASCADE graph internally —
    // safer than per-table TRUNCATE which would force us to enumerate the
    // dependency order manually.
    const tableList = SMOKE_RESET_TABLES.join(', ');
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
  } catch (e: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors — the original error is the actionable one.
    }
    const cause = e instanceof Error ? e : new Error(String(e));
    return {
      ok: false,
      error: new Error(`smoke-reset: TRUNCATE failed: ${cause.message}`, { cause }),
    };
  } finally {
    client.release();
    await pool.end();
  }

  // Re-run migrate post-truncate. Idempotent (Drizzle journal short-circuits
  // already-applied migrations; hand-crafted SQL uses IF NOT EXISTS). This
  // guarantees the post-reset schema is identical to a fresh deploy even if
  // the migrate pipeline grew new statements between resets.
  try {
    const remigrate = options.remigrate ?? defaultRemigrate;
    await remigrate(databaseUrl);
  } catch (e: unknown) {
    const cause = e instanceof Error ? e : new Error(String(e));
    return {
      ok: false,
      error: new Error(`smoke-reset: re-migrate failed: ${cause.message}`, { cause }),
    };
  }

  return { ok: true, value: undefined };
};

/**
 * Default re-migrate hook — dynamic-imports `lib/db/migrate.ts` so the
 * compiled `dist/scripts/smoke-reset.js` lazily resolves the migrate module
 * at runtime (the Dockerfile builder stage compiles both files; the
 * resulting `dist/lib/db/migrate.js` sits alongside this script).
 *
 * Dynamic import keeps the unit test fast — the test passes a stub
 * `remigrate` and never loads the real migrator (which would try to read
 * `./lib/db/migrations/` relative to cwd).
 */
const defaultRemigrate = async (databaseUrl: string): Promise<void> => {
  // Resolved at runtime so the test path can skip this branch entirely.
  // The compiled JS path is `../lib/db/migrate` relative to `dist/scripts/`.
  const migrateModule = (await import('../lib/db/migrate')) as {
    runMigrations: (url?: string) => Promise<void>;
  };
  await migrateModule.runMigrations(databaseUrl);
};

// CLI entry — exercised by `docker exec tokenfx-server node dist/scripts/smoke-reset.js`
// from the host-side smoke-reset orchestrator (TASK-RESET-ROOT).
if (require.main === module) {
  void (async (): Promise<void> => {
    const result = await smokeReset();
    if (!result.ok) {
      process.stderr.write(`smoke-reset failed: ${result.error.message}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `smoke-reset complete — ${SMOKE_RESET_TABLES.length} tables truncated + re-migrated\n`,
    );
    process.exit(0);
  })();
}
