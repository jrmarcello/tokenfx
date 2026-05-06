/**
 * Playwright globalSetup for the central server E2E suite (TASK-22).
 *
 * Responsibilities:
 *   1. Spin up a Postgres 16 testcontainer once per Playwright run.
 *   2. Apply Drizzle migrations against the container.
 *   3. Seed the deterministic fixture (`scripts/seed-server.ts --e2e`).
 *   4. Spawn the Next.js dev server with `DATABASE_URL` + auth env vars set.
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
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | null = null;
let devServer: ChildProcess | null = null;

const DEV_PORT = 3232;
const DEV_BOOT_TIMEOUT_MS = 60_000;

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

/**
 * Wait for the dev server to respond on `/api/health` (or any 2xx/3xx/4xx
 * answer — anything but `ECONNREFUSED`). We don't care about the body, just
 * that the listener is up. Polls every 250ms up to `DEV_BOOT_TIMEOUT_MS`.
 */
const waitForDevServerReady = async (port: number): Promise<void> => {
  const deadline = Date.now() + DEV_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1_000),
      });
      // Any HTTP response means the listener is up; auth gate may 403/redirect
      // but that's fine — we just need the process accepting connections.
      if (res.status >= 100) return;
    } catch {
      // ECONNREFUSED / abort — keep polling.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `[e2e setup] dev server did not respond on :${port} within ${DEV_BOOT_TIMEOUT_MS}ms`,
  );
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
  // execFileSync (vs execSync) — argv array form prevents future refactors
  // from accidentally interpolating shell metacharacters from a test parameter
  // into the command string. Today neither call has user input, but the
  // argv form is what the project's security checklist asks for.
  execFileSync('pnpm', ['db:migrate'], { stdio: 'inherit', cwd });
  execFileSync('tsx', ['scripts/seed-server.ts', '--e2e'], {
    stdio: 'inherit',
    cwd,
  });
  // Manager-dashboard-v2 fixture: 3-team Alpha + 1-team Gamma + 30d of
  // team_metrics_daily rollups. Required for TC-E2E-02 (3-polygon radar)
  // and TC-E2E-13 (1-team radar absent). Idempotent — re-runs safely
  // via `onConflictDoNothing`/`onConflictDoUpdate` inside seedManagerV2.
  // Run as a child process (mirrors seed-server.ts above) so a failure
  // surfaces as a non-zero exit + thrown ChildProcessError, propagating
  // cleanly to globalSetup → Playwright (run aborts; container is torn
  // down by the SIGTERM/beforeExit handlers below).
  execFileSync('tsx', ['scripts/seed-manager-v2.ts'], {
    stdio: 'inherit',
    cwd,
  });

  // Spawn the dev server with the container URI + auth-bypass env vars. The
  // secret here MUST match `manager.spec.ts:E2E_SECRET` — the test mints
  // session JWTs with this secret and the server has to decode with the
  // same value. Provider creds are dummies; the JWT-cookie auth bypass
  // never round-trips through OAuth, but NextAuth refuses to initialize
  // providers with `undefined` clientId/clientSecret, so we feed them
  // values to keep the signin error page from masking real failures.
  const e2eSecret = process.env.NEXTAUTH_SECRET ?? 'tokenfx-e2e-secret';
  devServer = spawn('pnpm', ['dev'], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: e2eSecret,
      NEXTAUTH_SECRET: e2eSecret,
      AUTH_TRUST_HOST: '1',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? 'e2e-google-id',
      GOOGLE_CLIENT_SECRET:
        process.env.GOOGLE_CLIENT_SECRET ?? 'e2e-google-secret',
      OKTA_CLIENT_ID: process.env.OKTA_CLIENT_ID ?? 'e2e-okta-id',
      OKTA_CLIENT_SECRET:
        process.env.OKTA_CLIENT_SECRET ?? 'e2e-okta-secret',
      OKTA_ISSUER:
        process.env.OKTA_ISSUER ?? 'https://e2e.okta.example/oauth2/default',
    },
  });
  devServer.on('exit', (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[e2e setup] dev server exited with code ${code}\n`);
    }
  });

  await waitForDevServerReady(DEV_PORT);

  // Hold container + dev server alive for the rest of the Playwright run;
  // SIGINT/SIGTERM handlers below tear them down on Ctrl+C or runner kill.
  // We deliberately do NOT register `process.once('exit', ...)` — the `exit`
  // event is synchronous, so `void stopContainer()` would fire-and-forget
  // and Node would exit before the testcontainer stop completes (lingering
  // container). Letting Playwright's own teardown run + `beforeExit` handle
  // the natural shutdown is enough; for abnormal exit, the OS reclaims the
  // child processes anyway.
  process.once('beforeExit', () => {
    stopDevServer();
    void stopContainer();
  });
  process.once('SIGINT', () => {
    stopDevServer();
    void stopContainer().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    stopDevServer();
    void stopContainer().finally(() => process.exit(143));
  });
};

export default setup;
