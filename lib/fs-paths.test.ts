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
  it('resolves under the user home directory', () => {
    const root = claudeProjectsRoot();
    expect(root).toBe(path.join(os.homedir(), '.claude', 'projects'));
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
