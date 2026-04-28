---
name: spec
description: Create + self-review an SDD specification (requirements, test plan, tasks, parallel batches) and present for user approval
argument-hint: "<feature-description>"
user-invocable: true
---

# /spec <feature-description>

End-to-end spec authoring with built-in self-review. **No iteration loops** — runs once, presents the result, waits for your approval. After approval, run `/ralph-loop .specs/<name>.md` to execute it.

## Example

```text
/spec "Add cost-per-LOC metric per project to the overview dashboard"
```

## Phases

The skill runs three phases back-to-back in a single response: **Author → Self-review → Present**.

### Phase 1 — Author

1. **Understand the request.** Parse the feature description; identify which area is affected (`app/`, `lib/queries/`, `lib/ingest/`, `lib/analytics/`, `components/`, `apps/server/`); classify (new query, new ingest, new dashboard surface, schema change, refactor, bug fix).
2. **Gather context.** Read `CLAUDE.md`, `roadmap.md`, the rules in `.claude/rules/`, and the most-similar existing module as reference (e.g. `lib/queries/effectiveness.ts` for new query modules; `lib/ingest/git/evaluator.ts` for new ingest paths).
3. **Pick a name.** Lowercase, hyphen-separated, descriptive: `.specs/effectiveness-personal-v2.md`, `.specs/outcome-integration-git.md`. If it maps to a roadmap phase, mirror the title (no numeric prefix needed — `roadmap.md` is the index).
4. **Write `.specs/<name>.md`** from `.specs/TEMPLATE.md`. Fill in:
   - **Context** — why the feature exists, decisions already locked, prior art.
   - **Requirements** in GIVEN/WHEN/THEN form. No vague "should kinda".
   - **Test Plan** (see *Test Plan rigor* below — this is the load-bearing section).
   - **Design** — approach paragraph + affected files + dependencies. Mark unknown items `[NEEDS CLARIFICATION]` instead of assuming.
   - **Tasks** — concrete, ordered, each with `files:`, `tests:` (TC-IDs), `depends:`.
   - **Parallel Batches** — auto-generated from `files:` and `depends:` (see *Parallelism analysis* below).
   - **Validation Criteria** — `pnpm typecheck`, `pnpm lint`, `pnpm test --run`, `pnpm build`, `pnpm test:e2e` (when applicable), plus **live validation against real data** for user-visible features.
   - **Status: DRAFT**.

#### Test Plan rigor (highest leverage)

Every spec MUST have a Test Plan that satisfies these coverage rules:

- Every REQ has ≥ 1 TC (at minimum the happy path).
- Every typed error surfaced by a module has ≥ 1 TC that triggers it.
- Every validated field (Zod schema) has boundary TCs: valid min, valid max, invalid min-1, invalid max+1.
- Every external dependency call (filesystem read, HTTP fetch, DB write) has ≥ 1 infra-failure TC.
- Every conditional branch in a function has TCs for both paths.
- Every new API route / Server Action has integration TCs: happy path (status + response shape), each distinct error status, field boundaries, idempotency.
- **Rigor check**: error/edge TCs should outnumber happy-path TCs. No business rule untested, no error path missing, no boundary unchecked.

TCs grouped by layer: Unit (`TC-U-NN`) for pure functions/parsers/scoring, Integration (`TC-I-NN`) for DB/queries/routes against real SQLite, E2E (`TC-E2E-NN`) for Playwright. Categories: `happy`, `validation`, `business`, `edge`, `infra`, `idempotency`, `security`.

#### Parallelism analysis

After Tasks, build **Parallel Batches**:

1. Build a dependency graph from `depends:` and `files:`.
2. Two tasks **cannot** be parallel if: one is in the other's `depends:` list, OR they share any file in their `files:` lists.
3. Group via topological sort: Batch 1 = no dependencies; Batch N = dependencies satisfied by Batches 1..N-1.
4. Classify shared files:
   - **exclusive** — only one task touches it (parallel-safe)
   - **shared-additive** — multiple tasks add to it (e.g. `app/page.tsx` adding a new section, `lib/db/schema.sql` adding a new table) → use **accumulator pattern** (see `.claude/rules/sdd.md` §Merge Strategy): each parallel task emits a fragment, a `TASK-MERGE-*` task in the next batch applies them
   - **shared-mutative** — multiple tasks modify existing code in the same file → must serialize (single task in a sequential batch; never parallel)

