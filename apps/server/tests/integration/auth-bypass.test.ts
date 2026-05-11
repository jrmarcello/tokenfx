/**
 * Integration coverage for the e2e-bypass auth path —
 * `.specs/fix-e2e-auth-bypass.md` TC-I-04..09.
 *
 * # Scope deviation from spec
 *
 * The original spec listed TC-I-01..09 here. Several are infeasible to run
 * inside Vitest without a live Postgres testcontainer + spawned Next.js dev
 * server (the dynamic DATABASE_URL + AUTH_SECRET threading happens in
 * `tests/e2e/global-setup.ts` and Vitest's `globalSetup` does the same
 * Postgres bring-up but does NOT spawn a dev server). Coverage that actually
 * lands:
 *
 *   - TC-I-01 (providers array contains credentials with E2E_AUTH_BYPASS=1)
 *     and TC-I-02 (does not contain when unset): covered by the unit tests
 *     for `buildE2eBypassProvider` in `lib/auth/e2e-bypass-provider.test.ts`
 *     (TC-U-01..06). Loading `auth.ts` in-process to inspect the live
 *     providers array would also exercise the Drizzle client init, which
 *     adds zero signal over the pure-function unit test.
 *   - TC-I-03 (boot-guard throws when NODE_ENV=production + flag=1):
 *     covered by the `assertNotProductionWithBypass` unit tests in the
 *     same file (test block "boot guard, called from auth.ts").
 *   - TC-I-04..07 (full HTTP round-trip against the dev server): require
 *     a running Next dev process at :3232. They land naturally in the
 *     Playwright auth-bypass smoke spec (`tests/e2e/auth-bypass.spec.ts`,
 *     TASK-7) because Playwright's global-setup already spawns that
 *     server. Duplicating the spawn here would be ~150 LOC of dev-server
 *     orchestration for tests that pass-by-construction once TASK-SMOKE
 *     runs green.
 *   - TC-I-08 (global-setup.ts wires `E2E_AUTH_BYPASS=1`): IS testable
 *     statically, retained below.
 *   - TC-I-09 (production `pnpm build` exits 0 without the flag): part of
 *     the Validation Criteria, not a unit/integration TC. Skipped here.
 *
 * The Execution Log documents this scoping decision; the spec's Test Plan
 * is immutable per `.claude/rules/sdd.md`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('global-setup.ts wires the e2e-bypass env var (TC-I-08)', () => {
  it('sets E2E_AUTH_BYPASS=1 in the dev-server spawn env block', () => {
    const setupPath = path.resolve(
      __dirname,
      '..',
      'e2e',
      'global-setup.ts',
    );
    const source = readFileSync(setupPath, 'utf8');
    // The env block lives inside the `spawn('pnpm', ['dev'], {...})` call.
    // We assert the literal key:value appears so a refactor that moves the
    // var out of the spawned process's env (or drops it entirely) fails
    // this test loudly instead of leaving e2e specs to redirect-loop again.
    expect(source).toMatch(/E2E_AUTH_BYPASS:\s*'1'/);
  });
});
