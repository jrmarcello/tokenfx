# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TokenFx** — personal dashboard tracking Claude Code token-effectiveness. Ingests JSONL transcripts from `~/.claude/projects/` and OTEL Prometheus metrics from Claude Code's local endpoint. Surfaces consumption KPIs + effectiveness heuristics + manual ratings. Localhost-only, SQLite-backed.

Stack: Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui + Recharts + better-sqlite3 + Vitest + Playwright. Managed with pnpm.

## Common Commands

```bash
pnpm dev                  # Next.js dev server
pnpm build                # Production build
pnpm typecheck            # tsc --noEmit
pnpm lint                 # ESLint
pnpm test                 # Vitest watch mode
pnpm test --run           # Vitest single run
pnpm test:e2e             # Playwright end-to-end tests
pnpm ingest               # One-shot ingestion of transcripts + OTEL metrics
pnpm watch                # Standalone watcher — real-time ingestion of ~/.claude/projects
pnpm seed-dev             # Seed local DB with synthetic data for development
```

Run a single test file:

```bash
pnpm test --run lib/ingest/transcript/parser.test.ts
```

## Architecture

Layered, but deliberately flat — this is a single-user local tool, not a distributed system.

### Layer Structure

- **`app/`** — Next.js App Router. Pages (`page.tsx`), layouts, loading/error boundaries, API routes (`app/api/*/route.ts`).
- **`components/`** — React components.
  - `components/ui/` — shadcn/ui primitives.
  - `components/<domain>/` — feature components.
- **`lib/db/`** — better-sqlite3 client, `schema.sql`, `migrate.ts`, shared types.
- **`lib/ingest/`** — JSONL transcript parser, OTEL Prometheus parser, writer (idempotent).
- **`lib/analytics/`** — scoring heuristics, pricing table.
- **`lib/queries/`** — server-side SQLite queries, grouped by domain.
- **`scripts/`** — CLI entry points (`ingest.ts`, `seed-dev.ts`) run via `tsx`.
- **`tests/`** — Vitest unit/integration + Playwright e2e. Fixtures under `tests/fixtures/`.
- **`data/dashboard.db`** — gitignored runtime SQLite database.

### Key Patterns

- **Server Components by default** — `'use client'` only where interactivity / browser APIs / client hooks require it.
- **Prepared statements** — every query goes through `db.prepare(...)` with parameter binding. Prepared statements are module-level or memoized (not per call).
- **Mutations + revalidation** — Server Actions or API routes perform writes; always call `revalidatePath(...)` or `revalidateTag(...)` afterward so Server Component reads refresh.
- **Idempotent ingestion** — the natural key is `sessionId + sourceFile`; writes use `INSERT ... ON CONFLICT DO UPDATE` so re-runs are safe. Default is pull-based (auto-ingest on page load); `TOKENFX_WATCH_MODE=1` enables a push-based chokidar watcher that ingests JSONL files as they're written (`pnpm watch` runs the same watcher standalone).
- **Result pattern** — parsers and other ingestion-boundary modules return `Result<T, E>` instead of throwing.
- **Path traversal guard** — all filesystem reads driven by user-controlled paths go through `lib/fs-paths.ts`, which resolves and verifies the path stays within `~/.claude/projects/`.
- **Pricing table** — hardcoded in `lib/analytics/pricing.ts`; update when Anthropic publishes new per-token pricing.

### Conventions

- **TS strict**: no `any`, `unknown` + narrowing, no non-null assertions without justification.
- **Named exports** preferred; defaults only where Next requires (`page.tsx`, `layout.tsx`, `route.ts`, etc.).
- **Tests colocated**: `foo.ts` + `foo.test.ts`.
- **No mocking frameworks** — hand-written stubs in the same test file.
- **Logging**: use `lib/logger.ts`, not `console.log`, in library/UI code.
- **Zod** at every external/ingestion boundary.
- **Commit messages**: `type(scope): description` (feat, fix, refactor, docs, test, chore).

## Claude Code Resources

### Skills (slash commands)

| Skill | Purpose | When to use |
| ----- | ------- | ----------- |
| `/spec` | Create SDD specification (requirements, design, tasks, test plan, batches) | Before implementing a new feature or complex change |
| `/spec-review` | Review implementation against specification | After `/ralph-loop` completes or manual implementation |
| `/ralph-loop` | Autonomous task-by-task execution from a spec | After `/spec` approval, for autonomous implementation |
| `/validate` | Full validation pipeline (typecheck + lint + tests + build) | Before committing any code change |
| `/validate quick` | Typecheck + tests only | Quick feedback during development |
| `/review` | Single-agent code review | Quick review of small changes |
| `/full-review-team` | Parallel review: code + security + data (Agent Team) | PRs, major changes, cross-layer work |

### Agents

Agent Teams enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Each agent has persistent memory (`memory: project`).

- `code-reviewer` (model: sonnet) — TS/React/Next correctness & conventions.
- `security-reviewer` (model: opus) — injection, XSS, path traversal, secrets, dependency risk.
- `data-reviewer` (model: sonnet) — SQLite schema, query performance, PRAGMA, transactions.

Delegate with "use a subagent to..." or launch a team via `/full-review-team`.

### Rules (auto-applied by file pattern)

