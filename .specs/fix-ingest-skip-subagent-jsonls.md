# Spec: fix-ingest-skip-subagent-jsonls

## Status: DONE

## Context

Discovered while live-validating `outcome-integration-git-v2-pr-lookup` (2026-05-07): 21 of 71 sessions in the local DB show **temporal overlap** with another session in the same `cwd`. Investigation:

- `lib/fs-paths.ts:listTranscriptFiles` walks `~/.claude/projects/**` recursively → picks up `<sessionId>/subagents/agent-*.jsonl` files (one per `Agent`/`Task` invocation).
- Subagent JSONL events embed the **parent's `sessionId`** (not their own) — confirmed by reading raw JSONL: `agent-a1c90707f67946c54.jsonl` has `sessionId=c85182dc-…` (the parent ID).
- Each subagent file is parsed by `lib/ingest/writer.ts:ingestSingleFile` and UPSERTed into `sessions` with the parent's id → ON CONFLICT REPLACE semantics.
- **Net effect**: the `sessions` row's `started_at`, `ended_at`, `source_file` reflect whichever subagent file was processed LAST (alphabetical sort order), not the parent. The window `[started_at, ended_at]` becomes the **union** of parent + all subagents — possibly spanning days.
- `session_outcomes` is computed against this inflated window → `commit_count`, `loc_added`, `reverts_within_7d`, `merged_pr_count` (post-v2) are computed over a wider time range than the user's actual interactive session.

Concrete example (DB state 2026-05-07):

| session id  | source_file (final)                          | started_at       | ended_at         | duration   |
| ----------- | -------------------------------------------- | ---------------- | ---------------- | ---------- |
| `c85182dc`  | `…/subagents/agent-af235c051cdb70d1a.jsonl`  | 2026-04-23 11:59 | 2026-04-28 13:02 | **5 days** |
| `3a5edd86`  | `…/3a5edd86-….jsonl` (main)                  | 2026-04-27 16:25 | 2026-04-28 22:13 | 30h        |

Both sessions in the same `banking-service-yield` cwd → 1236-min overlap.

**Good news (verified)**: aggregate cost is NOT double-counted — `SUM(sessions.total_cost_usd) === SUM(turns.cost_usd)` ($34,937.97 either way) because `turns` table is union-by-unique-ID. The damage is restricted to the **session window** and any downstream metric computed against it.

**Decisões já travadas:**

