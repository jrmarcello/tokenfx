/**
 * Subprocess-based integration tests for the flash-cookie boot guard
 * (`.specs/onboarding-followups-lowsev.md` REQ-12, REQ-13).
 *
 * Each test spawns `tsx` in a child process with a curated `env`, loads
 * the target module, and inspects the exit code + stderr. This is the
 * only way to exercise module-load side effects (boot guards that throw)
 * without polluting the parent test process's module graph.
 *
 * The tests do NOT need Postgres up — they exercise pure module-load
 * paths. Vitest's global setup may attempt to start a testcontainer, in
 * which case the suite runs as part of the integration tier; with
 * SKIP_PG_TESTS=1 the global setup short-circuits and these still run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

const runTsx = (code: string, env: NodeJS.ProcessEnv) => {
  const tsxBin = path.resolve(repoRoot, 'node_modules', '.bin', 'tsx');
  return spawnSync(tsxBin, ['-e', code], {
    cwd: repoRoot,
    env: { ...env, PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });
};

describe('flash-cookie boot guard — subprocess integration', () => {
  it('TC-I-08: assertFlashSecretAvailable throws when invoked directly with prod env + missing secrets', () => {
    const result = runTsx(
      `import { assertFlashSecretAvailable } from '@/lib/auth/flash-cookie';
       assertFlashSecretAvailable(process.env);`,
      { NODE_ENV: 'production' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/AUTH_SECRET.*required for flash cookies/);
  });

  it('TC-I-09: auth.ts loads cleanly when AUTH_SECRET + ONBOARDING_EMAIL_HASH_PEPPER are set in production', () => {
    const result = runTsx(
      `import('@/lib/auth/auth').then(() => process.exit(0));`,
      {
        NODE_ENV: 'production',
        AUTH_SECRET: 'x-secret-for-test',
        ONBOARDING_EMAIL_HASH_PEPPER: 'p-pepper-for-test',
        // Provide minimal env so the module doesn't bail on unrelated reads.
        DATABASE_URL: 'postgres://dummy@localhost:1/dummy',
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 'g',
        OKTA_CLIENT_ID: 'o',
        OKTA_CLIENT_SECRET: 'o',
        OKTA_ISSUER: 'https://e2e.okta.example/oauth2/default',
      },
    );
    // With all required secrets set, all module-load guards pass — exit 0.
    // The dynamic import keeps the assertion local to module-load (no
    // further runtime queries happen before process.exit).
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/required/);
  });

  it('TC-I-10: auth.ts throws SOME secret-required error in production when all secrets are unset (regression — guard chain intact, no silent boot)', () => {
    const result = runTsx(
      `import('@/lib/auth/auth').then(() => process.exit(0));`,
      {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://dummy@localhost:1/dummy',
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 'g',
        OKTA_CLIENT_ID: 'o',
        OKTA_CLIENT_SECRET: 'o',
        OKTA_ISSUER: 'https://e2e.okta.example/oauth2/default',
      },
    );
    expect(result.status).not.toBe(0);
    // The boot chain runs in import order: email-hash pepper guard fires
    // first (transitive import from `./load-user`), then AUTH_SECRET,
    // then assertFlashSecretAvailable, then assertNotProductionWithBypass.
    // We pin the assertion to the FIRST-FIRING guard's concrete error text
    // (email-hash pepper) so a future change to that message surfaces
    // here as a test failure, not as a silent vacuous pass.
    expect(result.stderr).toMatch(
      /ONBOARDING_EMAIL_HASH_PEPPER.*required in production/,
    );
    // Anti-regression: the flash-cookie guard is unreachable via auth.ts
    // chain (earlier guards fire first) — so its message MUST NOT appear
    // here. If it does, the earlier guards have been weakened.
    expect(result.stderr).not.toMatch(/required for flash cookies/);
  });
});
