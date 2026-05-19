/**
 * Playwright globalSetup for the central server E2E suite.
 *
 * Responsibilities:
 *   1. Spin up a Postgres 16 testcontainer once per Playwright run.
 *   2. Apply Drizzle migrations against the container.
 *   3. Seed the deterministic fixtures (`scripts/seed-server.ts --e2e`,
 *      seed-manager-v2.ts, seed-manager-v3-outcomes.ts).
 *   4. Spawn the local OIDC IdP stub (`@tokenfx/idp-stub`) so NextAuth's
 *      Okta provider can sign-in end-to-end without a real Okta tenant.
 *   5. Spawn the Next.js dev server with `DATABASE_URL` + auth env vars
 *      + OKTA_* envs pointing at the stub.
 *
 * Why launch the dev server from here instead of `playwright.config.ts`'s
 * `webServer` block? Because the testcontainer's connection URI is dynamic
 * (testcontainers picks a free host port), and `webServer` is spawned BEFORE
 * `globalSetup` runs — so the dev server would not see the container URL.
 * Spawning here guarantees the server inherits the correct `DATABASE_URL`
 * after `globalSetup` resolves it.
 *
 * Set `SKIP_PG_TESTS=1` to bypass container + dev-server startup (useful
 * when running specs against an already-running stack).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { buildSpawnOptions, pipeChildToFile } from './helpers/spawn-with-log';

// fix-sso-e2e-remaining-5 TASK-0: capture dev-server + idp-stub stdio to
// `tests/e2e/.logs/*.log`. Without this, next-auth error lines emitted via
// `console.error` (e.g. `[next-auth][error] { error_type: 'Configuration',
// error_message: '...' }`) vanish after the test run — Playwright's
// reporter does not persist child-process stderr.
const LOGS_DIR = path.resolve(__dirname, '.logs');

let container: StartedPostgreSqlContainer | null = null;
let devServer: ChildProcess | null = null;
let idpStub: ChildProcess | null = null;

const DEV_PORT = 3232;
const DEV_BOOT_TIMEOUT_MS = 60_000;
const IDP_STUB_PORT = Number(process.env.IDP_STUB_PORT ?? 3001);
const IDP_STUB_BASE_URL =
  process.env.IDP_STUB_BASE_URL ?? `http://localhost:${IDP_STUB_PORT}`;
const IDP_STUB_BOOT_TIMEOUT_MS = 5_000;

const stopContainer = async (): Promise<void> => {
  if (container) {
    await container.stop().catch(() => {
      // best-effort: don't crash teardown if stop races process exit
    });
    container = null;
  }
};

const stopDevServer = (): void => {
  if (devServer && !devServer.killed) {
    devServer.kill('SIGTERM');
    devServer = null;
  }
};

const stopIdpStub = (): void => {
  if (idpStub && !idpStub.killed) {
    idpStub.kill('SIGTERM');
    idpStub = null;
  }
};

/**
 * Unified teardown — kills all spawned processes + stops the testcontainer.
 * Called from every signal handler (SIGINT, SIGTERM, beforeExit) to avoid
 * the race where one handler's `process.exit()` runs before another's
 * cleanup completes.
 */
const stopAll = async (): Promise<void> => {
  stopIdpStub();
  stopDevServer();
  await stopContainer();
};

const waitForUrlReady = async (
  url: string,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.status >= 100 && res.status < 500) return;
    } catch {
      // ECONNREFUSED / abort — keep polling.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`[e2e setup] ${label} did not respond within ${timeoutMs}ms (${url})`);
};

