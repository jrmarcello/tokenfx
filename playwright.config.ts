import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const TEST_DB = path.resolve(__dirname, 'data/e2e-test.db');

// When running the cross-stack `smoke` project, the user has already brought
// up the docker stack via `docker compose --profile smoke up -d` per
// `docs/smoke-runbook.md`. We must NOT auto-spawn `next dev` from
// Playwright's `webServer` in that mode (it would clobber port 3131 and
// collide with the dockerized root tokenfx). Detect the smoke run via env
// flag so the chromium project (default) still gets its dev server.
const IS_SMOKE_RUN = process.env.PLAYWRIGHT_SMOKE === '1';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  // Single worker — the suite shares one `next dev` server, and that server
  // in turn shares ONE `better-sqlite3` singleton connection (see
  // `lib/db/client.ts`). Multiple workers issuing writes (quota form
  // submits, rating POSTs) race against concurrent reads for the same
  // connection's WAL view, producing cascading flakes (e.g. /sessions
  // rendering "0 recentes" after a quota form submit in a sibling worker).
  // Serializing workers eliminates the race. Suite runs in ~1min.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3123',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      // `smoke` project — exercises the cross-stack docker smoke (root tokenfx
      // + apps/server + apps/idp-stub + postgres) brought up via
      // `docker compose --profile smoke up -d` per `docs/smoke-runbook.md`.
      //
      // This project assumes the stack is already running on host loopback
      // (root :3131, server :3232, idp-stub :3001) — it intentionally does
      // NOT spawn its own `webServer`. Run with:
      //   pnpm exec playwright test --project=smoke
      //
      // Tests are tagged `@smoke` in their titles; Playwright's `grep` filter
      // selects them. The shared `chromium` device config is reused for
      // consistency with the default project.
      name: 'smoke',
      testDir: './tests/e2e',
      grep: /@smoke/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3131',
      },
    },
  ],
  // Skip auto-spawning `next dev` when running the cross-stack smoke project
  // — the docker stack is already serving on host loopback.
  webServer: IS_SMOKE_RUN
    ? undefined
    : {
        // Seed the test DB FIRST, then boot `next dev`. Playwright's
        // `globalSetup` hook races `webServer` — next dev boots and opens the
        // DB on an inode that globalSetup later deletes and re-creates, leaving
        // the dev server holding a ghost FD. Chaining via shell makes the
        // sequence deterministic: seed → boot → serve.
        command: 'pnpm exec tsx tests/e2e/global-setup.ts && pnpm exec next dev',
        url: 'http://127.0.0.1:3123',
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DASHBOARD_DB_PATH: TEST_DB,
          NODE_ENV: 'development',
          PORT: '3123',
          // Keep SSR fast and deterministic — without this flag every page load
          // re-ingests ~/.claude/projects/ into the test DB.
          TOKENFX_DISABLE_AUTO_INGEST: '1',
        },
      },
  // NOTE: no `globalSetup` — seeding is chained into `webServer.command`
  // above so the dev server sees the seeded inode from first boot. A
  // Playwright `globalSetup` hook races the webServer and causes ghost-FD
  // bugs (better-sqlite3 keeps reading the pre-seed inode).
});
