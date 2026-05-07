# Spec: outcome-integration-git-v2-pr-lookup

## Status: IN_PROGRESS

## Context

Closes the **TASK-PR (v2 deferred)** carve-out from
`.specs/outcome-integration-git.md` (Fase 0, commit `faa2c33`):
populates the `session_outcomes.merged_pr_count` column that has lived
nullable since day 1 with a `NULL` placeholder in the evaluator's UPSERT.

The Fase 0 spec already locked the WHAT (REQ-8): when
`TOKENFX_GH_PR_LOOKUP=1` is set AND `gh` CLI is on PATH AND the repo has
a GitHub remote, populate `merged_pr_count` via the GitHub commits→PRs
endpoint, deduped by PR number across all session-commits. This v2
spec implements it.

### Why this spec exists separately from Fase 0

- The `gh` CLI is an **external dep** with non-trivial failure modes
  (rate limits, auth, network). Building it as a separate spec lets the
  failure-mode TCs land with focus + thorough rigor.
- It **unblocks Fase 5** (`manager-dashboard-v3-outcomes` —
  tokens-per-merged-LOC per team). Without merged-PR data flowing,
  v3-outcomes is vaporware.
- It is **opt-in** (env flag); the default behavior of `pnpm ingest`
  does NOT change for users who don't set the flag.

### Decisões já travadas (Phase 1 lock — não voltam atrás durante execução)

- **Owner/repo derivation**: parse `git remote get-url origin`. Accept
  both `git@github.com:owner/repo.git` (SSH) and
  `https://github.com/owner/repo.git` (HTTPS). Bail (return
  `{count: 0, status: 'not-found'}`) on any non-GitHub remote (gitlab,
  bitbucket, custom git server, no remote at all). Single source of
  truth — never read git config differently elsewhere in this spec.
- **Per-invocation in-memory cache** keyed by `sha`. No DB persistence.
  Justificativa: `pnpm ingest` is one-shot; persisting would require
  schema migration + invalidation logic + race handling for parallel
  ingest runs. Cache reset between invocations is acceptable. The cache
  ONLY stores positive `{count}` results — `'rate-limited'`,
  `'unauthorized'`, `'error'`, `'not-found'` are NOT cached (so a
  transient failure doesn't taint the rest of the run).
- **`gh` CLI auth**: assume user has run `gh auth login`. If `gh` is
  not authenticated, the helper surfaces `status: 'unauthorized'` and
  the evaluator writes `merged_pr_count = NULL` (the "not evaluated"
  sentinel — matches REQ-8 of the parent spec). NO interactive
  prompting, NO env var fallback for tokens (PRs come from GitHub auth,
  not TokenFx config).
- **Rate-limit back-off**: when `gh api` returns rate-limited, the
  helper sets a process-wide flag `rateLimitedUntil` (timestamp 1h in
  the future). Subsequent calls within that window short-circuit to
  `status: 'rate-limited'` WITHOUT spawning `gh`. Reset on next ingest
  run. Justificativa: GitHub's rate limit is per-token, so once one
  call hits the limit, all subsequent calls in the same run will too —
  short-circuiting saves spawn overhead AND avoids GitHub-side
  amplification.
- **DI seam**: `evaluateSessionOutcome(db, session, options)` already
  has `runGitImpl?` for git stub injection (Fase 0 spec line 32). We
  add a parallel `lookupPrCountImpl?: PrLookupFn` option. Default =
  production lookup. Tests inject a stub. This keeps the seam pattern
  consistent across the evaluator's external deps.
- **Failure mode → `merged_pr_count` mapping**:
  - `status: 'ok'` → write `count` (an integer ≥ 0).
  - All other statuses (`'rate-limited' | 'unauthorized' | 'not-found' |
    'error'`) → write `NULL`. The UI already treats `NULL` as "hide
    tile" (`session-outcome-panel.tsx:160`). The user gets a partial
    result for their other commits; the `gh` failure is logged at
    `info` (not `warn`) for the first occurrence per run, then silent
    (deduped via the same `rateLimitedUntil`-style flag). Justificativa:
    spamming `warn` for every session when `gh` is misconfigured would
    drown out other warnings.
- **No partial population**: if any session-commit lookup fails, the
  WHOLE session writes `merged_pr_count = NULL`. We do not return
  "count from the 3 commits that succeeded out of 5". Justificativa:
  per-commit partial sums break PR-number deduplication semantics
  (a PR present in commits 1+5, where commit 5 fails, would be
  counted once instead of zero times — silent under-count).
- **Owner/repo case sensitivity**: GitHub URLs are case-insensitive at
  the API level. We normalize to the as-written casing from `git remote
  get-url`; `gh api` handles both. NO `.toLowerCase()` — that would
  diverge from the user's actual remote and confuse log output.
- **Spec mãe Execution Log update**: marcar TASK-PR (v2 deferred) como
  DONE em `.specs/outcome-integration-git.md` no final desta spec
  (Phase 5 of ralph-loop, before commit).

## Requirements

### Helper module — `lib/ingest/git/pr-lookup.ts`

- [ ] **REQ-1**: GIVEN `lookupMergedPrCount({owner, repo, sha})` is invoked
  AND `gh` CLI is on PATH AND `gh auth status` is clean AND the SHA exists
  in the repo AND has at least one merged PR WHEN the helper runs THEN it
  spawns `gh api repos/{owner}/{repo}/commits/{sha}/pulls --jq '[.[] |
  select(.merged_at != null) | .number]'` (argv-array, shell:false, via
  the `spawnSync`-with-timeout pattern) AND returns
  `{ status: 'ok', prNumbers: number[] }` (the parsed JSON array of PR
  numbers, possibly empty if all PRs touching the SHA were closed
  unmerged).

- [ ] **REQ-2**: GIVEN `gh` CLI is NOT on PATH (`spawnSync` returns ENOENT)
  WHEN the helper runs THEN it returns
  `{ status: 'error', prNumbers: [] }` AND logs `info` (not warn) ONCE
  per invocation with `{ reason: 'gh-cli-missing' }` — subsequent calls in
  the same run short-circuit to the same status without re-logging.

- [ ] **REQ-3**: GIVEN `gh` returns a non-zero exit AND stderr matches
  `/HTTP 401|HTTP 403.*not.*authorized|gh auth login/i` WHEN the helper
  runs THEN it returns `{ status: 'unauthorized', prNumbers: [] }` AND
  logs `info` ONCE with `{ reason: 'gh-auth-failure' }`.

- [ ] **REQ-4**: GIVEN `gh` returns non-zero AND stderr indicates
  rate-limiting (matches `/rate.?limit|API rate limit exceeded|X-RateLimit-Remaining: 0/i`)
  WHEN the helper runs THEN it returns
  `{ status: 'rate-limited', prNumbers: [] }` AND sets a process-wide
  `rateLimitedUntil = now + 60min` flag. Subsequent calls before
  `rateLimitedUntil` short-circuit to `'rate-limited'` WITHOUT spawning
  `gh`. Logs `info` ONCE with `{ reason: 'rate-limited', resetMin: 60 }`.

- [ ] **REQ-5**: GIVEN `gh api` succeeds (exit 0) AND stdout parses to
  `[]` (empty JSON array — no merged PR contains this SHA) WHEN the
  helper runs THEN it returns `{ status: 'not-found', prNumbers: [] }`.
  **NOT** logged at warn — this is the legitimate "commit was direct-
  pushed, not via PR" case. **`'not-found'` is a SUCCESS status** (the
  SHA was queried and we definitively know there are 0 merged PRs); it
  participates in evaluator dedup as a contributor of zero PR numbers.
  Only `'rate-limited' | 'unauthorized' | 'error'` are failure statuses
  per REQ-15.

