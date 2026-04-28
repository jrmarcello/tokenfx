---
applies-to: ".specs/**"
---

# SDD Spec Rules

## Execution Flow (review-then-execute-then-review)

The SDD workflow follows a 7-step flow with **TWO mandatory user-approval pauses**. NEVER use Stop-hook iteration (no `.active.md`); the whole spec executes in one session.

1. **Cria spec** — `/spec` ou manual via `.specs/TEMPLATE.md`. Status: DRAFT.
2. **Self-review da spec** — apply fixes for gaps, bugs, ambiguity, missing TCs, best-way-possible, convenção do projeto. Inline; present "findings resolved" note.
3. **PAUSE 1 — Apresenta spec revisada com pontos de atenção; AGUARDA aprovação do usuário.** On approval, status → APPROVED.
4. **Executa spec inteira** (`/ralph-loop` ou manual) — paralelizando batches via worktree-isolated agents num único tool message; merge + cleanup após cada batch. Status → IN_PROGRESS.
5. **Self-review da implementação** — REQ-by-REQ (`✅/🟡/❌` com `file:line` + test name + SQL fragment); best-way-possible per REQ; live validation contra dados reais quando spec tem efeitos visíveis (dev server + curl + SQL).
6. **PAUSE 2 — Apresenta resultado liderando com live validation; AGUARDA review do usuário.** Surface partial REQs, never hide.
7. **Commit APENAS após aprovação explícita do usuário.** NÃO auto-commit. Status → DONE pós-commit.

**Hard rules** (the user should NEVER need to ask "you committed already?"):

- No commit antes da PAUSE 2 ter sido confirmada pelo usuário
- No `.active.md` file (Stop hook iteration está desabilitada)
- No "I'll commit and you can review" — commit é o último passo, não o primeiro
- No saltar dos checkpoints (steps 2, 5a, 5b) — todos obrigatórios

## Spec File Integrity

- Never modify the Requirements section during execution (only during DRAFT status)
- Never remove tasks — mark them as `[x]` (done) or `BLOCKED`
- Always append to Execution Log, never overwrite previous entries
- Status transitions: DRAFT -> APPROVED -> IN_PROGRESS -> DONE | FAILED

## Task Execution

- Each task must be independently verifiable (`pnpm typecheck` should pass after each task)
- Tasks are organized by feature/domain, not by layer
- Order tasks logically for the feature
- If a task is unclear, mark it `BLOCKED` with a reason and stop execution
- **Mandatory review before testing**: after implementing a task, re-read the task description and verify ALL specified files, patterns, and behaviors were implemented. Check: all files listed in `files:` metadata were created/modified, all patterns from the Design section are followed, all error handling is complete, no implementation gap vs the spec. Only then proceed to tests. This is NEVER skipped.

## Task Metadata

- Every task MUST have a `files:` sub-item listing files it creates or modifies
- Tasks with dependencies MUST have a `depends:` sub-item listing prerequisite TASK-N IDs
- `depends:` must form a DAG (no circular dependencies)
- Tasks that share files in their `files:` lists cannot be in the same parallel batch
- Tasks with testable code MUST have a `tests:` sub-item listing TC-IDs from the Test Plan (triggers TDD cycle in ralph-loop)

## Test Plan

Every spec MUST include a `## Test Plan` section between Requirements and Design. The Test Plan contains tables grouped by layer:

- **Unit Tests** (TC-U-NN): pure functions, parsers, scoring, pricing, value transforms
- **Integration Tests** (TC-I-NN): DB writer, queries, API routes with real SQLite
- **E2E Tests** (TC-E2E-NN): Playwright against a running Next.js app

Each TC row has: `| TC-ID | REQ | Category | Description | Expected |`

Categories: `happy`, `validation`, `business`, `edge`, `infra`, `idempotency`, `security`

For non-code specs (config/docs only), the Test Plan may be `N/A` with a justification.

### Coverage Rules

Every spec MUST satisfy all of the following:

- Every REQ has >= 1 TC (at minimum the happy path)
- Every typed error surfaced by a module has >= 1 TC that triggers it
- Every validated field (Zod schema) has boundary TCs: valid min, valid max, invalid min-1, invalid max+1
- Every external dependency call (filesystem read, HTTP fetch, DB write) has >= 1 infra-failure TC
- Every conditional branch in a function has TCs for both paths
- Every new API route / Server Action has integration TCs: happy path (status + response shape), each distinct error status, field boundaries, idempotency
- **Rigor check**: error/edge TCs should outnumber happy-path TCs — review the complete Test Plan and verify no business rule untested, no error path missing, no boundary unchecked

### Mutability

- TCs may be **added** during IN_PROGRESS (new edge cases discovered during implementation)
- TCs may NEVER be **removed** — if a TC is no longer applicable, mark it as `SKIPPED` with a reason
- REQ references in TCs must remain valid

### E2E Tests (Playwright)

- TC-E2E-* are validated by running `pnpm test:e2e`
- E2E tests are executed by `TASK-SMOKE` — a dedicated task at the end of the spec
- E2E tests do NOT follow the TDD RED/GREEN cycle (they are executed directly)
- If the app is not running, log `E2E: DEFERRED` in the Execution Log
- E2E file convention: `tests/e2e/<feature>.spec.ts`

## TDD Execution

When a task has `tests:` metadata, the ralph-loop follows the TDD cycle:

### RED Phase

1. Write the test file FIRST (before the production code)
2. Tests reference the function/type that will be implemented
3. Run `pnpm test --run <file>` — tests MUST fail (compile/import failure counts as valid RED)
4. If tests pass before implementation: the test is not testing the right thing — fix it

### GREEN Phase

