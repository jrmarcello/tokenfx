import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the central server (TASK-22).
 *
 * `globalSetup` (`tests/e2e/global-setup.ts`) is responsible for:
 *   1. Booting the Postgres testcontainer
 *   2. Running migrations + the deterministic E2E seed
 *   3. Spawning the Next.js dev server with the resolved DATABASE_URL +
 *      auth env vars (NEXTAUTH_SECRET, dummy OAuth provider creds, etc.)
 *
 * We deliberately do NOT use Playwright's own `webServer` block: it spawns
 * the server BEFORE `globalSetup` runs, which means the dev server would
 * not see the testcontainer's dynamic connection URI. Spawning from
 * globalSetup guarantees ordering. See `global-setup.ts` for details.
 *
 * Set `SKIP_PG_TESTS=1` to bypass container + dev-server startup (useful
 * when running specs against an already-running stack).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3232',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './tests/e2e/global-setup.ts',
});