- [ ] **REQ-6**: GIVEN `gh` exits with any other non-zero status (network
  error, malformed JSON, timeout, JSON parse error from `--jq`) WHEN the
  helper runs THEN it returns `{ status: 'error', prNumbers: [] }` AND
  logs `info` ONCE with `{ reason: 'gh-error', code: <exit-status>,
  stderrTail: <last 200 chars stderr> }`.

- [ ] **REQ-7**: GIVEN the same SHA is queried twice in the same process
  AND the FIRST call returned `status: 'ok'` WHEN the SECOND call runs
  THEN it returns the cached `{ status: 'ok', prNumbers }` WITHOUT
  spawning `gh`. **Cache lookup happens BEFORE the rate-limit
  short-circuit** — a SHA with a cached `'ok'` result is served even
  when the process-wide rate-limit flag is active (the cached PR
  numbers are still valid; the rate limit only blocks NEW queries).
  Cache is process-local, keyed by SHA only (owner/repo collisions are
  not a real concern — full SHAs are globally unique in practice).

- [ ] **REQ-7b**: GIVEN the FIRST call returned a non-`'ok'` status WHEN
  the SECOND call runs THEN it does NOT use the cache; it re-queries
  (except when `'rate-limited'` short-circuits via REQ-4's process-wide
  flag). Justificativa: a transient `'error'` shouldn't poison subsequent
  ingest runs of the same session.

- [ ] **REQ-8**: GIVEN the helper's exposed function signature is
  `lookupMergedPrCount(input, options?): Result<PrLookupResult, never>`
  (synchronous — mirrors `runGit`'s shape; `gh` is a child process via
  `spawnSync`, no async needed) WHEN inspected THEN:
  - `input: { owner: string; repo: string; sha: string }`
  - `options?: { runImpl?: PrRunImpl; shaCache?: Map<string, { status: 'ok'; prNumbers: number[] }>; rateLimitRef?: { limitedUntil: number | null }; nowMs?: () => number }`
  - `PrRunImpl = (args: string[], opts: { timeoutMs?: number }) => { stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException }`
  - Default `runImpl` calls `spawnSync('gh', args, …)`. Default
    `shaCache` / `rateLimitRef` are module-level singletons. Default
    `nowMs = Date.now`.
  - **Tests pass fresh `shaCache: new Map()` + `rateLimitRef: { limitedUntil: null }` + a controllable `nowMs` per case** — replaces the earlier `__resetForTests()` design (which would have leaked test-only surface; flagged by self-review M-code/M-spec).

### Owner/repo derivation — same module or `lib/ingest/git/git-remote.ts`

- [ ] **REQ-9**: GIVEN a function `parseGitHubRemote(remoteUrl: string)`
  WHEN passed any of the accepted GitHub shapes:
  - `git@github.com:owner/repo.git`
  - `git@github.com:owner/repo` (no `.git` suffix)
  - `https://github.com/owner/repo.git`
  - `https://github.com/owner/repo`
  - `https://github.com/owner/repo/` (trailing slash)
  - `ssh://git@github.com/owner/repo.git` (full SSH URI form)
  - `https://<token>@github.com/owner/repo.git` (token-in-URL HTTPS,
    common in CI — token is dropped from the parsed result;
    owner/repo extraction unaffected)

  THEN it returns `{ owner: 'owner', repo: 'repo' }`. WHEN passed any
  other shape (`git@gitlab.com:...`, `https://bitbucket.org/...`,
  custom git host, empty string, malformed) THEN it returns `null`.

