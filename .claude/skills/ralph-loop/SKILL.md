---
name: ralph-loop
description: Autonomous single-run execution of an approved SDD spec — parallel via worktrees, self-reviewed, presented for approval before commit
argument-hint: "<spec-file-path>"
user-invocable: true
---

# /ralph-loop <spec-file>

Executes an approved spec **end-to-end in a single run** — no Stop-hook iteration, no per-task pauses, no `.active.md` state files. Parallelizes whatever the Parallel Batches section allows (one worktree per parallel task), then self-reviews the diff before handing back to the user. Commits only after explicit user approval.

## Example

```text
/ralph-loop .specs/effectiveness-personal-v2.md
```

## Phases

The skill runs five phases back-to-back: **Validate → Execute → Self-review → Present → Commit**. The only pause point is at the end of Phase 4 (waiting for the user to approve the commit). Phase 5 runs only after explicit approval.

### Phase 1 — Validate inputs

1. Read the spec file. Refuse if status ≠ `APPROVED` or `IN_PROGRESS`.
2. Verify the **Parallel Batches** section exists. If missing, regenerate from `files:`/`depends:` and warn the user.
3. Verify the **Test Plan** section is non-empty (or has explicit `N/A` justification).
4. Set spec status to `IN_PROGRESS` (if not already).

If anything fails: stop, report what's missing, and tell the user to re-run `/spec` or fix the spec manually.

### Phase 2 — Execute (autonomous, parallel where possible)

For each batch in **Parallel Batches**, sequentially:

#### Case A — Batch with 1 task (TASK-MERGE-* or anything else)

Execute inline in the main working tree (no worktree overhead):

1. Read spec for the task: `files:`, `tests:`, Design section, relevant rules in `.claude/rules/`.
2. **If the task name starts with `TASK-MERGE-`** (accumulator pattern, see `.claude/rules/sdd.md` §Merge Strategy):
   - Read every fragment under `.specs/wiring/<spec-slug>/`.
   - Group fragments by `Target`. Verify all targets in fragments match files in this task's `files:`.
   - For each target file, in fragment-name order (alphabetical sort of `<task-id>`):
     - Apply imports (deduplicated, merged into existing import block).
     - For each `### Section: <anchor>` block, locate the named anchor in the target file and insert the code block right before the closing token of that section (or at end-of-file if anchor is `end of file`).
   - If two fragments contradict each other at the same anchor with different content: STOP, report the conflict, leave the task `[ ]`.
   - If the merge succeeds, run `pnpm lint` on the target file then `pnpm typecheck`.
3. **Else if `tests:` present (TDD cycle):**
   - **RED:** Write the test file(s) first with all listed TCs as `it.each` entries (test names: natural English, NOT TC-IDs). Run `pnpm test --run <file>` to confirm RED state (compile fail OR test fail).
   - **GREEN:** Implement production code until all tests pass.
   - **REFACTOR:** optional cleanup; tests must stay green.
   - Re-read spec, verify all `files:` were touched and all patterns followed (mandatory REVIEW step).
4. **Else** (migrations, config, schema-only): execute as described in the task.
5. Run `pnpm typecheck` to verify compilation.
6. Mark `- [ ] TASK-N:` → `- [x] TASK-N:` in the spec.
7. Append a one-line entry to the Execution Log:

   ```markdown
   ### TASK-N (YYYY-MM-DD HH:MM)
   TDD: RED(X) → GREEN(X) — <1-line summary>
   ```

   For TASK-MERGE-*, the entry is `MERGE: <N> fragments → <target-file>`.

#### Case B — Batch with 2+ tasks (PARALLEL via worktrees)

Launch **all tasks in the batch as parallel `Agent` calls in a SINGLE message** with `isolation: "worktree"`. ALL Agent calls in the same message — that's what produces real parallelism.

Each agent prompt is self-contained:

```text
Execute TASK-N from .specs/<name>.md.

## Task
<full task description verbatim from spec>

## Files
<files: from task metadata>

## Test Plan (relevant rows)
<TC-IDs from this task's tests:, with full row from spec Test Plan>

## Wiring fragments (if any)
If your `files:` includes a fragment path like
`.specs/wiring/<spec-slug>/<task-id>.<target-slug>.fragment.md`, you must
write that fragment instead of editing the shared target file directly.
Format spec: `.claude/rules/sdd.md` §Merge Strategy (accumulator pattern).

## TDD Cycle
1. Write tests FIRST (*.test.ts) for all TCs listed
2. `pnpm test --run <file>` to confirm RED
3. Implement production code
4. REVIEW: re-read Task and Files. Verify all files created/modified, all patterns followed.
5. `pnpm test --run <file>` to confirm GREEN
6. `pnpm typecheck` to confirm compile

## Conventions
- See .claude/rules/ts-conventions.md, nextjs-conventions.md, security.md
- TS strict, no `any`, named exports
- Result pattern at boundaries (lib/result.ts)
- Zod at every external/ingestion boundary
- Hand-written stubs in *.test.ts (no mocking framework)
- Logger via lib/logger.ts (no console.log in lib/, app/, components/)
- Prepared statements via WeakMap when memoizable

Report back: list files created/modified, RED count → GREEN count, any deviations
+ justification, open questions, worktree path.
```

