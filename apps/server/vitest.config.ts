import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/integration/setup-pg.ts'],
    testTimeout: 30_000, // Postgres startup can be slow
    // tests/e2e/* are Playwright specs (manager.spec.ts) — Vitest picks up
    // *.spec.ts by default; exclude the e2e dir so they don't crash here.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    // Integration tests share ONE Testcontainers Postgres instance via
    // `globalSetup`. Running test files in parallel would race on TRUNCATE
    // CASCADE between sibling files (teams/overview/ingest all wipe + seed
    // the same tables in their `beforeAll`). Serializing keeps them coherent.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@root': path.resolve(__dirname, '../../lib'),
    },
  },
});