- [ ] **REQ-10**: GIVEN `resolveGitHubRepo(cwd, runGitImpl)` runs
  `git remote get-url origin` (via `runGit`) WHEN the command succeeds
  THEN it returns `parseGitHubRemote(stdout.trim())`. WHEN the command
  fails (no `origin` remote) OR `parseGitHubRemote` returns null THEN
  it returns `null`.

### Evaluator integration — `lib/ingest/git/evaluator.ts`

- [ ] **REQ-11**: GIVEN `process.env.TOKENFX_GH_PR_LOOKUP === '1'` AND
  `evaluateSessionOutcome` runs AND there is at least one session-commit
  AND `resolveGitHubRepo(cwd)` returns a non-null `{ owner, repo }`
  WHEN the evaluator processes commits THEN for EACH session-commit
  SHA, it calls `lookupPrCountImpl({owner, repo, sha})` (default =
  `lookupMergedPrCount`) AND collects the per-commit `count` values
  AND PR numbers.

  **Wait** — the helper returns `count` (length) but for proper
  dedup-by-PR-number we need the PR numbers themselves. Either (a) the
  helper returns `Set<number>` not just `count`, OR (b) we change
  `--jq` to return the array of numbers and the evaluator dedupes.

  **Lock resolution**: helper returns `{ status, prNumbers: number[] }`
  (an array, possibly empty). Evaluator unions the arrays from each
  session-commit into a `Set<number>` and writes `merged_pr_count =
  set.size`. Update REQ-1..6 to reflect the array shape (NOT count).

- [ ] **REQ-12**: GIVEN `process.env.TOKENFX_GH_PR_LOOKUP !== '1'`
  (unset OR any value other than literal `'1'`) WHEN the evaluator
  runs THEN it does NOT call `lookupPrCountImpl` AND the row is
  upserted with `merged_pr_count = NULL` — byte-for-byte identical to
  the pre-spec behavior.

- [ ] **REQ-13**: GIVEN the env flag is on AND `resolveGitHubRepo`
  returns null (no GitHub remote) WHEN the evaluator runs THEN it does
  NOT spawn `gh` AND writes `merged_pr_count = NULL` AND logs `info`
  ONCE per invocation with `{ reason: 'no-github-remote' }`.

- [ ] **REQ-14**: GIVEN the env flag is on AND there are 5
  session-commits AND lookups return: `[{ok, [42]}, {ok, []},
  {not-found, []}, {ok, [42, 99]}, {ok, [99]}]` (PR 42 in commits 1+4,
  PR 99 in commits 4+5, commit 3 has no PR) WHEN the evaluator
  upserts THEN `merged_pr_count = 2` (the unique-PR set is `{42, 99}`).

- [ ] **REQ-15**: GIVEN the env flag is on AND ANY lookup returns a
  failure status (`'rate-limited' | 'unauthorized' | 'error'` —
  `'not-found'` is success per REQ-5 lock) WHEN the evaluator finishes
  iterating commits THEN it writes `merged_pr_count = NULL` (the
  partial sum is discarded). Successful lookups in the same session
  ARE wasted but the cache (REQ-7) makes a re-run free for those.

- [ ] **REQ-16**: GIVEN the UPSERT SQL in `evaluator.ts:45-58` WHEN
  modified THEN it accepts `merged_pr_count` as a bind parameter
  (currently hardcoded to `NULL`) AND `upsertOutcome(db, row)` accepts
  `mergedPrCount: number | null` in the row shape. The ON CONFLICT
  clause includes `merged_pr_count = excluded.merged_pr_count`.

### Logging + privacy

- [ ] **REQ-17**: NO log call (`info` / `warn` / `error`) emitted by
  this spec includes commit messages, PR titles/bodies, file diffs, or
  user emails. Logs include only `{ sessionId?, sha?, owner?, repo?,
  reason, code?, stderrTail? }` where `stderrTail` is capped at 200
  chars and never contains git diff or user-content fragments.

- [ ] **REQ-18**: NO `console.log` anywhere — use `lib/logger.ts`
  (`log.info` / `log.warn`). Project rule. **Enforcement**: ESLint's
  `no-console` rule + the Stop hook's lint gate (NOT a runtime TC —
  static-analysis is more reliable than a Vitest assertion that would
  miss `console.log` calls behind unreachable branches). Verified by
  the Validation Criteria's `pnpm lint` step.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-9 | happy | `parseGitHubRemote('git@github.com:owner/repo.git')` | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-02 | REQ-9 | happy | `parseGitHubRemote('git@github.com:owner/repo')` (no `.git`) | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-03 | REQ-9 | happy | `parseGitHubRemote('https://github.com/owner/repo.git')` | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-04 | REQ-9 | happy | `parseGitHubRemote('https://github.com/owner/repo')` (no `.git`) | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-05 | REQ-9 | edge | `parseGitHubRemote('https://github.com/owner/repo/')` (trailing slash) | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-06 | REQ-9 | validation | `parseGitHubRemote('git@gitlab.com:owner/repo.git')` (gitlab) | `null` |
