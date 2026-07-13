import fs from 'node:fs';
import type { Statement } from 'better-sqlite3';
import type { DB } from '@/lib/db/client';
import { log } from '@tokenfx/shared/logger';
import type { Result } from '@/lib/result';
import { parseNumstat } from './numstat';
import { parseRevertGrep } from './reverts';
import { runGit as defaultRunGit, type GitError } from './run-git';
import { resolveGitHubRepo } from './git-remote';
import {
  lookupMergedPrCount as defaultLookupMergedPrCount,
  type PrLookupResult,
} from './pr-lookup';
import type { OutcomeStatus } from './types';

/**
 * Minimal session shape consumed by the evaluator. Mirrors the columns
 * read from `sessions`. Kept as a local type (not the full
 * `lib/db/types.ts` `Session`) so this module doesn't accidentally grow
 * dependencies on unrelated session columns.
 */
export interface EvaluatorSession {
  /** session_id PK on `sessions`. */
  readonly id: string;
  /** working directory at session start (REQ-1). */
  readonly cwd: string;
  /** ms-precision window start (inclusive, REQ-1). */
  readonly started_at: number;
  /** ms-precision window end (inclusive, REQ-1). */
  readonly ended_at: number;
}

/**
 * Pluggable runner. Defaults to {@link defaultRunGit}. Tests inject a stub
 * for parse-failure simulation (TC-U-26 needs malformed numstat that real
 * git won't ever produce).
 */
