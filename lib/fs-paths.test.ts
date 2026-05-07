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

  // Subagent-filter TCs (fix-ingest-skip-subagent-jsonls).
  // Subagent JSONLs at <root>/<sessionId>/subagents/agent-*.jsonl share
  // the parent's sessionId and would inflate session windows on UPSERT.
  // Filter excludes them path-segment-style (NOT substring), pre-realpath,
  // so symlinked subagents/ dirs are still excluded by naming convention.

  // TC-U-01 (subagent-inflation REQ-1)
  it('excludes subagent JSONLs at <sessionId>/subagents/agent-*.jsonl', async () => {
    const sessionDir = path.join(tmpDir, 'proj', 'session-1');
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'parent.jsonl'), '');
    fs.writeFileSync(path.join(subagentsDir, 'agent-1.jsonl'), '');
    fs.writeFileSync(path.join(subagentsDir, 'agent-2.jsonl'), '');

    const files = await listTranscriptFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith('parent.jsonl')).toBe(true);
    for (const f of files) expect(f.includes('/subagents/')).toBe(false);
  });

  // TC-U-02 (subagent-inflation REQ-1)
  it('excludes subagent JSONLs nested arbitrarily deep in the tree', async () => {
    const deep = path.join(tmpDir, 'proj', 'session-1', 'foo', 'subagents');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'agent.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'proj', 'session-1', 'parent.jsonl'), '');

    const files = await listTranscriptFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith('parent.jsonl')).toBe(true);
  });

  // TC-U-03 (subagent-inflation REQ-3): segment-match, not substring
  it('includes a root-level subagents.jsonl file but excludes files under subagents/ directory', async () => {
    const subagentsDir = path.join(tmpDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'subagents.jsonl'), ''); // root-level file
    fs.writeFileSync(path.join(subagentsDir, 'agent.jsonl'), ''); // dir-level subagent

    const files = await listTranscriptFiles(tmpDir);
    expect(files).toHaveLength(1);
    // The file `subagents.jsonl` (NOT in a subagents directory) IS included.
    expect(files[0]?.endsWith('subagents.jsonl')).toBe(true);
    // The file under subagents/ IS NOT.
    expect(files.some((f) => f.includes('/subagents/'))).toBe(false);
  });

  // TC-U-04 (subagent-inflation REQ-2)
  it('returns every file when no subagents/ directory exists in the tree', async () => {
    const a = path.join(tmpDir, 'proj-a');
    const b = path.join(tmpDir, 'proj-b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 's1.jsonl'), '');
    fs.writeFileSync(path.join(b, 's2.jsonl'), '');

    const files = await listTranscriptFiles(tmpDir);
    expect(files).toHaveLength(2);
  });

  // TC-U-05 (subagent-inflation REQ-4): escape guard composes with subagent filter
  it('rejects a symlink inside subagents/ pointing outside the projects root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    const outsideFile = path.join(outsideDir, 'leak.jsonl');
    fs.writeFileSync(outsideFile, '');

    const subagentsDir = path.join(tmpDir, 'proj', 'session-1', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    try {
      fs.symlinkSync(outsideFile, path.join(subagentsDir, 'leak.jsonl'));
    } catch {
      // some test runners disallow symlinks; skip silently
      return;
    }

    const files = await listTranscriptFiles(tmpDir);
    // Either filter (subagent OR realpath escape) must drop the symlinked file.
    expect(files.some((f) => f.includes('leak.jsonl'))).toBe(false);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // TC-U-06 (subagent-inflation REQ-1+REQ-4): pre-realpath segment filter wins
  it('rejects symlinks within subagents/ that point to other files within subagents/', async () => {
    const subagentsDir = path.join(tmpDir, 'proj', 'session-1', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const real = path.join(subagentsDir, 'real.jsonl');
    const link = path.join(subagentsDir, 'link.jsonl');
    fs.writeFileSync(real, '');
    try {
      fs.symlinkSync(real, link);
    } catch {
      return;
    }

    const files = await listTranscriptFiles(tmpDir);
    // Both the real file AND the symlink are inside subagents/ — both excluded.
    expect(files).toEqual([]);
  });
});
