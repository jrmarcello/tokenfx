# Spec: refactor-prepared-statements-evaluator

## Status: DONE (pending commit)

## Context

Code-reviewer flagged during `outcome-integration-git-v2-pr-lookup` self-review (2026-05-07): `lib/ingest/git/evaluator.ts:94` re-prepares the UPSERT SQL on every call, violating the project's "module-level or WeakMap-memoized prepared statements" convention (CLAUDE.md "Key Patterns" + `.claude/rules/security.md`).

**Audit (2026-05-07) revised the original spec scope** — original DRAFT named `evaluator-otel-reconcile` claiming three files, but verification shows:

- `lib/ingest/otel.ts` — **does not exist** (the OTEL parsing/scraping logic lives at `lib/ingest/otel/parser.ts` + writer functions in `lib/ingest/writer.ts`, both already correctly memoized).
- `lib/ingest/reconcile.ts` — **already uses WeakMap pattern** (`getPrepared(db)` at `reconcile.ts:117-126`). No change needed.

**Genuine remaining targets, ranked by impact:**

- **`lib/ingest/git/evaluator.ts:94`** (Impact: **High**) — called per session × per ingest sweep (50+ sessions/run × 4 code paths in evaluator.ts).
- `lib/ingest/writer.ts:561` (Impact: Low) — once per ingest run; AND has branching SQL (forceOutcomes ON/OFF → 2 distinct prepared statements needed).
- `lib/reporter/runner.ts:413` (Impact: Low) — once per push cycle.
- `lib/queries/calibration.ts:180,220,227,239` (Impact: Low) — once per ingest run.

**Decisões já travadas:**

- **Scope: only `evaluator.ts:94`**. The other three (`writer.ts:561`, `runner.ts:413`, `calibration.ts`) re-prepare ONCE per ingest/push cycle (not per session) — the cost is sub-millisecond total. **`writer.ts:561` additionally has branching SQL** (two distinct prepared statements depending on `forceOutcomes`) which makes a clean WeakMap hoist non-trivial — definitively defers it. **Tracked as a future cosmetic-cleanup spec** (`refactor-prepared-statements-remaining.md`) if convention drift surfaces them.
- **Pattern: WeakMap-by-DB cache + `function` declaration**, identical to `lib/ingest/reconcile.ts:117-126` (the closest neighbor in the same `lib/ingest/` layer). The codebase has split convention — `lib/queries/effectiveness.ts:420-450` uses `const = (db) => {...}`. We pick `function` to match the in-layer neighbor.
- **`Statement` import**: `import type { Statement } from 'better-sqlite3'` at the top of `evaluator.ts` (matching `reconcile.ts:1`). NOT inline `import('better-sqlite3').Statement<>` — the type appears twice (cache annotation + helper return), explicit import is cleaner.
- **Tuple type**: plain mutable tuple `[string, number, ...]` — NOT `readonly [...]`. The `@types/better-sqlite3` `Statement<BindParameters extends unknown[]>` rejects `readonly` tuples (`readonly T[]` not assignable to `T[]` under strict mode). Existing codebase uses plain tuples (`reconcile.ts:110` `Statement<[string]>`).
- **No behavioral change.** Existing 40 TCs in `evaluator.test.ts` (HEAD `f879688`) stay as-is. New TCs only assert the cache-reuse contract.
- **Module-level helper signature**: `function getUpsertOutcomeStmt(db: DB): Statement<[...]>` returning the cached prepared statement. Called by `upsertOutcome` (line 80) — replaces the inline `db.prepare(UPSERT_SQL).run(...)`.
- **Test isolation**: the module-level `WeakMap` is a singleton per Vitest worker. Each test creates a fresh `:memory:` DB (distinct object reference), so WeakMap entries don't leak between tests. `vi.resetModules()` is NOT needed and would break TC-U-01 by resetting the singleton mid-test.

## Requirements