| TC-U-07 | REQ-9 | validation | `parseGitHubRemote('https://bitbucket.org/owner/repo.git')` | `null` |
| TC-U-08 | REQ-9 | validation | `parseGitHubRemote('')` (empty) | `null` |
| TC-U-09 | REQ-9 | validation | `parseGitHubRemote('not-a-url')` (malformed) | `null` |
| TC-U-10 | REQ-9 | edge | `parseGitHubRemote('git@github.com:org-with-dashes/repo.with.dots.git')` (dashes + dots) | `{ owner: 'org-with-dashes', repo: 'repo.with.dots' }` |
| TC-U-10b | REQ-9 | edge | `parseGitHubRemote('ssh://git@github.com/owner/repo.git')` (full SSH URI) | `{ owner: 'owner', repo: 'repo' }` |
| TC-U-10c | REQ-9 | edge | `parseGitHubRemote('https://ghp_xxxxxxx@github.com/owner/repo.git')` (token-in-URL HTTPS) | `{ owner: 'owner', repo: 'repo' }` (token stripped; not part of returned shape) |
| TC-U-11 | REQ-7 | happy | Helper called twice with same `sha` → SECOND call does NOT invoke `runImpl` (verified via stub call count) | runImpl called exactly once |
| TC-U-12 | REQ-7b | edge | Helper called twice; FIRST returns `'error'` → SECOND call DOES invoke `runImpl` (no negative cache) | runImpl called twice |
| TC-U-13 | REQ-4 | edge | Helper called twice; FIRST returns `'rate-limited'` → SECOND call short-circuits (process-wide flag) WITHOUT calling `runImpl` | runImpl called once |
| TC-U-14 | REQ-4 | edge | After `'rate-limited'` set, advance clock > 60min via `vi.useFakeTimers()` + `vi.setSystemTime(Date.now() + 61 * 60_000)` (or inject `nowMs: () => …` via options seam — pick one mechanism per test, document in test file). Next call DOES invoke `runImpl` | runImpl called twice |
| TC-U-15 | REQ-1, REQ-7 | happy | Cache hit AFTER rate-limit set: SHA `abc` cached with `'ok'`, then a different SHA triggers `'rate-limited'`. Re-query SHA `abc` → returns cached `'ok'` WITHOUT spawning `gh` | runImpl called once for `abc` (initial), once for the rate-limit-triggering SHA, total 2 calls (cached SHA does NOT add a call) |
| TC-U-16 | REQ-7b, REQ-4 | edge | Combined flow: FIRST call `'error'` (no cache, REQ-7b allows re-query); SECOND call same SHA returns `'rate-limited'`; THIRD call short-circuits (REQ-4 wins via process-wide flag) | runImpl called twice; THIRD call NOT spawned |
| TC-U-17 | REQ-3 | security | classifyGhResult arm: stderr matches `'HTTP 403: forbidden, you must be authorized'` → `'unauthorized'` | second regex arm tested |
| TC-U-18 | REQ-3 | security | classifyGhResult arm: stderr matches `'Please run: gh auth login'` → `'unauthorized'` | third regex arm tested |
| TC-U-19 | REQ-6 | edge | classifyGhResult: stdout=`'[42]'` parses but `[42]` is not the array of `number` (e.g. `[null]`, `["42"]`) — JSON shape validation fails → `'error'` | rejected as malformed |
| TC-U-20 | REQ-6 | edge | classifyGhResult: status=0, stdout=`''` (empty) → `'error'` (cannot parse empty as JSON array) | distinct from `'not-found'` |
| TC-U-21 | REQ-12 | validation | `TOKENFX_GH_PR_LOOKUP = 'true'` → flag is OFF (strict `=== '1'`) | lookupPrCountImpl NOT called (covered at integration level too) |
| TC-U-22 | REQ-12 | validation | `TOKENFX_GH_PR_LOOKUP = '1 '` (trailing space) → flag is OFF (NO `.trim()`) | lookupPrCountImpl NOT called |
| TC-U-23 | REQ-12 | validation | `TOKENFX_GH_PR_LOOKUP = ' 1'` (leading space) → flag is OFF | lookupPrCountImpl NOT called |
| TC-U-24 | REQ-12 | validation | `TOKENFX_GH_PR_LOOKUP = 'yes'` → flag is OFF | lookupPrCountImpl NOT called |
| TC-U-25 | REQ-12 | validation | `TOKENFX_GH_PR_LOOKUP = 'TRUE'` (case sensitive) → flag is OFF | lookupPrCountImpl NOT called |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `lookupMergedPrCount({owner, repo, sha})` with stub `runImpl` returning `{stdout: '[42, 99]', stderr: '', status: 0}` | `{ status: 'ok', prNumbers: [42, 99] }` |
| TC-I-02 | REQ-2 | infra | Stub `runImpl` rejects with `{ code: 'ENOENT' }` | `{ status: 'error', prNumbers: [] }`; logged ONCE per invocation with `reason: 'gh-cli-missing'` |
| TC-I-03 | REQ-3 | security | Stub returns `{stderr: 'HTTP 401: bad credentials. Run gh auth login.', status: 1}` | `{ status: 'unauthorized', prNumbers: [] }`; logged with `reason: 'gh-auth-failure'` |
| TC-I-04 | REQ-4 | infra | Stub returns `{stderr: 'API rate limit exceeded for user.', status: 1}` | `{ status: 'rate-limited', prNumbers: [] }`; subsequent call to a different SHA short-circuits without invoking stub |
| TC-I-05 | REQ-5 | edge | Stub returns `{stdout: '[]', stderr: '', status: 0}` (commit has no PR) | `{ status: 'not-found', prNumbers: [] }`; NOT logged at warn |
| TC-I-06 | REQ-6 | infra | Stub returns `{stderr: 'tcp i/o timeout connecting to api.github.com', status: 1}` | `{ status: 'error', prNumbers: [] }`; logged with `reason: 'gh-error'` |
| TC-I-07 | REQ-6 | edge | Stub returns `{stdout: 'malformed{json', stderr: '', status: 0}` (jq output garbage) | `{ status: 'error', prNumbers: [] }` (JSON parse fail in helper) |
| TC-I-08 | REQ-10 | happy | `resolveGitHubRepo(cwd, stubRunGit)` where stubRunGit returns `git@github.com:foo/bar.git\n` | `{ owner: 'foo', repo: 'bar' }` |
| TC-I-09 | REQ-10 | edge | stubRunGit returns non-zero (no origin remote) | `null` |
| TC-I-10 | REQ-10 | edge | stubRunGit returns `git@gitlab.com:foo/bar.git\n` (non-GitHub) | `null` |
| TC-I-11 | REQ-12 | happy (anti-regression) | `evaluateSessionOutcome` with `TOKENFX_GH_PR_LOOKUP` UNSET → row written with `merged_pr_count = NULL`. Stub `lookupPrCountImpl` is NOT called. | `merged_pr_count: null`; lookupPrCountImpl call count = 0 |
| TC-I-12 | REQ-12 | edge | `TOKENFX_GH_PR_LOOKUP = '0'` (string '0', not '1') → flag is OFF | identical to TC-I-11 |
| TC-I-13 | REQ-13 | infra | Flag on, `resolveGitHubRepo` returns null → row written with `merged_pr_count = NULL`; lookupPrCountImpl NOT called | `merged_pr_count: null`; lookupPrCountImpl call count = 0; logged with `reason: 'no-github-remote'` |
| TC-I-14 | REQ-11, REQ-14 | business | Flag on, 5 session commits, stub returns `[ok:[42], ok:[], not-found:[], ok:[42,99], ok:[99]]` | `merged_pr_count = 2` (set is `{42, 99}`) |
| TC-I-15 | REQ-15 | edge | Flag on, 3 session commits, stub returns `[ok:[42], rate-limited:[], ok:[99]]` (one rate-limited) | `merged_pr_count = NULL` (partial discarded) |
| TC-I-16 | REQ-15 | edge | Flag on, 3 commits, stub returns `[ok:[42], unauthorized:[], ok:[99]]` | `merged_pr_count = NULL` |
| TC-I-17 | REQ-15 | edge | Flag on, 3 commits, stub returns `[ok:[42], error:[], ok:[99]]` | `merged_pr_count = NULL` |
| TC-I-18 | REQ-11, REQ-5 | edge | Flag on, 3 commits, stub returns `[ok:[42], not-found:[], not-found:[]]` (mix of ok + not-found, no failures) | `merged_pr_count = 1` (`'not-found'` is success per lock) |
| TC-I-19 | REQ-11 | edge | Flag on, ZERO session commits (empty session) → no lookups, row written with `merged_pr_count = NULL` (no commits to attribute) | `merged_pr_count: null`; lookupPrCountImpl NOT called |
| TC-I-20 | REQ-16 | infra | UPSERT SQL accepts non-null `merged_pr_count` and ON CONFLICT updates it on re-run | row count stays 1; field updates from NULL → 2 → 3 across reruns |
| TC-I-21 | REQ-17 | security | Stub returns `stderr: 'feat: SECRET-FEATURE-NAME ' + 'x'.repeat(500)`; capture `log.info` calls via hand-written spy (`vi.spyOn(log, 'info')` — vitest primitive). Helper logs once with `reason='gh-error'`, `stderrTail` field. **Deterministic assertions**: (a) `stderrTail.length <= 200`; (b) the captured log call's argument structure matches `{ reason: string, code?: number\|string, stderrTail: string }` (no extra fields like `'message'`, `'sha'`, `'email'`); (c) `stderrTail` is the LAST 200 chars of the stub stderr (not the first — verifies the truncation direction). | all 3 assertions pass |
| TC-I-23 | REQ-7 | happy | `evaluateSessionOutcome` with 2 sessions sharing 3 SHAs → cache deduplicates: stub called 3 times total, not 6 | call count = 3 |
| TC-I-24 | REQ-15 | edge | Flag on, 3 commits, stub returns `[ok:[42], rate-limited:[], unauthorized:[]]` (TWO different failure statuses + 1 ok) | `merged_pr_count = NULL` (any failure → discard partial) |
| TC-I-25 | REQ-5, REQ-15 | edge | Flag on, 2 commits, stub returns `[not-found:[], not-found:[]]` (ALL not-found, no ok or failure) | `merged_pr_count = 0` (set is empty `{}` — `'not-found'` is success, prNumbers=[] each) |
| TC-I-26 | REQ-12 | infra (anti-regression) | Run evaluator with flag ON for SHA producing `merged_pr_count = 2`. Then re-run with flag UNSET. **Locked behavior**: when flag is OFF, the entire evaluation path skips PR lookup AND the UPSERT writes `merged_pr_count = NULL` (overwriting the previous `2`). Justificativa: flag-OFF is "do not evaluate PRs"; preserving stale value would lie about what was just evaluated. | row updates from `2` to `NULL` |

