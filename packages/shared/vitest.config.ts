import { defineConfig } from 'vitest/config';

// The shared package runs its OWN suite (via `pnpm --filter @tokenfx/shared
// test`) — it does not inherit a workspace-vitest from the repo root. The 5
// moved modules' colocated tests live under src/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