### Phase 2 — Self-review (BLOCKING — runs every time)

Spawn **three review agents in parallel** in a single message with three Agent calls:

```text
Agent(spec-reviewer): Review .specs/<name>.md for gaps, ambiguity, missing tests, rule violations, and architectural mismatches.

Agent(test-reviewer): Audit the Test Plan section of .specs/<name>.md for coverage gaps — every REQ has TC, every error class has TC, every Zod-validated field has boundary TCs, every external dep has an infra-failure TC, every conditional branch has TCs for both paths.

Agent(code-reviewer): Audit the Design section of .specs/<name>.md for project-rule adherence — does the approach respect the project conventions (Server Components by default, Result pattern at boundaries, Zod at every external boundary, prepared statements, named exports, colocated tests, no mocking framework, logger via lib/logger.ts)?
```

Wait for all three. Aggregate findings:

1. **Apply trivially-correct fixes inline** to the spec file:
   - Missing TC-IDs for declared error classes → add the entry to the Test Plan.
   - Missing `tests:` mapping on a task that produces testable code → add it.
   - Wrong file path in `files:` → fix it.
   - Missing dependency in `depends:` → add it.
   - Boundary TCs missing for a validated field → add them.
   - Privacy/security constraint missing in Validation Criteria → add it.
   - Trivial wording fixes.
2. **Do NOT silently change** anything that requires a judgment call:
   - Architectural choices (e.g. reviewer says "use a Server Action instead of an API route").
   - Adding/removing a REQ (only the user can change scope).
   - Refactoring suggestions to existing code outside the spec.
   - Anything the user might want to push back on — surface in Phase 3.

After applying trivial fixes, re-read the spec end-to-end (mandatory) and verify the **best-way-possible check**: does the spec solve the problem the best way, or settle for the first approach that came to mind? Any shortcut that hurts correctness, performance, or ergonomics you wouldn't defend in code review? Any obvious simpler path (reuse an existing helper instead of rolling new logic, use the DB engine instead of an app-side loop, use Server Action instead of API route)? Apply fixes inline.

### Phase 3 — Present for approval (MANDATORY PAUSE 1)

Output to the user, in this order:

1. **Spec path** — `.specs/<name>.md`.
2. **Resumo** — REQ count, task count, TC count (Unit/Integration/E2E), batch count, biggest design decision.
3. **Auto-revisão — fixes aplicados** — bullet list of trivial fixes from phase 2.
4. **⚠️ Pontos de atenção** — every MUST FIX / SHOULD FIX from the three reviewers, plus any open questions worth highlighting.
5. **🟢 Aprovado pra `/ralph-loop`?** — explicit ask. Status remains `DRAFT` until the user approves; no auto-promotion.

**Stop here.** Wait for the user.

#### What to do with user feedback (re-review on iteration is MANDATORY)

After presenting, three things can happen:

- **Approval ("ok", "aprovado", "siga"):** set status to `APPROVED`. Tell the user the next step is `/ralph-loop .specs/<name>.md`. Do NOT call `/ralph-loop` proactively from this skill — `/ralph-loop` is the user's separate invocation.
- **More changes requested:** apply the requested changes, **then re-run Phase 2 self-review from scratch** (3 reviewers in parallel, fix triviais inline), **then re-present Phase 3**. Loop until the user approves or rejects. Re-running the review on every iteration is mandatory — a correction is itself spec content that can introduce regressions.
- **Rejection / abort:** delete the spec file (or leave it as `DRAFT` per user preference). Stop.

## Rules

- Spec files go in `.specs/`, lowercase, hyphen-separated.
- Never include tasks that require user decisions during execution — ask upfront during spec creation, lock decisions in the Context section as `decisões já travadas`.
- Reference existing patterns: if a task is similar to existing code, note which files to use as reference.
- Match spec depth to task complexity — a simple bug fix needs fewer sections than a new domain.
- Architecture is pragmatic: organize by feature/domain under `lib/`, `app/`, `components/`, `apps/server/`. No enforced layering — respect the boundaries documented in `CLAUDE.md`.

## When to use vs. /ralph-loop

- `/spec` writes the spec; you review and approve.
- `/ralph-loop` executes the approved spec end-to-end and presents results.

The two are explicitly separate — you always have a checkpoint between them.
