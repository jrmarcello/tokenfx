---
name: validate
description: Post-implementation validation pipeline (typecheck + lint + tests + build)
user-invocable: true
---

# /validate [quick]

Post-implementation validation pipeline. Ensures TS/Next.js changes are production-ready for this local dashboard.

## Phases

### Phase 1 — Static Validation

1. `pnpm typecheck` — TypeScript compiler in `--noEmit` mode
2. `pnpm lint` — ESLint (plus Prettier/Biome checks if wired)

### Phase 2 — Automated Tests

1. `pnpm test --run` — Vitest unit + integration tests

### Phase 3 — Build (skip with `quick`)

1. `pnpm build` — Next.js production build (catches route-level and type issues Vitest doesn't)

### Phase 4 — Functional Validation (skip with `quick`)

1. Spin up `pnpm dev`, exercise the specific behavior that was implemented/fixed
2. Hit `http://localhost:3131` and verify pages render
3. If ingestion was changed: run `pnpm ingest` against a small fixture and verify DB state via `sqlite3 data/dashboard.db`

## Usage

- `/validate` — Full pipeline (all 4 phases)
- `/validate quick` — `pnpm typecheck && pnpm test --run --silent` only (fastest feedback)

## Output

| Phase | Check | Result |
|-------|-------|--------|
| 1 | Typecheck | PASS/FAIL |
| 1 | Lint | PASS/FAIL |
| 2 | Tests | PASS/FAIL |
| 3 | Build | PASS/FAIL/SKIP |
| 4 | Functional | PASS/FAIL/SKIP |
