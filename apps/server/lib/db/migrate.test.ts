/**
 * Unit tests for `apps/server/lib/db/migrate.ts` CLI output.
 *
 * Spec: .specs/review-report-2026-05-14-fixes.md (REQ-11 / C-2)
 *
 * REQ-11 forbids `console.log` / `console.error` in `migrate.ts`. The CLI
 * block (`if (require.main === module)`) does not execute under Vitest, so
 * the CLI body is extracted into `runMigrationsCli` for direct testing via:
 *   - a hand-written stub of the migration runner (no mocking framework)
 *   - `vi.spyOn(process.stdout, 'write')` / `vi.spyOn(process.stderr, 'write')`
 *     (built-in Vitest spy)
 *   - an injectable `exit` callback so the test never actually exits Node.
 *
 * A complementary static regression check reads the source file and asserts
 * the literal token `console.` is absent — belt-and-suspenders against
 * accidental reintroduction.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrationsCli } from './migrate';

const migrateSourcePath = path.resolve(__dirname, 'migrate.ts');

describe('runMigrationsCli — REQ-11 / C-2 (TC-U-36)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Stub the writes so test output stays clean and we can assert calls.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes "migrations complete\\n" to process.stdout on success and exits 0', async () => {
    const exitCodes: number[] = [];
    const fakeRunMigrations = async (): Promise<void> => {
      // success
    };

    await runMigrationsCli(fakeRunMigrations, (code) => {
      exitCodes.push(code);
    });

    expect(stdoutSpy).toHaveBeenCalledWith('migrations complete\n');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([0]);
  });

  it('writes the error to process.stderr on failure and exits 1', async () => {
    const exitCodes: number[] = [];
    const failure = new Error('boom');
    const fakeRunMigrations = async (): Promise<void> => {
      throw failure;
    };

    await runMigrationsCli(fakeRunMigrations, (code) => {
      exitCodes.push(code);
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const firstArg = stderrSpy.mock.calls[0]?.[0];
    expect(String(firstArg)).toContain('boom');
    expect(String(firstArg).endsWith('\n')).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitCodes).toEqual([1]);
  });

  it('source file does not call `console.*` (static regression guard)', () => {
    const source = readFileSync(migrateSourcePath, 'utf8');
    // Strip line and block comments so the spec's rationale text — which
    // legitimately names `console.*` — does not trigger the guard.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Match any `console.<method>(...)` invocation in code.
    expect(codeOnly).not.toMatch(/console\.\w+\s*\(/);
  });
});