1. Write the MINIMUM production code to make tests pass
2. Follow existing patterns: hand-written stubs colocated in the test file, table-driven cases
3. Run `pnpm test --run <file>` — all tests listed in `tests:` MUST pass
4. If other tests break: fix immediately before proceeding

### REFACTOR Phase

1. Clean up production code: remove duplication, improve naming, extract helpers
2. Run `pnpm test --run` again — all tests MUST still pass
3. Run `pnpm typecheck` — must compile cleanly

### Execution Log Format

When a task follows TDD, the Execution Log entry includes:

```text
TDD: RED(N failing) -> GREEN(N passing) -> REFACTOR(clean)
```

### Exceptions

- **E2E tests** (TC-E2E-*): executed directly via Playwright, not via TDD cycle
- **Non-code tasks** (docs, config): no TDD — normal execution
- **Tasks without `tests:` metadata**: normal execution (no TDD cycle required)

## Parallel Batches

- The Parallel Batches section is auto-generated by `/spec` based on dependency and file analysis
- Batches are sequential: Batch N+1 starts only after all tasks in Batch N complete
- Tasks within a batch are independent: no shared files, no inter-dependencies
- Shared files are classified as:
  - **exclusive** — only one task touches it (safe for parallel)
  - **shared-additive** — multiple tasks add to it (candidate for sequential batches)
  - **shared-mutative** — multiple tasks modify existing code (must serialize)

## Merge Strategy

When parallel tasks share additive files (e.g. `app/layout.tsx` shell vs content):

- Prefer sequencing additive edits across batches rather than concurrent edits within a batch
- If unavoidable, each parallel task emits a fragment under `.specs/fragments/` and a dedicated merge task applies them sequentially
- Shared-mutative files always serialize — never run in parallel

## Naming

- Spec files: lowercase, hyphen-separated: `dashboard-mvp.md`, `effectiveness-scoring.md`
- No active-state files (`.active.md`) — the current flow runs in single session without Stop-hook iteration

## Discipline Checkpoints (non-negotiable)

Three checkpoints gate the "done" of any spec. Skipping any is a regression — the user should never have to ask "você validou?" nor "you committed already?".

### Checkpoint 1 — Self-review against the spec (REQ-by-REQ)

After the last task is marked `[x]` and before reporting:

- Walk **every REQ** in the Requirements section and confirm it is satisfied by concrete evidence (`file:line`, test name, SQL fragment). Build an internal `REQ-1..N` checklist with `✅ / 🟡 partial / ❌ blocked` status.
- For each partial/blocked REQ, surface it in the final report — never hide it behind "tests pass".
- **Best-way-possible check**: for each REQ, ask "was this implemented the best way?" — right primitive (Server Action vs API route, SQL aggregation vs JS loop), no duplicated logic, reuses existing helpers, follows project conventions (named exports, Zod at boundaries, prepared statements, Result pattern, colocated tests). "Works" is not the bar — "works + would survive code review" is.
- Re-check every `decisões já travadas` / `decisions locked` entry in the Context: each must have a corresponding code artifact.
- Re-check every task's REVIEW step was genuinely executed (all `files:` touched, patterns from Design followed, no implementation gap).
- If the self-review surfaces any gap, fix it before moving to Checkpoint 2.

### Checkpoint 2 — Live validation with real data (when applicable)

If the spec has user-visible effects (UI changes, new queries, new metrics, CLI scripts, migrations), validate against a **real** environment — not just test fixtures:

- Start the dev server in background (`pnpm dev`) and curl the affected routes — confirm HTTP 200 and that expected aria-labels / headings / data-attributes / badges appear in the HTML (grep the response body).
- For CLI tools (`pnpm ingest`, `pnpm recompute-costs`, `pnpm seed-dev`), run against the live DB and inspect both the CLI output and raw SQL (`sqlite3 data/dashboard.db "SELECT ..."`) — values must match across layers.
- For new UI states (badges, empty states, divergence hints), trigger the state via seed data or by hand and confirm via HTML grep.
- For E2E tests that were flaky in the batch run (port collisions, timing), re-run in isolation to confirm they actually pass.
- Stop the dev server when done. A `SIGTERM (exit 143)` from explicitly killing the server is expected — mention it so the user doesn't think something crashed.

Skip Checkpoint 2 **only** when the spec is truly internal (pure refactor, no observable behavior change) — and say so explicitly in the report.

### Reporting discipline

- **Lead** with what was validated against real data, not with "tests pass". Example: "Spend 30d: \$9,749 (list) → \$1,956 (calibrated), ratio 0.20 — matches Max plan".
- Include a table of REQs with status (✅ / 🟡 / ❌). That table is the proof Checkpoint 1 happened.
- List new tests and the delta (`399 → 429, +30`).
- Partial items get explicit "follow-up" notes — never swept under the rug.

### Checkpoint 3 — MANDATORY PAUSE for user review (no commit yet)

After Checkpoints 1 + 2 are clean and the report is composed:

- **STOP**. Present the report to the user. Status remains `IN_PROGRESS` (NOT `DONE` yet).
- **AGUARDA explicit user feedback or approval to commit.** No auto-commit. No "I committed and here's what changed" — commit is the user's decision, not the agent's.
- If the user requests changes, apply them, re-run the relevant validation, present again, wait again.
- Only after the user explicitly approves AND requests/permits commit: stage + commit (per `feedback_commit_style` — no Co-Authored-By trailer), set status `DONE`, update Execution Log with the commit SHA.

**Why this checkpoint exists**: the user explicitly defined the SDD flow with a pause before commit (2026-04-28). Auto-committing after a green pipeline removes the user's review opportunity and conflates "code works" with "code is what the user wanted to ship".
