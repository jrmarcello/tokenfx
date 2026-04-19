import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeProjectsRoot,
  deriveProjectName,
  listTranscriptFiles,
  resolveWithinClaudeProjects,
} from './fs-paths';

describe('claudeProjectsRoot', () => {
  const prev = process.env.CLAUDE_PROJECTS_ROOT;
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
    else process.env.CLAUDE_PROJECTS_ROOT = prev;
  });

  it('TC-U-02: fallback to ~/.claude/projects when env is unset', () => {
    delete process.env.CLAUDE_PROJECTS_ROOT;
    expect(claudeProjectsRoot()).toBe(
      path.join(os.homedir(), '.claude', 'projects'),
    );
  });

  it('TC-U-03: fallback when env is empty string', () => {
    process.env.CLAUDE_PROJECTS_ROOT = '';
    expect(claudeProjectsRoot()).toBe(
      path.join(os.homedir(), '.claude', 'projects'),
    );
  });

  it('TC-U-01: honors CLAUDE_PROJECTS_ROOT when set to an absolute path', () => {
    process.env.CLAUDE_PROJECTS_ROOT = '/tmp/cp';
    expect(claudeProjectsRoot()).toBe('/tmp/cp');
  });

  it('TC-U-04: resolves a relative CLAUDE_PROJECTS_ROOT against cwd', () => {
    process.env.CLAUDE_PROJECTS_ROOT = './relative/path';
    expect(claudeProjectsRoot()).toBe(path.resolve('./relative/path'));
  });
});

describe('deriveProjectName', () => {
  it.each([
    { cwd: '/Users/alice/code/api-service', expected: 'api-service' },
    { cwd: '/opt/foo/bar/', expected: 'bar' },
    { cwd: '', expected: 'unknown' },
    { cwd: '/', expected: 'unknown' },
  ])('derives "$expected" from "$cwd"', ({ cwd, expected }) => {
    expect(deriveProjectName(cwd)).toBe(expected);
  });
});

describe('resolveWithinClaudeProjects', () => {
  it('rejects explicit parent-dir segments before normalization', () => {
    expect(() =>
      resolveWithinClaudeProjects(
        path.join(claudeProjectsRoot(), '..', 'etc', 'passwd'),
      ),
    ).toThrow(/escapes/);
  });

  it('rejects a path that resolves outside the root', () => {
    expect(() => resolveWithinClaudeProjects('/etc/passwd')).toThrow(/escapes/);
  });

  it('accepts a path inside the root (lexically)', () => {
    const inside = path.join(claudeProjectsRoot(), 'some-project', 'file.jsonl');
    const resolved = resolveWithinClaudeProjects(inside);
    // realpath may rewrite on macOS (/var → /private/var etc.); we just
    // assert the resolver accepts the path.
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('accepts the root itself', () => {
    const resolved = resolveWithinClaudeProjects(claudeProjectsRoot());
    expect(typeof resolved).toBe('string');
  });

  describe('with CLAUDE_PROJECTS_ROOT env override', () => {
    let customRoot: string;
    const prev = process.env.CLAUDE_PROJECTS_ROOT;

    beforeEach(() => {
      customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-root-'));
      process.env.CLAUDE_PROJECTS_ROOT = customRoot;
    });

    afterEach(() => {
      fs.rmSync(customRoot, { recursive: true, force: true });
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_ROOT;
      else process.env.CLAUDE_PROJECTS_ROOT = prev;
    });

    it('TC-U-05: rejects traversal attempts relative to the custom root', () => {
      expect(() =>
        resolveWithinClaudeProjects(
          path.join(customRoot, '..', '..', 'etc', 'passwd'),
        ),
      ).toThrow(/escapes/);
    });

    it('TC-U-06: accepts a path inside the custom root', () => {
      const projDir = path.join(customRoot, 'project-a');
      fs.mkdirSync(projDir, { recursive: true });
      const file = path.join(projDir, 'file.jsonl');
      fs.writeFileSync(file, '');
      const resolved = resolveWithinClaudeProjects(file);
      expect(typeof resolved).toBe('string');
      expect(resolved.length).toBeGreaterThan(0);
    });

    it('TC-U-07: error message references generic "Claude projects root"', () => {
      expect(() => resolveWithinClaudeProjects('/etc/passwd')).toThrow(
        /Claude projects root/,
      );
    });
  });
});

describe('listTranscriptFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const files = await listTranscriptFiles(missing);
    expect(files).toEqual([]);
  });

  it('returns only .jsonl files, sorted, with absolute paths', async () => {
    const sub = path.join(tmpDir, 'proj-a');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'c.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'a.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), '');
    fs.writeFileSync(path.join(sub, 'nested.jsonl'), '');

    const files = await listTranscriptFiles(tmpDir);
    expect(files).toHaveLength(3);
    // all absolute
    for (const f of files) expect(path.isAbsolute(f)).toBe(true);
    // all end with .jsonl
    for (const f of files) expect(f.endsWith('.jsonl')).toBe(true);
    // sorted
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
    // includes the nested one
    expect(files.some((f) => f.endsWith(path.join('proj-a', 'nested.jsonl')))).toBe(true);
  });

  it('returns [] for an empty directory', async () => {
    const files = await listTranscriptFiles(tmpDir);
    expect(files).toEqual([]);
  });
});