After **all parallel agents return**:

##### Auto-rollback on partial failure

Before merging anything, count how many agents succeeded:

- **All agents succeeded:** continue to the merge step below.
- **Any agent failed:** STOP. **Do not merge any worktree.** Surface to the user:

  ```text
  ⚠️ Batch [TASK-X, TASK-Y, TASK-Z] — partial failure.

  ✅ TASK-X: <summary>
  ✅ TASK-Y: <summary>
  ❌ TASK-Z: <one-line failure cause>

  Nothing has been merged into main. Choose:
    (a) merge X and Y, leave Z for me to fix manually
    (b) discard everything, rerun the batch with adjustments
    (c) stop here so I can investigate
  ```

  Wait for explicit user direction. Default (no answer): treat as (c). **Never merge a partially-failed batch silently** — even if the failure is in an "independent" task, dependencies may not be visible from `depends:` alone (shared imports, fixtures, types).

##### Merge step (only when all succeeded, or after user picks option (a))

1. For each succeeded worktree, in order: `cp` the agent's modified/created files into main (use the agent's reported file list; do NOT `cp -R` whole worktree to avoid sweeping in symlinks/node_modules).
2. Cleanup each worktree: `git worktree remove <path> --force && git worktree prune`. Required because the runtime does NOT auto-cleanup worktrees that received changes.
3. **Verify merged state:** `pnpm lint`, `pnpm typecheck`, `pnpm test --run`.
4. Mark all successfully-executed tasks `[x]` in the spec. Tasks from option (a)'s skipped set remain `[ ]`.
5. Append a single batch entry to the Execution Log:

   ```markdown
   ### Batch [TASK-3, TASK-4, TASK-5] (YYYY-MM-DD HH:MM)
   Parallel via worktrees.
   - TASK-3: <summary> — TDD: RED(X) → GREEN(X)
   - TASK-4: <summary> — TDD: RED(X) → GREEN(X)
   - TASK-5: <summary> — TDD: RED(X) → GREEN(X)
   ```

   For partial merge (option a), include `- TASK-Z: SKIPPED — <reason>`.

#### After all batches

- All tasks marked `[x]` (modulo any skipped via auto-rollback). Set spec status to `DONE` (still subject to phase-4 approval — this is just bookkeeping; gets reverted to `IN_PROGRESS` if user rejects).
- Run final validation in the working tree: `pnpm lint`, `pnpm typecheck`, `pnpm test --run`.
- Capture the diff stat (`git diff --stat`) for the self-review phase.

### Phase 3 — Self-review (BLOCKING — runs every time, including after user-requested changes)

Spawn **three review agents in parallel** in a single message:

```text
Agent(code-reviewer): Review the implementation of .specs/<name>.md against:
  - the spec's Design and Tasks sections
  - .claude/rules/ts-conventions.md, nextjs-conventions.md, security.md
  - project idioms (Server Components by default, prepared statements, Result pattern, Zod boundaries)
  Flag MUST FIX / SHOULD FIX / NICE TO HAVE.

Agent(test-reviewer): Audit the tests added by .specs/<name>.md:
  - every TC in the spec's Test Plan has a matching it / it.each entry
  - test names are natural English, not TC-IDs
  - hand-written stubs colocated, no mocking framework
  - no .only / .skip left in the tree
  - vi.useFakeTimers used for time-dependent tests
  - boundary TCs present for every Zod-validated field
  - infra-failure TCs for every external dep (filesystem, HTTP, DB)
  Flag MUST FIX / SHOULD FIX / NICE TO HAVE.

Agent(security-reviewer): Audit the diff for security/privacy violations per .claude/rules/security.md:
  - no PII in logs, fixtures, exports
  - no `console.log` in lib/, app/, components/
  - all SQL via prepared statements (parameter binding) — no template-literal interpolation
  - path traversal guard for any user-controlled filesystem read
  - no `dangerouslySetInnerHTML` without sanitized + documented-as-trusted input
  - Zod at every external boundary (API route bodies, CLI args, file contents)
  Flag CRITICAL / HIGH / MEDIUM / LOW.
```

Wait for all three. Aggregate findings:

