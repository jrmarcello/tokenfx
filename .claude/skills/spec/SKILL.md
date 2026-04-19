---
name: spec
description: Create a structured SDD specification (requirements, design, tasks) for a new feature or change
argument-hint: "<feature-description>"
user-invocable: true
---

# /spec <feature-description>

Creates a structured specification document following Specification-Driven Development (SDD) principles.

## Example

```text
/spec "Add audit logging to all user write operations"
```

## Workflow

### 1. Understand the Request

- Parse the feature description
- Identify affected domain(s) and code areas
- Determine the type of change: new feature, refactor, bug fix, new domain, etc.

### 2. Gather Context

- Read existing code for affected areas
- Identify existing patterns to follow (check `lib/`, `app/`, `components/` for conventions)
- Respect the project's pragmatic structure — organize by feature/domain, not by layer

### 3. Generate Spec

- Create `.specs/<feature-name>.md` from the template at `.specs/TEMPLATE.md`
- Fill in all sections: Context, Requirements, Test Plan, Design, Tasks, Parallel Batches, Validation Criteria
- Requirements should use **GIVEN/WHEN/THEN** format for unambiguous acceptance criteria
- Mark uncertain items with `[NEEDS CLARIFICATION]` instead of assuming
- Tasks must be:
  - Concrete and independently verifiable (`pnpm typecheck` should pass after each)
  - Ordered logically for the feature (not necessarily by architecture layer)
  - Small enough to complete in a single focused iteration
  - Self-contained — each task description should be understandable without reading previous tasks
- Each task MUST include:
  - `files:` — concrete file paths this task creates or modifies
  - `depends:` — other TASK-N IDs that must complete first (omit if no dependencies)
  - `tests:` — TC-IDs from the Test Plan that this task must satisfy (triggers TDD cycle in ralph-loop; omit for non-code tasks)

### 4. Generate Test Plan

After generating Requirements and Design, derive an **exhaustive** Test Plan. If a scenario can happen in production, it must have a test case.

1. **For each REQ**: derive at least one happy-path TC plus all error/edge TCs
2. **For each typed error** surfaced by a module: >= 1 TC that triggers it
3. **For each validated field** (Zod schema): boundary TCs — valid min, valid max, invalid min-1, invalid max+1
4. **For each external dependency** (filesystem, HTTP fetch, DB write): >= 1 infra-failure TC
5. **For each conditional branch** in a function: TCs for both paths
6. **For each new API route / Server Action**, generate TCs covering:
   - Happy path (status + response shape)
   - Each distinct error status (400/404/500)
   - Field boundaries and edge cases
   - Idempotency (if applicable)
7. **Assign TCs to tasks** via `tests:` metadata — E2E smoke TCs go in dedicated `TASK-SMOKE`
8. **Rigor check**: error/edge TCs should outnumber happy-path TCs — no rule untested, no boundary unchecked.

Group TCs by layer:

- **Unit Tests** (TC-U-NN): pure functions, parsers, scoring, pricing
- **Integration Tests** (TC-I-NN): DB writer + queries + API routes
- **E2E Tests** (TC-E2E-NN): Playwright against running Next app

Categories: `happy`, `validation`, `business`, `edge`, `infra`, `idempotency`, `security`

For non-code specs (config/docs only), the Test Plan may be `N/A` with justification.

### 5. Analyze Parallelism

After generating tasks, build the **Parallel Batches** section:

1. Build a dependency graph from `depends:` and `files:` metadata
2. Two tasks **cannot** be parallel if:
   - One appears in the other's `depends:` list
   - They share any file in their `files:` lists
3. Group tasks into sequential batches using topological sort:
   - Batch 1: all tasks with no dependencies
   - Batch 2: all tasks whose dependencies are fully satisfied by Batch 1
   - Batch N: all tasks whose dependencies are fully satisfied by Batches 1..N-1