- [ ] REQ-1: GIVEN `evaluator.ts:upsertOutcome` is called N times against the same `DB` instance, WHEN measured by counting `db.prepare(...)` calls whose SQL matches `/INSERT INTO session_outcomes/i`, THEN this count is exactly **1** (not N), regardless of N. The cache-miss branch fires once on the first call; the cache-hit branch fires for every subsequent call.
- [ ] REQ-2: GIVEN two distinct `DB` instances passed to `upsertOutcome`, WHEN each is invoked at least once, THEN each DB has its own prepared statement. Total `db.prepare(/INSERT INTO session_outcomes/i)` count across both DBs = exactly 2.
- [ ] REQ-3 (structural): The cache MUST be a `WeakMap<DB, Statement<...>>`, NOT a `Map<...>`. This guarantees DB instances are GC-eligible despite the module-level cache. **Verified by code inspection / static type check** — no runtime TC can force GC in Vitest.
- [ ] REQ-4: GIVEN the public function signature `upsertOutcome(db, row): void` and `writeStatusOnly(db, sessionId, status): void`, WHEN this refactor is applied, THEN both signatures are unchanged. Direct callers of `upsertOutcome` (lines 112 inside `writeStatusOnly`, line 426 inside `evaluateSessionOutcome`) and direct callers of `writeStatusOnly` (lines 354, 364, 375) need no edits. `getUpsertOutcomeStmt` is a module-private helper — NOT exported.
- [ ] REQ-5: GIVEN ALL existing tests for `evaluator` (40 TCs as of HEAD `f879688`), WHEN this refactor is implemented, THEN every TC continues to pass without modification. **Verified via Validation Criteria** (`pnpm test --run lib/ingest/git/evaluator.test.ts`), NOT a separate TC entry.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | infra | Hand-written counting wrapper (no `vi.spyOn`/`vi.mock` per project rule) installed AFTER `setupDb()` + `migrate(db)` + `insertSession(db, ...)` so migration prepares aren't counted; wrapper filters SQL with `/INSERT INTO session_outcomes/i` and increments a counter; call `evaluateSessionOutcome(db, session, opts)` 50× with fixture sessions that reach `upsertOutcome`. See Design "TC-U-01 wrapper sketch" below for the exact code. | `upsertPrepareCount === 1` exactly. First call exercises cache-miss branch; calls 2–50 exercise cache-hit branch. Both branches of `if (stmt === undefined)` exercised. |
| TC-U-02 | REQ-2 | infra | Two distinct DBs (`openDatabase(':memory:')` × 2), each with the counting wrapper installed; call `evaluateSessionOutcome` once on each. | Sum of `upsertPrepareCount` across both DBs = 2 (one per DB). Each DB instance keyed independently in the WeakMap. |
| TC-U-03 | REQ-3, REQ-4 | infra | Module-export shape assertion: `import * as evaluatorMod from './evaluator'`; assert `Object.keys(evaluatorMod)` does NOT contain `'getUpsertOutcomeStmt'` and does NOT contain `'upsertOutcomeStmtCache'`. REQ-3 (WeakMap, not Map) is enforced statically by the source file's type annotation — `pnpm typecheck` verifies the cache type. | `getUpsertOutcomeStmt` and the cache are module-private. Cache type is `WeakMap` (compile-time check). |

### Integration Tests

The 40 existing TCs in `evaluator.test.ts` ARE the integration regression suite — REQ-5 is verified by running them post-refactor. **No new integration TC is added** (TC-I-01 from the prior draft was removed: it described "run the existing test suite" which is a Validation Criteria gate, not a test scenario).

### Out-of-scope (explicitly NOT covered)

- `lib/ingest/writer.ts:561` (sweep query with branching SQL) — would need a 2-statement WeakMap value. Tracked for future spec.
- `lib/reporter/runner.ts:413` — once per push cycle. Tracked.
- `lib/queries/calibration.ts:180,220,227,239` — once per ingest run. Tracked.

## Design

### Architecture Decisions

- **WeakMap-by-DB cache**, identical pattern to `lib/ingest/reconcile.ts:117-126`. New code at the top of `evaluator.ts` (after the existing `import type { OutcomeStatus } from './types';` import block, before `UPSERT_SQL`):

  ```ts
  // Add to imports at top of file:
  import type { Statement } from 'better-sqlite3';
  ```

  Then immediately after `UPSERT_SQL` (current line 80), before `const upsertOutcome`:

  ```ts
  /** Tuple shape mirrors UPSERT_SQL's 9 positional args (REQ-1, REQ-3). */
  type UpsertParams = [
    string,           // session_id
    number,           // commit_count
    number,           // loc_added
    number,           // loc_removed
    number,           // files_changed
    number,           // reverts_within_7d
    number | null,    // merged_pr_count
    OutcomeStatus,    // status
    number,           // last_evaluated_at
  ];

  // Module-private cache. WeakMap (not Map) so DB GC eligibility is preserved.
  const upsertOutcomeStmtCache = new WeakMap<DB, Statement<UpsertParams>>();

  function getUpsertOutcomeStmt(db: DB): Statement<UpsertParams> {
    const existing = upsertOutcomeStmtCache.get(db);
    if (existing !== undefined) return existing;
    const prepared = db.prepare<UpsertParams>(UPSERT_SQL);
    upsertOutcomeStmtCache.set(db, prepared);
    return prepared;
  }
  ```

- **`upsertOutcome` body becomes**:

  ```ts
  const upsertOutcome = (db: DB, row: { ... }): void => {
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
  ```

  The 9 positional args match `UpsertParams` order. Existing arg order (line 96 onwards) is preserved.

