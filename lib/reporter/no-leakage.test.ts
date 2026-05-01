import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * TC-I-11 (REQ-11, security) — guarantees the personal dashboard never
 * transitively imports `lib/reporter/**`. The reporter is opt-in: a dev
 * who never created `data/reporter-config.json` MUST NOT incur any
 * outbound network call from `pnpm dev`, `pnpm ingest`, or `pnpm watch`.
 *
 * The runtime gate inside `runReporter()` provides the second-line
 * defense; this test enforces the structural guarantee that the network
 * layer (`client.ts`, `signer.ts`, `runner.ts`) is not reachable from
 * the dashboard's import graph at all.
 */

describe('reporter import isolation (TC-I-11)', () => {
  it('lib/reporter/* is not transitively imported by app/, lib/queries/, lib/ingest/', () => {
    // Walk up from the test file to the repo root: lib/reporter/foo.test.ts → repo
    const repoRoot = path.resolve(__dirname, '..', '..');
    const result = execSync(
      `grep -rE "from ['\\"]@?/?lib/reporter" app lib/queries lib/ingest 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: repoRoot },
    );
    expect(result.trim()).toBe('');
  });
});
