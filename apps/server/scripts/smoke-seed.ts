#!/usr/bin/env tsx
/**
 * Smoke seed for `apps/server` (TASK-SEED-SERVER of
 * `.specs/cross-stack-smoke-validation.md`).
 *
 * Deterministic dataset for cross-stack smoke validation:
 *
 *   - 1 org: "Smoke Co" (UUID `00000000-0000-4000-8000-aaaa00000001`)
 *   - 2 users:
 *       - smoke-user-1@example.com  role=manager  UUID `…aaaa00000002`
 *       - smoke-user-2@example.com  role=member   UUID `…aaaa00000003`
 *   - 1 user_machine for user-1 (machineId `…aaaa0000aaaa`, keyId `key-smoke-001`)
 *       Bearer plaintext: `crypto.randomBytes(32).toString('hex')`. Bcrypt
 *       hashed before INSERT — plaintext NEVER stored at rest.
 *   - 1 active, non-revoked invite with `email_pattern='smoke-user-3@example.com'`
 *     (valid `expires_at` 30 days out).
 *   - role `tokenfx` created if missing (idempotent `DO $$ … END $$`). Requires
 *     superuser; we DOWNGRADE TO WARN when not superuser (the smoke profile in
 *     docker-compose runs PG with the default `tokenfx` superuser, so the
 *     normal path is silent).
 *
 * SIDE EFFECT — `.env.smoke` (host-side, gitignored) is written with:
 *
 *   ```
 *   REPORTER_BEARER_SECRET=<plaintext 64 hex chars>
 *   REPORTER_PROJECT_SECRET=<64 hex chars>
 *   REPORTER_KEY_ID=key-smoke-001
 *   REPORTER_TARGET_URL=http://localhost:3232
 *   ```
 *
 * The plaintext bearer secret is leaked to disk INTENTIONALLY here (smoke
 * runbook hand-loads it on the reporter side via `source .env.smoke`).
 * `.env.smoke` is gitignored. We log the WRITTEN PATH, not the contents.
 *
 * Usage:
 *   tsx apps/server/scripts/smoke-seed.ts                    # uses $DATABASE_URL + ./.env.smoke
 *   tsx apps/server/scripts/smoke-seed.ts /tmp/x/.env.smoke  # custom env path
 *
 * The exported `runSmokeSeed` is the test seam — it takes the database URL
 * and env path as explicit args so the test suite can exercise the failure
 * mode (unreachable PG) and the happy path (testcontainer) without process
 * env mutation.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@/lib/db/schema';
import { BCRYPT_COST } from '@/lib/auth/bearer-auth';
import { hashInviteToken } from '@/lib/auth/tokens';

// --- Public types -----------------------------------------------------------

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface SmokeSeedOptions {
  readonly databaseUrl: string;
  /** Absolute path where `.env.smoke` is written. */
  readonly envSmokePath: string;
  /** Optional override for the tokenfx role password (default `smoke-pg-password`). */
  readonly tokenfxRolePassword?: string;
}

export interface SmokeSeedResult {
  readonly orgId: string;
  readonly user1Id: string;
  readonly user2Id: string;
  readonly machineId: string;
  readonly keyId: string;
  readonly bearerPlaintext: string;
  readonly projectSecret: string;
  /** Non-fatal warnings (e.g. could not create `tokenfx` role: not superuser). */
  readonly warnings: readonly string[];
  /** Absolute path of the `.env.smoke` written. */
  readonly envSmokePath: string;
}

// --- Constants (deterministic seed values) ----------------------------------

const ORG_ID = '00000000-0000-4000-8000-aaaa00000001';
const USER_1_ID = '00000000-0000-4000-8000-aaaa00000002';
const USER_2_ID = '00000000-0000-4000-8000-aaaa00000003';
const MACHINE_UUID = '00000000-0000-4000-8000-aaaa0000aaaa';
const KEY_ID = 'key-smoke-001';
const USER_1_EMAIL = 'smoke-user-1@example.com';
const USER_2_EMAIL = 'smoke-user-2@example.com';
const INVITE_EMAIL_PATTERN = 'smoke-user-3@example.com';
const ORG_NAME = 'Smoke Co';
const INVITE_TOKEN_PREFIX = 'smoke-invite-token-';

