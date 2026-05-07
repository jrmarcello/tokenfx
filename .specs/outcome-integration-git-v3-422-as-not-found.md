# Spec: outcome-integration-git-v3-422-as-not-found

## Status: DONE

## Context

Discovered while live-validating `outcome-integration-git-v2-pr-lookup` (2026-05-07): when a session's commits are still LOCAL (not yet pushed to GitHub), `gh api repos/{owner}/{repo}/commits/{sha}/pulls` returns:

```text
HTTP 422
gh: No commit found for SHA: 328806d… (HTTP 422)
```

The current classifier (`lib/ingest/git/pr-lookup.ts:classifyGhResult`) doesn't match this case against any known status:

- `/HTTP 401|HTTP 403.*not.*authorized|gh auth login/i` → `'unauthorized'` — no match
- `/rate.?limit|API rate limit exceeded|X-RateLimit-Remaining: 0/i` → `'rate-limited'` — no match
- `result.status === 0` → JSON-parse path — no match (exit code is 1)
- else → **`'error'`** ← falls here

→ `anyFailure = true` → `merged_pr_count = NULL` for the whole session.

**Real-world impact**: any tokenfx-style local-first workflow (commit, push later) yields persistent NULL for `merged_pr_count` whenever ANY in-window commit is local-only. The user's main branch was 15 commits ahead of `origin/main` during the live validation; every recent session in `tokenfx` cwd thus produced NULL.

### Decisões já travadas

- **Semantically**, "SHA not found on remote" is **a known answer**: there cannot be a merged PR for a commit the remote has never seen. Treat as `'not-found'` (count contribution = 0), NOT as `'error'` (which would NULL-collapse the session).
- **Detection signal**: `result.stderr` matches `/no commit found for sha: [0-9a-f]{7,40}/i` AND `result.status !== 0`. **Both conditions required** — guards against the (impossible-but-defensive) case of exit 0 + matching stderr.
- **Insertion point in `classifyGhResult`**: AFTER the rate-limited check (line 137 in current `pr-lookup.ts`), BEFORE the `if (result.status === 0)` block (line 139). This ordering means rate-limit and unauthorized take precedence (REQ-2), and the JSON-parse path is unaffected when `gh` actually succeeds.
- **Variable name in scope**: `stderr` (declared on line 131 of `pr-lookup.ts`), NOT `stderrTail` (which is a logging-layer truncation built later in `lookupMergedPrCount`).
- **Regex anchoring**: NOT anchored (matches anywhere in stderr). For stderr containing 41+ hex chars, the first 40 match — acceptable because real `gh` always emits the canonical 40-char SHA, never truncated, so the upper bound is academic.
- **`'not-found'` already wired downstream**: v2's `evaluator.ts:computeMergedPrCount` (line 494–504) already treats `'not-found'` as a success status (contributes empty `prNumbers` to the dedup set). No evaluator change needed — this is purely a classifier change.
- Alternative considered/rejected: probe via `git rev-parse --verify origin/main..HEAD` to identify unpushed commits beforehand. Rejected because (a) doubles git invocations per session; (b) doesn't generalize to repos without `origin/main`; (c) the gh 422 signal is authoritative — GitHub itself tells us the commit isn't there.

## Requirements

