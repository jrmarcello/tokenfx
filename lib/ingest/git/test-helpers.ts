import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Defaults for the synthetic test author. Spec REQ-19 lets us pick anything
 * stable; using a clearly-fake `tokenfx-test@example.com` keeps the commits
 * obviously synthetic and prevents accidental collisions with the local
 * `git config --global user.email` during attribution tests.
 */
export const TEST_USER_EMAIL = 'tokenfx-test@example.com';
export const TEST_USER_NAME = 'tokenfx-test';

export interface CommitOptions {
  readonly message: string;
  /** Map of relative path → file contents to write before committing. */
  readonly files?: Record<string, string>;
  /** Override author/committer email for this commit. */
  readonly authorEmail?: string;
  /** Override author/committer name for this commit. */
  readonly authorName?: string;
  /**
   * Override committer date (epoch seconds OR ISO 8601 string). When set,
   * passes both `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` so `%ct` reflects
   * the chosen timestamp — necessary for window-boundary tests.
   */
  readonly date?: number | string;
}

export interface TestRepo {
  /** Absolute path to the tmp git repo. */
  readonly path: string;
  /**
   * Stage and commit. Returns the resulting commit SHA. Files default to
   * an empty content map; pass `{ message }` only to make an empty commit.
   */
  commit(opts: CommitOptions): string;
  /** Recursively remove the tmp directory. Idempotent. */
  cleanup(): void;
}

/**
 * Run a git command synchronously inside a test repo. Throws on non-zero
 * exit — test setup failures should surface loudly, not be masked by Result.
 */
const runGitInTest = (
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): string => {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd} (status=${result.status}): ${stderr}`,
    );
  }
  return result.stdout?.toString() ?? '';
};

/**
 * Create a fresh git repo in a unique tmp dir.
 *
 * - Uses `fs.mkdtempSync` (not a shared `os.tmpdir()` path) so concurrent
 *   Vitest workers can't collide.
 * - Sets `init.defaultBranch=main` to avoid the "hint:" noise from newer git.
 * - Configures local `user.email` / `user.name` (locally only — never touches
 *   the user's global git config).
 *
 * The returned object exposes a chainable-ish API for tests:
 *
 * ```ts
 * const repo = setupTestRepo('boundary-test');
 * repo.commit({ message: 'initial', files: { 'a.txt': 'hi' } });
 * const sha = repo.commit({ message: 'second', files: { 'b.txt': 'bye' } });
 * // ... assertions ...
 * repo.cleanup();
 * ```
 */
export const setupTestRepo = (scenario: string): TestRepo => {
  const safeScenario = scenario.replace(/[^a-zA-Z0-9_-]/g, '-');
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `tokenfx-git-${safeScenario}-`),
  );

  runGitInTest(dir, ['init', '-q', '--initial-branch=main']);
  runGitInTest(dir, ['config', '--local', 'user.email', TEST_USER_EMAIL]);
  runGitInTest(dir, ['config', '--local', 'user.name', TEST_USER_NAME]);
  // Disable GPG signing in case the user's global config has it enabled —
  // tests must run on hosts without the test author's GPG key.
  runGitInTest(dir, ['config', '--local', 'commit.gpgsign', 'false']);

  const commit = (opts: CommitOptions): string => {
    if (opts.files) {
      for (const [relPath, contents] of Object.entries(opts.files)) {
        const target = path.join(dir, relPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      runGitInTest(dir, ['add', '-A']);
    }
    const env: Record<string, string> = {};
    if (opts.date !== undefined) {
      const dateStr =
        typeof opts.date === 'number' ? `${opts.date} +0000` : opts.date;
      env.GIT_AUTHOR_DATE = dateStr;
      env.GIT_COMMITTER_DATE = dateStr;
    }
    const email = opts.authorEmail ?? TEST_USER_EMAIL;
    const name = opts.authorName ?? TEST_USER_NAME;
    const allowEmpty = opts.files ? [] : ['--allow-empty'];
    runGitInTest(
      dir,
      [
        '-c',
        `user.email=${email}`,
        '-c',
        `user.name=${name}`,
        'commit',
        ...allowEmpty,
        '-m',
        opts.message,
      ],
      env,
    );
    const sha = runGitInTest(dir, ['rev-parse', 'HEAD']).trim();
    return sha;
  };

  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: a watcher or AV scanner may briefly hold files open.
      // Tests should not fail because cleanup raced.
    }
  };

  return { path: dir, commit, cleanup };
};
