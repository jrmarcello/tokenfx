/**
 * Shared types for the git outcome ingestion layer.
 *
 * Pure types only — no I/O, no runtime dependencies. Other tasks in the
 * `outcome-integration-git` spec (TASK-1 schema, TASK-4 evaluator,
 * TASK-3 collectors) consume these definitions.
 */

/** Aggregated result of `git diff --numstat` over a session window. */
export type NumstatSummary = {
  /** Sum of `loc_added` over all changed files in the window. */
  added: number;
  /** Sum of `loc_removed` over all changed files in the window. */
  removed: number;
  /**
   * Distinct paths touched. Binary files (numstat `-\t-`) and renames
   * each count as a single path.
   */
  filesChanged: number;
};

/**
 * Boundary parse failure surfaced by parsers in this module.
 *
 * `kind: 'parse-failed'` indicates a malformed numstat line (or other
 * git-output line) that could not be interpreted. The offending line is
 * preserved for diagnostics — never log it externally without redaction
 * since paths may contain repository-internal hints.
 */
export type ParseError = {
  kind: 'parse-failed';
  line: string;
};

/**
 * Outcome evaluation status for a session.
 *
 * - `evaluated`     — git collection succeeded; LOC/reverts/cost columns populated.
 * - `cwd-missing`   — session.cwd directory no longer exists on disk.
 * - `not-a-git-repo` — the cwd resolves but is not inside a git work tree.
 * - `no-user-email` — no Claude Code user email available to attribute commits to.
 *
 * Persisted on `sessions.outcome_status`; consumed by TASK-4 evaluator and
 * surfaced via TASK-5 UI badges.
 */
export type OutcomeStatus =
  | 'evaluated'
  | 'cwd-missing'
  | 'not-a-git-repo'
  | 'no-user-email';
