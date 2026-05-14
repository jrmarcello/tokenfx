import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Audit tables that must be append-only at the role boundary. Migration 0004
 * REVOKEs UPDATE/DELETE from the configured app runtime role on these tables.
 * Boot-time invariant check (`assertAuditTablesAppendOnly`) verifies that
 * REVOKE actually held after migrate, closing the gap for:
 *   - non-canonical deploys (role name ≠ default `app_runtime`)
 *   - HIGH-2 race: role created AFTER migration 0004 already ran, never
 *     triggering the IF EXISTS-gated REVOKE block
 * Spec: review-report-2026-05-14-fixes.md §"D-1 unblocking" + self-review
 * Security HIGH-1/HIGH-2.
 */
const AUDIT_TABLES_APPEND_ONLY = [
  'auth_event_log',
  'onboarding_redemption_log',
  'onboarding_audit_log',
] as const;

const DEFAULT_APP_RUNTIME_ROLE = 'app_runtime';

/**
 * Resolve the configured app runtime role name. Env-driven so non-canonical
 * deploys can opt in without editing migration 0004's hard-coded literal.
 */
export const getAppRuntimeRole = (env: NodeJS.ProcessEnv = process.env): string =>
  env.TOKENFX_APP_RUNTIME_ROLE && env.TOKENFX_APP_RUNTIME_ROLE.length > 0
    ? env.TOKENFX_APP_RUNTIME_ROLE
    : DEFAULT_APP_RUNTIME_ROLE;

/**
 * Boot-time runtime check: verify that the configured app runtime role does
 * NOT have UPDATE or DELETE privileges on any of the append-only audit
 * tables. Defends against two HIGH-severity gaps surfaced in self-review:
 *
 *  HIGH-1: A deploy using a role name other than `app_runtime` silently
 *          skips migration 0004's REVOKE block (it's gated on the literal
 *          `app_runtime`); that role then retains default UPDATE/DELETE.
 *  HIGH-2: The role is created AFTER migration 0004 already ran (e.g. by
 *          a post-migration ops script); the REVOKE never fires.
 *
 * This check uses `has_table_privilege(role, table, privilege)` (PG built-in)
 * which honors actual ACLs at runtime. If a violation is found, throws —
 * server refuses to boot rather than silently allowing audit-log rewrites.
 *
 * If the role does NOT exist at boot time, returns 'role-missing' instead
 * of throwing — this is the expected state in fresh test/dev environments.
 * Operators are responsible for the role creation order in production.
 */
export type AuditInvariantResult =
  | { ok: true }
  | { ok: false; reason: 'role-missing' }
  | {
      ok: false;
      reason: 'append-only-violation';
      role: string;
      table: string;
      privilege: 'UPDATE' | 'DELETE';
    };

export const checkAuditTablesAppendOnly = async (
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: { exists: boolean }[] }> },
  role: string = getAppRuntimeRole(),
): Promise<AuditInvariantResult> => {
  // Role-existence check first — fresh test/dev DBs lack the role; the
  // migration's IF EXISTS-gated REVOKE already handled that path.
  const roleRow = await db.query(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists`,
    [role],
  );
  if (!roleRow.rows[0]?.exists) {
    return { ok: false, reason: 'role-missing' };
  }
  for (const table of AUDIT_TABLES_APPEND_ONLY) {
    for (const privilege of ['UPDATE', 'DELETE'] as const) {
      const row = await db.query(
        `SELECT has_table_privilege($1, $2, $3) AS exists`,
        [role, table, privilege],
      );
      if (row.rows[0]?.exists) {
        return { ok: false, reason: 'append-only-violation', role, table, privilege };
      }
    }
  }
  return { ok: true };
};

/**
 * Apply the audit-table REVOKE for the configured role. Called by
 * `runMigrations` after `migrate()` so HIGH-2 (role created after 0004
 * already applied) self-heals on next boot. Idempotent — REVOKE on an
 * already-revoked grant is a no-op.
 */
export const applyAuditTableRevokes = async (
  pool: { query: (sql: string) => Promise<unknown> },
  role: string,
): Promise<void> => {
  // Identifier-quote the role via pg_catalog.quote_ident — defense against
  // an accidentally-crafted env var that injects DDL. Role name comes from
  // `TOKENFX_APP_RUNTIME_ROLE` which is an operator-controlled env var; the
  // quote_ident defense is belt-and-suspenders.
  for (const table of AUDIT_TABLES_APPEND_ONLY) {
    await pool.query(
      `DO $$
       DECLARE qrole text := quote_ident('${role.replace(/'/g, "''")}');
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role.replace(/'/g, "''")}') THEN
           EXECUTE 'REVOKE UPDATE, DELETE ON ${table} FROM ' || qrole;
         END IF;
       END $$;`,
    );
  }
};

export const runMigrations = async (databaseUrl?: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl ?? process.env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  // HIGH-1/HIGH-2 mitigation: re-apply the REVOKE for the configured role
  // after migrate. Idempotent + closes the race where the role was created
  // post-0004.
  const role = getAppRuntimeRole();
  await applyAuditTableRevokes(pool, role);
  // HIGH-1/HIGH-2 invariant check: refuse to boot if the runtime role still
  // has UPDATE/DELETE on any append-only table. `role-missing` is OK in
  // test/dev (the migration's IF EXISTS branch handled it).
  const invariant = await checkAuditTablesAppendOnly(
    {
      query: (sql, params) =>
        pool.query(sql, params as unknown as unknown[]) as Promise<{
          rows: { exists: boolean }[];
        }>,
    },
    role,
  );
  if (!invariant.ok && invariant.reason === 'append-only-violation') {
    await pool.end();
    throw new Error(
      `audit-log invariant violated: role "${invariant.role}" has ${invariant.privilege} on ${invariant.table}. ` +
        `Migration 0004's REVOKE block did not apply. Verify the role name (TOKENFX_APP_RUNTIME_ROLE) ` +
        `matches the production role, then re-run migrations.`,
    );
  }
  await pool.end();
};

/**
 * CLI entry body extracted as a function so it is directly unit-testable.
 *
 * Rationale (REQ-11 / C-2): the CLI guarded by `require.main === module`
 * does not execute under Vitest, so the side-effects (stdout/stderr writes,
 * process exit) cannot be exercised through the module load. This function
 * accepts the runner and an `exit` callback as dependencies, letting tests
 * substitute hand-written stubs and inspect calls via `vi.spyOn` on
 * `process.stdout.write` / `process.stderr.write`.
 *
 * Uses `process.stdout.write` / `process.stderr.write` (NOT `console.*`) so
 * the file is consistent with the project's logger rule (`.claude/rules/
 * ts-conventions.md`) for non-library CLI output and is grep-clean against
 * `console.`.
 */
export const runMigrationsCli = async (
  runner: (databaseUrl?: string) => Promise<void>,
  exit: (code: number) => void,
): Promise<void> => {
  try {
    await runner();
    process.stdout.write('migrations complete\n');
    exit(0);
  } catch (e: unknown) {
    process.stderr.write(String(e) + '\n');
    exit(1);
  }
};

if (require.main === module) {
  void runMigrationsCli(runMigrations, (code) => process.exit(code));
}
