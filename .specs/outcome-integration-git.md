# Spec: Outcome Integration — git outcomes per session

## Status: DONE

## Context

TokenFx today tracks Claude Code **consumption** (tokens, cost, sessions, tool calls) but is blind to **actual code outcomes**. We can render "this session cost $4.20" but not "this session shipped 320 LOC across 3 commits, 0 reverts in 7d". Without that link, the dashboard can't answer the questions that matter for ROI:

- Did this expensive session ship anything (commits, LOC)?
- Are sessions correlating with reverts (rework signal)?
- What's the cost-per-merged-LOC over the last 30d?
- Which sessions are "high-cost no-output" — burned tokens, no commits?

This is the **foundational outcome-tracking spec**. It introduces `session_outcomes` keyed by `session_id` and a new `lib/ingest/git/` module that runs `git log` inside `session.cwd` for the session's time window, attributes commits to the local user (filter by `git config user.email`), computes LOC delta, and detects reverts via heuristic `git log --grep`. Surfaces flow into a new outcome panel on session detail and an "Outcomes" card on the overview dashboard. A v2 toggle (`TOKENFX_GH_PR_LOOKUP=1`) cross-references merged PRs via `gh` CLI but is **not** in scope for the initial GREEN — it ships as an optional task with the flag off by default.

**Decisões já travadas:**