### E2E Tests

N/A — this is an ingestion-pipeline change with no UI surface beyond
the existing `<SessionOutcomePanel>` (already handles `mergedPrCount !==
null` conditional render — no changes needed).

## Design

### Architecture Decisions

**Helper module structure**. New file `lib/ingest/git/pr-lookup.ts`
exporting `lookupMergedPrCount` + the helper types. Owner/repo parsing
lives in a sibling `lib/ingest/git/git-remote.ts` (separate file
because the parser is pure + has its own test file with 10 TC-Us — keeping
it co-located with the helper would mix unit and integration concerns).

**`gh` invocation pattern**. We do NOT reuse `runGit` (which is
git-only — `cwd` guard rejects non-home paths and `gh` doesn't need
cwd-relative state). Instead a new internal `runGh(args, opts)` helper
in `pr-lookup.ts`. **Signature differs from `runGit`**: `runGh` takes
`{ timeoutMs?: number }` only — NO `cwd` parameter (`gh api` calls the
GitHub HTTP API; cwd is irrelevant). Same `spawnSync` pattern,
shell:false, argv-array, timeout 5000ms. **Sets `GH_PROMPT_DISABLED=1`
in the spawned env** (analog to `GIT_TERMINAL_PROMPT=0` in `runGit`)
to prevent `gh` from interactively prompting on auth failure. The DI
seam `options.runImpl?: PrRunImpl` lets tests stub without spawning.