- `.claude/rules/ts-conventions.md` — `**/*.{ts,tsx}`
- `.claude/rules/nextjs-conventions.md` — `app/**/*,components/**/*`
- `.claude/rules/security.md` — `**/*`
- `.claude/rules/sdd.md` — `.specs/**`

### Hooks

- **PreToolUse[Bash]** — `guard-bash.sh`: blocks `.env` staging, `git add -A/.`, `DROP` statements, `--no-verify`.
- **PostToolUse[Edit|Write]** — `lint-ts-file.sh`: ESLint on every TS/JS file edit.
- **Stop** — `ralph-loop.sh`: checks spec task progress, returns exit 2 to continue autonomous execution (transparent when no loop active).
- **Stop** — `stop-validate.sh`: typecheck + lint + tests gate with tiered validation; skipped during active ralph-loop.
- **WorktreeCreate/Remove** — automated git worktree setup and cleanup.

### Execution Directives

1. **Prefer subagents and parallelization** — use subagents or Agent Teams for independent discovery/analysis. Merge findings before coding.
2. **Mandatory cycle** for non-trivial tasks: **Plan** → **Implement** → **Review** → **Test** → **Validate**. Do not finish without concrete validation evidence.
3. **The Review step is MANDATORY and AUTOMATIC** — after implementing, re-read the plan/spec and diff what was implemented vs what was specified (files, patterns, mappings). Verify: all files listed in `files:` metadata were created/modified, all patterns from the Design section are followed, all error mappings are complete, no implementation gap vs the spec. Only then proceed to tests. This is NEVER skipped.
4. **Post-implementation validation** — enforced automatically by the **Stop hook** (typecheck + lint + tests). The hook blocks completion until validation passes. For the full pipeline including Playwright e2e, run `/validate` explicitly.
5. **SDD workflow** for complex features: `/spec` → approve → `/ralph-loop` → `/spec-review`. Specs live in `.specs/`. The ralph-loop uses the Stop hook (exit code 2) to iterate task-by-task within the same session. Three checkpoints gate the "done" of any spec — skipping any is a regression (see `.claude/skills/spec/SKILL.md` "Self-Review the Spec" + `.claude/rules/sdd.md` "Discipline Checkpoints"):
   - **MANDATORY — Self-review the spec before presenting DRAFT**: after writing the spec and before showing it to the user, critically review it for alignment with the proposal, requirement clarity, ambiguity, missing TCs, architectural soundness, and — crucially — whether it solves the problem **the best way possible** (no shortcut hurting correctness/ergonomics, reuses existing helpers, follows project conventions). Apply the fixes in place; present with a "findings resolved" note.
   - **MANDATORY — Self-review REQ-by-REQ + best-way-possible check**: after the last task is marked `[x]`, walk every REQ with concrete evidence (`file:line`, test name, SQL fragment) and build a `✅ / 🟡 / ❌` checklist before reporting. For each REQ, also ask "was this implemented the best way possible, following project conventions?" — not just "works". Partial/blocked REQs surfaced in the report, never hidden.
   - **MANDATORY — Live validation with real data (when applicable)**: when the spec has user-visible effects (UI, queries, metrics, CLI, migration), start the dev server / run the CLI against the real DB, curl routes + grep HTML, cross-check SQL, and **lead** the final report with what was validated against real data — not with "tests pass". Skip only for pure refactors with no observable behavior change, and say so explicitly.
6. **Parallelism** — Three types: (a) **Intra-spec**: `/spec` auto-generates Parallel Batches from task `files:` and `depends:` metadata; ralph-loop launches parallel agents with `isolation: "worktree"` for multi-task batches. (b) **Inter-spec**: independent specs run in separate worktrees. (c) Shared files classified as exclusive, shared-additive (sequential batches), or shared-mutative (must serialize).
7. **Agent worktree cleanup is MANUAL** — when launching `Agent` with `isolation: "worktree"`, the runtime does NOT auto-cleanup worktrees if the agent made changes. After merging files from a worktree, ALWAYS run `git worktree remove <path> --force && git worktree prune`. Orphan worktrees accumulate fast and break IDE tooling. The `WorktreeRemove` hook only fires on explicit removal.

## MCP — Context7

Context7 fetches up-to-date documentation directly from library sources.

**Usage directives:**

- Always consult Context7 before writing code that depends on external library APIs (Next.js, React, Tailwind, Vitest, better-sqlite3, Zod, Recharts, Playwright, etc.)
- Use `resolve-library-id` to find the library ID, then `query-docs` to fetch the docs
- Maximum 3 calls per question (Context7 rate limit)
- Do NOT include sensitive data in the `query` parameter
- Prioritize results with source reputation "High" and high benchmark score

**Pre-resolved library IDs:**

| Library | Context7 ID |
| ------- | ----------- |
| Next.js | `/vercel/next.js` |
| React | `/facebook/react` |
| Tailwind CSS | `/tailwindlabs/tailwindcss` |
| Vitest | `/vitest-dev/vitest` |

**Resolve on-demand:** shadcn/ui, Radix UI, Recharts, better-sqlite3, Zod, Playwright, tsx, ESLint, Biome.

**When NOT to use Context7:** TypeScript language itself and Node.js stdlib — use built-in knowledge instead.