const DEFAULT_TOKENFX_PASSWORD = 'smoke-pg-password';

// --- Core seed function -----------------------------------------------------

export const runSmokeSeed = async (
  opts: SmokeSeedOptions,
): Promise<Result<SmokeSeedResult, Error>> => {
  if (!opts.databaseUrl) {
    return {
      ok: false,
      error: new Error('smoke-seed: DATABASE_URL is required'),
    };
  }

  // Fail-fast Pool config — TC-I-11 requires we error within a few seconds when
  // the PG endpoint is unreachable. Defaults can wait ~30s+; we cap aggressively.
  const pool = new Pool({
    connectionString: opts.databaseUrl,
    connectionTimeoutMillis: 2_000,
    // 1 client is plenty for a serial seed; cap to avoid Pool exhaustion delays.
    max: 1,
  });

  // The Pool emits 'error' on idle-client failures (which we don't trigger
  // here, but ignore to avoid noisy logs in test runs).
  pool.on('error', () => {
    /* swallow — surfaced via per-query try/catch below */
  });

  const warnings: string[] = [];

  try {
    const db = drizzle(pool, { schema });

    // 1. role `tokenfx` — separate transaction (DO block). Requires superuser.
    //    Gracefully WARN if we lack rights; the smoke compose config runs as
    //    superuser so this is the silent path in practice.
    //
    //    Postgres DO blocks execute via the simple-query protocol and do NOT
    //    accept bind parameters — `$N` placeholders cannot pass into the block.
    //    We instead validate the password against a strict whitelist (so it's
    //    impossible to embed quote/semicolon/etc) and inline it via
    //    quote_literal at the SQL layer. Defense-in-depth.
    const rolePassword = opts.tokenfxRolePassword ?? DEFAULT_TOKENFX_PASSWORD;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rolePassword)) {
      return {
        ok: false,
        error: new Error(
          'smoke-seed: tokenfxRolePassword must match /^[A-Za-z0-9_-]{1,64}$/ (no shell/SQL specials)',
        ),
      };
    }
    try {
      await pool.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tokenfx') THEN
             EXECUTE 'CREATE ROLE tokenfx LOGIN PASSWORD ' || quote_literal('${rolePassword}');
           END IF;
         END $$;`,
      );
    } catch (err) {
      // permission denied → not superuser → warn + continue.
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied|must be superuser|must have CREATEROLE/i.test(msg)) {
        warnings.push(
          `smoke-seed: could not create role 'tokenfx' (not superuser) — skipping. ${msg}`,
        );
      } else {
        // Re-raise unexpected failures (network drop mid-flight, etc.).
        throw err;
      }
    }

    // 2. Mint secrets BEFORE the data transaction — failure here aborts cheaply.
    const bearerPlaintext = randomBytes(32).toString('hex');
    const projectSecret = randomBytes(32).toString('hex');
    const bearerHash = await bcrypt.hash(bearerPlaintext, BCRYPT_COST);

    // 3. Data seed — single transaction (atomic). Idempotent via onConflictDoNothing.
    await db.transaction(async (tx) => {
      // Org
      await tx
        .insert(schema.orgs)
        .values({ id: ORG_ID, name: ORG_NAME })
        .onConflictDoNothing();

      // Users — manager + member.
      await tx
        .insert(schema.users)
        .values([
          {
            id: USER_1_ID,
            orgId: ORG_ID,
            email: USER_1_EMAIL,
            ssoProvider: 'manual-seed',
            ssoSubject: `seed:${USER_1_EMAIL}`,
            role: 'manager',
          },
          {
            id: USER_2_ID,
            orgId: ORG_ID,
            email: USER_2_EMAIL,
            ssoProvider: 'manual-seed',
            ssoSubject: `seed:${USER_2_EMAIL}`,
            role: 'member',
          },
        ])
        .onConflictDoNothing();

      // Machine for user-1 (only). Bcrypt-hashed secret at rest.
      await tx
        .insert(schema.userMachines)
        .values({
          userId: USER_1_ID,
          machineId: MACHINE_UUID,
          keyId: KEY_ID,
          secretHash: bearerHash,
          provisionedVia: 'manual-token',
        })
        .onConflictDoNothing();

      // Invite — active (non-revoked), valid expires_at (30 days), email_pattern
      // matches user-3. The 30-day window stays well inside the 180-day SSO
      // expires cap enforced by `onboarding_invites_sso_expires_check`.
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const smokeInviteToken = `${INVITE_TOKEN_PREFIX}${randomBytes(8).toString('hex')}`;
      await tx
        .insert(schema.onboardingInvites)
        .values({
          // Email-pattern fixture, not token-redeemed in smoke — store the
          // hash at rest with its plaintext-derived prefix.
          tokenHash: hashInviteToken(smokeInviteToken),
          tokenPrefix: smokeInviteToken.slice(0, 8),
          orgId: ORG_ID,
          emailPattern: INVITE_EMAIL_PATTERN,
          maxUses: 1,
          usedCount: 0,
          expiresAt,
          createdBy: USER_1_ID,
        })
        .onConflictDoNothing();
    });

    // 4. `.env.smoke` — single atomic writeFile (no append; preserves the
    //    contract that re-running the seed always reflects the freshly-minted
    //    plaintext, never a stale one).
    const envPath = resolve(opts.envSmokePath);
    const envContent =
      [
        `REPORTER_BEARER_SECRET=${bearerPlaintext}`,
        `REPORTER_PROJECT_SECRET=${projectSecret}`,
        `REPORTER_KEY_ID=${KEY_ID}`,
        `REPORTER_TARGET_URL=http://localhost:3232`,
        '',
      ].join('\n');
    writeFileSync(envPath, envContent, { mode: 0o600 });

    return {
      ok: true,
      value: {
        orgId: ORG_ID,
        user1Id: USER_1_ID,
        user2Id: USER_2_ID,
        machineId: MACHINE_UUID,
        keyId: KEY_ID,
        bearerPlaintext,
        projectSecret,
        warnings,
        envSmokePath: envPath,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  } finally {
    await pool.end().catch(() => {
      /* connection may already be dead — best-effort cleanup */
    });
  }
};