4. Classify shared files:
   - **Exclusive**: only one task touches it — safe for parallel
   - **Shared-additive**: multiple tasks touch it, but all are additive (e.g., `app/layout.tsx` shell → content layering) — candidate for sequential batches
   - **Shared-mutative**: multiple tasks modify existing code in the same file — must serialize
5. Present the batches to the user with the classification

Example output:

```text
## Parallel Batches

Batch 1: [TASK-1]                    — foundation
Batch 2: [TASK-2, TASK-3, TASK-4]    — parallel (no shared files)
Batch 3: [TASK-5]                    — sequential (shared: app/layout.tsx [additive])
Batch 4: [TASK-6]                    — sequential (depends: TASK-2, TASK-3)

File overlap analysis:
- app/layout.tsx: TASK-2, TASK-5 -> classified as shared-additive (shell then content)
- All other files: exclusive to one task
```

### 6. Self-Review the Spec (mandatory before presenting)

**Before showing the spec to the user, critically review what you just wrote.** Drafts look fine to the author in the moment; the gaps show up on a second pass. Read the spec with fresh eyes and check:

- **Alignment with the proposal**: Does every paragraph of the user's original request map to a REQ? Any concepts you paraphrased incorrectly? Any "decisões já travadas" you forgot to encode?
- **Requirement clarity**: Each REQ uses GIVEN/WHEN/THEN unambiguously. Bounds are inclusive-or-exclusive explicitly. No "handle this appropriately" hand-waving.
- **Ambiguity scan**: Any sentence that two readers could interpret differently? Any migration condition based on row values instead of schema state? Any test case marked "throw or return empty" without picking one?
- **Missing TCs**: every REQ has ≥1 TC; every validation boundary (Zod min/max, null handling, empty input, division by zero) has a TC; every conditional branch hit at least once; every external dep has an infra-failure TC. Rigor check: error/edge TCs outnumber happy-path TCs.
- **Architectural soundness**: Are task dependencies correct? Any shared-mutative files marked parallel that should be sequential? Any task doing two things (split it)? Any pattern duplication that should reuse existing helpers (e.g., `deriveModelFamily` instead of a new regex)?
- **Design decisions inline**: Schemas of new tables written out in Design (not "as described elsewhere"). Key algorithms spelled out (not "see implementation"). Trade-offs documented.
- **Inherited constraints**: Does the spec respect prior specs' contracts? Does it break an existing test you didn't realize was there?
- **Empty-state behavior**: What renders when the data is empty? Has first run? Has zero OTEL? Each of these cases explicit in a REQ or Test Plan entry.
- **Backward compatibility**: If changing a function signature, does the spec keep existing callers working (or explicitly migrate them in a task)?

**If you find gaps, apply the fixes to the spec in place BEFORE showing it to the user.** Present a "9 findings resolved / spec updated" note alongside the final DRAFT — the user shouldn't have to catch the same issue you could have caught yourself.

### 7. Present for Approval

- Display the spec to the user, highlighting the **Test Plan** and **Parallel Batches** sections
- Set status to `DRAFT`
- Ask: "Review this spec. Edit anything you want, then approve to begin implementation."
- If parallel batches exist, note: "Batches with multiple tasks can run in parallel via worktree agents or sequentially via `/ralph-loop`."
- On approval, set status to `APPROVED`

## Rules

- Spec files go in `.specs/` directory
- File naming: lowercase, hyphen-separated: `.specs/user-audit-log.md`
- Never include tasks that require user decisions — ask upfront during spec creation
- Reference existing patterns: if a task is similar to existing code, note which files to use as reference
- Match spec depth to task complexity — a simple bug fix needs fewer sections than a new domain
- Architecture is pragmatic: organize by feature/domain under `lib/`, `app/`, `components/`. No enforced layering — respect the boundaries documented in `CLAUDE.md`

## Integration

- After approval, run `/ralph-loop .specs/<name>.md` for autonomous execution
- Or execute tasks manually one at a time
- Use `/spec-review .specs/<name>.md` after implementation to verify against requirements
