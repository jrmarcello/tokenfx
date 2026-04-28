---
name: ralph-loop
description: Single-session SDD spec execution with worktree-based parallel batches, mandatory user-review pause before commit
argument-hint: "<spec-file-path>"
user-invocable: true
---

# /ralph-loop <spec-file>

Executes an APPROVED SDD spec end-to-end **in a single session** using worktree-based parallel batches. Self-reviews after the last task. **PAUSES** for the user to review before any commit. **Never auto-commits.**

This skill assumes the spec's Steps 1-3 (create + self-review + user approval) already happened — see `.claude/rules/sdd.md` "Execution Flow". The skill handles Steps 4-5 (execute + self-review) and pauses at Step 6 (user review). Step 7 (commit) only happens after the user explicitly approves.

## Example

```text
/ralph-loop .specs/effectiveness-personal-v2.md
```

## Flow (what this skill does)

```text
INPUT: spec status = APPROVED
  │
  ├── Set status → IN_PROGRESS
  │
  ├── Step 4: Execute all batches in order
  │     │
  │     └── Per batch:
  │           ├── 1 task    → Execute directly (TDD cycle if `tests:` present)
  │           └── 2+ tasks  → Parallel agents in worktrees (single tool message);
  │                            merge worktrees + cleanup MANUALLY after batch.
  │
  ├── Step 5: Self-review
  │     ├── Checkpoint 1: REQ-by-REQ checklist with concrete evidence
  │     ├── Checkpoint 2: live validation with real data (when applicable)
  │     └── Best-way-possible per REQ
  │
  └── Step 6: MANDATORY PAUSE — present results, wait for user review.
        Status remains IN_PROGRESS. NO commit yet.

OUTPUT: report to user; await review. Step 7 (commit) is user-driven.
```

## Startup

1. Read the spec file path from argument.
2. Validate the spec exists and has status `APPROVED` or `IN_PROGRESS`.
3. **Do NOT create `.active.md`** — Stop-hook iteration is disabled in this flow.
4. Set status to `IN_PROGRESS` if currently `APPROVED`.
5. Read the **Parallel Batches** section to determine execution order. Sequential fallback if absent.
6. Read each task's `files:`, `depends:`, `tests:` metadata.

## Parallel Batch Execution

Per batch:

```text
batch tasks count
  │
  ├── 1 uncompleted task     → Execute directly in main session
  │
  └── 2+ uncompleted tasks
        │
        ├── All files exclusive  → Launch parallel agents (worktrees)
        │
        └── Shared files exist   → Sequential within batch
```

### How to parallelize