**Sync vs async** (locked decision). `lookupMergedPrCount` returns a
plain `Result`-shaped value, NOT a `Promise`. Justificativa: `gh` is
spawned via `spawnSync` (matching `runGit`); wrapping in `async` adds
microtask overhead and forces the evaluator (currently fully sync —
`evaluateSessionOutcome` returns `void`) to become async or use
`.then()` chains. If a future v3 swaps `gh` for `fetch`, the public
signature can be widened; today, sync matches the rest of the
ingestion pipeline.

**Cache + rate-limit DI seams** (locked — replaces the earlier
`__resetForTests()` design which violated the project's "no test-only
exports" rule per spec/code-reviewer self-review).
`lookupMergedPrCount` accepts three options:

- `shaCache?: Map<string, { status: 'ok'; prNumbers: number[] }>` —
  positive-only cache, keyed by SHA. Only `'ok'` results stored.
- `rateLimitRef?: { limitedUntil: number | null }` — wrapper object
  (so the function can mutate `.limitedUntil` without re-assigning a
  module-level binding through a return value).
- `nowMs?: () => number` — clock injection, default `Date.now`.

**Defaults are module-level singletons** (one `Map` + one wrapper
object created at module load — fresh per `pnpm ingest` invocation).
Tests construct fresh instances per case and pass them in:

```ts
it('TC-U-13: rate-limited short-circuits second call', () => {
  const shaCache = new Map();
  const rateLimitRef = { limitedUntil: null };
  // ... call lookupMergedPrCount({...}, { runImpl: stub, shaCache, rateLimitRef, nowMs: () => fakeNow })
});
```

**Order of precedence inside `lookupMergedPrCount`**:

1. Check `shaCache.get(sha)` — return cached `'ok'` result if present
   (REQ-7: cache wins over rate limit; cached PR numbers are still
   valid).
2. Check `rateLimitRef.limitedUntil` — if `nowMs() < limitedUntil`,
   short-circuit to `'rate-limited'` without spawning.
3. Spawn `gh` via `runImpl`, classify result, populate cache or
   `rateLimitRef.limitedUntil = nowMs() + 60 * 60 * 1000` as
   appropriate.

**Failure-mode classification logic**. A small switch on stderr
patterns:
1. `ENOENT` from `spawnSync` `error.code` → `'error'` with
   `reason: 'gh-cli-missing'`.
2. stderr matches `/HTTP 401|HTTP 403.*not.*authorized|gh auth login/i`
   → `'unauthorized'`.
3. stderr matches
   `/rate.?limit|API rate limit exceeded|X-RateLimit-Remaining: 0/i`
   → `'rate-limited'`.
4. `status === 0` AND stdout parses as `[]` → `'not-found'`.
5. `status === 0` AND stdout parses as `[number, ...]` → `'ok'`.
6. Anything else → `'error'`.

The classification is colocated with the helper in a
`classifyGhResult(result): PrLookupResult` pure function — testable in
isolation (TC-U-15..TC-U-25 cover its branches; declared in TC-I-* table
above as integration tests because they exercise the full
`lookupMergedPrCount` API surface, which is the contract).

**`--jq` filter choice**. The Fase 0 spec line 46 specifies
`'[.[] | select(.merged_at != null) | .number]'` (returns array of
PR numbers). v2 keeps that filter. Helper parses stdout as JSON;
expects an array of integers. Anything else is `'error'`.

**Why per-invocation cache, not DB-backed**. DB-backed cache would
require schema migration (new `gh_pr_cache` table), an invalidation
strategy (PRs can be merged after the SHA was first looked up), and
race handling for parallel ingest runs. The trade-off: re-running
`pnpm ingest` re-spawns `gh` for every SHA. Acceptable because:
- Most users run `pnpm ingest` ad-hoc, not in a tight loop.
- The cache hits within ONE run (multiple sessions in the same repo
  often share commits) — that's the dominant case.
- A future v3 could add DB-backed cache as a separate spec if real
  usage data shows it's worthwhile.

### Files to Create

- `lib/ingest/git/pr-lookup.ts` — helper module.
- `lib/ingest/git/pr-lookup.test.ts` — TDD-first.
- `lib/ingest/git/git-remote.ts` — owner/repo parser.
- `lib/ingest/git/git-remote.test.ts` — TDD-first (TC-U-01..10).

### Files to Modify

- `lib/ingest/git/evaluator.ts` —
  - Add `lookupPrCountImpl?: PrLookupFn` to `EvaluateOptions`.
  - Modify `UPSERT_SQL` to accept `merged_pr_count` as a bind parameter
    (replace the hardcoded `NULL`).
  - Add `mergedPrCount: number | null` to `upsertOutcome` row shape.
  - In `evaluateSessionOutcome`, after enumerating session-commits AND
    when `process.env.TOKENFX_GH_PR_LOOKUP === '1'`, call
    `resolveGitHubRepo(cwd, runGitImpl)`. If result is non-null,
    iterate commits, call `lookupPrCountImpl` for each, union
    `prNumbers`, classify final status (any failure → null), pass to
    `upsertOutcome`.
- `lib/ingest/git/evaluator.test.ts` —
  - Anti-regression: TC-I-01/02 of parent spec must continue passing
    (`merged_pr_count = NULL` when env unset).
  - Add TC-I-11..TC-I-23 from above.
- `.specs/outcome-integration-git.md` — append Execution Log entry
  marking TASK-PR (v2 deferred) DONE with reference to commit SHA of
  this spec.

### Dependencies

- `gh` CLI: external runtime dependency (not a npm package). Helper
  fails gracefully when missing.
- No new npm packages.

## Tasks

- [x] **TASK-1** (Owner/repo parser — TDD): create
  `lib/ingest/git/git-remote.{ts,test.ts}` with `parseGitHubRemote` +
  `resolveGitHubRepo` (the latter takes `runGitImpl` for DI). Pure
  parser TCs (12) cover SSH/HTTPS/with-suffix/without-suffix/trailing-
  slash/dashes-dots/full-SSH-URI/token-in-URL/non-GitHub/empty/malformed.
  - files: lib/ingest/git/git-remote.ts, lib/ingest/git/git-remote.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-10b, TC-U-10c, TC-I-08, TC-I-09, TC-I-10

- [x] **TASK-2** (Helper module — TDD): create
  `lib/ingest/git/pr-lookup.{ts,test.ts}`. Implements
  `lookupMergedPrCount` + classifier + cache + rate-limit short-circuit.
  Hand-written stub for `runImpl` in tests (no `gh` spawn). DI seam
  options for `shaCache`, `rateLimitRef`, `nowMs` (not `__resetForTests`
  — see REQ-8 lock). Export `classifyGhResult` for unit tests
  (TC-U-15..20). `runGh` (internal) sets `GH_PROMPT_DISABLED=1` in
  spawned env (analog to `GIT_TERMINAL_PROMPT=0` in `runGit`).
  - files: lib/ingest/git/pr-lookup.ts, lib/ingest/git/pr-lookup.test.ts
  - tests: TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-21, TC-I-23

- [x] **TASK-3** (Evaluator integration): wire `lookupPrCountImpl` into
  `evaluator.ts`. Concrete steps (in order — leaving any out breaks
  things, per code-reviewer self-review CRITICAL findings):
  1. Modify `UPSERT_SQL`: replace hardcoded `NULL` in the VALUES list
     with a bind parameter `?` for `merged_pr_count`.
  2. Modify `UPSERT_SQL` ON CONFLICT SET: ADD
     `merged_pr_count = excluded.merged_pr_count` to the SET list (was
     missing — that's why TC-I-20 / TC-I-26 require this fix to avoid
     stale values surviving re-evaluation).
  3. Modify `upsertOutcome(db, row)` row shape: add
     `mergedPrCount: number | null` and pass it to `db.prepare(...).run(...)`.
  4. Modify `writeStatusOnly` (the early-exit path called for
     `cwd-missing`, `not-a-git-repo`, `no-user-email`): add
     `mergedPrCount: null` to its `upsertOutcome` call. Without this,
     the bind-parameter count mismatches and skipped sessions throw at
     runtime.
  5. Add `lookupPrCountImpl?: PrLookupFn` and `parseRemoteImpl?:` to
     `EvaluateOptions`. Default to production helpers from TASK-1/2.
  6. In `evaluateSessionOutcome`, after enumerating session-commits:
     read `process.env.TOKENFX_GH_PR_LOOKUP` and compare to literal
     `'1'` (strict equality, NO `.trim()`, NO `.toLowerCase()` —
     boundary TCs TC-U-21..25). If unset/non-`'1'`, set
     `mergedPrCount = null` and short-circuit the lookup path.
  7. If flag on: call `resolveGitHubRepo(realCwd, runGitImpl)`. Null →
     `mergedPrCount = null`, log `info` once with `reason: 'no-github-remote'`.
  8. If repo present: iterate `commits`, call
     `lookupPrCountImpl({owner, repo, sha})` for each. Track `Set<number>`
     of accumulated PR numbers AND a flag `anyFailure: boolean`.
     `'ok'` and `'not-found'` are success (their `prNumbers` are merged;
     empty arrays contribute nothing). `'rate-limited' | 'unauthorized'
     | 'error'` set `anyFailure = true`.
  9. After the loop: `mergedPrCount = anyFailure ? null : prSet.size`.
     Pass through to `upsertOutcome`.
  - files: lib/ingest/git/evaluator.ts, lib/ingest/git/evaluator.test.ts
  - depends: TASK-1, TASK-2
  - tests: TC-I-11, TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-17, TC-I-18, TC-I-19, TC-I-20, TC-I-24, TC-I-25, TC-I-26
  - anti-regression (must continue passing): parent-spec
    `evaluator.test.ts` TCs covering REQ-1..7 of `outcome-integration-git.md`
    (TC-U-14..28, TC-I-01, TC-I-02, TC-I-15, TC-I-16). Verified by
    `pnpm test --run lib/ingest/git/evaluator.test.ts` after refactor.

- [x] **TASK-4** (Spec mãe Execution Log): append entry to
  `.specs/outcome-integration-git.md` Execution Log marking TASK-PR
  (v2 deferred) DONE, referencing this spec by name. Mechanical edit.
  - files: .specs/outcome-integration-git.md
  - depends: TASK-3
  - tests: (no TC — docs)

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]
   — TASK-1 (git-remote.{ts,test.ts}, exclusive)
   — TASK-2 (pr-lookup.{ts,test.ts}, exclusive)
   Files disjoint. No inter-deps. Both pure helper modules.

