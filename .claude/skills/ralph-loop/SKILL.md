---
name: ralph-loop
description: Autonomous task-by-task execution loop from an SDD spec file (Stop hook-based iteration)
argument-hint: "<spec-file-path>"
user-invocable: true
---

# /ralph-loop <spec-file>

Executes tasks from a spec file autonomously, one task per iteration. Uses the Stop hook (exit code 2) to continue in the same session after each task.

## Example

```text
/ralph-loop .specs/ingest-jsonl.md
```

## Mechanism

The loop uses the Stop hook pattern:

1. You execute ONE task from the spec
2. When you finish (try to stop), the `ralph-loop.sh` Stop hook fires
3. If tasks remain: hook returns exit 2 (continue) — you receive a stderr message with progress
4. If all tasks done: hook returns exit 0 — `stop-validate.sh` runs final validation
5. Each iteration adds context to the same session — be focused and concise

## Startup

1. Read the spec file path from argument
2. Validate the spec exists and has status `APPROVED` or `IN_PROGRESS`
3. Verify no other ralph-loop is active (no other `.active.md` files in `.specs/`)
4. Set status to `IN_PROGRESS` if not already
5. Create state file: `.specs/<name>.active.md` containing the spec file path (this signals the Stop hook)
6. Check the **Parallel Batches** section to determine execution order:
   - If batches exist: follow batch order (Batch 1 -> Batch 2 -> ...)
   - Within a batch: check if parallel execution applies (see below)
   - If no batches section: fall back to sequential `TASK-N` order
7. Identify the next uncompleted `- [ ] TASK-N:` entry respecting batch order

## Parallel Execution (multi-task batches)

When a batch contains 2+ tasks, evaluate whether to parallelize:

### Decision Flow

```text
Read next batch from spec
  │
  ├── 1 uncompleted task  → Execute sequentially (normal iteration)
  │
  └── 2+ uncompleted tasks
        │
        ├── All files exclusive → Launch parallel agents in worktrees
        │
        └── Shared files exist  → Execute sequentially within batch
```

### How to Parallelize

1. Identify all uncompleted tasks in the current batch
2. For each task, launch an Agent call with `isolation: "worktree"` — ALL Agent calls MUST be in a single message (this ensures real parallelism)
3. Wait for all agents to complete
4. Collect results — each agent returns its worktree path (if changes were made)
5. Merge worktrees sequentially into main working directory (use `cp` from worktree paths)
6. **Cleanup worktrees MANUALLY** (CRITICAL — the runtime does NOT auto-cleanup Agent worktrees when changes were made):

   ```bash
   git worktree remove <worktreePath> --force
   git worktree prune
   ```

   Run this for EACH worktree immediately after merging its files. Orphan worktrees pile up fast (one per Agent call). The `WorktreeRemove` hook only fires on explicit removal, not on Agent completion.

7. Verify: `pnpm typecheck` and `pnpm test --run` pass after merge
8. Mark all completed tasks as `[x]` in the spec
9. Log all tasks in a single Execution Log entry

### Agent Prompt Template

Each parallel agent receives a self-contained prompt with:

- **Task**: full task description from spec
- **Files**: the `files:` list — only these files should be created/modified
- **Test Plan**: TC-IDs from `tests:` metadata with descriptions from the Test Plan section
- **TDD Cycle**: if `tests:` present, follow RED -> GREEN -> REFACTOR
- **Conventions**: TS strict, Result pattern at boundaries, hand-written stubs in `*.test.ts`, table-driven tests
- **REVIEW**: "Re-read the Task and Files sections. Verify all files created/modified, all patterns followed, all mappings complete. This is mandatory before running tests."
- **Report**: return summary of what was done, files changed, TDD results

### When NOT to Parallelize

- Tasks share **mutative** files (both modify existing code in the same file)
- Worktree isolation is unavailable
- Tasks are trivial (< 1 minute each) — overhead of worktrees outweighs benefit
- Fewer than 2 tasks in the batch

### Merge Strategy

- **All succeeded**: merge worktrees sequentially, verify typecheck + tests
- **Some failed**: merge successful ones, leave failed tasks unchecked, log failures
- **Merge conflicts**: resolve manually, verify typecheck + tests after resolution

## Per-Iteration Execution

**CRITICAL: Execute exactly ONE task per iteration (unless parallelizing a batch).**

For each task:

1. **Read the spec file** to find the current task (first unchecked `- [ ] TASK-N:`)
2. **Read relevant code** referenced in the spec's Design section
3. **Check `tests:` metadata** on the task to determine execution mode:

### If task has `tests:` -> TDD Cycle

**RED Phase:**

1. Write the test file FIRST (before production code) — `foo.test.ts` next to `foo.ts`
2. Tests reference the function/type to be implemented
3. Run `pnpm test --run <file>` — tests MUST fail (compilation/import failure = valid RED)

**GREEN Phase:**

1. Write MINIMUM production code to make tests pass
2. Follow existing patterns: hand-written stubs colocated in `*.test.ts`, table-driven tests
3. Run `pnpm test --run <file>` — all TCs in `tests:` MUST pass

**REFACTOR Phase:**