- **TC-U-01 wrapper sketch** (used by TC-U-01 and TC-U-02; hand-written stub, no mocking framework):

  ```ts
  let upsertPrepareCount = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (/INSERT INTO session_outcomes/i.test(sql)) {
      upsertPrepareCount += 1;
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  // ... drive the test ...
  // restore (afterEach already closes the DB; no explicit restore needed
  // since the patched method is on the test-scoped DB instance only).
  ```

  Filter on the SQL string ensures only UPSERT prepares are counted — `migrate(db)` and `insertSession` prepare other statements that must NOT contaminate the count.

### Files to Modify

- `lib/ingest/git/evaluator.ts` — add `Statement` import + `UpsertParams` type + `upsertOutcomeStmtCache` WeakMap + `getUpsertOutcomeStmt(db)` helper. Replace the inline `db.prepare(UPSERT_SQL).run(...)` inside `upsertOutcome` (line 94) with `getUpsertOutcomeStmt(db).run(...)`. No other line in evaluator.ts is touched.
- `lib/ingest/git/evaluator.test.ts` — add TC-U-01, TC-U-02, TC-U-03. All other 40 TCs unchanged.

### Files to Create

None.

### Dependencies

None new. `WeakMap` is stdlib; `Statement` is from existing `better-sqlite3` dep.

## Tasks

- [x] TASK-1: Hoist `evaluator.ts:upsertOutcome` UPSERT prepare via WeakMap. RED (TC-U-01 fails before refactor — `upsertPrepareCount` will be 50 after 50 calls; TC-U-02 fails — count will be 2 + 49 = 51 across both DBs) → GREEN (count = 1 / total = 2 post-refactor). REVIEW: re-read REQ-1..5 + verify all 40 existing TCs unchanged. Run `pnpm typecheck` and `pnpm test --run lib/ingest/git/evaluator.test.ts`.
  - files: `lib/ingest/git/evaluator.ts`, `lib/ingest/git/evaluator.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03

## Parallel Batches

- Batch 1: [TASK-1] — single task.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run lib/ingest/git/evaluator.test.ts` passes (43 TCs total: 40 existing + 3 new)
- [ ] `pnpm test --run lib/ingest/git/` passes (no regression in pr-lookup or git-remote, ~109 TCs)
- [ ] **Optional benchmark** (informational, not gating): time `pnpm ingest --force-outcomes` before vs after on the user's real DB. Expected: small but measurable reduction in outcome-sweep wall time at 50+ sessions. Not blocking.

## Execution Log

### TASK-1 (2026-05-07 18:11)

TDD: RED (TC-U-01 observed `upsertPrepareCount === 50` before refactor — one prepare per call) → GREEN (count === 1 post-refactor; cache-miss on first call, cache-hit on calls 2-50). Added: `import type { Statement } from 'better-sqlite3'`, `UpsertParams` tuple, `upsertOutcomeStmtCache: WeakMap<DB, Statement<UpsertParams>>`, `function getUpsertOutcomeStmt(db: DB): Statement<UpsertParams>`. Replaced `db.prepare(UPSERT_SQL).run(...)` (line 95 pre-refactor) with `getUpsertOutcomeStmt(db).run(...)`. Public function signatures (`upsertOutcome`, `writeStatusOnly`) unchanged; helper + cache module-private (TC-U-03 verifies via `Object.keys(import('./evaluator'))`).

### Self-review iteration (2026-05-07 18:15)

3 reviewers in parallel (code + test + security). 0 CRITICAL/HIGH/MEDIUM/MUST FIX. SHOULD FIX/NICE TO HAVE applied inline:

- **`installPrepareCounter` cast comment** — added explanatory note for `as typeof target.prepare` (better-sqlite3 generic-overload covering signature can't be expressed; runtime delegates unchanged).
- **TC-U-02 `localRepo`** — replaced outer-`repo` mutation with a locally-scoped `setupTestRepo` + `localRepo.cleanup()` in `finally`. TC owns its lifecycle independently of `afterEach`.
- **TC-U-01/02 `Date.now()` capture** — single `const now = Date.now()` then reference for both `started_at`/`ended_at` (cleaner than two near-but-distinct calls).

**Pre-existing issue surfaced (out of scope):** `evaluator.test.ts:1040` (TC-I-13) uses `vi.spyOn(log, 'info')` — violates "no mocking framework" rule. Not introduced by this spec; flagged as future cleanup target.

Final: typecheck clean, lint clean, **109/109 in `lib/ingest/git/`** (40 evaluator anti-regression preserved + 3 new TCs = 43; pr-lookup 33; git-remote 15; helpers 18).