Batch 2: [TASK-3]
   — Evaluator integration. Depends on TASK-1 + TASK-2 exports.
   Modifies existing evaluator.ts + evaluator.test.ts (shared-mutative
   with parent spec's tests but the diff is purely additive).

Batch 3: [TASK-4]
   — Docs-only update to spec mãe Execution Log.
   Depends on TASK-3 (so the spec is materially DONE before we mark it).
```

File overlap analysis:

- `lib/ingest/git/git-remote.{ts,test.ts}` — exclusive to TASK-1 (NEW).
- `lib/ingest/git/pr-lookup.{ts,test.ts}` — exclusive to TASK-2 (NEW).
- `lib/ingest/git/evaluator.{ts,test.ts}` — shared-additive but
  exclusive to TASK-3 within this spec (no other task in this spec
  touches it). The "shared-additive" nature is vs the parent spec's
  TC-I-01..TC-I-16 — we ADD new TCs and MODIFY the UPSERT SQL +
  `upsertOutcome` signature; existing TCs continue passing.
- `.specs/outcome-integration-git.md` — exclusive to TASK-4.

Zero shared-mutative across parallel batches. Zero accumulator pattern
needed.

## Validation Criteria

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm test --run` passes (TC-U-01..14 + TC-I-01..23 + all parent
      spec TCs continue passing).
- [ ] `pnpm build` clean.
- [ ] **Live validation against real data** (the GENUINE test that
      `gh` integration works):
      1. `gh auth status` clean.
      2. `cd <a TokenFx-tracked repo>`.
      3. `TOKENFX_GH_PR_LOOKUP=1 pnpm ingest --force-outcomes`.
      4. `sqlite3 data/dashboard.db "SELECT session_id, commit_count,
         merged_pr_count FROM session_outcomes WHERE merged_pr_count IS
         NOT NULL LIMIT 5"` — expect non-null counts for sessions whose
         commits landed via merged PRs.
      5. Navigate to `/sessions/<id>` for one of those sessions —
         confirm the `<SessionOutcomePanel>` "Merged PRs" tile renders
         (was hidden before).
      Document in Execution Log.
- [ ] **Anti-regression (off path)**: with `TOKENFX_GH_PR_LOOKUP`
      unset, run `pnpm ingest --force-outcomes` and confirm
      `merged_pr_count IS NULL` for every row touched (parent spec
      TC-I-14 contract).
- [ ] **Anti-regression — explicit list of parent-spec TCs that MUST
      continue passing** (verified by `pnpm test --run lib/ingest/git/`):
      from `outcome-integration-git.md`:
  - TC-U-14 through TC-U-28 (numstat parser, reverts parser, evaluator
    pure helpers).
  - TC-I-01: evaluator writes a row on first run.
  - TC-I-02: evaluator UPSERTs (no duplicate row) on second run.
  - TC-I-15: cwd-missing → status row only, `merged_pr_count` stays NULL.
  - TC-I-16: cwd-is-symlink-to-repo → evaluation proceeds.
- [ ] **Privacy / no-console**: `pnpm lint` clean (catches `console.log`
      via `no-console` rule). `lib/ingest/git/pr-lookup.ts` and
      `lib/ingest/git/git-remote.ts` use `lib/logger.ts` exclusively.

## Open Questions

Nenhuma — todas as decisões locked acima em "Decisões já travadas".

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-2] (2026-05-06)