- [ ] REQ-1: GIVEN a `gh api commits/{sha}/pulls` invocation, WHEN `result.status !== 0` AND `result.stderr` matches `/no commit found for sha: [0-9a-f]{7,40}/i`, THEN `classifyGhResult` returns `{ status: 'not-found', prNumbers: [] }`.
- [ ] REQ-2: GIVEN stderr matching BOTH `/rate.?limit/i` AND `/no commit found for sha/i`, WHEN classified, THEN `'rate-limited'` wins (rate-limit is transient, sha-not-found is permanent — fail-safe to retry). This is enforced by the insertion order: rate-limited check fires before the new arm.
- [ ] REQ-3: GIVEN `result.status !== 0` with stderr `"HTTP 422 …"` but NOT containing the canonical SHA-not-found phrase (e.g. `"HTTP 422 Validation Failed"`, `"HTTP 422 Unprocessable Entity"`), WHEN classified, THEN status remains `'error'` (other 422 cases are disambiguated/unknown — fail-safe).
- [ ] REQ-4: GIVEN a session with mixed commits (some pushed, some local-only), WHEN the lookup runs and produces a mix of `'ok'` and `'not-found'`, THEN `merged_pr_count` reflects the dedup'd PR count from the `'ok'` results only — `'not-found'` contributes empty prNumbers (consistent with v2 REQ-14).
- [ ] REQ-5: GIVEN existing v2 anti-regression tests in `lib/ingest/git/pr-lookup.test.ts` and `lib/ingest/git/evaluator.test.ts`, WHEN this spec is implemented, THEN ALL existing TCs continue to pass without modification.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `classifyGhResult({ status: 1, stderr: 'gh: No commit found for SHA: 328806d7924e (HTTP 422)\n', stdout: '', spawnError: null })` (12-char SHA) | `{ status: 'not-found', prNumbers: [] }` |
| TC-U-02 | REQ-1 | edge | Full canonical 40-char SHA: stderr `'gh: No commit found for SHA: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 (HTTP 422)\n'`, status 1 | `{ status: 'not-found', prNumbers: [] }` (max boundary inclusive) |
| TC-U-03 | REQ-1 | edge | Minimum 7-char SHA: stderr `'gh: No commit found for SHA: deadbee (HTTP 422)\n'`, status 1 | `{ status: 'not-found', prNumbers: [] }` (min boundary inclusive) |
| TC-U-03b | REQ-1 | validation | Below min: 6-char hex `'No commit found for SHA: abc123 (HTTP 422)'`, status 1 | `'error'` (regex `{7,40}` rejects 6-char; falls through to fallback) |
| TC-U-03c | REQ-1 | validation | Above max: 41-char hex `'No commit found for SHA: ' + 'a'.repeat(41)`, status 1 | `'not-found'` — regex is unanchored; first 40 chars match. Documents the locked decision (real `gh` never emits 41+, so this case is purely informational). |
| TC-U-04 | REQ-1 | edge | Mixed-case match for `/i` flag: stderr `'NO COMMIT FOUND FOR SHA: ABC1234 (HTTP 422)'`, status 1 | `{ status: 'not-found', prNumbers: [] }` (case-insensitive matches both phrase AND hex `A-F` via `/i`) |
| TC-U-05 | REQ-2 | business | Stderr contains BOTH `'No commit found for SHA: deadbee1'` AND `'API rate limit exceeded'`, status 1 | `'rate-limited'` (precedence: rate-limited check fires first) |
| TC-U-06 | REQ-3 | edge | Stderr `'HTTP 422 Unprocessable Entity'` (no SHA-not-found phrase), status 1 | `'error'` (fallback — no specific recovery) |
| TC-U-07 | REQ-1 | validation | Char-class rejection: stderr contains valid 16-char span with one non-hex char in the middle: `'No commit found for SHA: deadbeefz1234567 (HTTP 422)'`, status 1 | `'error'` — `'z'` violates `[0-9a-f]` AND the surrounding span is broken into two sub-7-char halves around the `z` (`deadbeef` is 8 valid + `z` + `1234567` is 7 valid; wait — `deadbeef` IS ≥7 hex chars, so this WILL match. **Fix the fixture**: use `'gggggggg'` (8 chars all `g`) so no contiguous 7-hex run exists). Expected: `'error'`. |
| TC-U-08 | REQ-1 | edge | Defensive: `result.status === 0` AND stderr has the phrase (impossible with real `gh` but the explicit `status !== 0` guard must hold): stdout `'[]'`, status 0, stderr has SHA-not-found phrase | `'not-found'` via the **status-0 JSON-parse path** (NOT via the new arm). The new arm's `status !== 0` guard prevents it from firing; the existing path returns `'not-found'` from the empty-array branch. Confirms the guard is wired correctly. |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-4 | happy | Wire a `runImpl` stub that returns the literal real-`gh` 422 stderr (`'gh: No commit found for SHA: deadbee123 (HTTP 422)\n'` + status 1) for one of 3 commit SHAs, normal `'ok'` JSON for the other 2. End-to-end via `lookupMergedPrCount` + evaluator. | Session's `merged_pr_count` reflects dedup'd PR count from the 2 `'ok'` results only; the 422-bearing commit contributes empty (no NULL collapse). |
| TC-I-02 | REQ-2 | business | Wire `runImpl` stub: commit 1 → `'No commit found for SHA: …'` (status 1), commit 2 → `'API rate limit exceeded'` (status 1), commit 3 → ok | `merged_pr_count = NULL`. Confirms rate-limited still dominates the failure mode at integration level after the new classifier arm is in place. |