- Subagent runs are billing detail of the parent, NOT a separate logical session in the dashboard sense.
- Filter `**/subagents/**` from `listTranscriptFiles` (single-line change, well-defined boundary).
- **Filter applied to the `candidate` path (pre-realpath)**, NOT to `real` (post-realpath). Reason: a symlinked `subagents/` directory pointing to a sibling without `subagents/` in its name would escape the filter if applied post-realpath. Pre-realpath check guarantees the naming-convention exclusion holds.
- **Filter implementation**: POSIX regex `/\/subagents\//` (this project is macOS/Linux-only; no Windows support implied). Idiomatic with the rest of `lib/fs-paths.ts` which uses POSIX paths throughout.
- **Cleanup script** uses `openDatabase()` from `lib/db/client.ts` (which sets `PRAGMA foreign_keys = ON`) and does **explicit ordered DELETEs** — same pattern as `scripts/seed-dev.ts`. Reason: relying on cascade alone is fragile if a future schema change drops the `ON DELETE CASCADE`; explicit ordering documents the dependency. Order: `session_outcomes`, `compaction_events`, `reporter_pushed_sessions`, `ratings`, `tool_calls`, `turns`, `sessions`, then `ingested_files`.
- **`ingested_files` MUST be cleared** in the same run. Otherwise stale mtime entries silently skip re-ingestion of parent JSONLs whose mtime didn't advance after the cleanup, leaving the DB in a partially-populated bad state. This is a silent data-loss bug that "looks correct" (no errors) — the most dangerous gap raised by the self-review.
- Re-ingest from clean state: after the script runs, user manually invokes `pnpm ingest` (no automatic chaining). Idempotent by design.
- Alternative considered/rejected: keep parsing subagent files but tag them so writer skips the `sessions` UPSERT for subagent-sourced events. Rejected because (a) the filter is simpler; (b) the cost loss is zero (subagents ride along the parent JSONL via `tool_use` messages, so all their cost is already in the parent's totals via the existing `turns` ON CONFLICT REPLACE).

**Out of scope:** the 2 sessions with `turn_count = 0` in `devtools-observability` (orphan/empty parent JSONLs — separate spec if it persists post-fix).

## Requirements

- [ ] REQ-1: GIVEN `~/.claude/projects/<proj>/<sessionId>/subagents/agent-XXX.jsonl` exists, WHEN `listTranscriptFiles()` is called, THEN the path is excluded from the returned list. The check uses a POSIX regex `/\/subagents\//` applied to the **candidate path** (pre-`realpathSync`), so symlinked `subagents/` directories are also excluded by the naming convention.
- [ ] REQ-2: GIVEN a JSONL outside any `subagents/` directory segment (parent `c85182dc.jsonl` directly under the project root), WHEN `listTranscriptFiles()` runs, THEN the path IS returned. Anti-regression for the pre-fix happy path.
- [ ] REQ-3: GIVEN a file literally named `subagents.jsonl` at the project root (no `subagents/` directory), WHEN `listTranscriptFiles()` runs, THEN the path IS returned. The filter is path-segment-based, NOT a naive substring match.
- [ ] REQ-4: GIVEN a path-traversal symlink inside `subagents/`, WHEN encountered, THEN behavior is unchanged from the existing `realpath`-based escape guard (still rejected). The `/subagents/` filter composes with the existing security guard.
- [ ] REQ-5: GIVEN existing rows in `sessions` and stale `ingested_files` entries inflated by subagent UPSERTs pre-fix, WHEN the migration script `scripts/cleanup-subagent-inflation.ts` runs, THEN it executes (in this order, in a single transaction): `DELETE FROM session_outcomes; DELETE FROM compaction_events; DELETE FROM reporter_pushed_sessions; DELETE FROM ratings; DELETE FROM tool_calls; DELETE FROM turns; DELETE FROM sessions; DELETE FROM ingested_files;` and exits 0. User then runs `pnpm ingest` to rebuild.
- [ ] REQ-6: GIVEN the cleanup script with `--dry-run`, WHEN invoked, THEN it logs counts of rows that WOULD be deleted (one count per table) but performs no DELETE. Exits 0. Argument parsing: `process.argv.slice(2).includes('--dry-run')` (no external CLI library — same idiom as `scripts/ingest.ts` / `scripts/seed-dev.ts`).
- [ ] REQ-7: GIVEN the cleanup script run against an empty DB (0 sessions), WHEN invoked (with or without `--dry-run`), THEN it exits 0 and logs "0 rows deleted" / "0 rows would be deleted" per table. Idempotent on empty state.
- [ ] REQ-8: GIVEN the cleanup script run with a `DASHBOARD_DB_PATH` env var pointing to a non-existent file, WHEN invoked, THEN the script either creates an empty DB at that path (running `migrate` to ensure schema) and exits 0 with "0 rows" output (consistent with REQ-7), OR throws a clear human-readable error before any DELETE. The behavior MUST be one of these two — never a raw stack trace from `better-sqlite3`. Decision: use `openDatabase` + `migrate` (creates empty DB if missing — same as `seed-dev.ts`).
- [ ] REQ-9: GIVEN the cleanup script, WHEN it logs, THEN it uses `log.info` / `log.error` from `lib/logger.ts` (NOT `console.log`). Same convention as existing `scripts/ingest.ts` and `scripts/seed-dev.ts`.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1, REQ-2 | happy | `listTranscriptFiles` over a tmp tree with `parent.jsonl` + `subagents/agent-1.jsonl` + `subagents/agent-2.jsonl` | returns only `[parent.jsonl]` (the two subagent paths excluded) |
| TC-U-02 | REQ-1 | edge | Path with `subagents` as a directory deep in the tree (`<proj>/<sessionId>/foo/subagents/agent.jsonl`) | excluded — segment match fires regardless of nesting depth |
| TC-U-03 | REQ-3 | edge | Fixture has BOTH `<root>/subagents.jsonl` (file at root, NOT in a directory) AND `<root>/subagents/agent.jsonl` (real subagent file in directory) | result includes `subagents.jsonl`, excludes `subagents/agent.jsonl`. This setup makes the test impossible to pass with a naive `path.includes('subagents')` filter |
| TC-U-04 | REQ-2 | happy | Tree with only `<sessionId>.jsonl` files, no `subagents/` directories | every file returned |
| TC-U-05 | REQ-4 | security | Symlink inside `subagents/` pointing OUTSIDE the projects root | excluded by EITHER filter (subagents OR realpath escape guard) — assert that it doesn't appear in result |
| TC-U-06 | REQ-1, REQ-4 | security | Symlink at `subagents/link.jsonl` pointing to `subagents/real.jsonl` (target ALSO inside subagents/, inside root) | excluded — segment match fires on the candidate path; this confirms the filter is on `candidate` (pre-realpath), since post-realpath the resolved target still has `subagents/` but the safety net should also trip on the candidate level |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `ingestAll()` against fixture: parent `S1.jsonl` with events at timestamps T1=1700000000000..T2=1700000600000 (10min window) + 3 subagent files `S1/subagents/agent-{a,b,c}.jsonl` with events at T3=1690000000000 (way before parent) | 1 row in `sessions` for S1, **`started_at === T1` AND `ended_at === T2`** (window matches parent ONLY, NOT the union with T3). This assertion would FAIL with the pre-fix behavior |
| TC-I-02 | REQ-1, REQ-2 | business | `ingestAll()` against tree with 2 parent JSONLs S1 + S2 (different cwds, distinct sessionIds) and S1 has subagents with timestamps outside S1's window | 2 rows in `sessions`, each with `started_at`/`ended_at` matching ITS own parent's events only, not inflated |
| TC-I-03 | REQ-5 | happy | Cleanup script against a seeded DB with 5 sessions + 3 ratings + 2 reporter_pushed_sessions rows + 100 turns + 50 tool_calls + ingested_files entries | All listed tables empty after run; exit code 0; logs row counts deleted per table |
| TC-I-04 | REQ-6 | validation | `--dry-run` against same seeded DB | logs "X rows would be deleted" per table, row counts in DB unchanged, exit 0 |
| TC-I-05 | REQ-7 | idempotency | Run cleanup against an empty DB (post-`migrate`, no rows) | exits 0; logs "0 rows" per table; no exception |
| TC-I-06 | REQ-8 | infra | Run cleanup with `DASHBOARD_DB_PATH=/tmp/nonexistent-cleanup-test-${TIMESTAMP}.db` | DB created at path with empty schema (via `migrate`); behavior matches TC-I-05; exit 0 |
| TC-I-07 | REQ-5 | regression | After cleanup, run `ingestAll({ db, root: fixturePath })` (in-process, NOT subprocess) over a fixture that originally caused inflation | Sessions recreated with windows reflecting parent only; `ingested_files` repopulated; no orphans in any child table |
| TC-I-08 | REQ-9 | infra | Spy on `console.log` and `console.error` while running the cleanup script | spy never called; all output went through `lib/logger.ts` |

### Live Validation

- After implementation, run on the user's actual DB (`./data/dashboard.db`):

  ```bash
  pnpm tsx scripts/cleanup-subagent-inflation.ts --dry-run   # confirm counts look reasonable
  pnpm tsx scripts/cleanup-subagent-inflation.ts             # actual cleanup
  pnpm ingest                                                 # rebuild from JSONLs
  ```

- Then SQL: `SELECT id, source_file, started_at, ended_at FROM sessions WHERE source_file LIKE '%/subagents/%'` returns **0 rows** (was N>0 pre-fix).
- And: previously-inflated session `c85182dc` now has `(ended_at - started_at) / 60000.0 < 1440` minutes (< 1 day; was 7262 min / 5 days pre-fix).

## Design

### Architecture Decisions

- **Filter location**: inside `listTranscriptFiles`, applied to the `candidate` path (line 75 of current `lib/fs-paths.ts`, BEFORE `realpathSync`). Reasoning: applying post-realpath would let symlinked `subagents/` directories pointing outside the named-`subagents` tree escape the convention. Pre-realpath enforces the directory-name convention strictly.

- **Filter implementation** (concrete sketch):

  ```ts
  // After: const candidate = path.resolve(parent, entry.name);
  // Skip subagent JSONLs — they share the parent session's ID and
  // would inflate session windows on UPSERT (see fix-ingest-skip-subagent-jsonls).
  if (/\/subagents\//.test(candidate)) continue;
  // ... existing realpathSync + escape guard ...
  ```

- **Cleanup script**: `scripts/cleanup-subagent-inflation.ts`. Uses `openDatabase()` (sets `PRAGMA foreign_keys = ON`) + `migrate()` (ensures schema) — same entry-point pattern as `scripts/seed-dev.ts`. Argument parsing: `const dryRun = process.argv.slice(2).includes('--dry-run')`. Logging: `import { log } from '@/lib/logger'`; calls `log.info` for normal output, `log.error` for failures. **Explicit ordered DELETEs in a single transaction** (NOT relying on FK cascade alone — cascade still fires as a safety net since FKs are ON, but ordering documents the dependency and survives schema evolution):

  ```ts
  const TABLES_IN_DEPENDENCY_ORDER = [
    'session_outcomes',
    'compaction_events',
    'reporter_pushed_sessions',
    'ratings',
    'tool_calls',
    'turns',
    'sessions',
    'ingested_files', // NOT FK-linked but must be cleared to allow re-ingest
  ] as const;
  ```

### Files to Create

- `scripts/cleanup-subagent-inflation.ts` — REQ-5..9.
- `scripts/cleanup-subagent-inflation.test.ts` — TC-I-03..08 (colocated per project convention `foo.ts` + `foo.test.ts`).

### Files to Modify

- `lib/fs-paths.ts` — add subagent-path filter.
- `lib/fs-paths.test.ts` — add TC-U-01..06 to the existing describe block (extend, don't fork).
- `lib/ingest/writer.test.ts` — add TC-I-01, TC-I-02 to the existing describe block (extend, don't create `writer.subagents.test.ts` — colocation convention).
- `lib/ingest/writer.test.ts` — also add TC-I-07 (post-cleanup re-ingest) to confirm the end-to-end loop.

### Dependencies

None new. `path`, `fs`, `node:path`, `process` are stdlib.

## Tasks

- [x] TASK-1: Add `subagents/` filter to `listTranscriptFiles`. RED (write 6 unit TCs first) → GREEN.
  - files: `lib/fs-paths.ts`, `lib/fs-paths.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06

- [x] TASK-2: Integration tests in `lib/ingest/writer.test.ts` for end-to-end no-inflation behavior.
  - files: `lib/ingest/writer.test.ts`
  - tests: TC-I-01, TC-I-02
  - depends: TASK-1

- [x] TASK-3: Cleanup script + colocated integration test.
  - files: `scripts/cleanup-subagent-inflation.ts`, `scripts/cleanup-subagent-inflation.test.ts`
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-08

- [x] TASK-4: Post-cleanup-then-reingest end-to-end test (separate from TASK-2 because it composes TASK-1's filter with TASK-3's script).
  - files: `lib/ingest/writer.test.ts`
  - tests: TC-I-07
  - depends: TASK-1, TASK-3

## Parallel Batches

- Batch 1: [TASK-1] — foundation (filter)
- Batch 2: [TASK-2, TASK-3] — parallel (TASK-2 extends `lib/ingest/writer.test.ts`, TASK-3 creates new files in `scripts/`; no shared files)
- Batch 3: [TASK-4] — sequential (depends on both TASK-1 + TASK-3, extends `lib/ingest/writer.test.ts` which TASK-2 also touched → shared-mutative, must serialize after TASK-2)

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (all 14 new TCs + anti-regression on existing fs-paths/writer tests)
- [ ] **Live validation**: run cleanup script with `--dry-run` on real DB; verify counts plausible. Run cleanup; run `pnpm ingest`. SQL verification:
  - `SELECT COUNT(*) FROM sessions WHERE source_file LIKE '%/subagents/%'` returns 0
  - Session `c85182dc-09c5-4a80-a347-57766b2e2a8c` has `(ended_at - started_at) / 60000.0` ≪ 1440 min
  - `SELECT COUNT(*) FROM ingested_files` is non-zero (re-populated by re-ingest)
  - `SUM(turns.cost_usd) === SUM(sessions.total_cost_usd)` (cost integrity preserved)

## Execution Log

### TASK-1 (2026-05-07 16:48)

TDD: RED(4/6 new TCs fail before filter) → GREEN(24/24 pass after filter on candidate path) — added POSIX regex `/\/subagents\//` check in `listTranscriptFiles` BEFORE `realpathSync` (per spec decision: pre-realpath enforces naming convention even for symlinked subagents/).

### Batch 2 [TASK-2, TASK-3] (2026-05-07 17:05)

Parallel via worktrees. Both worktrees were on stale base commit `90e949f` (lacked `session_outcomes`/`compaction_events`/`reporter_pushed_sessions` schema); merge resolution was selective:

- TASK-2: cherry-picked the new fixture builders (`buildUserEvent`/`buildAssistantEvent`/`buildSubagentInflationJsonl`) + 2 new TCs from worktree, applied on top of HEAD's `lib/ingest/writer.test.ts` (preserving the pre-existing 17 TCs intact). Direct `cp` would have regressed `compactionEvents` field on the `makeSession` helper.
- TASK-3: agent wrote directly to main tree (worktree was missing schema tables required by the cleanup TCs). 5 TCs colocated at `scripts/cleanup-subagent-inflation.test.ts`.
- TDD: RED (writer-tc01: filesProcessed=4, expected=1, with filter commented; cleanup-script: import failure before module existed) → GREEN (writer.test.ts 19/19, cleanup tests 5/5).
- Worktrees cleaned up per directive 7.

Combined Batch 1+2 result: `lib/fs-paths.test.ts` 24/24 + `lib/ingest/writer.test.ts` 19/19 + `scripts/cleanup-subagent-inflation.test.ts` 5/5 = 48/48.

### TASK-4 (2026-05-07 17:07)

TDD: GREEN on first run (20/20 in writer.test.ts) — TC-I-07 composes TASK-1's filter with TASK-3's script via dynamic `import('@/scripts/cleanup-subagent-inflation')`. Asserts: (a) initial ingest populates ingested_files, (b) cleanup wipes all 8 tables to 0, (c) re-ingest re-populates with windows reflecting parents only (`started_at === T1`, `ended_at === T2`), (d) zero orphan turns post-reingest.

### Self-review iteration (2026-05-07 17:15)

3 reviewers in parallel (code + test + security). Aggregated MUST FIX + most-load-bearing SHOULD FIX applied inline:

- **TC-I-08 was vacuous** (spied on `console.log`/`console.error` but `log.info` routes to `console.info`). Replaced `vi.spyOn` (mocking-framework violation) with hand-written stub that swaps all 5 `console.*` methods, asserts `console.info > 0` (proves logger was used) AND `console.log/warn/error/debug === 0` (proves no raw drift).
- **CLI default-safe**: `main()` now defaults to dry-run unless `--yes` is passed; before any DELETE, the SQLite file is copied to `<dbPath>.pre-cleanup-<epochMs>.bak`. `--dry-run` still accepted for parity. The pure `cleanupSubagentInflation()` API is unchanged — gating lives only in the CLI guard. Security-reviewer MEDIUM addressed.
- **Comment on table-allowlist invariant** added to clarify the safe-by-construction interpolation (security.md prepared-statement rule applies to user-controlled values, not typed const tuples).
- **TC-I-07 tightened** `expect(ingestedBefore).toBe(1)` (was `> 0`). Catches a future filter regression that ingests subagent files alongside the parent.
- **TC-IDs moved to comments** for the 6+4 new TCs added by this spec; `it()` strings now natural English. Pre-existing TC-ID-named tests (TC-U-01..07 in `claudeProjectsRoot`/`resolveWithinClaudeProjects` describe blocks) untouched — out of scope for this spec.

Final result: typecheck clean, lint clean, `lib/fs-paths.test.ts` 24/24 + `lib/ingest/writer.test.ts` 20/20 + `scripts/cleanup-subagent-inflation.test.ts` 5/5 = **49/49**.
