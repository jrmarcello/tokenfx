---
name: Integration test patterns — central-reporter-server
description: Key patterns used in apps/server Postgres integration tests (Testcontainers, TRUNCATE CASCADE, closeDb, E2E setup)
type: project
---

apps/server integration tests share a single Testcontainers Postgres instance via `tests/integration/setup-pg.ts` (Vitest globalSetup). Files run serialized (`fileParallelism: false`, `sequence: { concurrent: false }`) because they all write to the same DB. Each test file that touches Postgres runs TRUNCATE TABLE ... RESTART IDENTITY CASCADE over all 9 schema tables in beforeAll/afterEach to prevent cross-file state leaks.

**Why:** prior to Fix C, parallel or ordered-but-unseeded runs caused FK/unique violations between sibling files (teams, overview, ingest all seed the same orgs/users tables).

**How to apply:** any new integration test file under apps/server must include the full 9-table TRUNCATE in its beforeAll. Cleanup.test.ts intentionally does NOT TRUNCATE in beforeAll (seeds org/user once and only wipes ingestion_log in afterEach) — this is an exception because it does not seed the tables that other sibling files seed.

E2E (Playwright) setup is in `tests/e2e/global-setup.ts` — spawns the dev server itself instead of using Playwright's webServer block because the Testcontainers URI is dynamic and not available at webServer-spawn time.

The `closeDb()` function in `lib/db/client.ts` nulls both pool and dbInstance, so multiple test files each calling it in afterAll is safe (subsequent calls are no-ops once pool is null).