export type RunGitImpl = (
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Result<string, GitError>;

/**
 * DI seam for the merged-PR lookup. Defaults to the production
 * `lookupMergedPrCount` from `./pr-lookup`. Tests inject a stub.
 *
 * Exposed as a typed alias rather than `typeof defaultLookupMergedPrCount`
 * to keep the test surface narrow — tests should not need access to the
 * cache/rate-limit/now seams of the underlying helper. They pass a
 * function that takes `(input)` and returns the production-shaped Result.
 */
export type LookupPrCountImpl = (
  input: { owner: string; repo: string; sha: string },
) => Result<PrLookupResult, never>;

export interface EvaluateOptions {
  readonly runGitImpl?: RunGitImpl;
  readonly lookupPrCountImpl?: LookupPrCountImpl;
}

/** Well-known empty-tree SHA in git (REQ-6 fallback for parentless commits). */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

const UPSERT_SQL = `
  INSERT INTO session_outcomes (
    session_id, commit_count, loc_added, loc_removed, files_changed,
    reverts_within_7d, merged_pr_count, status, last_evaluated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    commit_count = excluded.commit_count,
    loc_added = excluded.loc_added,
    loc_removed = excluded.loc_removed,
    files_changed = excluded.files_changed,
    reverts_within_7d = excluded.reverts_within_7d,
    merged_pr_count = excluded.merged_pr_count,
    status = excluded.status,
    last_evaluated_at = excluded.last_evaluated_at
` as const;

/** Tuple shape mirrors UPSERT_SQL's 9 positional args. */
type UpsertParams = [
  string, // session_id
  number, // commit_count
  number, // loc_added
  number, // loc_removed
  number, // files_changed
  number, // reverts_within_7d
  number | null, // merged_pr_count
  OutcomeStatus, // status
  number, // last_evaluated_at
];

// Module-private cache. WeakMap (not Map) so DB GC eligibility is preserved.
// See .specs/refactor-prepared-statements-evaluator.md.
const upsertOutcomeStmtCache = new WeakMap<DB, Statement<UpsertParams>>();

function getUpsertOutcomeStmt(db: DB): Statement<UpsertParams> {
  const existing = upsertOutcomeStmtCache.get(db);
  if (existing !== undefined) return existing;
  const prepared = db.prepare<UpsertParams>(UPSERT_SQL);
  upsertOutcomeStmtCache.set(db, prepared);
  return prepared;
}

const upsertOutcome = (
  db: DB,
  row: {
    sessionId: string;
    commitCount: number;
    locAdded: number;
    locRemoved: number;
    filesChanged: number;
    revertsWithin7d: number;
    mergedPrCount: number | null;
    status: OutcomeStatus;
    lastEvaluatedAt: number;
  },
): void => {
  getUpsertOutcomeStmt(db).run(
    row.sessionId,
    row.commitCount,
    row.locAdded,
    row.locRemoved,
    row.filesChanged,
    row.revertsWithin7d,
    row.mergedPrCount,
    row.status,
    row.lastEvaluatedAt,
  );
};

const writeStatusOnly = (
  db: DB,
  sessionId: string,
  status: OutcomeStatus,
): void => {
  upsertOutcome(db, {
    sessionId,
    commitCount: 0,
    locAdded: 0,
    locRemoved: 0,
    filesChanged: 0,
    revertsWithin7d: 0,
    mergedPrCount: null,
    status,
    lastEvaluatedAt: Date.now(),
  });
};

/**
 * Resolve `cwd` through `fs.realpathSync` to follow symlinks (TC-I-16).
 * Returns null when the path doesn't exist on disk (REQ-2 cwd-missing).
 */
const resolveCwd = (cwd: string): string | null => {
  if (!fs.existsSync(cwd)) return null;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
};

/**
 * Detect whether `runGit ['rev-parse', '--git-dir']` succeeds in `cwd`.
 * A non-zero exit (or any error variant) means the dir is not a git work
 * tree (REQ-2 not-a-git-repo).
 */
const isGitRepo = (cwd: string, runGitImpl: RunGitImpl): boolean => {
  const r = runGitImpl(['rev-parse', '--git-dir'], { cwd });
  return r.ok;
};

/**
 * Read `git config user.email` (local repo first; git itself falls back to
 * global/system unless overridden via env). Empty stdout → no-user-email.
 *
 * Returns null when the config call fails OR returns whitespace only.
 */
const readUserEmail = (cwd: string, runGitImpl: RunGitImpl): string | null => {
  const r = runGitImpl(['config', 'user.email'], { cwd });
  if (!r.ok) {
    // `git config <key>` exits 1 when the key is unset — Result.err
    // (kind: 'non-zero', code: 1). We collapse all failure variants into
    // "no email available"; the evaluator's REQ-4 path handles it.
    return null;
  }
  const trimmed = r.value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

interface SessionCommit {
  readonly sha: string;
  /** committer date in epoch seconds (`%ct`). */
  readonly ct: number;
  /** author email (`%ae`). */
  readonly ae: string;
}

/**
 * Enumerate session-commits via the widened git window (±1s pre-filter,
 * second-precision is fine here) and JS-filter to ms-precision exact-match
 * author (REQ-1).
 */
const enumerateSessionCommits = (
  cwd: string,
  startedAtMs: number,
  endedAtMs: number,
  userEmail: string,
  runGitImpl: RunGitImpl,
): SessionCommit[] => {
  // Widen window by 1 second on each side to be robust to second-precision
  // git filters; the JS filter below enforces ms-exact bounds.
  const sinceSec = Math.floor(startedAtMs / 1000) - 1;
  const untilSec = Math.ceil(endedAtMs / 1000) + 1;
  const r = runGitImpl(
    [
      'log',
      '--format=%H %ct %ae',
      `--since=${sinceSec}`,
      `--until=${untilSec}`,
    ],
    { cwd },
  );
  if (!r.ok) {
    // No history (e.g. empty repo) returns non-zero from `git log`. Treat
    // as zero session-commits.
    return [];
  }
  const out: SessionCommit[] = [];
  for (const raw of r.value.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // %H is 40 hex; %ct is digits; %ae is email. Tokens are space-separated;
    // emails do not contain spaces in valid git authorship lines.
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const sha = parts[0];
    const ct = Number(parts[1]);
    const ae = parts.slice(2).join(' ');
    if (!Number.isFinite(ct)) continue;
    const ctMs = ct * 1000;
    if (ae !== userEmail) continue;
    if (ctMs < startedAtMs || ctMs > endedAtMs) continue;
    out.push({ sha, ct, ae });
  }
  return out;
};

interface CommitDiff {
  readonly added: number;
  readonly removed: number;
  readonly paths: ReadonlyArray<string>;
}

/**
 * Run `git diff --numstat <sha>^..<sha>` (or empty-tree fallback when the
 * commit has no parent — REQ-6) and return both the totals AND the file
 * paths so the caller can union into a Set for `files_changed` (REQ-5).
 *
 * On parse failure (REQ-18) returns `null` — the caller logs and falls
 * back to 0/0/[].
 */
const computeCommitDiff = (
  cwd: string,
  sha: string,
  sessionId: string,
  runGitImpl: RunGitImpl,
): CommitDiff | null => {
  // Detect parentless via `rev-parse <sha>^` — non-zero exit → empty-tree.
  const parentResult = runGitImpl(['rev-parse', `${sha}^`], { cwd });
  const range = parentResult.ok ? `${sha}^..${sha}` : `${EMPTY_TREE_SHA}..${sha}`;

  // Use `--name-only`-style data via `--numstat` — paths are tab-separated.
  // We need both totals AND paths to satisfy REQ-5; `--numstat` carries both.
  const diffResult = runGitImpl(['diff', '--numstat', range], { cwd });
  if (!diffResult.ok) {
    log.warn('[git/evaluator] diff failed', {
      sessionId,
      shortSha: sha.slice(0, 7),
      reason: diffResult.error.kind,
    });
    return null;
  }
  const parsed = parseNumstat(diffResult.value);
  if (!parsed.ok) {
    log.warn('[git/evaluator] numstat parse failed', {
      sessionId,
      shortSha: sha.slice(0, 7),
      reason: parsed.error.kind,
    });
    return null;
  }

  // parseNumstat doesn't surface paths — it sums totals. Since REQ-5 needs
  // the union of paths across commits, re-derive paths from the same stdout.
  const paths: string[] = [];
  for (const raw of diffResult.value.split('\n')) {
    if (raw.length === 0 || raw.trim().length === 0) continue;
    const fields = raw.split('\t');
    if (fields.length < 3) continue;
    // Field 2 onward is the path. Renames `{old => new}/x` keep one entry.
    const p = fields.slice(2).join('\t');
    paths.push(p);
  }

  return {
    added: parsed.value.added,
    removed: parsed.value.removed,
    paths,
  };
};

/**
 * Count unique revert-commits (REQ-7) referencing each session-commit's
 * short SHA within `[commit_at, commit_at + 7d]`. Failures degrade
 * gracefully (count what we can; log+continue otherwise).
 */
const countReverts = (
  cwd: string,
  sessionCommits: ReadonlyArray<SessionCommit>,
  sessionId: string,
  runGitImpl: RunGitImpl,
): number => {
  const dedupedReverts = new Set<string>();
  for (const c of sessionCommits) {
    const shortSha = c.sha.slice(0, 7);
    const sinceSec = c.ct;
    const untilSec = c.ct + SEVEN_DAYS_SECONDS;
    const r = runGitImpl(
      [
        'log',
        '--pretty=oneline',
        '--abbrev-commit',
        `--grep=Revert.*${shortSha}`,
        `--since=${sinceSec}`,
        `--until=${untilSec}`,
      ],
      { cwd },
    );
    if (!r.ok) {
      log.warn('[git/evaluator] revert grep failed', {
        sessionId,
        shortSha,
        reason: r.error.kind,
      });
      continue;
    }
    const found = parseRevertGrep(r.value, [shortSha]);
    for (const sha of found) dedupedReverts.add(sha);
  }
  return dedupedReverts.size;
};

/**
 * Evaluate git outcomes for a session and UPSERT the row in
 * `session_outcomes` (REQ-1..REQ-7, REQ-10, REQ-15a, REQ-17, REQ-18).
 *
 * - Never throws — every failure is degraded into a logged warning + a
 *   correctly-shaped DB row (status field encodes the failure mode).
 * - Logs only `{sessionId, shortSha?, reason}` — never commit messages,
 *   diff bodies, or other PII (REQ-17).
 * - `runGitImpl` lets tests inject a stub for parse-failure simulation
 *   (TC-U-26); production callers omit it and get the real `runGit`.
 */
export const evaluateSessionOutcome = (
  db: DB,
  session: EvaluatorSession,
  options: EvaluateOptions = {},
): void => {
  const runGitImpl = options.runGitImpl ?? defaultRunGit;

  // REQ-2: cwd-missing
  const realCwd = resolveCwd(session.cwd);
  if (realCwd === null) {
    log.info('[git/evaluator] skip', {
      sessionId: session.id,
      reason: 'cwd-missing',
    });
    writeStatusOnly(db, session.id, 'cwd-missing');
    return;
  }

  // REQ-2: not-a-git-repo
  if (!isGitRepo(realCwd, runGitImpl)) {
    log.info('[git/evaluator] skip', {
      sessionId: session.id,
      reason: 'not-a-git-repo',
    });
    writeStatusOnly(db, session.id, 'not-a-git-repo');
    return;
  }

  // REQ-4: no-user-email
  const userEmail = readUserEmail(realCwd, runGitImpl);
  if (userEmail === null) {
    log.warn('[git/evaluator] skip', {
      sessionId: session.id,
      reason: 'no-user-email',
    });
    writeStatusOnly(db, session.id, 'no-user-email');
    return;
  }

  // REQ-1: enumerate session-commits (ms-precision JS filter)
  const commits = enumerateSessionCommits(
    realCwd,
    session.started_at,
    session.ended_at,
    userEmail,
    runGitImpl,
  );

  // REQ-5/6: per-commit numstat diff, accumulate, union paths
  let locAdded = 0;
  let locRemoved = 0;
  const filesUnion = new Set<string>();
  for (const c of commits) {
    const diff = computeCommitDiff(realCwd, c.sha, session.id, runGitImpl);
    if (diff === null) {
      // Parse failure or diff command failure — non-fatal (REQ-18).
      // Preserve commit_count by NOT decrementing it, but contribute 0/0
      // and no paths from this commit.
      continue;
    }
    locAdded += diff.added;
    locRemoved += diff.removed;
    for (const p of diff.paths) filesUnion.add(p);
  }

  // REQ-7: reverts within 7d, deduped
  const revertsWithin7d = countReverts(
    realCwd,
    commits,
    session.id,
    runGitImpl,
  );

  // v2-pr-lookup REQ-11..15: optional GitHub merged-PR cross-reference,
  // gated by `TOKENFX_GH_PR_LOOKUP=1` (strict equality — REQ-12).
  // The flag check uses literal `'1'`; ANY other value (including
  // `'true'`, `' 1 '`, empty string, undefined) leaves the flag OFF
  // and `mergedPrCount = null` is written (parent-spec contract).
  const mergedPrCount = computeMergedPrCount({
    cwd: realCwd,
    sessionId: session.id,
    commits,
    runGitImpl,
    lookupPrCountImpl: options.lookupPrCountImpl ?? defaultLookupMergedPrCount,
  });

  upsertOutcome(db, {
    sessionId: session.id,
    commitCount: commits.length,
    locAdded,
    locRemoved,
    filesChanged: filesUnion.size,
    revertsWithin7d,
    mergedPrCount,
    status: 'evaluated',
    lastEvaluatedAt: Date.now(),
  });
};

/**
 * Resolve `merged_pr_count` for the session. Returns `null` (the
 * "not evaluated" sentinel) in three cases:
 *   1. `TOKENFX_GH_PR_LOOKUP !== '1'` (flag off — REQ-12).
 *   2. `resolveGitHubRepo(cwd)` returns null (no GitHub remote — REQ-13).
 *   3. Any per-commit lookup returns a failure status
 *      (`'rate-limited' | 'unauthorized' | 'error'` — REQ-15). Successes
 *      including `'not-found'` (`prNumbers: []`) participate normally.
 *
 * Returns the deduplicated PR-number count when all lookups succeed.
 *
 * Idempotent in production via `pr-lookup`'s module-level SHA cache —
 * re-runs over the same session reuse the cached `'ok'` results.
 */
const computeMergedPrCount = (input: {
  cwd: string;
  sessionId: string;
  commits: ReadonlyArray<{ sha: string }>;
  runGitImpl: RunGitImpl;
  lookupPrCountImpl: LookupPrCountImpl;
}): number | null => {
  if (process.env.TOKENFX_GH_PR_LOOKUP !== '1') {
    return null;
  }
  if (input.commits.length === 0) {
    // No commits → no PRs to look up. Distinct from "lookup attempted
    // but yielded zero" — write null so downstream can't confuse the
    // two cases.
    return null;
  }
  const repo = resolveGitHubRepo(input.cwd, input.runGitImpl);
  if (repo === null) {
    log.info('[git/evaluator] pr-lookup skip', {
      sessionId: input.sessionId,
      reason: 'no-github-remote',
    });
    return null;
  }

  const prSet = new Set<number>();
  let anyFailure = false;
  for (const c of input.commits) {
    const result = input.lookupPrCountImpl({
      owner: repo.owner,
      repo: repo.repo,
      sha: c.sha,
    });
    // `Result<T, never>` — unreachable today (helper never returns ok:false).
    // Treat as failure rather than silently skipping, so a future signature
    // widening (e.g. async refactor) doesn't eat errors as "no PR found".
    if (!result.ok) {
      anyFailure = true;
      continue;
    }
    const { status, prNumbers } = result.value;
    if (
      status === 'rate-limited' ||
      status === 'unauthorized' ||
      status === 'error'
    ) {
      anyFailure = true;
      continue;
    }
    // status is 'ok' or 'not-found' — both contribute their prNumbers
    // (empty for 'not-found') to the dedup set.
    for (const n of prNumbers) prSet.add(n);
  }
  return anyFailure ? null : prSet.size;
};
