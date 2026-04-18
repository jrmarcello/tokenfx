# Spec: dashboard-mvp

## Status: DONE

## Context

`/cost` shows only the current session; Grafana shows time-series — neither lets you **drill down into an expensive session, read the transcript, and rate whether it was worth it**. This spec delivers a localhost-only personal dashboard that:

1. Ingests two data sources: JSONL transcripts from `~/.claude/projects/` and OTEL Prometheus metrics scraped from Claude Code's local endpoint.
2. Surfaces consumption KPIs (spend, tokens, cache-hit ratio) and effectiveness KPIs (output/input ratio, correction heuristic, manual ratings).
3. Allows drill-down: click an expensive session → see turns → rate quality → scores recompute.

Base project: empty directory. Reference DX stack: `../gopherplate/.claude` (Go — adapted here to TS/Next).

## Requirements

- [x] REQ-1: Ingest all `.jsonl` files in `~/.claude/projects/` idempotently (same session re-ingested twice does not duplicate rows).
- [x] REQ-2: Compute per-turn cost via a model pricing table; session cost = sum of turn costs.
- [x] REQ-3: Home page shows global KPIs — spend (today / 7d / 30d), cache-hit %, total tokens, top-5 expensive sessions, daily-spend trend (30d).
- [x] REQ-4: `/sessions/[id]` shows session metadata + turn list (cost, tokens, model per turn) + transcript viewer (user prompt + assistant text + collapsible tool calls).
- [x] REQ-5: Each turn has a rating widget (-1 / 0 / +1) with persistence; session-level avg rating surfaces on the detail page.
- [x] REQ-6: `/effectiveness` shows composite score, weekly output/input ratio, cost-per-turn distribution, top tools leaderboard.
- [x] REQ-7: Ingestion via CLI (`pnpm ingest`) and UI (`POST /api/ingest`).
- [x] REQ-8: Effectiveness scoring uses at least two automatic heuristics: (a) output/input token ratio, (b) correction-follow-up detection (pt+en regex on next user prompt).
- [x] REQ-9: Transcript parser is tolerant — malformed JSONL lines are skipped via `onWarn` callback, never throw.
- [x] REQ-10: OTEL ingestion via Prometheus text format (opt-in via `OTEL_SCRAPE_URL`; parser exists; docs explain how to enable Claude Code's exporter).

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | Transcript parser groups valid JSONL by sessionId, sums token counts | `{ok:true}`, session with 1 turn, tokens match |
| TC-U-02 | REQ-9 | edge | Mixed valid + malformed JSONL lines | Malformed skipped via `onWarn`, parser continues |
| TC-U-03 | REQ-2 | happy | `computeCost` with known models (opus/sonnet/haiku) | Exact USD value per formula |
| TC-U-04 | REQ-2 | edge | `computeCost` with unknown model | Returns 0; no throw |
| TC-U-05 | REQ-8 | business | Correction heuristic (pt + en, strong + mild) | Correct turn penalized at 1.0 (strong) / 0.5 (mild) |
| TC-U-06 | REQ-2 | boundary | 0 tokens → 0 cost; 1M tokens → exactly `rate` | Exact match, no float drift |
| TC-U-SCORING-* | REQ-8 | business | `effectivenessScore` redistribution + weights | Null inputs skipped, composite 0..100 |
| TC-U-OTEL-* | REQ-10 | edge | Prometheus text: NaN/Inf, escaped quotes, malformed lines | Skipped silently or parsed correctly |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy, idempotency | Insert session + turns; re-run identical insert | Counts remain 1 / N, no dupes |
| TC-I-02 | REQ-1 | idempotency | Same sessionId with different source_file | Updates in place (not duplicated) |
| TC-I-03 | REQ-5 | happy | `upsertRating` insert + update | One row per turn, value updated |
| TC-I-WRITER-* | REQ-1, REQ-2 | happy, idempotency | Writer tests: session/turns/tool_calls via `ON CONFLICT` | Totals correct, idempotent re-run |
| TC-I-INGEST-* | REQ-1, REQ-10 | infra | `ingestAll` against tmp dir + fake OTEL fetcher | Summary correct, OTEL failure non-fatal |
| TC-I-Q-* | REQ-3, REQ-4, REQ-6 | happy, edge | Queries: overview / session / effectiveness on seeded DB | Correct aggregations, empty DB returns 0s/[] |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-3 | happy | Home loads with seeded data, KPIs rendered | "Overview" heading + all 4 KPI titles visible |
| TC-E2E-02 | REQ-4 | happy | Drill-down into session shows transcript | Session heading + transcript content visible |
| TC-E2E-03 | REQ-5 | happy | Rating a turn updates UI and persists across reload | Emerald class on Good button, survives reload |

## Design

### Architecture Decisions

- **Storage:** SQLite via `better-sqlite3` — synchronous, file-backed, zero infra.
- **App:** Next.js 16 (App Router) + TypeScript strict. Server Components query SQLite directly; Client Components only for interactivity (Nav, RatingWidget, charts).
- **Charts:** Recharts (dark-themed). Tremor dropped (package in flux post-"Tremor Raw") — custom KPI card + Card primitive cover the needs.
- **OTEL:** no daemon — Claude Code's built-in Prometheus exporter provides a localhost HTTP endpoint; ingestor `fetch`es and parses the text format directly.
- **Pricing:** hardcoded table in `lib/analytics/pricing.ts`; normalized lookups strip `[1m]` / date suffixes.
- **Correction heuristic:** regex-based, bilingual (pt + en), penalizes the assistant turn immediately before a correction prompt.
- **Composite score:** weighted blend of (output/input ratio, cache-hit ratio, avg rating, 1 − correction density) with weight redistribution when signals are null.
- **Idempotency:** natural key `sessionId + source_file`; writer uses `INSERT ... ON CONFLICT(id) DO UPDATE` for sessions/turns/tool_calls.
- **Path-traversal guard:** `lib/fs-paths.ts` rejects `..` segments before normalization and resolves symlinks via `realpath`.
- **Schema migration:** `getDb()` singleton runs `migrate()` once at creation; pages/routes don't touch migration.

### Files to Create

See `Tasks` below — each task lists its `files:`.

### Files to Modify

None at spec inception (empty repo).

### Dependencies

Production: `next@16`, `react@19`, `better-sqlite3@12`, `zod@4`, `recharts@3`, `tailwindcss@4`.
Dev: `vitest@4`, `@playwright/test@1.59`, `@testing-library/react@16`, `jsdom`, `tsx`, `eslint@9`.

## Tasks

- [x] TASK-1: Bootstrap Next.js 16 + pnpm + deps
  - files: package.json, tsconfig.json, next.config.ts, tailwind config, app/layout.tsx, app/page.tsx, .gitignore, vitest.config.ts
  - tests: —
- [x] TASK-2: Port and adapt `.claude/` DX config (Go → TS)
  - files: .claude/settings.json, .claude/CLAUDE.md (→ root), .claude/hooks/*, .claude/rules/*, .claude/agents/*, .claude/skills/*
  - tests: —
- [x] TASK-3: SQLite schema + migrate + types + fixtures
  - files: lib/db/schema.sql, lib/db/client.ts, lib/db/migrate.ts, lib/db/types.ts, tests/integration/db.test.ts, tests/fixtures/sample.jsonl
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02
- [x] TASK-4: Tolerant JSONL transcript parser + correction heuristic
  - files: lib/ingest/transcript/parser.ts, lib/ingest/transcript/parser.test.ts, lib/ingest/transcript/types.ts
  - depends: TASK-1
  - tests: TC-U-01, TC-U-02, TC-U-05
- [x] TASK-5: OTEL Prometheus parser + pricing table
  - files: lib/ingest/otel/parser.ts, lib/ingest/otel/parser.test.ts, lib/analytics/pricing.ts, lib/analytics/pricing.test.ts
  - depends: TASK-1
  - tests: TC-U-03, TC-U-04, TC-U-06, TC-U-OTEL-*
- [x] TASK-6: UI shell — layout, nav, KPI card, Card primitive, placeholder pages
  - files: app/layout.tsx, components/nav.tsx, components/kpi-card.tsx, components/ui/card.tsx, app/sessions/[id]/page.tsx, app/effectiveness/page.tsx, lib/cn.ts
  - depends: TASK-1
  - tests: —
- [x] TASK-7: Ingestion writer + CLI + API route
  - files: lib/ingest/writer.ts, lib/ingest/writer.test.ts, lib/fs-paths.ts, lib/logger.ts, scripts/ingest.ts, app/api/ingest/route.ts
  - depends: TASK-3, TASK-4, TASK-5
  - tests: TC-I-WRITER-*, TC-I-INGEST-*
- [x] TASK-8: Overview page (real KPIs + trend chart + top sessions)
  - files: app/page.tsx, components/overview/*, lib/queries/overview.ts, lib/queries/overview.test.ts
  - depends: TASK-3, TASK-6
  - tests: TC-I-Q-OVERVIEW, TC-E2E-01
- [x] TASK-9: Session drill-down + transcript viewer + rating widget + ratings API + sessions index
  - files: app/sessions/[id]/page.tsx, app/sessions/page.tsx, components/transcript-viewer.tsx, components/rating-widget.tsx, app/api/ratings/route.ts, lib/queries/session.ts, lib/queries/session.test.ts
  - depends: TASK-3, TASK-6
  - tests: TC-I-03, TC-I-Q-SESSION, TC-E2E-02, TC-E2E-03
- [x] TASK-10: Effectiveness page + composite scoring
  - files: lib/analytics/scoring.ts, lib/analytics/scoring.test.ts, app/effectiveness/page.tsx, components/effectiveness/*, lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - depends: TASK-8
  - tests: TC-U-SCORING-*, TC-I-Q-EFFECTIVENESS
- [x] TASK-SMOKE: Playwright E2E + seed-dev + README
  - files: tests/e2e/smoke.spec.ts, tests/e2e/global-setup.ts, playwright.config.ts, scripts/seed-dev.ts, README.md
  - depends: TASK-9, TASK-10
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]                    — parallel (app root vs .claude/ disjoint)
Batch 2: [TASK-3, TASK-4, TASK-5, TASK-6]    — 4 agents in parallel (100% disjoint files)
Batch 3: [TASK-7, TASK-8, TASK-9]            — 3 agents in parallel (domain-disjoint)
Batch 4: [TASK-10]                           — sequential (depends on TASK-8)
Batch 5: [TASK-SMOKE]                        — sequential final
```

File overlap analysis (all shared-additive; natural batch order resolves):
- `app/layout.tsx`: TASK-1 (scaffold) → TASK-6 (shell) — later overrides earlier.
- `app/page.tsx`: TASK-1 → TASK-6 → TASK-8 — same pattern.
- `app/sessions/[id]/page.tsx`: TASK-6 (shell) → TASK-9 (real).
- `app/effectiveness/page.tsx`: TASK-6 (shell) → TASK-10 (real).

## Validation Criteria

- [x] `pnpm typecheck` passes
- [x] `pnpm lint` passes
- [x] `pnpm test --run` passes (76 tests)
- [x] `pnpm build` passes (7 routes)
- [x] `pnpm test:e2e` passes (3 smoke tests)
- [x] `pnpm ingest` runs against real `~/.claude/projects` without error
- [x] Home, drill-down, and rating flow exercised end-to-end in a real browser
- [x] Full review team (code + security + data) returns no unresolved MUST FIX

## Execution Log

### Batch 1 — 2026-04-18 (chore: bootstrap)

Next 16 + pnpm + deps + Tailwind v4; `.claude/` ported from gopherplate and adapted Go → TS (settings permissions for pnpm/tsx/vitest/playwright/sqlite3; hooks: guard-bash reused, lint-ts-file new, stop-validate tiered, ralph-loop typecheck, worktree-create pnpm install; rules ts/nextjs-conventions new; agents code/security/data-reviewer rewritten; skills spec/ralph/validate adapted); root `CLAUDE.md` consolidated with `@AGENTS.md` import (Next 16 breaking-change notice); Clean Architecture references scrubbed.

### Batch 2 — 2026-04-18 (feat: schema + parsers + UI shell)

TASK-3: 5 tables + 1 view (`session_effectiveness`), PRAGMAs (`foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`), idempotent `migrate`. TASK-4: tolerant parser with `onWarn` callback, tool_use/tool_result linkage, inconsistent-sessionId error. TASK-5: Prometheus text parser with escape-aware label tokenizer, pricing table with alias normalization. TASK-6: dark-themed shell (`bg-neutral-950`), Server Components default, Client Component only for Nav.

Tests: 33/33 passing. Build clean.

### Batch 3 — 2026-04-18 (feat: ingestion + overview + drill-down)

TASK-7: idempotent writer with `ON CONFLICT DO UPDATE` across sessions/turns/tool_calls, WeakMap-cached prepared statements, transaction-wrapped multi-row writes; `ingestAll` composes transcripts + OTEL scrape; CLI exits non-zero on errors. TASK-8: overview KPIs (today/7d/30d spend, tokens, cache-hit, sessions count), 30-day spend trend (Recharts LineChart), top-5 expensive sessions. TASK-9: session detail page with KPI row + transcript viewer (native `<details>` for tool calls) + Client RatingWidget (`useTransition` optimistic UI, error rollback); `POST /api/ratings` with Zod validation.

Tests: 56/56 passing. Build clean.

### Batch 4 — 2026-04-18 (feat: effectiveness)

TASK-10: `effectivenessScore` composite 0..100 with null-weighted redistribution across output/input ratio, cache-hit, avg rating, and `(1 − correctionDensity)`; `bucketCostPerTurn` histogram helper; page with BarChart distribution + LineChart weekly ratio + tool leaderboard.

Tests: 76/76 passing.

### Batch 5 — 2026-04-18 (feat: E2E + seed + README)

TASK-SMOKE: Playwright config on port 3123 with dedicated `data/e2e-test.db`; `global-setup.ts` seeds deterministic `e2e-1/2/3` sessions; 3 smoke tests (home / drill-down / rating). `seed-dev` script generates 10 sessions, 80 turns, 63 tool calls, 4 ratings deterministically via seeded LCG. README with quick-start / commands / env vars / troubleshooting. `next.config.ts` adds `allowedDevOrigins: ['127.0.0.1', 'localhost']` so Playwright's client-side fetches are not blocked by Next 16's cross-origin dev guard.

Tests: 76/76 unit+integration passing, 3/3 E2E passing, build clean.

### Review pass — 2026-04-18 (refactor: apply MUST FIX findings)

Full review team (code-reviewer, security-reviewer, data-reviewer) run in parallel. MUST FIX items applied:

- `getDb()` now migrates once at singleton creation (was running `db.exec(schema.sql)` on every request across 6 call sites).
- `/api/ratings` looks up `sessionId` from `turnId` and calls `revalidatePath('/sessions/${sessionId}')` (was revalidating `/sessions/<turnId>` — non-existent path).
- `/api/ingest` rejects non-loopback Host headers (defense-in-depth for localhost-only contract).
- `lib/queries/session.ts`: replaced dynamic `IN(...)` `db.prepare()` per call with cached session-scoped JOIN statements; added `getSessionIdForTurn`.
- `lib/db/schema.sql`: added `idx_sessions_started_at` and `idx_sessions_cost` (cover nearly every time-windowed query).
- `lib/fs-paths.ts`: reject `..` segments before normalization; resolve symlinks via `realpath` before containment check.
- Dedup: `lib/result.ts` single source of truth for `Result<T,E>`; `lib/fmt.ts` consolidates formatters used across 4 pages; correction regex lives only in `lib/analytics/scoring.ts` (parser re-exports via `detectCorrectionPenalty`).

Tests: 76/76 passing post-refactor; typecheck + lint clean.
