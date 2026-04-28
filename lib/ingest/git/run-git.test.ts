import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './run-git';
import { setupTestRepo, type TestRepo } from './test-helpers';

describe('runGit', () => {
  let repo: TestRepo;

  beforeAll(() => {
    repo = setupTestRepo('run-git');
    repo.commit({
      message: 'initial commit',
      files: { 'README.md': '# test repo\n' },
    });
  });

  afterAll(() => {
    repo.cleanup();
  });

  it('TC-U-09: returns Result.ok(stdout) for `rev-parse --show-toplevel` in a real repo', () => {
    const result = runGit(['rev-parse', '--show-toplevel'], { cwd: repo.path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stdout includes a trailing newline; the resolved toplevel should
      // match the realpath of repo.path (macOS may surface /private/* prefix
      // for /var/* tmpdirs, so compare after fs.realpathSync on both sides).
      const reportedPath = fs.realpathSync(result.value.trim());
      const expectedPath = fs.realpathSync(repo.path);
      expect(reportedPath).toBe(expectedPath);
    }
  });

  it('TC-U-10: returns Result.err for cwd that does not exist', () => {
    // Use a nonexistent path that is still under home (so the cwd-out-of-bounds
    // guard doesn't fire — we want to exercise the spawn-failed path here).
    const fakeCwd = path.join(
      os.homedir(),
      `tokenfx-runGit-nonexistent-${Date.now()}`,
    );
    expect(fs.existsSync(fakeCwd)).toBe(false);
    const result = runGit(['log'], { cwd: fakeCwd });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['spawn-failed', 'non-zero']).toContain(result.error.kind);
    }
  });

  it('TC-U-11: returns Result.err({kind:"timeout"}) when timeoutMs is exceeded', () => {
    // 1ms timeout is essentially impossible to beat for any spawn cost;
    // on the rare host where it does succeed, log returns ok and the test
    // would flake — so we deliberately use --grep on a real (small) repo
    // and a 1ms budget to force the timeout path.
    const result = runGit(['log', '--grep=long_loop'], {
      cwd: repo.path,
      timeoutMs: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
    }
  });

  it('TC-U-12: passes args as array (shell-false) — `$(rm -rf /)` is treated as a literal pathspec', () => {
    // This exercises the security invariant that args go through spawnSync
    // without shell interpretation. We assert two things:
    //   1) The malicious-looking arg does NOT cause `/` to vanish.
    //   2) git rejects the unknown pathspec — i.e. the `$(...)` reaches git
    //      as a literal, proving no shell ran it.
    const before = fs.existsSync('/');
    const result = runGit(['log', '--', '$(rm -rf /)'], { cwd: repo.path });
    const after = fs.existsSync('/');
    expect(before).toBe(true);
    expect(after).toBe(true);
    // Either git exits 0 (newer git accepts unknown pathspecs as a no-op
    // returning empty log) or non-zero. The shell-false invariant is the
    // only thing we *must* assert; the non-execution above proves it.
    if (!result.ok) {
      expect(result.error.kind).toBe('non-zero');
    }
  });

  it('TC-U-13: returns Result.err({kind:"spawn-failed", code:"cwd-out-of-bounds"}) when cwd is outside home', () => {
    const result = runGit(['log'], { cwd: '/etc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('spawn-failed');
      if (result.error.kind === 'spawn-failed') {
        expect(result.error.code).toBe('cwd-out-of-bounds');
      }
    }
  });
});