1. **Apply trivially-correct fixes inline.** Then re-run `pnpm typecheck && pnpm test --run` to confirm nothing broke.
   - Missing test name conversion (TC-ID → English).
   - Forgotten error-message context wrap.
   - `console.log` left in production code.
   - Missing index on a foreign-key column.
   - Forgotten `revalidatePath` after a mutation.
   - Missed `'use client'` on a component using hooks.
2. **Do NOT silently change** anything that requires judgment:
   - Architectural pushback ("this should use a Server Action instead of an API route").
   - Adding a TC the reviewer thinks should exist (mention it, let user decide).
   - Refactoring suggestions.
   - Privacy CRITICAL findings — never auto-fix; always escalate.

### Phase 4 — Present for approval (MANDATORY PAUSE 2)

Output to the user, in this order:

1. **Spec status** — DONE (pending commit).
2. **Resumo da execução** — N tasks done, M batches, X paralelos via worktree, total LOC adicionado.
3. **Diff stat** — `git diff --stat` summary.
4. **Auto-revisão — fixes aplicados** — bullet list of trivial fixes from phase 3.
5. **⚠️ Pontos de atenção** — every MUST FIX / SHOULD FIX / CRITICAL / HIGH from the reviewers, with `file:line` and suggested fix.
6. **🟢 Validação** — typecheck / lint / test results (pass/fail count). Lead with **live validation against real data** when applicable (the user shouldn't need to ask "validou?").
7. **🟢 Posso commitar?** — explicit ask for the user to either approve, push back, or request more changes.

**Stop here.** Status remains `IN_PROGRESS`. Do not commit. Do not `git add`. Do not stage anything.

#### What to do with user feedback (re-review on iteration is MANDATORY)

After presenting, three things can happen:

- **Approval ("ok", "commit", "pode commitar", "siga"):** advance to Phase 5.
- **More changes requested:** apply the requested changes, **then re-run Phase 3 self-review from scratch** (3 reviewers in parallel, fix triviais inline), **then re-present Phase 4**. The cycle continues until the user approves. Re-running the review every loop is intentional — it protects against regressions in the corrections themselves and keeps the audit honest. The cost is a few seconds; the alternative (skipping) silently erodes the safety net.
- **Rejection / abort:** mark spec status as `FAILED` with a one-line reason in the Execution Log. Stop.

### Phase 5 — Commit (only after explicit user approval)

1. Stage only the files in the spec's Tasks `files:` lists (plus the spec file itself, plus any merged-in fragment files under `.specs/wiring/<spec-slug>/`). **Never `git add -A` or `git add .`** — see `.claude/hooks/guard-bash.sh`.
2. Commit with a `type(scope): description` message per project convention (see recent `git log` for style):

   ```text
   feat(<scope>): <one-line summary based on spec REQs>

   <body explaining major design decisions, REQ highlights, and live-validation evidence>

   See .specs/<name>.md for the full requirements, test plan, and execution log.
   ```

   **NO `Co-Authored-By` trailer** (per `feedback_commit_style` user memory). NEVER use `--no-verify`.
3. Show `git log -1` and current status.
4. Suggest next steps: `/spec-review .specs/<name>.md` for an independent post-merge audit, or `/spec <next-feature>` to start the next item from `roadmap.md`.

## Failure handling

- **Agent in a worktree fails:** auto-rollback semantics (Phase 2 Case B). **Do not merge any worktree** of the batch silently. Stop, report which task failed, and ask the user to choose between (a)/(b)/(c).
- **Merge conflict on a shared file (after agents succeeded):** stop the batch, leave all batch tasks unchecked, surface in Phase 4. The fix is usually a missing TASK-MERGE in the next batch — re-`/spec` may be needed.
- **TASK-MERGE conflict (two fragments contradict each other):** stop, leave the merge task unchecked, surface to user. The fix is to clarify intent in the spec.
- **Validation fails after a batch:** stop. Do not start the next batch. Surface what broke.
- **Test fails after RED→GREEN:** the implementing agent must fix it before reporting success. If it gives up, the task is unchecked, fail the batch.

## What the skill does NOT do

- Does not iterate task-by-task with the Stop hook (the old Ralph Loop). Single pass, parallel where possible.
- Does not create `.active.md` state files.
- Does not auto-commit. Always waits for user approval.
- Does not modify the spec's Requirements or Test Plan during execution. Tasks may be marked `[x]`, the Execution Log appended to. Nothing else.
- Does not skip Phase 3 (self-review). Even for trivial specs, the review pass runs.
- Does not push to remote. The user runs `git push` (or asks).

## When to use vs. /spec

- `/spec` writes the spec; you review and approve.
- `/ralph-loop` executes the approved spec end-to-end and presents results.

The two are explicitly separate — you always have a checkpoint between them.
