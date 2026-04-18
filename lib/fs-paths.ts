import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function resolveWithinClaudeProjects(p: string): string {
  // Reject ".." segments before normalization — any attempt to traverse
  // upward is an injection attempt, not a benign relative path.
  const segments = p.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error('path escapes ~/.claude/projects');
  }
  const root = claudeProjectsRoot();
  const resolved = path.resolve(p);
  // Resolve symlinks if the file exists — otherwise a symlink inside
  // ~/.claude/projects pointing outside would bypass the check.
  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet — fall through to lexical check.
  }
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // Root may not exist in some environments; fall through.
  }
  if (
    realResolved !== realRoot &&
    !realResolved.startsWith(realRoot + path.sep)
  ) {
    throw new Error('path escapes ~/.claude/projects');
  }
  return realResolved;
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
      // Node 20 Dirent: .path; Node 22+: .parentPath. @types/node lags.
      // Casts here are safe — we only read optional string properties.
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