// --- CLI entrypoint ---------------------------------------------------------

const isCli = (() => {
  // Two-path detection: tsx (ESM) and esbuild-bundled CJS.
  //  - tsx runs the file as ESM → `import.meta.url` is the file URL.
  //  - esbuild --format=cjs strips import.meta; in CJS `require.main` is
  //    the entry module. We check BOTH so the same script works in
  //    `pnpm tsx scripts/smoke-seed.ts` and `node dist/scripts/smoke-seed.js`.
  try {
    if (typeof require !== 'undefined' && require.main === module) return true;
  } catch {
    /* require/module not in scope (pure ESM) */
  }
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isCli) {
  void (async () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const envPathArg = process.argv[2] ?? resolve(process.cwd(), '.env.smoke');

    if (!databaseUrl) {
      process.stderr.write('smoke-seed: DATABASE_URL env var is required\n');
      process.exit(1);
    }

    const result = await runSmokeSeed({
      databaseUrl,
      envSmokePath: envPathArg,
    });

    if (!result.ok) {
      process.stderr.write(`smoke-seed: failed — ${result.error.message}\n`);
      process.exit(1);
    }

    // Log the written path (NOT the contents — plaintext stays out of stdout/logs).
    process.stdout.write(
      `[smoke-seed] org=${result.value.orgId} users=2 machines=1 invites=1\n`,
    );
    process.stdout.write(`[smoke-seed] wrote ${result.value.envSmokePath}\n`);
    for (const w of result.value.warnings) {
      process.stderr.write(`[smoke-seed] WARN: ${w}\n`);
    }
    process.exit(0);
  })();
}
