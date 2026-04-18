import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function resolveWithinClaudeProjects(p: string): string {
  const root = claudeProjectsRoot();
  const resolved = path.resolve(p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('path escapes ~/.claude/projects');
  }
  return resolved;
}

export async function listTranscriptFiles(root?: string): Promise<string[]> {
  const base = root ?? claudeProjectsRoot();
  try {
    const entries = await fs.promises.readdir(base, {
      recursive: true,
      withFileTypes: true,
    });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      // Node 24: Dirent has parentPath; older: path. Prefer parentPath.
      const parent =
        (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        base;
      files.push(path.resolve(parent, entry.name));
    }
    files.sort();
    return files;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return [];
    }
    throw err;
  }
}

export function deriveProjectName(cwd: string): string {
  if (!cwd) return 'unknown';
  const base = path.basename(cwd);
  return base || 'unknown';
}
