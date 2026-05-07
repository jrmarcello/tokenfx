import { describe, it, expect } from 'vitest';
import {
  parseGitHubRemote,
  resolveGitHubRepo,
  type RunGitImpl,
} from './git-remote';
import type { Result } from '@/lib/result';
import type { GitError } from './run-git';

describe('parseGitHubRemote', () => {
  it.each([
    {
      // TC-U-01
      name: 'parses SCP-style SSH GitHub remote with .git suffix',
      input: 'git@github.com:owner/repo.git',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-02
      name: 'parses SCP-style SSH GitHub remote without .git suffix',
      input: 'git@github.com:owner/repo',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-03
      name: 'parses HTTPS GitHub remote with .git suffix',
      input: 'https://github.com/owner/repo.git',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-04
      name: 'parses HTTPS GitHub remote without .git suffix',
      input: 'https://github.com/owner/repo',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-05
      name: 'parses HTTPS GitHub remote with trailing slash',
      input: 'https://github.com/owner/repo/',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-06
      name: 'rejects gitlab SSH remote',
      input: 'git@gitlab.com:owner/repo.git',
      expected: null,
    },
    {
      // TC-U-07
      name: 'rejects bitbucket HTTPS remote',
      input: 'https://bitbucket.org/owner/repo.git',
      expected: null,
    },
    {
      // TC-U-08
      name: 'rejects empty string',
      input: '',
      expected: null,
    },
    {
      // TC-U-09
      name: 'rejects malformed URL',
      input: 'not-a-url',
      expected: null,
    },
    {
      // TC-U-10
      name: 'parses owner with dashes and repo with dots',
      input: 'git@github.com:org-with-dashes/repo.with.dots.git',
      expected: { owner: 'org-with-dashes', repo: 'repo.with.dots' },
    },
    {
      // TC-U-10b
      name: 'parses full ssh:// URI form for GitHub',
      input: 'ssh://git@github.com/owner/repo.git',
      expected: { owner: 'owner', repo: 'repo' },
    },
    {
      // TC-U-10c
      name: 'parses HTTPS GitHub remote with token-in-URL (token stripped)',
      input: 'https://ghp_xxxxxxx@github.com/owner/repo.git',
      expected: { owner: 'owner', repo: 'repo' },
    },
  ])('$name', ({ input, expected }) => {
    expect(parseGitHubRemote(input)).toEqual(expected);
  });
});

describe('resolveGitHubRepo', () => {
  it('returns parsed owner/repo when git remote get-url origin succeeds', () => {
    const stubRunGit: RunGitImpl = (args): Result<string, GitError> => {
      // Sanity-check the command shape — expected to be the canonical
      // `remote get-url origin` invocation.
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return { ok: true, value: 'git@github.com:foo/bar.git\n' };
    };

    expect(resolveGitHubRepo('/some/cwd', stubRunGit)).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('returns null when git command fails (no origin remote)', () => {
    const stubRunGit: RunGitImpl = (): Result<string, GitError> => ({
      ok: false,
      error: { kind: 'non-zero', stderr: 'no origin', code: 128 },
    });

    expect(resolveGitHubRepo('/some/cwd', stubRunGit)).toBeNull();
  });

  it('returns null when remote URL is non-GitHub', () => {
    const stubRunGit: RunGitImpl = (): Result<string, GitError> => ({
      ok: true,
      value: 'git@gitlab.com:foo/bar.git\n',
    });

    expect(resolveGitHubRepo('/some/cwd', stubRunGit)).toBeNull();
  });
});
