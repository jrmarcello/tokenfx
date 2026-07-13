// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Standing structural guards for the monorepo shared-package refactor
 * (.specs/refactor-monorepo-shared-package.md TC-I-03 / TC-I-04).
 *
 * The 5 shared modules (logger, analytics/model, analytics/cost-calibration,
 * reporter/types, reporter/canonical-json) live in `packages/shared`; nothing
 * should import them via the retired `@root/*` alias (apps/server) or leave a
 * stray copy at the old `lib/` path. These assertions were one-shot commands
 * during the migration — promoted here so a future copy-paste of an old
 * snippet re-introducing `@root/` or `lib/logger.ts` fails the suite instead
 * of silently resurrecting the split-brain. Same fs/exec precedent as
 * tests/unit/privacy-allowlist-docs.test.ts.
 */

const repoRoot = path.resolve(__dirname, '../..');

describe('monorepo shared-package structural invariants', () => {
  it('has no @root/ imports left in apps/server source (TC-I-03)', () => {
    // grep exits 1 when there are no matches — that's the success case.
    let matches = '';
    try {
      matches = execSync(
        `grep -rn "@root/" apps/server --include='*.ts' --include='*.tsx'`,
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch {
      matches = '';
    }
    expect(matches.trim()).toBe('');
  });

  it('has no ../../ references in apps/server/tsconfig.json (TC-I-11)', () => {
    const tsconfig = fs.readFileSync(
      path.join(repoRoot, 'apps/server/tsconfig.json'),
      'utf8',
    );
    expect(tsconfig.includes('../../')).toBe(false);
  });

  it.each([
    'lib/logger.ts',
    'lib/analytics/model.ts',
    'lib/analytics/cost-calibration.ts',
    'lib/reporter/types.ts',
    'lib/reporter/canonical-json.ts',
  ])('no stray copy of the moved module at the old path: %s (TC-I-04)', (rel) => {
    expect(fs.existsSync(path.join(repoRoot, rel))).toBe(false);
  });

  it('has no apps/server/pnpm-lock.yaml — single root lockfile (TC-I-05)', () => {
    expect(fs.existsSync(path.join(repoRoot, 'apps/server/pnpm-lock.yaml'))).toBe(
      false,
    );
  });
});