Parallel via 2 agents (no worktree — main tree, disjoint files).

- TASK-1 (`lib/ingest/git/git-remote.{ts,test.ts}`): `parseGitHubRemote` + `resolveGitHubRepo`. TDD RED → GREEN(15/15 — TC-U-01..10c + TC-I-08/09/10). 105 + 124 LOC. Two regex arms: SCP-style SSH and full URI form (HTTPS/ssh://) with optional userinfo for token-in-URL stripping. Hostname literal `github.com` enforced — defends against `https://github.com.evil.com/...`.
- TASK-2 (`lib/ingest/git/pr-lookup.{ts,test.ts}`): `lookupMergedPrCount` + `classifyGhResult` + `runGh`. TDD RED → GREEN(22/22 — TC-U-11..20 + TC-I-01..07 + TC-I-21/23). 253 + 507 LOC. DI seam adds `loggedReasons?: Set<string>` (test isolation, beyond spec). Sync `Result<T, never>` per REQ-8 lock. TC-U-17 fixture corrected to match REQ-3 regex (`HTTP 403.*not.*authorized`); fixture-level fix only, regex unchanged.

**Pre-existing failure detected** in `lib/ingest/git/evaluator.test.ts` (20/20 fail) — `better-sqlite3` ABI mismatch (Node 137 → 141 after Node 25.x upgrade). Fixed via `pnpm rebuild better-sqlite3` before Batch 2.

### Batch 2 [TASK-3] (2026-05-06)

Inline (single-task batch). Evaluator integration per spec's 9 numbered steps.

- `lib/ingest/git/evaluator.ts` (+95 LOC): `UPSERT_SQL` accepts `merged_pr_count` bind param + `ON CONFLICT SET merged_pr_count = excluded.merged_pr_count` (REQ-16); `upsertOutcome` row shape adds `mergedPrCount: number | null`; `writeStatusOnly` passes `mergedPrCount: null` (early-exit paths preserved); `EvaluateOptions` adds `lookupPrCountImpl?: LookupPrCountImpl` DI seam. New `computeMergedPrCount` helper orchestrates env-flag check (strict `=== '1'`), `resolveGitHubRepo`, per-commit lookup loop, dedup `Set<number>`, failure → null collapse.
- `lib/ingest/git/evaluator.test.ts` (+13 TCs): TC-I-11..20 + TC-I-24/25/26. Hand-written `makeLookupStub` (planned answer queue) + `addGithubRemote` helpers. ENV var manipulation via try/finally.
- Anti-regression: 20 existing TCs still pass.

### Batch 3 [TASK-4] (2026-05-06)

Inline (docs-only). Append entry to `.specs/outcome-integration-git.md` Execution Log marking TASK-PR (v2 deferred) as DONE; toggle TASK-PR checkbox `[ ]` → `[x]` in the parent spec's Tasks section.

Cumulative: typecheck clean, lint clean, **88 tests pass** in `lib/ingest/git/` (15 git-remote + 22 pr-lookup + 33 evaluator + 18 numstat/reverts/run-git unrelated). No regressions.