**Anti-regression note (NOT new TCs to write)**: `pnpm test --run lib/ingest/git/pr-lookup.test.ts lib/ingest/git/evaluator.test.ts` MUST continue to pass without modification. Specifically v2's TC-I-15 (rate-limited mid-session → NULL), TC-I-18 (ok+not-found mix → 1), TC-I-25 (all not-found → 0) verify that downstream `'not-found'` handling is unchanged. No new test code for these — they already exist and must remain green.

### Live Validation

- After implementation, on the user's actual DB: have at least one local-only commit (i.e., a SHA on `main` that is NOT on `origin/main`). Run `TOKENFX_GH_PR_LOOKUP=1 pnpm ingest`. Then:

  ```sql
  -- Sessions touching local-only commits should now have merged_pr_count = 0 (was NULL pre-fix).
  SELECT COUNT(*) AS sessions_now_zero
  FROM session_outcomes
  WHERE merged_pr_count = 0
    AND last_evaluated_at > <pre-fix snapshot timestamp>;
  ```

- **If origin is fully up-to-date** (no local-only commits): the 422 path won't trigger and the live validation cannot directly confirm the new arm. In that case, fall back to verifying via unit TCs (TC-U-01..04, TC-U-05) and live-running `gh api repos/{owner}/{repo}/commits/<random-sha>/pulls` manually to confirm the stderr format hasn't changed since spec-authoring.

## Design

### Architecture Decisions

- **Single classifier extension** in `lib/ingest/git/pr-lookup.ts:classifyGhResult`. The full updated decision tree (in execution order):

  1. `result.spawnError?.code === 'ENOENT'` → `'error'`
  2. `/HTTP 401|HTTP 403.*not.*authorized|gh auth login/i.test(stderr)` → `'unauthorized'`
  3. `/rate.?limit|API rate limit exceeded|X-RateLimit-Remaining: 0/i.test(stderr)` → `'rate-limited'`
  4. **NEW**: `result.status !== 0 && /no commit found for sha: [0-9a-f]{7,40}/i.test(stderr)` → `'not-found'`
  5. `result.status === 0` → JSON-parse stdout → `'ok'` | `'not-found'` (empty array) | `'error'`
  6. Fallthrough → `'error'`

- **Concrete code sketch** (insertion at the precise line):

  ```ts
  // After: rate-limited check at line 135-137
  // Before: `if (result.status === 0)` block at line 139

  // REQ-1: SHA not found on remote → permanent 'not-found' (count = 0).
  // gh emits this for HTTP 422 when the SHA isn't on origin (typical for
  // local-only commits not yet pushed). REQ-2: rate-limited check above
  // fires first if both patterns are present in stderr.
  if (
    result.status !== 0 &&
    /no commit found for sha: [0-9a-f]{7,40}/i.test(stderr)
  ) {
    return { status: 'not-found', prNumbers: [] };
  }
  ```

- **No DB schema change.** v2's `merged_pr_count` semantics are preserved; only the classifier mapping changes. Backward-compatible at the function-signature level: the 5 existing statuses are unchanged, no new status added, no caller updates needed.

