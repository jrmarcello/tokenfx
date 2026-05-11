import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Result } from './result';

export type FsPathError = {
  readonly reason: 'path-outside-workspace';
  readonly message: string;
};

/**
 * Generalised path-traversal guard with a parametrisable workspace root and
 * a `Result` return type (no throws).
 *
 * Differs from {@link resolveWithinClaudeProjects} (legacy, throws + fixed
 * root). Mixed-model is a documented deviation; the legacy function is kept
 * to avoid scope creep in the i18n-microcopy-consolidation spec.
 *
 * Algorithm:
 *  1. Resolve `root` to a real path via `fs.realpathSync` (defence against
 *     a cwd located behind a symlink — e.g. `/var` → `/private/var` on
 *     macOS).
 *  2. Resolve `candidate` to an absolute path via `path.resolve` (which
 *     also normalises any `..` segments lexically).
 *  3. If `candidate` exists on disk, resolve it via `realpath` so a
 *     symlink inside `root` pointing outside cannot bypass the check.
 *     If it does not exist (we may be asked about a not-yet-written
 *     file), fall through to the lexical absolute path.
 *  4. Assert `resolved === realRoot` OR
 *     `resolved.startsWith(realRoot + path.sep)`.
 */
export const resolveWithinWorkspace = (
  root: string,
  candidate: string,
): Result<string, FsPathError> => {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    // Root doesn't exist on disk — fall back to lexical resolution.
    realRoot = path.resolve(root);
  }

  // Resolve against realRoot so a symlinked root doesn't break the prefix check.
  const resolvedCandidate = path.resolve(realRoot, candidate);
  let realCandidate = resolvedCandidate;
  try {
    realCandidate = fs.realpathSync(resolvedCandidate);
  } catch {
    // Candidate may not exist yet — use the lexical resolution.
  }

  const inside =
    realCandidate === realRoot ||
    realCandidate.startsWith(realRoot + path.sep);

  if (!inside) {
    return {
      ok: false,
      error: {
        reason: 'path-outside-workspace',
        message: `path "${candidate}" escapes workspace root "${root}"`,
      },
    };
  }

  return { ok: true, value: realCandidate };
};

export function claudeProjectsRoot(): string {
  // Allow overriding the root via env (primary use case: Docker container
  // with transcripts bind-mounted at `/claude-projects`). Falls back to the
  // user's home `~/.claude/projects` when the env is unset or empty.
  const fromEnv = process.env.CLAUDE_PROJECTS_ROOT?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

export function resolveWithinClaudeProjects(p: string): string {
  // Reject ".." segments before normalization — any attempt to traverse
  // upward is an injection attempt, not a benign relative path.
  const segments = p.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error('path escapes the Claude projects root');
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
    throw new Error('path escapes the Claude projects root');
  }
  return realResolved;
}

export async function listTranscriptFiles(root?: string): Promise<string[]> {
  const base = root ?? claudeProjectsRoot();
  // Enumeration follows symlinks by default, so a symlinked directory
  // inside ~/.claude/projects pointing elsewhere would surface .jsonl
  // files outside the allowed root. Re-validate every candidate with
  // resolveWithinClaudeProjects (which uses realpath) and drop escapes.
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    // Root may not exist — listing will return [] below.
  }
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
      const candidate = path.resolve(parent, entry.name);
      // Skip subagent JSONLs (e.g. <sessionId>/subagents/agent-XXX.jsonl).
      // They share the parent's sessionId and would inflate the parent's
      // session window on UPSERT (started_at/ended_at union across all
      // subagents). The check is on `candidate` (pre-realpath) so a
      // symlinked subagents/ directory can't escape the naming convention.
      // See .specs/fix-ingest-skip-subagent-jsonls.md.
      if (/\/subagents\//.test(candidate)) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (real !== realBase && !real.startsWith(realBase + path.sep)) {
          continue; // symlink escapes the root — drop silently
        }
        files.push(real);
      } catch {
        // racy: file vanished between readdir and realpath; ignore
      }
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