1. For each task in the batch, launch an `Agent` call with `isolation: "worktree"`. **ALL Agent calls in a SINGLE tool message** — that's what produces real parallelism.
2. Wait for all agents to complete.
3. Each agent returns a worktree path (if changes were made) plus a report.
4. Merge worktrees sequentially into main: `cp -R <worktreePath>/<changed-files> .` (or use targeted file copies based on the agent's report).
5. **Cleanup worktrees MANUALLY** after each merge — the runtime does NOT auto-cleanup when the agent made changes:

   ```bash
   git worktree remove <worktreePath> --force
   git worktree prune
   ```

   Orphan worktrees pile up fast and break IDE tooling.

6. After merging the batch, run `pnpm typecheck && pnpm test --run` against main to verify.
7. Mark all completed tasks `[x]` in the spec; append a single Execution Log entry for the batch.

### Agent prompt template

Each parallel agent receives a self-contained prompt with:

- **Task**: full task description from spec (verbatim).
- **Files**: the `files:` metadata — only these may be created/modified.
- **Test Plan**: the TC-IDs from `tests:` with each TC's full row from the Test Plan table.
- **TDD Cycle**: if `tests:` present, follow RED → GREEN → REFACTOR.
- **Conventions**: TS strict, Result pattern at boundaries, Zod at boundaries, named exports, prepared statements, hand-written stubs colocated in `*.test.ts` (no mocking framework), table-driven tests.
- **REVIEW step**: "Re-read the Task and Files sections before reporting. Verify all files created/modified, all patterns followed, all error mappings complete. This is mandatory."
- **Report format**: files changed, TDD result, deviations + justification, open questions, worktree path.

### When NOT to parallelize

- Tasks share **mutative** files (both modify existing code in the same file).
- Worktree isolation is unavailable.
- Tasks are trivial (< 1 minute each) — overhead outweighs benefit.
- Fewer than 2 tasks in the batch.

## TDD Cycle (per task with `tests:` metadata)

**RED:**

1. Write test file FIRST (`foo.test.ts` next to `foo.ts`).
2. Tests reference the symbol/type to be implemented.
3. `pnpm test --run <file>` MUST fail (compile/import failure counts).

**GREEN:**

1. Minimum production code to make tests pass.
2. Hand-written stubs colocated in the test file. Table-driven cases.
3. `pnpm test --run <file>` — all listed TCs pass.
4. Other tests breaking → fix immediately.

**REFACTOR:**

1. Clean up: dedupe, rename, extract.
2. `pnpm test --run` + `pnpm typecheck` — must pass.

Tasks without `tests:` execute normally (verify `pnpm typecheck`).

## After Last Task — Self-Review (Checkpoints 1 + 2)

**Do NOT rush to report. NEVER commit before the pause.** Walk these in order:

### Checkpoint 1 — REQ-by-REQ

- Walk every REQ in the spec's Requirements section.
- For each: cite concrete evidence (`file:line`, test name, SQL fragment).
- Status: `✅ full` / `🟡 partial` / `❌ blocked`.
- **Best-way-possible per REQ**: right primitive (Server Action vs API route, SQL aggregation vs JS loop), no duplicated logic, reuses existing helpers, follows project conventions (named exports, Zod at boundaries, prepared statements, Result pattern). "Works" is not the bar — "works + would survive a review" is.
- Re-check every `decisões já travadas` / `decisions locked` entry has a corresponding code artifact.
- Re-check each task's REVIEW step was genuinely executed (`files:` touched, patterns followed, no implementation gap).
- If gaps surface → fix them, re-test, then proceed.

### Checkpoint 2 — Live validation with real data (when applicable)

If the spec has user-visible effects (UI, queries, metrics, CLI, migration):

- `pnpm dev` in background; curl affected routes; grep HTML for expected aria-labels / headings / data-attributes / badges.
- For CLI tools: run against the live DB; cross-check raw SQL (`sqlite3 data/dashboard.db "SELECT ..."`).
- For new UI states (badges, empty states, divergence hints): trigger via seed and confirm via HTML grep.
- Stop the dev server when done. `SIGTERM (exit 143)` is expected — say so explicitly.

Skip only when the spec is truly internal (pure refactor, no observable behavior change) — and say so explicitly in the report.

### Reporting (preparing for the pause)

- **Lead** with what was validated against real data, not "tests pass". Example: "30d spend: \$9,749 list → \$1,956 calibrated, 5× closer to actual Max usage."
- REQ table with status (✅ / 🟡 / ❌) — the proof Checkpoint 1 happened.
- New tests and delta (`399 → 429, +30`).
- Any `[SIGTERM]` exit codes from dev-server kills explained.
- Partial REQs flagged with explicit "follow-up" notes — never hidden.

## Checkpoint 3 — MANDATORY PAUSE for user review

**STOP HERE.** Present the report and **wait for explicit user feedback**.

- Status remains `IN_PROGRESS` (NOT `DONE`).
- **NO commit. NO `git add`. NO staging.** The user reviews the diff in their IDE / via `git diff`.
- If the user asks for changes, apply them, re-run the relevant validation, present again, wait again.
- Only after the user explicitly approves AND requests/permits commit:
  1. Stage + commit per `feedback_commit_style` (no Co-Authored-By trailer).
  2. Set spec status → `DONE`.
  3. Append the commit SHA to the Execution Log.

**Why this pause exists**: the user explicitly defined the SDD flow with a review pause before commit (2026-04-28). Auto-committing after a green pipeline conflates "code works" with "code is what the user wanted to ship".

## Resume After Interruption

If the session was interrupted before completing all batches:

1. Re-running `/ralph-loop <spec>` re-reads the spec.
2. Picks up from the first `- [ ] TASK-N:` entry.
3. Already-completed tasks are marked `[x]` and skipped.
4. No `.active.md` to manage — there is none.

## Rules (non-negotiable)

- **NEVER auto-commit.** Wait for explicit user approval (Checkpoint 3 / Step 7).
- **NEVER use Stop-hook iteration** (no `.active.md` file).
- **NEVER skip self-review** (Checkpoint 1 always; Checkpoint 2 when applicable).
- **NEVER skip the pause** (Checkpoint 3) — even when validation is green.
- Worktree cleanup is MANUAL after merge — see CLAUDE.md directive 7.
- Spec status: APPROVED → IN_PROGRESS → DONE (only after the user-approved commit).
- Read the spec file fresh at the start of each batch — it is the single source of truth.
- Never modify the spec's Requirements or Design sections during execution.
- If a task is unclear or blocked: mark it `BLOCKED` in the spec, surface in the pause, do NOT silently skip.
- For features with many tasks (15+), consider splitting into smaller specs.

## Emergency Stop

To abort mid-execution: just stop. There is no `.active.md` to clean up. Re-running `/ralph-loop <spec>` will resume from the first unchecked task.