/**
 * Wait for the dev server to respond on `/` (or any 2xx/3xx/4xx — anything
 * but `ECONNREFUSED`). We don't care about the body, just that the listener
 * is up. Polls every 250ms up to `DEV_BOOT_TIMEOUT_MS`.
 *
 * fix-sso-e2e-remaining-5 TASK-1: races against `child.once('exit', ...)`
 * so an early dev-server crash (e.g. `EADDRINUSE` when a previous run left
 * port 3232 in use) rejects FAST with the exit code instead of timing out
 * after 60s. Without this, a hanging dev-server made every subsequent
 * test fail with the opaque NextAuth `?error=Configuration` because the
 * Credentials callback's POST hit nothing — the previous session's
 * "30-test regression" misdiagnosed this as an invite-seeding fixture
 * pollution issue.
 */
const waitForDevServerReady = async (
  port: number,
  child: ChildProcess,
): Promise<void> => {
  const deadline = Date.now() + DEV_BOOT_TIMEOUT_MS;
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  const exitRef: { current: ExitInfo | null } = { current: null };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitRef.current = { code, signal };
  };
  child.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      const exited = exitRef.current;
      if (exited !== null) {
        throw new Error(
          `[e2e setup] dev server exited prematurely (code=${exited.code} signal=${exited.signal}). Check tests/e2e/.logs/dev-server.log for the cause — common: port ${port} already in use (lsof -ti:${port} | xargs kill).`,
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(1_000),
        });
        if (res.status >= 100) return;
      } catch {
        // ECONNREFUSED / abort — keep polling.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `[e2e setup] dev server did not respond on :${port} within ${DEV_BOOT_TIMEOUT_MS}ms`,
    );
  } finally {
    child.off('exit', onExit);
  }
};

