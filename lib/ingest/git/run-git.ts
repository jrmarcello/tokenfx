import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Result } from '../../result';

/**
 * Typed errors returned by `runGit`. The same `GitError` shape is reused by
 * downstream evaluator code; we keep the definition colocated with `runGit`
 * (rather than in a shared `types.ts`) to avoid cross-file merge collisions
 * with sibling git-module tasks.
 */
export type GitError =
  | { kind: 'timeout'; stderr?: string; code?: string | number }
  | { kind: 'non-zero'; stderr: string; code: number }
  | { kind: 'spawn-failed'; stderr?: string; code: string | number };

export interface RunGitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Cheap sanity guard: the resolved cwd MUST live under `os.homedir()` or
 * the OS tmp dir (the latter is required so the test suite — which creates
 * ephemeral repos via `fs.mkdtempSync(os.tmpdir(), ...)` per spec REQ-19 —
 * can exercise `runGit` against real fixtures on macOS, where `os.tmpdir()`
 * resolves under `/var/folders/...` outside `$HOME`).
 *
 * This is NOT the strict `~/.claude/projects/` traversal guard from
 * `lib/fs-paths.ts` — `session.cwd` legitimately points to repos under
 * `~/Development/...` etc. We only want to refuse `/`, `/etc`, and similar
 * paths that almost certainly indicate a bug propagating an empty/garbage
 * value into `runGit`.
 *
 * Uses `path.resolve` + `String.prototype.startsWith` (with the trailing
 * separator) — never a bare substring check, which would accept
 * `/etc-fake/home` if the user's home happened to contain that as a prefix.
 *
 * On macOS, `os.tmpdir()` returns `/var/folders/...` while `fs.realpathSync`
 * resolves it to `/private/var/folders/...`. We canonicalise both sides via
 * `realpathSync` (best-effort) to keep the prefix check honest.
 */
const isUnder = (resolved: string, root: string): boolean => {
  if (resolved === root) return true;
  return resolved.startsWith(root + path.sep);
};

const realpathBestEffort = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const isCwdAllowed = (cwd: string): boolean => {
  const resolved = realpathBestEffort(path.resolve(cwd));
  const home = realpathBestEffort(os.homedir());
  const tmp = realpathBestEffort(os.tmpdir());
  return isUnder(resolved, home) || isUnder(resolved, tmp);
};

/**
 * Run a git command with a hardcoded timeout, no shell, and Result-shaped
 * error handling.
 *
 * Args MUST be passed as an array — never concatenate user input into a
 * single string. With `shell: false`, the OS exec'es git directly with the
 * argv, so shell metacharacters in args (e.g. `$(...)`, `;`, `|`) are
 * passed as literal bytes to git and never interpreted.
 */
export const runGit = (
  args: string[],
  opts: RunGitOptions,
): Result<string, GitError> => {
  if (!isCwdAllowed(opts.cwd)) {
    return {
      ok: false,
      error: {
        kind: 'spawn-failed',
        code: 'cwd-out-of-bounds',
        stderr: `cwd ${opts.cwd} is outside ${os.homedir()}`,
      },
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    shell: false,
    timeout: timeoutMs,
    encoding: 'utf8',
    // Avoid leaking interactive prompts (e.g. credential helper) — fail fast.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  // spawn() failed before producing any signal/status (e.g. ENOENT for git
  // itself, or EACCES on the cwd). Node surfaces this on `result.error`.
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException & { code?: string };
    // Node sets `code` to 'ETIMEDOUT' when the timeout option fires; we
    // surface that as the dedicated timeout kind.
    if (err.code === 'ETIMEDOUT') {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          stderr: result.stderr?.toString() ?? undefined,
          code: err.code,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'spawn-failed',
        code: err.code ?? 'unknown',
        stderr: err.message,
      },
    };
  }

  // Even when result.error is unset, a SIGTERM signal indicates the timeout
  // killed the process. (Node delivers SIGTERM by default when `timeout`
  // expires; the `error` field is only set on certain platforms.)
  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
    return {
      ok: false,
      error: {
        kind: 'timeout',
        stderr: result.stderr?.toString() ?? undefined,
        code: result.signal,
      },
    };
  }

  const status = result.status;
  if (status === null) {
    // No status and no error — treat as spawn failure to be safe.
    return {
      ok: false,
      error: {
        kind: 'spawn-failed',
        code: 'no-status',
        stderr: result.stderr?.toString() ?? undefined,
      },
    };
  }

  if (status !== 0) {
    return {
      ok: false,
      error: {
        kind: 'non-zero',
        stderr: result.stderr?.toString() ?? '',
        code: status,
      },
    };
  }

  return { ok: true, value: result.stdout?.toString() ?? '' };
};