### Files to Modify

- `lib/ingest/git/pr-lookup.ts` — extend `classifyGhResult` (single new arm).
- `lib/ingest/git/pr-lookup.test.ts` — add TC-U-01..08 (9 new TCs).
- `lib/ingest/git/evaluator.test.ts` — add TC-I-01, TC-I-02 (2 new TCs at `runImpl` level, exercising the full classifier→evaluator path with real-`gh`-shape stderr).

### Files to Create

None.

### Dependencies

None new.

## Tasks

- [x] TASK-1: Add the `'no commit found for sha'` arm to `classifyGhResult`. RED (write 9 unit TCs first, expect 8 to fail since the new arm doesn't exist yet — TC-U-08 may pass trivially since it tests the existing status-0 path) → GREEN.
  - files: `lib/ingest/git/pr-lookup.ts`, `lib/ingest/git/pr-lookup.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-03b, TC-U-03c, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08

- [x] TASK-2: Integration tests in `evaluator.test.ts` wiring at the **`runImpl`** level (NOT at the `lookupPrCountImpl` DI seam — we want the classifier's new arm to actually fire from real-shape stderr).
  - files: `lib/ingest/git/evaluator.test.ts`
  - tests: TC-I-01, TC-I-02
  - depends: TASK-1

## Parallel Batches

- Batch 1: [TASK-1]
- Batch 2: [TASK-2] — sequential (depends on TASK-1)

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (anti-regression: 49+ TCs in `lib/ingest/git/`)
- [ ] `pnpm build` passes
- [ ] **Live validation** (when local-only commits exist on `main`): `TOKENFX_GH_PR_LOOKUP=1 pnpm ingest`; SQL `SELECT COUNT(*) FROM session_outcomes WHERE merged_pr_count = 0` returns ≥ 1 row for sessions whose commits include local-only SHAs. If origin is up-to-date, fall back to manual `gh api` invocation to confirm stderr format hasn't drifted.

## Execution Log

### TASK-1 (2026-05-07 17:33)

TDD: RED(5/9 new TCs fail before classifier arm; 4 trivially pass — the existing `'error'` fallback was already returning the wrong-but-not-asserted value for some fixtures) → GREEN(32/32 in pr-lookup.test.ts after adding `if (result.status !== 0 && /no commit found for sha: [0-9a-f]{7,40}/i.test(stderr))` arm between rate-limited check and status===0 block).

### TASK-2 (2026-05-07 17:36)

GREEN on first run (40/40 in evaluator.test.ts, 105/105 in lib/ingest/git/). Wired stubs at the **runImpl level** via a new `makeRunImplLookup(fixtures)` helper that wraps the production `lookupMergedPrCount` with a fake `runImpl` emitting fixtures in commit-iteration order. SHA template substitution via callback fixture `(sha) => PrRunResult` so the canonical 422 stderr embeds the real test-repo SHA. TC-I-01 confirms 422 → not-found path yields `merged_pr_count = 2` (was NULL pre-fix); TC-I-02 confirms rate-limit still dominates the new arm (NULL collapse preserved).

### Self-review iteration (2026-05-07 17:43)

3 reviewers in parallel (code + test + security). 0 CRITICAL/HIGH/MEDIUM. SHOULD FIX applied inline:

- **`makeRunImplLookup` exposes `callCount()`** + asserted in both TC-I-01/02 (`toBe(3)`) — guards against silent under-consumption if commit enumeration changes.
- **Replaced `fixtures[idx]!` non-null assertion** with explicit `undefined` check (mirrors `makeRunStub` pattern in pr-lookup.test.ts).
- **`RunFixture` type relocated** from inside the describe block to module scope (after imports), alongside other type aliases.
- **TC-U-05b added** — precedence test with no-commit-found phrase appearing FIRST in stderr (catches hypothetical string-order bugs; current code is correct, this locks the contract).

Final: 106/106 passing in `lib/ingest/git/`, typecheck clean, lint clean.