const setup = async (): Promise<void> => {
  if (process.env.SKIP_PG_TESTS === '1') {
    process.stdout.write('[e2e setup] SKIP_PG_TESTS=1 — skipping Postgres setup\n');
    return;
  }

  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tokenfx_e2e')
    .withUsername('test')
    .withPassword('test')
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  const cwd = path.resolve(__dirname, '..', '..');
  const repoRoot = path.resolve(cwd, '..', '..');
  execFileSync('pnpm', ['db:migrate'], { stdio: 'inherit', cwd });

  // Apply orphan hand-crafted .sql migrations that aren't yet registered
  // in the Drizzle journal (`meta/_journal.json`). Mirrors the integration
  // suite's logic in `tests/integration/setup-pg.ts:62-109` — without this,
  // migrations 0004 + 0005 are skipped here and seed-server.ts fails on
  // `column "provisioned_via" does not exist`.
  const migrationsFolder = path.resolve(cwd, 'lib', 'db', 'migrations');
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const knownTags = new Set(journal.entries.map((e) => e.tag));
  const orphans = readdirSync(migrationsFolder)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !knownTags.has(f.replace(/\.sql$/, '')))
    .sort();
  if (orphans.length > 0) {
    const orphanPool = new Pool({ connectionString: databaseUrl });
    try {
      for (const file of orphans) {
        const sql = readFileSync(path.join(migrationsFolder, file), 'utf8');
        const stmts = sql
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
            // Skip psql client-side variable substitution (`:"role_name"`)
            // — production hardening with no test-time semantics.
            if (/:"[A-Za-z_][A-Za-z0-9_]*"/.test(stripped)) return false;
            return true;
          });
        for (const stmt of stmts) {
          await orphanPool.query(stmt);
        }
      }
    } finally {
      await orphanPool.end();
    }
  }

  execFileSync('tsx', ['scripts/seed-server.ts', '--e2e'], {
    stdio: 'inherit',
    cwd,
  });
  execFileSync('tsx', ['scripts/seed-manager-v2.ts'], {
    stdio: 'inherit',
    cwd,
  });
  execFileSync('tsx', ['scripts/seed-manager-v3-outcomes.ts'], {
    stdio: 'inherit',
    cwd,
  });

  // Spawn the idp-stub BEFORE the dev server so the OKTA_* env vars below
  // point at a live discovery endpoint that NextAuth can reach as soon as
  // it boots.
  //
  // TASK-0: piped stdio (NOT 'inherit') so stderr lands in
  // tests/e2e/.logs/idp-stub.log via the readline + redaction pipeline.
  const idpStubSpawn = buildSpawnOptions('idp-stub', LOGS_DIR);
  idpStub = spawn('pnpm', ['--filter', '@tokenfx/idp-stub', 'start'], {
    cwd: repoRoot,
    stdio: idpStubSpawn.stdio,
    env: {
      ...process.env,
      IDP_STUB_PORT: String(IDP_STUB_PORT),
      IDP_STUB_BASE_URL,
    },
  });
  await pipeChildToFile(idpStub, 'idp-stub', LOGS_DIR);
  idpStub.on('exit', (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[e2e setup] idp-stub exited with code ${code}\n`);
    }
  });
  await waitForUrlReady(
    `${IDP_STUB_BASE_URL}/.well-known/openid-configuration`,
    IDP_STUB_BOOT_TIMEOUT_MS,
    'idp-stub',
  );

  const e2eSecret = process.env.NEXTAUTH_SECRET ?? 'tokenfx-e2e-secret';
  // TASK-0: piped stdio for dev-server stderr capture. Without this the
  // next-auth `[next-auth][error]` lines (which surface Configuration /
  // InvalidCheck failures) are unreachable after a test run ends.
  const devServerSpawn = buildSpawnOptions('dev-server', LOGS_DIR);
  devServer = spawn('pnpm', ['dev'], {
    cwd,
    stdio: devServerSpawn.stdio,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: e2eSecret,
      NEXTAUTH_SECRET: e2eSecret,
      AUTH_TRUST_HOST: '1',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? 'e2e-google-id',
      GOOGLE_CLIENT_SECRET:
        process.env.GOOGLE_CLIENT_SECRET ?? 'e2e-google-secret',
      // Point NextAuth's Okta provider at the local stub. The fake values
      // below are shaped so secret-scanners (gitleaks/trufflehog) skip them;
      // the stub does not validate client_secret at /token in any case.
      OKTA_CLIENT_ID: 'test-client',
      OKTA_CLIENT_SECRET: 'fake-e2e-not-a-real-secret',
      OKTA_ISSUER: IDP_STUB_BASE_URL,
      // Extend the orchestrator's issuer whitelist via the existing env hook
      // (sso-auto-provision.ts:DEFAULT_ISSUER_WHITELIST).
      TOKENFX_SSO_ISSUERS_OKTA: IDP_STUB_BASE_URL,
      // fix-sso-e2e-remaining-5 TASK-2 root-cause: sso-auto-provision.ts
      // sources `clientId` from `TOKENFX_NEXTAUTH_CLIENT_ID` for the
      // `audience !== clientId` CSRF guard. Without this env, every
      // Okta callback short-circuited to `rejected-csrf` → CallbackRouteError
      // → /auth/error?error=Configuration. Setting it to match the
      // OKTA_CLIENT_ID above unblocks TC-E2E-01 / TC-E2E-02 / TC-E2E-04.
      TOKENFX_NEXTAUTH_CLIENT_ID: 'test-client',
      // fix-e2e-auth-bypass: test-only Credentials provider gate.
      E2E_AUTH_BYPASS: '1',
      HOSTNAME: '127.0.0.1',
    },
  });
  await pipeChildToFile(devServer, 'dev-server', LOGS_DIR);
  devServer.on('exit', (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[e2e setup] dev server exited with code ${code}\n`);
    }
  });

  await waitForDevServerReady(DEV_PORT, devServer);

  // Unified teardown via stopAll() — every handler defers to the same
  // shared helper, then exits with the appropriate code. Prevents the
  // race where the first signal handler's process.exit() fires before
  // a sibling handler's cleanup completes.
  process.once('beforeExit', () => {
    void stopAll();
  });
  process.once('SIGINT', () => {
    void stopAll().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    void stopAll().finally(() => process.exit(143));
  });
};

export default setup;