1. Clean up: remove duplication, improve naming, extract helpers
2. Run `pnpm test --run` + `pnpm typecheck` — must pass

### If task has no `tests:` -> Normal Execution

1. Execute the task as described
2. Verify: `pnpm typecheck`

### After execution (all modes)

1. **Mandatory review** (NEVER skip): re-read task description and verify: all files listed in `files:` were created/modified, all patterns from the Design section are followed, all error mappings/wrapping are complete, no implementation gap vs the spec
2. **Mark complete**: change `- [ ] TASK-N:` to `- [x] TASK-N:`
3. **Log**: append to Execution Log:

```markdown
### Iteration N — TASK-N (YYYY-MM-DD HH:MM)

<1-2 sentence summary>
TDD: RED(N failing) -> GREEN(N passing) -> REFACTOR(clean)  <!-- if TDD -->
```

1. **Stop** — let the hook decide whether to continue or finish

## TDD Edge Cases

- **Compilation/import failure counts as valid RED** — the test file exists but the imported symbol doesn't exist yet
- **Test file before production file** — always create `*.test.ts` before the implementation file
- **Stubs**: hand-written stubs colocated in the same `*.test.ts` (no mocking frameworks)
- **Existing tests break**: fix immediately before proceeding to GREEN
- **Multiple TCs in one task**: all TCs must pass in GREEN phase

## On Final Task

After marking the last task complete, **do NOT rush to report back**. Five steps in order:

### 1. Full validation pipeline

- The Stop hook detects all tasks done, returns exit 0
- `stop-validate.sh` runs full validation (typecheck + lint + tests)
- If validation fails: fix issues (stop-validate retries up to 3 times)

### 2. Self-review against the spec (mandatory)

Re-read the spec's Requirements section and walk **every REQ** individually:

- Is the REQ satisfied by something concrete you can cite (file:line, test name, SQL fragment)?
- Is it **fully** satisfied, or partially? Partial = flag explicitly, don't hide it.
- Is the implementation the best approach for the REQ, or did you settle for a shortcut?
- Did you skip the spec's explicit decisions (`decisões já travadas`) anywhere?
- Is the REVIEW step from each task genuinely done (all `files:` touched, patterns followed, no implementation gap)?

Build a checklist (REQ-1..N) in your internal notes with status per REQ. Any ⚠️ or 🟡 items get surfaced in the report — never swept.

### 3. Live validation with real data (when applicable)

If the feature has user-visible effects (UI changes, new queries, new metrics, script behavior), validate against a **real** database or environment, not just test fixtures:

- Start the dev server (`pnpm dev` in background) and curl the affected routes — confirm HTTP 200 and that the new content appears in the rendered HTML (grep the response for key aria-labels, headings, badges, data-attributes).
- For new CLI tools (`pnpm recompute-costs`, `pnpm ingest`, `pnpm seed-dev`), run against the live DB and inspect the output. Cross-check with raw SQL (`sqlite3 data/dashboard.db "SELECT ..."`) that the expected rows/values appear.
- For new UI states (badges, empty states, divergence hints), trigger the state via seed data or by hand and visually confirm via HTML grep.
- For E2E tests that were flaky in the batch run (port collisions, timing), re-run in isolation to confirm they actually pass.
- Stop the dev server when done.

Skip only when the feature is truly internal (pure refactor, no observable behavior change).

### 4. Spec status and cleanup

- If validation + self-review pass cleanly: set spec status to `DONE`, remove the `.active.md` state file.
- If partial: set status to `DONE` and flag the partial REQs in the final report with a clear "follow-up" note — don't leave them invisible.

### 5. Report back

- Lead with **what was validated against real data** (not just "tests pass"). Example: "30-day spend KPI: \$9,749 list → \$1,956 calibrated, 5× closer to actual Max usage."
- Table of REQs with status (✅ / 🟡 partial / ❌ blocked) — this is your proof the spec was followed.
- List of new tests and the delta (`399 → 429, +30`).
- Any `[SIGTERM]` exit codes from dev-server kills: explain them; don't leave the user thinking something crashed.
- Suggest: "Run `/spec-review .specs/<name>.md` for a formal review against requirements" **only if** the self-review surfaced anything worth a second pair of eyes.

## Resume After Interruption

If a loop was interrupted (Ctrl+C, crash, etc.):

1. The `.active.md` state file remains on disk
2. Running `/ralph-loop .specs/<name>.md` again picks up from the first unchecked task
3. No work is lost — completed tasks are already marked `[x]`

## Rules

- **ONE task per iteration** — unless parallelizing a batch (then all batch tasks in one iteration)
- **Parallel batches launch multiple agents** in a single message with `isolation: "worktree"`
- **Read the spec file first** every iteration — it is the single source of truth
- Never modify the spec's Requirements or Design sections during execution
- If a task is unclear or blocked, mark it `BLOCKED` in the spec, remove the `.active.md` file, and stop
- Follow project conventions: TS strict, Result pattern at boundaries, colocated tests
- Be concise in responses — context accumulates across iterations
- For features with many tasks (15+), consider splitting into smaller specs

## Emergency Stop

To stop the loop at any time:

```bash
rm .specs/*.active.md
```

This removes the state file. The Stop hook will see no active loop and pass through normally.
