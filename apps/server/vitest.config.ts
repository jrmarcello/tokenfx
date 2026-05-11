import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/integration/setup-pg.ts'],
    testTimeout: 30_000, // Postgres startup can be slow
    // tests/e2e/*.spec.ts are Playwright specs — Vitest picks up *.spec.ts
    // by default; exclude those so they don't crash here. tests/e2e/helpers/
    // *.test.ts are unit tests of the e2e helper layer (fix-e2e-auth-bypass)
    // and DO run under Vitest, so we do NOT blanket-exclude `tests/e2e/**`.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/*.spec.ts'],
    // Integration tests share ONE Testcontainers Postgres instance via
    // `globalSetup`. Running test files in parallel would race on TRUNCATE
    // CASCADE between sibling files (teams/overview/ingest all wipe + seed
    // the same tables in their `beforeAll`). Serializing keeps them coherent.
    fileParallelism: false,
    sequence: { concurrent: false },
    // next-auth's internal `import 'next/server'` (no `.js`) breaks under
    // vitest's default external resolution because Node's ESM resolver
    // expects the explicit extension. Inlining next-auth + next forces
    // vitest to transform them through Vite's bundler, which respects the
    // `exports` map in their package.json. Without this, any test file
    // that imports a Server Component touching `auth` or `after` fails
    // with "Cannot find module .../next/server".
    server: {
      deps: {
        // Match `next` AND every `next/*` subpath (next/server, next/headers, etc.).
        inline: [/^next-auth/, /^next($|\/)/],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@root': path.resolve(__dirname, '../../lib'),
    },
  },
  // tsconfig.json uses `jsx: preserve` for the Next.js compiler. Vitest
  // imports `.tsx` files (e.g. `_drilldown/render.tsx` exports
  // `loadDrilldownData` consumed by integration tests) — override the JSX
  // transform via Vite 8's `oxc` config so JSX is compiled to plain JS
  // instead of left preserved. Production / Next.js build is unaffected
  // (Next reads tsconfig.json directly, not vitest config).
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
});
