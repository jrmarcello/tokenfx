import type { Result } from '@/lib/result';
import { runGit, type GitError, type RunGitOptions } from './run-git';

/**
 * Parsed GitHub repository identifier. Owner/repo casing is preserved
 * as written in the remote URL — GitHub's API is case-insensitive but
 * we never normalize, to keep log output aligned with the user's
 * actual remote.
 */
export type GitHubRepo = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * DI seam alias for `runGit`. The evaluator + tests inject a stub here
 * to avoid spawning a real git process.
 */
export type RunGitImpl = (
  args: string[],
  opts: RunGitOptions,
) => Result<string, GitError>;

/**
 * Owner/repo segments accept letters, digits, dashes, dots, and
 * underscores. Disallow path separators, `@`, `:`, and whitespace —
 * those would indicate a malformed segment (e.g. a token leaking past
 * an `@` boundary into what we think is the owner field).
 */
const SEGMENT = '[A-Za-z0-9._-]+';

/**
 * SCP-style SSH: `git@github.com:owner/repo[.git]`.
 * Must start with `git@github.com:` (no other host accepted).
 */
const SCP_SSH_RE = new RegExp(
  `^git@github\\.com:(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`,
);

/**
 * Full URI form: `ssh://git@github.com/owner/repo[.git]` or
 * `https://[<user>[:<token>]@]github.com/owner/repo[.git][/]`.
 *
 * The optional userinfo segment (`<user>[:<token>]@`) covers the
 * token-in-URL pattern common in CI environments — we drop it from
 * the parsed result. Userinfo MUST be followed by `@github.com` to
 * count; we never accept `https://github.com.evil.com/...`.
 */
const URI_RE = new RegExp(
  `^(?:https|ssh)://(?:[^@/]+@)?github\\.com/(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`,
);

/**
 * Parse a git remote URL into `{ owner, repo }` if it points to GitHub.
 * Returns `null` for non-GitHub remotes, malformed input, or empty
 * string. Owner/repo casing is preserved (no normalization).
 *
 * Accepted shapes (REQ-9):
 *   - git@github.com:owner/repo.git
 *   - git@github.com:owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo/
 *   - ssh://git@github.com/owner/repo.git
 *   - https://<token>@github.com/owner/repo.git (token stripped)
 */
export const parseGitHubRemote = (remoteUrl: string): GitHubRepo | null => {
  if (remoteUrl.length === 0) return null;

  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  const scpMatch = SCP_SSH_RE.exec(trimmed);
  if (scpMatch) {
    const owner = scpMatch[1];
    const repo = scpMatch[2];
    if (owner !== undefined && repo !== undefined && repo.length > 0) {
      return { owner, repo };
    }
  }

  const uriMatch = URI_RE.exec(trimmed);
  if (uriMatch) {
    const owner = uriMatch[1];
    const repo = uriMatch[2];
    if (owner !== undefined && repo !== undefined && repo.length > 0) {
      return { owner, repo };
    }
  }

  return null;
};

/**
 * Resolve the GitHub `{ owner, repo }` for a working tree by reading
 * `git remote get-url origin`. Returns `null` if the command fails
 * (no `origin`, non-git cwd, etc.) OR the remote URL is not a GitHub
 * shape.
 *
 * `runGitImpl` is the DI seam for tests — defaults to the real
 * `runGit` from `./run-git`.
 */
export const resolveGitHubRepo = (
  cwd: string,
  runGitImpl: RunGitImpl = runGit,
): GitHubRepo | null => {
  const result = runGitImpl(['remote', 'get-url', 'origin'], { cwd });
  if (!result.ok) return null;
  return parseGitHubRemote(result.value.trim());
};
