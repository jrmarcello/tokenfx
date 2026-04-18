---
name: Project state after OTEL batch (2026-04-18 review pass 2)
description: Updated architectural facts and known issues after reviewing the OTEL + scoring refactor batch
type: project
---

MVP is complete. OTEL features added (5 metrics with graceful degradation). All tests pass. Stack: Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui + better-sqlite3 + Vitest + Playwright.

**Why:** Recorded after the second full review pass (same day as batch-4 review) to track what was fixed vs what persists.

**How to apply:** Cross-reference against new changes to see what was fixed vs what persists.

## Fixed since last review

- `Result<T,E>` is now canonical in `lib/result.ts`; `types.ts` re-exports it. The previous independent inline definitions are gone.
- `lib/analytics/scoring.ts` and `lib/ingest/transcript/parser.ts` correction-regex duplication is resolved: scoring.ts owns the implementation, parser.ts re-exports `correctionPenalties` under the legacy name `detectCorrectionPenalty`.
- `getTurns` in `lib/queries/session.ts` now uses the WeakMap-cached `PreparedSet` pattern correctly for turn/toolcall/rating queries.

## Persisting issues (unfixed as of 2026-04-18)

- **otel.ts prepared statements NOT memoized** — every call to `getOtelInsights`, `getWeeklyAcceptRate`, `getSessionOtelStats`, `getAcceptRatesBySession`, and `hasAnyOtelScrapes` calls `db.prepare(...)` inline. The other query modules all use a WeakMap cache; otel.ts is the outlier.
- **reconcile.ts prepared statements NOT memoized** — `reconcileSession` calls `db.prepare(RENUMBER_ONE_SQL).run(...)` and `db.prepare(ROLLUP_ONE_SQL).run(...)` on every invocation (called after every `writeSession`). No WeakMap cache.
- **migrate.ts inline prepare** — `db.prepare('SELECT 1 FROM sessions LIMIT 1').get()` is called inline inside `migrate()`. Low frequency but still inconsistent with the project pattern.
- **auto.ts inline prepare** — `db.prepare('SELECT MAX(ingested_at) AS last FROM sessions').get()` is called inline on every page render (via `ensureFreshIngest`). This is the hottest path.
- **ratings route error shape inconsistency** — POST /api/ratings returns `{ ok: false, error: 'invalid body' }` (string error) but the project security convention requires `{ error: { message: string, code?: string } }`.
- **`revalidatePath('/effectiveness')` missing** from `app/api/ratings/route.ts` — rating changes affect the effectiveness page (avgScore, ratedSessionCount) but that page is not invalidated.
- **Non-null assertions in test file** — `effectiveness.test.ts:165` uses `kpis.avgCacheHitRatio!` and lines 209-210 use `s1!.score` / `s2!.score`; should use type narrowing instead.
- **Unsafe cast in parser.ts** — `parser.ts:95-100` casts a union-typed block to `{ type: 'tool_result'; tool_use_id: string; ... }` after only checking `block.type === 'tool_result'`. Should use a Zod schema or proper discriminated-union narrowing.
- **`import.meta` double cast in migrate.ts:11** — `(import.meta as unknown as { url?: string }).url` is an acceptable workaround for the CJS/ESM dual-env problem but warrants a comment (comment exists, so this is minor).
- **`as unknown as` in fs-paths.ts:55-56** — acceptable Dirent type gap workaround; comment present.
- **`TranscriptViewer` Server/Client boundary** — component has no `'use client'` but renders `RatingWidget` (Client Component). Works correctly because RSC can include Client Components; this is NOT a bug but is worth documenting clearly.