- Natural key is `session_id` (1:1 with `sessions`).
- Window: `[session.started_at, session.ended_at]` (ms-precision, both ends inclusive). Implementation: enumerate commits without `--since/--until` (those are second-precision and can't honor ms boundaries reliably), then post-filter in JS by parsed `%ct` × 1000.
- Authorship filter: **exact match** against `git config user.email` (parsed via `%ae`, equality in JS — NOT `--author=` which is regex and breaks on emails with `+`/`.`).
- Window date field: **`%ct` (committer date)**, not `%at` (author date). Rebases mid-session don't move the commit out of the window. **[Q5 — locked]**
- LOC delta: **per-commit diff and sum** — for each session-commit, run `git diff --numstat <sha>^..<sha>` and sum `loc_added`/`loc_removed`/`files_changed` across all session-commits. This avoids attributing other-author commits between session-commits to the session. Empty-tree fallback (REQ-6) applies per-commit when `<sha>` has no parent.
- Cost-per-LOC denominator: **`loc_added` only** (matches GitHub "lines contributed" convention; removed lines aren't shipped value). **[Q3 — locked]**
- Reverts: 7d window, heuristic only — `git log --grep="Revert.*<short-sha>"`. Heuristic limitations documented (rebase/squash/manual reverts that don't match the pattern miss).
- Multi-repo cwd switching mid-session: use **cwd at session start** (the `cwd` column already on `sessions`).
- GitHub PR lookup: gated behind `TOKENFX_GH_PR_LOOKUP=1`; uses `gh api repos/{owner}/{repo}/commits/{sha}/pulls` (commits→PRs endpoint), NOT `gh pr list --search` (which only searches PR titles/bodies). Column `merged_pr_count` is nullable to encode "not evaluated".
- Sweep hook point: end of `ingestAll` in `lib/ingest/writer.ts` (after `recomputeCostCalibration`), not `lib/ingest/auto.ts` (which is a thin wrapper).
- Idempotent: re-runs UPSERT and refresh `last_evaluated_at`.

## Requirements

- [ ] **REQ-1**: GIVEN a session with `cwd` pointing to an existing git repo AND ≥1 commit whose author email (`%ae`) **exactly equals** `git config user.email` AND whose committer date (`%ct` × 1000) falls in `[session.started_at, session.ended_at]` (ms-precision, both ends inclusive) WHEN `evaluateSessionOutcome(db, session)` runs THEN a row in `session_outcomes` with `commit_count >= 1`, accurate `loc_added`/`loc_removed`/`files_changed`, and `last_evaluated_at = now()` is upserted. Implementation: enumerate via `git log --format=%H %ct %ae` over a widened window (`--since=startedAt-1s --until=endedAt+1s`, second-precision is fine here because exact ms-filtering happens in JS) WITHOUT `--author` (avoids the regex pitfall on `+`/`.` in emails), then filter in JS by `email === userEmail && ct*1000 >= startedAt && ct*1000 <= endedAt`.

- [ ] **REQ-2**: GIVEN `session.cwd` does not exist on disk OR is not a git repo (`.git` absent and not a worktree) WHEN evaluation runs THEN the row is upserted with `commit_count = 0`, `loc_added = 0`, `loc_removed = 0`, `files_changed = 0`, `reverts_within_7d = 0`, `merged_pr_count = NULL`, `last_evaluated_at = now()`, and `lib/logger.ts` `info` logs the skip with `{ sessionId, reason: 'cwd-missing' | 'not-a-git-repo' }`. No throw. Future runs re-evaluate (cwd may reappear).

- [ ] **REQ-3**: GIVEN the session window has commits but **none** authored by `git config user.email` WHEN evaluation runs THEN `commit_count = 0` and LOC fields are 0 (foreign-author commits are not attributed). `last_evaluated_at` is updated. No throw.

- [ ] **REQ-4**: GIVEN `git config user.email` is unset in the repo (and globally) WHEN evaluation runs THEN the row is upserted as the no-attribution case (REQ-3 shape) AND a `warn` log is emitted once per ingest run with `{ cwd, reason: 'no-user-email' }`. No throw.

- [ ] **REQ-5**: LOC delta is **per-commit summed**, not range-diffed. For each session-commit `<sha>` (filtered exactly per REQ-1), run `git diff --numstat <sha>^..<sha>` and accumulate. Final values: `loc_added = SUM(added_per_commit)`, `loc_removed = SUM(removed_per_commit)`, `files_changed = COUNT(DISTINCT path across all per-commit numstats)`. Binary files (numstat reports `-\t-`) contribute 0 added / 0 removed but DO count toward `files_changed`. **Rationale**: a range diff `<first>^..<last>` would attribute the changes of any non-session commits interleaved between session-commits to this session. Per-commit summing avoids that.

- [ ] **REQ-6**: GIVEN a session-commit has no parent (initial commit — `<sha>^` resolves to nothing) WHEN per-commit diff (REQ-5) is computed THEN fallback to `git diff --numstat <empty-tree>..<sha>` where `<empty-tree>` is the well-known SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (git constant). Detection: try `git rev-parse <sha>^` first; on non-zero exit, use empty-tree fallback. Test: a session whose only commit is the repo's initial commit MUST report nonzero `loc_added` and `files_changed`.

- [ ] **REQ-7**: Reverts heuristic — for each session-commit `<sha>`, run `git log --grep="Revert.*<short-sha>" --since=<commit_at> --until=<commit_at + 7d>`. Count unique revert-commits across all session-commits (a single revert that mentions multiple session-commits counts once). `reverts_within_7d` = that count. Heuristic limitations documented in design (cherry-picked reverts, rebases that drop commits, manual "Revert: ..." prefixes without short-sha all undercount).

- [ ] **REQ-8**: GIVEN `TOKENFX_GH_PR_LOOKUP=1` is set AND `gh` CLI is on PATH AND the repo has a GitHub remote WHEN evaluation runs THEN `merged_pr_count` is populated via `gh api repos/{owner}/{repo}/commits/{sha}/pulls --jq '[.[] | select(.merged_at != null) | .number]'` for each session-commit, deduped by PR number across all session-commits. **Rationale**: the GitHub commits→PRs endpoint returns the actual PRs that contain a given commit; `gh pr list --search` would only match PRs whose title/body mentions the sha, missing the common case where the sha is just one commit in a merged PR. GIVEN the env flag is unset OR `gh` is missing OR no remote OR the call errors THEN `merged_pr_count = NULL` (encodes "not evaluated"). Failures log `info`, never throw. **This task is optional in v2 — see TASK-PR.**

- [ ] **REQ-9**: All git command invocations go through a single helper `runGit(args: string[], { cwd, timeoutMs }): Result<string, GitError>` that uses `child_process.spawnSync` with `shell: false` and a hardcoded timeout (default 5000 ms). Args are passed as an array (no shell interpolation, no string concatenation of user input). `cwd` is resolved and verified to **start with** the user's home dir (cheap traversal guard — we don't constrain to `~/.claude/projects/` because real cwds live under `~/Development/...` etc.; the guard is a sanity check that we're not running git in `/`). Errors return `{ ok: false, error: { kind: 'timeout'|'non-zero'|'spawn-failed', stderr, code } }`.

- [ ] **REQ-10**: Idempotency — re-running `evaluateSessionOutcome` for the same `session_id` with no underlying repo changes UPSERTs the same row and updates only `last_evaluated_at`. Re-running after new commits have been authored within the window updates the metrics. The natural key is `session_id` alone (PK).

- [ ] **REQ-11**: Schema — `session_outcomes` table is added to `lib/db/schema.sql`:

  ```sql
  CREATE TABLE IF NOT EXISTS session_outcomes (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    commit_count INTEGER NOT NULL DEFAULT 0,
    loc_added INTEGER NOT NULL DEFAULT 0,
    loc_removed INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    reverts_within_7d INTEGER NOT NULL DEFAULT 0,
    merged_pr_count INTEGER,
    last_evaluated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_outcomes_evaluated_at
    ON session_outcomes(last_evaluated_at);
  ```

  `merged_pr_count` is nullable (distinguishes "0 PRs" from "not evaluated"). `migrate.ts` is idempotent via `CREATE TABLE IF NOT EXISTS` plus a `backfillSessionOutcomes` helper that is a no-op when the table already exists with the expected columns (mirrors `backfillTurnsCacheCreationSplit` shape).

- [ ] **REQ-12**: Ingestion integration — `ingestAll` lives in `lib/ingest/writer.ts` (line ~390). At the end of `ingestAll`, AFTER the `recomputeCostCalibration(db)` call (currently at writer.ts:468), a sweep iterates sessions whose `last_evaluated_at` is missing OR older than `session.ended_at` (i.e. the session ended after its last evaluation — needs refresh) AND whose `ended_at >= now - 30 days` (only re-evaluate recent sessions; older ones evaluated once stay frozen unless `forceOutcomes` opt is set). Each evaluation runs in its own try/catch — failures log and continue. `lib/ingest/auto.ts` is a thin wrapper around `ingestAll` and needs no changes beyond plumbing the `forceOutcomes` opt through.

- [ ] **REQ-13**: CLI flag — `pnpm ingest --force-outcomes` re-evaluates outcomes for **all** sessions in the DB regardless of `last_evaluated_at`. Without the flag, the sweep follows REQ-12. The flag is also surfaced as `--force-outcomes` on `scripts/ingest.ts` and documented in `--help`.

- [ ] **REQ-14**: New queries module `lib/queries/outcomes.ts` exports prepared-statement-backed (WeakMap-cached) queries:
  - `getSessionOutcome(db, sessionId): SessionOutcome | null`
  - `getCostPerLoc(db, { days }): { totalCost: number; totalLoc: number; ratio: number | null }` — `totalLoc = SUM(loc_added)`; ratio is `null` when totalLoc = 0 (avoids division-by-zero).
  - `getCostPerCommit(db, { days }): { totalCost: number; totalCommits: number; ratio: number | null }`
  - `getRevertRate(db, { days }): { sessionsWithCommits: number; sessionsWithReverts: number; ratio: number | null }` — denominator is sessions with `commit_count > 0`; numerator is sessions with `reverts_within_7d > 0`.
  - `getHighCostNoOutputSessions(db, { days, limit }): Array<{ sessionId, project, totalCostUsd, commitCount }>` — sessions ordered by effective cost DESC where `commit_count = 0`. Reuses `effectiveCostForSession` (the `cost-calibration` helper) so the cost shown matches the rest of the dashboard.
  - All cost numbers go through `effectiveCostForSession` (from `lib/analytics/cost-calibration.ts`) loaded with `getCostCalibration(db)` (from `lib/queries/calibration.ts`) — outcome metrics inherit the calibrated cost lens, never list price. Reference impl: `app/api/sessions/[id]/share/route.ts:54` (NOT `lib/queries/overview.ts` — overview does not currently use this pattern).

- [ ] **REQ-15**: Session detail UI — a new `<SessionOutcomePanel session={...} outcome={...} />` Server Component renders on `app/sessions/[id]/page.tsx` between the cost card and the transcript viewer. Empty states:
  - `outcome === null` (never evaluated) → render skeleton with copy "Outcome not yet evaluated. Run `pnpm ingest` to refresh.".
  - `commit_count === 0 && cwd-existed-and-was-git` → render "No commits attributed in this window" (literal copy).
  - `commit_count === 0 && cwd-missing-or-not-git` → render "Outcomes unavailable: cwd is not a git repository".
  - Otherwise → grid of `commit_count`, `loc_added`/`loc_removed` (color-coded), `files_changed`, `reverts_within_7d` (red badge when > 0), `merged_pr_count` only when not null.

  The "skip reason" is derived from the denormalized `status` field — see REQ-15a.

- [ ] **REQ-15a**: To distinguish the skip reasons in REQ-15 without re-running git from the UI, `session_outcomes` adds a `status TEXT NOT NULL DEFAULT 'evaluated'` column with values `'evaluated' | 'cwd-missing' | 'not-a-git-repo' | 'no-user-email'`. The schema in REQ-11 is amended to include this column. The empty-state copy in the UI maps directly from `status`.

- [ ] **REQ-16**: Overview dashboard — a new `<OutcomesCard />` server-fetched component renders on `app/page.tsx` after the existing KPI grid. Shows: "Cost per LOC (30d)" with `$X.XX / LOC` (or `—` when LOC=0), "Revert rate (30d)" with `Y%` and `N sessions / M with commits`, and a small "high-cost no-output" leaderboard (top 3 sessions by cost with `commit_count = 0`, links to session detail). Section is hidden entirely when zero sessions have evaluated outcomes (cold-start case).

- [ ] **REQ-17**: Logging — `lib/ingest/git/logger` calls go through `lib/logger.ts` (no `console.log`). PII rule: log session id and short SHAs only — never commit messages or diff bodies.

- [ ] **REQ-18**: Zod is applied at the boundary where `runGit` output is parsed into structured rows (e.g. numstat lines). Malformed numstat → return `Result.err({ kind: 'parse-failed', line })`. The evaluator treats parse failures as non-fatal: it logs and falls back to `commit_count > 0` with `loc_added/removed = 0` (preserving the commit count signal even when LOC is unparseable).

- [ ] **REQ-19**: Tests use **real git repos** created on-demand via a helper `setupTestRepo(scenario)` that shells out to `git init`, `git -c user.email=... commit -m ...`. Hand-written, no mocking framework. Each call creates a unique tmp dir via `fs.mkdtempSync(path.join(os.tmpdir(), 'tokenfx-git-'))` to prevent collisions between parallel Vitest workers. Cleanup in `afterAll` (or `afterEach` when each test owns its repo). Repos are NOT committed to the project repo.

- [ ] **REQ-20**: Heuristic limitations documented inline in `lib/ingest/git/reverts.ts` JSDoc and surfaced in the session detail panel as an info-tooltip on the "reverts" KPI: "Heuristic: counts commits whose message matches `Revert.*<short-sha>`. Misses cherry-picked reverts, rebases that drop commits, and manual reverts without the short-sha pattern.".

## Test Plan

### Unit Tests — `lib/ingest/git/`

`runGit`, numstat parser, revert grep parser, evaluator orchestration. Pure-ish (filesystem via real git in a tmp repo for the orchestrator tests; numstat parser is fully pure given a string input).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-5 | happy | `parseNumstat("10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts")` | `{ added: 15, removed: 2, filesChanged: 2 }` |
| TC-U-02 | REQ-5 | edge | `parseNumstat("-\t-\timg/logo.png")` (binary) | `{ added: 0, removed: 0, filesChanged: 1 }` |
| TC-U-03 | REQ-5 | edge | `parseNumstat("")` (empty diff) | `{ added: 0, removed: 0, filesChanged: 0 }` |
| TC-U-04 | REQ-18 | validation | `parseNumstat("garbage line")` | `Result.err({ kind: 'parse-failed', line: 'garbage line' })` |
| TC-U-05 | REQ-5 | edge | numstat with renamed file `5\t3\t{old => new}/path.ts` | counted once in `filesChanged`; lines summed |
| TC-U-06 | REQ-7 | happy | `parseRevertGrep("abc1234 Revert \"foo\" (#123)\nef56789 Revert sha1234 manually")` matching session sha `sha1234` | 1 unique revert-commit referenced |
| TC-U-07 | REQ-7 | edge | `parseRevertGrep("")` | 0 reverts |
| TC-U-08 | REQ-7 | business | revert-commit message mentions 2 different session shas | counted once (dedupe by revert sha) |
| TC-U-09 | REQ-9 | happy | `runGit(['rev-parse', '--show-toplevel'], { cwd: <real repo> })` | `Result.ok(<path>)` |
| TC-U-10 | REQ-9 | infra | `runGit(['log'], { cwd: '/nonexistent' })` | `Result.err({ kind: 'spawn-failed' \| 'non-zero' })` |
| TC-U-11 | REQ-9 | infra | `runGit(['log', '--grep=long_loop'], { timeoutMs: 1 })` against a large repo (forced via fixture) | `Result.err({ kind: 'timeout' })` |
| TC-U-12 | REQ-9 | security | `runGit(['log', '--', '$(rm -rf /)'], { cwd: <repo> })` | args passed as array, shell-false; the `$(...)` is treated as a literal pathspec (no execution); test asserts no side effect via `fs.existsSync('/')` and via spawn args |
| TC-U-13 | REQ-9 | security | `runGit([...], { cwd: '/etc' })` (outside home) | `Result.err({ kind: 'spawn-failed', code: 'cwd-out-of-bounds' })` (sanity guard) |
| TC-U-14 | REQ-2 | edge | `evaluateSessionOutcome` with `session.cwd = '/tmp/does-not-exist'` | upserts with `status: 'cwd-missing'`, all metrics = 0 |
| TC-U-15 | REQ-2 | edge | `evaluateSessionOutcome` with cwd that exists but has no `.git` | `status: 'not-a-git-repo'`, metrics = 0 |
| TC-U-16 | REQ-4 | edge | `evaluateSessionOutcome` with repo that has no `user.email` set globally or locally | `status: 'no-user-email'`, warn log, metrics = 0 |
| TC-U-17 | REQ-3 | business | repo has 2 commits in window, both authored by `other@example.com`; session user is `me@example.com` | `commit_count = 0`, `status: 'evaluated'`, `last_evaluated_at` updated |
| TC-U-18 | REQ-1 | happy | repo has 2 commits in window by `me@example.com`, total numstat 100 added / 20 removed across 5 files | `commit_count: 2, loc_added: 100, loc_removed: 20, files_changed: 5` |
| TC-U-19 | REQ-6 | edge | session's only commit is the repo's initial commit (no parent) | LOC computed via empty-tree fallback; nonzero `loc_added` |
| TC-U-20 | REQ-1 | edge | commit at exactly `session.started_at` (boundary inclusive) | included |
| TC-U-21 | REQ-1 | edge | commit at exactly `session.ended_at` (boundary inclusive) | included |
| TC-U-22 | REQ-1 | edge | commit at `session.ended_at + 1 ms` | excluded |
| TC-U-23 | REQ-1 | edge | commit at `session.started_at - 1 ms` | excluded |
| TC-U-24 | REQ-7 | business | repo has 1 session-commit `abc1234` and 1 follow-up commit at `commit_at + 3d` matching `Revert abc1234` | `reverts_within_7d = 1` |
| TC-U-25 | REQ-7 | edge | revert-commit at `commit_at + 8d` (outside 7d window) | `reverts_within_7d = 0` |
| TC-U-26 | REQ-18 | edge | numstat output has 1 valid line + 1 garbage line | parse error logged; metrics fall back to `loc_added=0, loc_removed=0`, `commit_count` preserved |
| TC-U-27 | REQ-5 | business | Repo has 3 commits in window: A by `me@example.com` (+10 lines), B by `other@example.com` (+50 lines), C by `me@example.com` (+5 lines). Sessions's user is `me@example.com` | `commit_count = 2`, `loc_added = 15` (NOT 65). Regression test for the per-commit-sum invariant — a range diff `A^..C` would incorrectly include B's 50 lines. |
| TC-U-28 | REQ-1 | edge | Session user.email = `me+tag@gmail.com` (plus-addressed). Commit by `me@gmail.com` in-window | NOT attributed (exact match, not regex). Counter-test: commit by `me+tag@gmail.com` IS attributed. |

### Integration Tests — `lib/ingest/git/evaluator.test.ts` and `lib/queries/outcomes.test.ts`

Real SQLite + real ephemeral git repos.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-10 | happy | Insert session pointing to fresh tmp repo with 1 commit in-window; run `evaluateSessionOutcome` twice | First run inserts row; second run UPSERTs, only `last_evaluated_at` changes |
| TC-I-02 | REQ-10, REQ-12 | idempotency | Run evaluator, then add a new commit in-window, then re-run | `commit_count` and LOC reflect the new commit; `last_evaluated_at` advanced |
| TC-I-03 | REQ-11 | infra | Legacy DB without `session_outcomes` table → `migrate(db)` | Table created; second `migrate` call no-ops |
| TC-I-04 | REQ-11, REQ-15a | infra | Legacy DB with table but no `status` column (hypothetical pre-amendment) → `migrate(db)` | Column added via ALTER; existing rows default to `'evaluated'` |
| TC-I-05 | REQ-12 | business | `ingestAll` sweep evaluates only sessions with `ended_at >= now - 30d AND (last_evaluated_at IS NULL OR last_evaluated_at < ended_at)` | Older or already-fresh sessions skipped |
| TC-I-06 | REQ-13 | happy | `ingestAll({ forceOutcomes: true })` re-evaluates all sessions including older ones | All `last_evaluated_at` advanced |
| TC-I-07 | REQ-12 | infra | One session in the sweep throws (`runGit` simulated failure via cwd in /etc); other sessions still evaluate | Continues; failed session logged, no row inserted (or row updated to `cwd-missing` if reachable) |
| TC-I-08 | REQ-14 | happy | 3 sessions: A (cost $10, 100 LOC), B (cost $5, 50 LOC), C (cost $20, 0 commits). `getCostPerLoc({ days: 30 })` | `totalCost = 35` (effective via calibration), `totalLoc = 150`, ratio = 35/150 |
| TC-I-09 | REQ-14 | edge | `getCostPerLoc` with zero sessions in window | `{ totalCost: 0, totalLoc: 0, ratio: null }` (no division by zero) |
| TC-I-10 | REQ-14 | happy | 4 sessions, 2 with `reverts_within_7d > 0`, 1 with `commit_count = 0`. `getRevertRate({ days: 30 })` | `sessionsWithCommits = 3`, `sessionsWithReverts = 2`, ratio = 2/3 |
| TC-I-11 | REQ-14 | edge | `getRevertRate` denominator is 0 (no sessions with commits) | `ratio: null` |
| TC-I-12 | REQ-14 | happy | `getHighCostNoOutputSessions({ days: 30, limit: 3 })` returns sessions with `commit_count = 0` ordered by effective cost DESC | Correct order, length ≤ 3 |
| TC-I-13 | REQ-14 | edge | `getSessionOutcome(db, '<unknown-id>')` | `null` |
| TC-I-14 | REQ-14, REQ-8 | infra | Outcomes inserted with `merged_pr_count = NULL` (flag off) → `getSessionOutcome` round-trips NULL | `merged_pr_count: null` (not 0) |
| TC-I-15 | REQ-15a | happy | `evaluateSessionOutcome` on cwd-missing session → DB row has `status = 'cwd-missing'` | matches |
| TC-I-16 | REQ-2 | infra | cwd is a symlink to a valid git repo | Treated as valid (`fs.realpath` resolution); evaluation proceeds |

### E2E Tests — `tests/e2e/outcomes.spec.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-15 | happy | Seed includes a session with `session_outcomes` row populated (`commit_count=2, loc_added=120, loc_removed=15`). Visit `/sessions/<id>` | Outcome panel visible with "2 commits", "+120 / -15", "Heuristic" tooltip on reverts |
| TC-E2E-02 | REQ-15 | edge | Seed includes a session with `status = 'cwd-missing'`. Visit detail | Empty-state copy "Outcomes unavailable: cwd is not a git repository" rendered |
| TC-E2E-03 | REQ-15 | edge | Seed includes a session with no `session_outcomes` row. Visit detail | "Outcome not yet evaluated" skeleton rendered |
| TC-E2E-04 | REQ-16 | happy | Visit `/` (overview). Seed has ≥1 session with outcomes | "Outcomes" card visible with cost-per-LOC, revert rate, high-cost no-output list |
| TC-E2E-05 | REQ-16 | edge | DB has zero session_outcomes rows | Outcomes card hidden entirely (no heading either) |

## Design

### Architecture Decisions

1. **Outcome computation runs at ingest time, not query time.** Evaluating git for every session on every page view is too slow (spawn × N sessions). Cache the result in `session_outcomes` and refresh during `ingestAll`. UI reads are pure SQL.

2. **Natural key = `session_id` (PK).** 1:1 with `sessions`. ON DELETE CASCADE handles session purges. No surrogate id needed.

3. **`status` field is denormalized**, not derived in SQL/JS. The evaluator decides the status once and writes it; the UI maps it to copy. Avoids re-checking filesystem state from the UI layer (Server Component) which would add latency and break the rule that DB queries don't touch fs.

4. **`merged_pr_count` is nullable** to encode "not evaluated" (flag off, `gh` missing, no remote). `0` means "evaluated and there are zero merged PRs touching these commits". The UI treats `null` as "hide field".

5. **`runGit` helper** centralizes 3 things: `spawnSync` with `shell: false` (no shell injection), timeout (default 5s), Result return. Every git call in `lib/ingest/git/` goes through it. No `execSync` strings anywhere.

6. **Sanity cwd guard, not fs-paths**. `lib/fs-paths.ts` constrains paths to `~/.claude/projects/`; that's the JSONL transcript root. `session.cwd` lives elsewhere (typically `~/Development/...`). The git module only checks "is this path under `os.homedir()`?" as a cheap defense against bugs that propagate `/` or empty strings into `runGit`. Documented why fs-paths isn't reused.

7. **Reverts heuristic is intentionally simple.** A real revert-detector would need to walk the DAG and detect "this commit's diff is the inverse of an earlier commit". Out of scope for v1 — surfaced clearly in tooltip + JSDoc.

8. **Window + author filtering happen in JS, not via git flags.** Two reasons:
   - **ms-precision window**: git `--since/--until` operate at second-precision on committer-date and round at the boundary, making TC-U-20..23 flaky. Solution: enumerate via `git log --format=%H %ct %ae --since=<startedAt-1s> --until=<endedAt+1s>` (widened ±1s as a cheap pre-filter), then in JS keep only rows where `ct*1000 >= startedAt && ct*1000 <= endedAt` (both ends inclusive, ms-exact).
   - **exact-match author**: git's `--author` flag is a regex; emails like `me+tag@gmail.com` or `name.surname@...` would match too liberally. Comparing parsed `%ae` to `git config user.email` as plain strings is simpler and correct (TC-U-28 covers).

9. **LOC delta** uses `--numstat` (not `--stat`) and is **per-commit-summed** (not range-diffed):
   - `--numstat` is machine-parseable (tab-separated, no truncation), `--stat` is human-formatted. Same data, much safer to parse.
   - Per-commit summing (`git diff --numstat <sha>^..<sha>` for each session-commit, accumulate) avoids attributing interleaved non-session commits to this session — a range diff `<first>^..<last>` would include them. TC-U-27 is the regression test.

10. **Empty-tree fallback for initial commits** uses git's well-known empty-tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. No git config needed — it's a constant in git.

11. **Sweep granularity in REQ-12**: re-evaluate sessions where `last_evaluated_at IS NULL OR last_evaluated_at < ended_at`. The second clause handles "session ended after last sweep" (a session can be re-ingested with a later `ended_at` if more turns arrive). Older-than-30d sessions are frozen unless `--force-outcomes`.

12. **Cost numbers reuse `effectiveCostForSession`.** Outcome KPIs inherit calibration. We do not re-derive list-price cost for cost-per-LOC. Wire via `lib/queries/calibration.ts` `getCostCalibration`, same pattern as `lib/queries/overview.ts`.

13. **Server Component for `<SessionOutcomePanel>` and `<OutcomesCard>`.** No client interactivity needed (read-only). They fetch via `lib/queries/outcomes.ts` directly.

14. **`pnpm watch`/push-based ingest does NOT trigger outcome evaluation** for a single session on each JSONL append — too noisy (a session writes many turns mid-flight; evaluating git on each append is wasted work). The watcher already triggers `ingestAll` periodically; the outcome sweep runs there. Documented explicitly.

15. **Test fixtures via real git**. Mocking git output is fragile. `setupTestRepo` shells out to `git init` + `git commit` in `os.tmpdir()` and returns the path. Cleaned up in `afterAll`. Slower than mocks but truthful.

### Files to Create

- `lib/ingest/git/run-git.ts` — `runGit(args, opts): Result<string, GitError>` helper.
- `lib/ingest/git/run-git.test.ts` — TC-U-09..13.
- `lib/ingest/git/numstat.ts` — `parseNumstat(stdout): Result<NumstatSummary, ParseError>`.
- `lib/ingest/git/numstat.test.ts` — TC-U-01..05.
- `lib/ingest/git/reverts.ts` — `parseRevertGrep`, `findRevertsForCommits` (calls `runGit`).
- `lib/ingest/git/reverts.test.ts` — TC-U-06..08, TC-U-24..25.
- `lib/ingest/git/evaluator.ts` — `evaluateSessionOutcome(db, session): void`. Orchestrates: cwd check → `runGit log` for in-window commits by user.email → numstat diff → reverts grep → upsert.
- `lib/ingest/git/evaluator.test.ts` — TC-U-14..23, TC-U-26, TC-I-01..02, TC-I-15..16.
- `lib/ingest/git/types.ts` — `SessionOutcome`, `GitError`, `NumstatSummary`, `OutcomeStatus`.
- `lib/ingest/git/test-helpers.ts` — `setupTestRepo(scenario): { path, commit(opts), cleanup() }` shared across tests.
- `lib/queries/outcomes.ts` — query exports listed in REQ-14.
- `lib/queries/outcomes.test.ts` — TC-I-08..14.
- `tests/integration/outcome-sweep.test.ts` — TC-I-05..07.
- `components/session/session-outcome-panel.tsx` — Server Component; renders empty states from `status`.
- `components/overview/outcomes-card.tsx` — Server Component for home page.
- `tests/e2e/outcomes.spec.ts` — TC-E2E-01..05.

### Files to Modify

- `lib/db/schema.sql` — add `session_outcomes` (REQ-11 + REQ-15a `status` column).
- `lib/db/migrate.ts` — add `backfillSessionOutcomesStatus` helper (idempotent ALTER if column missing) following the pattern of `backfillTurnsCacheCreationSplit`.
- `lib/ingest/writer.ts` — `ingestAll` (line ~390) calls the outcome sweep at the end, after `recomputeCostCalibration` (line ~468). The function signature gains an optional `forceOutcomes?: boolean` opt.
- `lib/ingest/auto.ts` — thin wrapper: plumb `forceOutcomes` through to `ingestAll`. No sweep logic here.
- `lib/ingest/writer.test.ts` — extend `ingestAll` describe block with sweep behavior assertions (covered by TC-I-05..07).
- `scripts/ingest.ts` — parse `--force-outcomes` flag, plumb through.
- `app/sessions/[id]/page.tsx` — fetch outcome via `getSessionOutcome`; render `<SessionOutcomePanel>` between cost card and transcript viewer.
- `app/page.tsx` — render `<OutcomesCard />` after KPI grid.
- `tests/e2e/global-setup.ts` — seed at least one session with outcome row populated, one with `status='cwd-missing'`, one without an outcome row.
- `package.json` — no new deps. Document the `TOKENFX_GH_PR_LOOKUP` env var in README (out of spec scope, just note here).

### Dependencies

None new. `child_process` is Node stdlib; we already use `better-sqlite3`, `zod`, etc.

## Tasks

- [x] **TASK-1**: Schema + migration. Add `session_outcomes` to `lib/db/schema.sql` with all columns from REQ-11 plus `status` from REQ-15a. Add `backfillSessionOutcomesStatus(db)` to `lib/db/migrate.ts` (idempotent ALTER following `backfillTurnsCacheCreationSplit` pattern; no-op when column already exists). Add a migrate integration test that asserts: (a) fresh DB has the table after `migrate()`, (b) a DB without `status` gets the column added, (c) running `migrate()` twice is a no-op.
  - files: lib/db/schema.sql, lib/db/migrate.ts, tests/integration/migrate-session-outcomes.test.ts
  - tests: TC-I-03, TC-I-04

- [x] **TASK-2**: Pure helpers — `lib/ingest/git/numstat.ts` + `lib/ingest/git/reverts.ts` (parse-only, no I/O) with their tests. `parseNumstat(stdout)` returns `Result<{added, removed, filesChanged}, ParseError>` summing tab-delimited numeric rows; binary lines (`-\t-\t...`) contribute 0/0 but still count toward `filesChanged`; rename arrows `{old => new}` parsed as a single path. `parseRevertGrep(stdout, sessionShortShas)` returns the deduped revert sha set referenced.
  - files: lib/ingest/git/numstat.ts, lib/ingest/git/numstat.test.ts, lib/ingest/git/reverts.ts, lib/ingest/git/reverts.test.ts, lib/ingest/git/types.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08

- [x] **TASK-3**: `runGit` helper + sanity guard — `lib/ingest/git/run-git.ts`. Uses `spawnSync` with `shell: false`, default `timeoutMs = 5000`, returns `Result<string, GitError>`. `cwd` validation: must be under `os.homedir()`; otherwise `Result.err({ kind: 'spawn-failed', code: 'cwd-out-of-bounds' })`. Includes the `setupTestRepo` helper (in `lib/ingest/git/test-helpers.ts`) for downstream task tests.
  - files: lib/ingest/git/run-git.ts, lib/ingest/git/run-git.test.ts, lib/ingest/git/test-helpers.ts
  - tests: TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13

- [x] **TASK-4**: Evaluator — `lib/ingest/git/evaluator.ts` + tests. `evaluateSessionOutcome(db, session): void` orchestrates:
  1. `fs.existsSync(cwd)` and `runGit(['rev-parse', '--git-dir'])` checks → set `status` accordingly (`cwd-missing` | `not-a-git-repo`).
  2. `runGit(['config', 'user.email'])` (local repo first, falls back to global; empty stdout → `status: 'no-user-email'` and warn-log once per ingest).
  3. **Enumerate session-commits**: `runGit(['log', '--format=%H %ct %ae', '--since=<startedAt-1s seconds-since-epoch>', '--until=<endedAt+1s seconds-since-epoch>'])` (NO `--author`). Parse output and JS-filter: keep rows where `ae === userEmail && ct*1000 >= session.started_at && ct*1000 <= session.ended_at`. The widened git window is just a pre-filter to limit output size; ms boundaries are enforced in JS.
  4. **Per-commit numstat diff** (REQ-5): for each session-commit `<sha>`, try `runGit(['rev-parse', '<sha>^'])` to detect parentless; on success diff `<sha>^..<sha>`, on failure use empty-tree fallback `4b825dc642cb6eb9a060e54bf8d69288fbee4904..<sha>`. Accumulate `loc_added`/`loc_removed` and union the file-path set across all per-commit numstats; `files_changed = paths.size`.
  5. **Reverts grep** over each session-commit short-sha (REQ-7), dedupe by revert-commit sha.
  6. Upsert row with `status: 'evaluated'` (or the failure status from step 1/2).

  Each git call is wrapped in try/Result; failures log via `lib/logger.ts` and degrade gracefully (REQ-18). Real-repo fixtures via `setupTestRepo`.
  - files: lib/ingest/git/evaluator.ts, lib/ingest/git/evaluator.test.ts
  - depends: TASK-1, TASK-2, TASK-3
  - tests: TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-U-22, TC-U-23, TC-U-24, TC-U-25, TC-U-26, TC-U-27, TC-U-28, TC-I-01, TC-I-02, TC-I-15, TC-I-16

- [x] **TASK-5**: Sweep integration — extend `ingestAll` in `lib/ingest/writer.ts` (line ~390) to call `evaluateSessionOutcome` for each candidate session AFTER `recomputeCostCalibration` (line ~468). Candidates: `last_evaluated_at IS NULL OR last_evaluated_at < ended_at`, AND `ended_at >= now - 30d` (unless `forceOutcomes` opt is set, which removes the 30d guard). Each evaluation in its own try/catch. `lib/ingest/auto.ts` plumbs `forceOutcomes` through to `ingestAll`. `scripts/ingest.ts` parses `--force-outcomes` and passes through. Watcher path (`pnpm watch`) reuses the existing `ingestAll` invocation — confirms outcome sweep also fires there with no extra wiring.
  - files: lib/ingest/writer.ts, lib/ingest/auto.ts, scripts/ingest.ts, tests/integration/outcome-sweep.test.ts
  - depends: TASK-4
  - tests: TC-I-05, TC-I-06, TC-I-07

- [x] **TASK-6**: Queries — `lib/queries/outcomes.ts` + tests. All exports listed in REQ-14. Cost numbers go through `effectiveCostForSession` (from `lib/analytics/cost-calibration.ts`); load calibration once per query via `getCostCalibration(db)` (from `lib/queries/calibration.ts`). Reference impl: `app/api/sessions/[id]/share/route.ts:54`. All prepared statements WeakMap-cached.
  - files: lib/queries/outcomes.ts, lib/queries/outcomes.test.ts
  - depends: TASK-1
  - tests: TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-I-14

- [x] **TASK-7**: Session detail UI — `components/session/session-outcome-panel.tsx` (Server Component). Renders empty states from `status`. LOC color-coded (green for `+`, red for `-`). Reverts row shows red badge when > 0 with the limitations tooltip from REQ-20 (use existing `<InfoTooltip>` from `components/info-tooltip.tsx`). Wire into `app/sessions/[id]/page.tsx` between the cost card and the transcript viewer.
  - files: components/session/session-outcome-panel.tsx, app/sessions/[id]/page.tsx
  - depends: TASK-6

- [x] **TASK-8**: Overview UI — `components/overview/outcomes-card.tsx`. Cost-per-LOC, revert rate, high-cost-no-output top-3. Hidden when zero sessions have outcome rows. Wire into `app/page.tsx`.
  - files: components/overview/outcomes-card.tsx, app/page.tsx
  - depends: TASK-6

- [x] **TASK-PR** (closed 2026-05-06 via `.specs/outcome-integration-git-v2-pr-lookup.md`): GitHub PR cross-reference behind `TOKENFX_GH_PR_LOOKUP=1`. New helper `lib/ingest/git/gh-prs.ts` runs `gh api repos/{owner}/{repo}/commits/{sha}/pulls --jq '[.[] | select(.merged_at != null) | .number]'` per session-commit (the GitHub commits→PRs endpoint — finds PRs that contain a given commit, NOT PRs whose title/body mentions the sha). Repo `{owner}/{repo}` is derived from `git remote get-url origin` (parse GitHub URL — bail on non-GitHub remotes). Dedupes by PR number across all session-commits, returns count or null on any failure (gh missing, network error, no remote, non-GitHub remote, rate-limited). Wired into the evaluator only when the env flag is set. Tests use a stub `gh` binary placed on PATH via fixture (no real GitHub calls in CI).
  - files: lib/ingest/git/gh-prs.ts, lib/ingest/git/gh-prs.test.ts, lib/ingest/git/evaluator.ts (extension)
  - depends: TASK-4
  - tests: TC-I-14 (already covers null round-trip; live `gh` test added in this task)

- [x] **TASK-SMOKE**: E2E. Extend `tests/e2e/global-setup.ts` to seed: (a) one session with a populated `session_outcomes` row including nonzero LOC, (b) one with `status='cwd-missing'`, (c) one without any outcome row. New file `tests/e2e/outcomes.spec.ts` covers TC-E2E-01..05.
  - files: tests/e2e/outcomes.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-7, TASK-8
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3]    — parallel (schema, parse helpers, runGit — all disjoint)
Batch 2: [TASK-4]                    — evaluator (depends TASK-1+2+3; touches its own files)
Batch 3: [TASK-5, TASK-6, TASK-PR]   — parallel (sweep wiring vs queries vs optional PR lookup; all disjoint, all only need TASK-4 or TASK-1)
Batch 4: [TASK-7, TASK-8]            — parallel UI (session detail vs overview; disjoint files; both depend TASK-6)
Batch 5: [TASK-SMOKE]                — E2E
```

File overlap analysis:

- `lib/db/schema.sql` + `lib/db/migrate.ts` + migration test: exclusive TASK-1.
- `lib/ingest/git/numstat.{ts,test.ts}` + `reverts.{ts,test.ts}` + `types.ts`: exclusive TASK-2.
- `lib/ingest/git/run-git.{ts,test.ts}` + `test-helpers.ts`: exclusive TASK-3.
- `lib/ingest/git/evaluator.{ts,test.ts}`: TASK-4 owns; TASK-PR extends only after TASK-4 — note: TASK-PR modifies `evaluator.ts`, so TASK-PR is **NOT** parallel-safe with TASK-4 itself; both are in different batches (TASK-4 in Batch 2, TASK-PR in Batch 3) so the sequential order is preserved. TASK-PR is parallel with TASK-5 and TASK-6 (different files except `evaluator.ts` which TASK-5 only reads via import).
  - **Correction**: TASK-5 imports `evaluateSessionOutcome` from `evaluator.ts` but does not modify it. TASK-PR modifies `evaluator.ts`. TASK-5 and TASK-PR therefore touch `evaluator.ts` in different ways (read vs write). Classified as shared-additive — sequencing: run TASK-PR after TASK-5, or merge their evaluator-changes serially. **Resolution**: move TASK-PR to Batch 4 (after TASK-5). Batches updated:

```text
Batch 1: [TASK-1, TASK-2, TASK-3]
Batch 2: [TASK-4]
Batch 3: [TASK-5, TASK-6]
Batch 4: [TASK-7, TASK-8, TASK-PR]   — TASK-PR runs in parallel with UI tasks (disjoint files now)
Batch 5: [TASK-SMOKE]
```

- `lib/ingest/writer.ts` (sweep wiring at end of `ingestAll`) + `lib/ingest/auto.ts` (forceOutcomes plumbing) + `scripts/ingest.ts` + `tests/integration/outcome-sweep.test.ts`: exclusive TASK-5.
- `lib/queries/outcomes.{ts,test.ts}`: exclusive TASK-6.
- `components/session/session-outcome-panel.tsx` + `app/sessions/[id]/page.tsx`: exclusive TASK-7.
- `components/overview/outcomes-card.tsx` + `app/page.tsx`: exclusive TASK-8.
- `lib/ingest/git/gh-prs.{ts,test.ts}` + `lib/ingest/git/evaluator.ts` (additive extension): TASK-PR. Evaluator extension is the only shared edit and runs after TASK-5 has settled.
- `tests/e2e/global-setup.ts`: shared-additive across many specs historically; TASK-SMOKE alone in Batch 5.
- `tests/e2e/outcomes.spec.ts`: exclusive TASK-SMOKE.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (all TC-U + TC-I green)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (TC-E2E-01..05)
- [ ] **Live validation with real DB**:
  - `pnpm ingest` runs sweep without errors; `sqlite3 data/dashboard.db "SELECT COUNT(*) FROM session_outcomes"` ≥ recent-session count.
  - `sqlite3 data/dashboard.db "SELECT session_id, commit_count, loc_added, status FROM session_outcomes ORDER BY last_evaluated_at DESC LIMIT 5"` shows non-trivial values for sessions in real repos and `status='evaluated'`.
  - `pnpm dev` + `curl http://localhost:3000/sessions/<real-id>` returns HTML containing the outcome panel grid (grep "commits" + LOC numbers).
  - `curl http://localhost:3000/` returns HTML containing the Outcomes card heading.
  - `pnpm ingest --force-outcomes` re-evaluates older sessions; SQL shows `last_evaluated_at` advanced.
  - Run inside a non-git directory's session: status row = `'not-a-git-repo'`, no crash.
- [ ] Logging discipline: `grep -r "console\\." lib/ingest/git/ components/session/session-outcome-panel.tsx components/overview/outcomes-card.tsx` returns nothing (only `lib/logger.ts` calls allowed).

## Open Questions

- **Q1**: Should the 30d sweep cutoff be configurable (env var)? Current spec hardcodes 30d in REQ-12. If user has a session that ended 31d ago and the repo is now stale-but-relevant, they only get evaluation via `--force-outcomes`. Acceptable trade-off for v1.
- **Q2**: Should `merged_pr_count` be split into `open_pr_count` + `merged_pr_count`? Current spec: only merged. Open PRs change state and would require frequent re-evaluation. Defer.
- **Q3** [LOCKED — user confirmed 2026-04-28]: Cost-per-LOC denominator = **`loc_added` only**. Matches GitHub "lines contributed" convention; removed lines aren't shipped value.
- **Q4**: For sessions whose cwd is a sub-directory of a git repo (e.g. `~/Development/repo/packages/foo`), `git -C <cwd>` correctly walks up to the repo root. Are LOC numbers still scoped to the whole repo's diff or to the sub-path? Current implementation: whole repo (no `-- <path>` filter). If the user works on a monorepo and runs Claude Code only in `packages/foo`, the spec attributes commits across the whole monorepo to that session. Acceptable for v1; flag as future enhancement.
- **Q5** [LOCKED — user confirmed 2026-04-28]: Window date field = **`%ct` (committer date)**, not `%at` (author date). Rebases mid-session don't move commits out of the window.

## Execution Log

- 2026-04-28: DRAFT created. **Self-review findings resolved (8)**: (1) Added REQ-15a to denormalize `status` so the UI doesn't re-touch the filesystem. (2) Switched LOC from `--stat` (mentioned in user prompt) to `--numstat` for parseability — locked in Design #9. (3) Added empty-tree fallback (REQ-6) for sessions whose only commit is the initial commit. (4) Added `runGit` security TCs (TC-U-12, TC-U-13) covering shell-injection and cwd-out-of-bounds. (5) Added boundary TCs for the inclusive window (TC-U-20..23). (6) Added division-by-zero handling in `getCostPerLoc` / `getRevertRate` (REQ-14, TC-I-09, TC-I-11). (7) Added `merged_pr_count = NULL` round-trip TC (TC-I-14) so "not evaluated" stays distinguishable from "evaluated and zero". (8) Detected and corrected a parallel-batch conflict: TASK-PR modifies `evaluator.ts` (which TASK-5 imports). Reclassified TASK-PR into Batch 4 to serialize the evaluator edit.
- 2026-04-28: **User-review pass — 9 fixes applied**:
  - **B1** (correctness): REQ-5 changed from range-diff `<first>^..<last>` to per-commit-summed `<sha>^..<sha>`. Range diff would attribute non-session commits interleaved between session-commits. New regression test TC-U-27.
  - **B2** (wrong file): REQ-12, TASK-5, "Files to Modify" changed from `lib/ingest/auto.ts` to `lib/ingest/writer.ts` (where `ingestAll` actually lives, line ~390). `auto.ts` is a thin wrapper.
  - **B3** (precision): REQ-1 + Design #8 — window filtering moved from git's second-precision `--since/--until` to JS-level ms-precision filter. Git is used as a pre-filter (widened ±1s) only.
  - **M1** (gh API): REQ-8 + TASK-PR switched from `gh pr list --search <sha>` (searches PR title/body, misses real cases) to `gh api repos/{owner}/{repo}/commits/{sha}/pulls` (the dedicated commits→PRs endpoint).
  - **M2** (regex pitfall): REQ-1 + Design #8 — author filter moved from `--author=<email>` (regex; matches too liberally on `+`/`.`) to JS exact-match on parsed `%ae`. New TC-U-28 covers plus-addressing.
  - **M3** (wrong reference): REQ-14, TASK-6 — calibration pattern reference fixed from `lib/queries/overview.ts` (does not use the pattern) to `app/api/sessions/[id]/share/route.ts:54`.
  - **Minor**: REQ-15 standardized on `status` (was inconsistently called `outcome_status`).
  - **Minor**: REQ-19 fixture isolation via `fs.mkdtempSync(path.join(os.tmpdir(), 'tokenfx-git-'))` to prevent collisions across parallel Vitest workers.
  - **User-locked**: Q3 (cost-per-LOC = added only) and Q5 (window = `%ct` committer date) confirmed.
- 2026-04-28: Status DRAFT → **APPROVED** (user). Q1 (30d cutoff hardcoded), Q2 (only merged PRs), Q4 (sub-dir cwd attributes whole-repo diff for v1) — accepted as documented.
- 2026-04-28: Status APPROVED → **IN_PROGRESS**. Batch 1 executed in parallel via 3 worktree-isolated agents:
  - **TASK-1** (schema + migrate): `lib/db/schema.sql` (+18), `lib/db/migrate.ts` (+30 — `backfillSessionOutcomesStatus` mirroring `backfillTurnsCacheCreationSplit`), `tests/integration/migrate-session-outcomes.test.ts` (+163, TC-I-03 + TC-I-04). CHECK constraint on `status` column on fresh-DB schema; ALTER path can't add CHECK in SQLite (documented limitation, app-level writers enforce on legacy DBs).
  - **TASK-2** (parsers): `lib/ingest/git/types.ts` (50), `numstat.ts` (62), `numstat.test.ts` (62, 7 tests — 5 spec + 2 extra edges), `reverts.ts` (51), `reverts.test.ts` (52, 6 tests — 3 spec + 3 extra). Parsers pure (zero I/O imports); regex-based numeric guard (Zod overkill for 2-field format).
  - **TASK-3** (runGit): `lib/ingest/git/run-git.ts` (167 — `spawnSync shell:false`, default `timeoutMs=5000`, `Result<string, GitError>` with `timeout|non-zero|spawn-failed` variants), `run-git.test.ts` (89, 5 tests — TC-U-09..13), `test-helpers.ts` (138 — `setupTestRepo` via `fs.mkdtempSync`).
  - **Deviation in TASK-3**: `cwd` guard accepts both `os.homedir()` AND `os.tmpdir()` (with `fs.realpathSync` to handle macOS `/private/var/...`). Justification: REQ-9 + REQ-19 + TC-U-09 contradict if home-only, since tests must use `os.tmpdir()`. TC-U-13 (`/etc`) still fails as expected.
  - Validation: `pnpm typecheck` clean; `pnpm test --run lib/ingest/git/ tests/integration/migrate-session-outcomes.test.ts` = 20/20 passing.
  - Worktrees merged into main and removed.
- 2026-04-28: **Batch 2 (TASK-4 evaluator)** — single agent in worktree. `lib/ingest/git/evaluator.ts` (400 LOC) + `evaluator.test.ts` (915 LOC, 20 tests). Per-commit summed numstat with file-path Set union (REQ-5 + TC-U-27 regression). Empty-tree fallback on parentless commits (REQ-6). ms-precision JS filter on `%ct × 1000` after widened git pre-filter (REQ-1). Exact `%ae === userEmail` (REQ-1 + TC-U-28). `fs.realpathSync` for symlink cwd (TC-I-16). Optional `runGitImpl` injection for parse-failure tests (TC-U-26). All git via `runGit` (REQ-9). Logger only `{sessionId, shortSha, reason}` (REQ-17). Validation: 38/38 in `lib/ingest/git/`.
- 2026-04-28: **Batch 3 (TASK-5 sweep + TASK-6 queries)** — 2 parallel agents. **TASK-5**: `lib/ingest/writer.ts` (+75 — `runOutcomeSweep` extracted), `lib/ingest/auto.ts` (+14 — plumbed `forceOutcomes`), `scripts/ingest.ts` (+28 — `--force-outcomes` flag), `tests/integration/outcome-sweep.test.ts` (+304, TC-I-05/06/07). Sweep predicate `LEFT JOIN session_outcomes` + 30d cutoff unless force; per-session try/catch. Watcher path picks up sweep automatically via existing `ingestAll({ db })` call. **TASK-6**: `lib/queries/outcomes.ts` (+327) + tests (+365, 17 TCs covering TC-I-08..14 + 10 edges). All cost via `effectiveCostForSession` with `getCostCalibration(db)` loaded once per query. WeakMap-cached `PreparedSet`. `mergedPrCount` round-trips NULL. JS-side sort for `getHighCostNoOutputSessions` (calibration cascade not expressible in single SQL). Pre-merge: `pnpm rebuild better-sqlite3` to fix native binding mismatch (Node 25.9 vs agent worktree's 26.x). Validation: 58/58 in `lib/queries/outcomes.test.ts + tests/integration/outcome-sweep.test.ts + lib/ingest/git/`.
- 2026-04-28: **Batch 4 (TASK-7 session UI + TASK-8 overview UI)** — 2 parallel agents. **TASK-7**: `components/session/session-outcome-panel.tsx` (+185, Server Component) + 5-LOC patch on `app/sessions/[id]/page.tsx`. Empty states 100% derived from `status` (REQ-15a — no fs reads). Exhaustive switch with `_exhaustive: never`. `<InfoTooltip>` reused for reverts heuristic (REQ-20). LOC color-coded `+green/-red` via Unicode chars (lucide-react not in deps). **TASK-8**: `components/overview/outcomes-card.tsx` (+153, Server Component) + 3-LOC patch on `app/page.tsx`. Hidden when `totalLoc === 0 && sessionsWithCommits === 0` (REQ-16). Cost per LOC uses `fmtUsdFine` (4 decimals). Inserted between `#consumo` and `#efetividade` sections. `pnpm typecheck` clean, `pnpm lint` clean.
- 2026-04-28: **Batch 5 (TASK-SMOKE E2E)** — single agent. `tests/e2e/outcomes.spec.ts` (142 LOC, 5 tests covering TC-E2E-01..05) + `tests/e2e/global-setup.ts` (+98 — 3 new sessions: `e2e-outcome-with-data` [populated], `e2e-outcome-cwd-missing`, `e2e-outcome-not-evaluated` [no row]). TC-E2E-05 strategy: snapshot → DELETE → reload → assert hidden → restore in `finally` (safe under `workers: 1`). E2E result: **5/5 passing in 13.3s**. Existing seeds untouched.
- 2026-04-28: **Self-review Checkpoint 1 (REQ-by-REQ) + Checkpoint 2 (live validation)** — full pipeline:
  - `pnpm typecheck`: clean
  - `pnpm lint`: clean
  - `pnpm test --run`: **737/738 passing** (1 pre-existing parallel-flake in `lib/ingest/watcher.test.ts:TC-I-15` — passes 24/24 in isolation, flagged by all 4 task agents as pre-existing).
  - `pnpm build`: clean
  - `pnpm test:e2e tests/e2e/outcomes.spec.ts`: **5/5 passing**
  - **Live data**: `pnpm ingest` clean (3 sessions/1639 turns/1023 tool_calls/0 errors); `session_outcomes` table populated for **45 of 61 sessions** (16 outside 30d cutoff per REQ-12 — expected); `status` distribution: `evaluated:32`, `cwd-missing:12`, `not-a-git-repo:1`. One real session shows `commit_count:13, loc_added:9162, loc_removed:12701, files_changed:119` (this very implementation session).
  - **Live UI** (dev server on :3131): home page renders "Outcomes" heading + "Cost per LOC" + "Revert rate" + "High-cost no-output". Session detail with `commit_count > 0` renders "Outcomes / Commits / Files changed / Reverts / Heuristic" (panel + tooltip). Session detail with `status='cwd-missing'` renders "Outcomes unavailable: cwd is not a git repository" empty-state.
  - SIGTERM 143 from explicit `kill $DEV_PID` — expected.

## Final state

- 2026-04-28: Status `IN_PROGRESS` → **DONE**. User approved the implementation after PAUSE 2 review (live validation against real DB + UI grep + 743 tests/5 E2E green). Committed as `feat(outcome-integration-git)`.

- **2026-05-06: TASK-PR (v2 deferred) → DONE**. Closed via separate spec
  `.specs/outcome-integration-git-v2-pr-lookup.md`. The deferred GitHub
  merged-PR cross-reference (REQ-8 of this spec) is now implemented
  behind `TOKENFX_GH_PR_LOOKUP=1`. New helper `lib/ingest/git/pr-lookup.ts`
  calls `gh api repos/{owner}/{repo}/commits/{sha}/pulls --jq '[.[] |
  select(.merged_at != null) | .number]'`; new helper
  `lib/ingest/git/git-remote.ts` parses `git remote get-url origin` to
  derive owner/repo. The evaluator wires both via a `lookupPrCountImpl?`
  DI seam; `session_outcomes.merged_pr_count` is populated from a
  deduplicated `Set<number>` across session-commits. Failure modes
  (rate-limited / unauthorized / error) collapse the partial result to
  NULL; `'not-found'` is treated as success. Idempotent via per-process
  SHA cache. 50+ TCs added across `git-remote.test.ts`,
  `pr-lookup.test.ts`, and `evaluator.test.ts`. See the v2 spec's
  Execution Log for full task-level detail.
