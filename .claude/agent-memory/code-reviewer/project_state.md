---
name: Project state after effectiveness-personal-v2 (2026-04-28 review pass 4)
description: Updated architectural facts and known issues after reviewing the effectiveness-personal-v2 spec implementation
type: project
---

MVP is complete. OTEL features added (5 metrics with graceful degradation). All tests pass. Stack: Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui + better-sqlite3 + Vitest + Playwright.

**Why:** Recorded after the second full review pass (same day as batch-4 review) to track what was fixed vs what persists.

**How to apply:** Cross-reference against new changes to see what was fixed vs what persists.

## Fixed since last review

- `Result<T,E>` is now canonical in `lib/result.ts`; `types.ts` re-exports it. The previous independent inline definitions are gone.
- `lib/analytics/scoring.ts` and `lib/ingest/transcript/parser.ts` correction-regex duplication is resolved: scoring.ts owns the implementation, parser.ts re-exports `correctionPenalties` under the legacy name `detectCorrectionPenalty`.
- `getTurns` in `lib/queries/session.ts` now uses the WeakMap-cached `PreparedSet` pattern correctly for turn/toolcall/rating queries.

## Added in session-timeline-heatmap (2026-04-18 review pass 3)

- `lib/analytics/heatmap.ts` — pure helpers (`computeLevels`, `arrangeWeeks`, `monthLabels`, `parseDateParam`). Clean TS strict, no anys.
- `components/overview/activity-heatmap.tsx` — SVG heatmap Client Component with delegated click, keyboard nav, legend, empty state.
- `lib/queries/session.ts` — `listSessionsByDate` added with inline validation (duplicate of `parseDateParam` logic; acceptable per design decision AD-7).
- `lib/queries/overview.ts` — `DailyPoint.sessionCount` added; zero-fill updated; prepared statements WeakMap-cached correctly.
- `app/sessions/page.tsx` — discriminated union branch pattern for date filter/invalid/all cases.

### New known issues (heatmap spec)

- **DST boundary bug in `listSessionsByDate`**: `end = start + 86_400_000` is fixed-offset. On the night of a DST clock-forward (spring-ahead), the local day is only 23 hours; end will overshoot into the next day by 1 hour. Affects exactly 2 nights/year in DST-observing TZs. Low severity for a localhost tool but technically incorrect.
- **`ver todas` link only shown when filtered items > 0**: REQ-5 says "dia sem sessões → link ver todas". The link is present in the empty-day branch. But for filtered results > 0, the link appears in the subtitle but NOT after the session list. Minor UX gap vs GitHub-style "back to all" affordance, not a REQ violation.
- **`aria-disabled` on SVG `<rect>`**: `aria-disabled` is not a globally supported ARIA attribute on `role="gridcell"`. Screen readers may ignore it. The empty cells do have `tabIndex=-1` so they're unreachable by Tab; click guard is JS-only. Non-blocking for a localhost tool.
- **Heatmap hidden behind `hasData` gate**: The `ActivityHeatmap` empty state ("Sem sessões ainda") is only reachable if `kpis.sessionCount30d > 0` but `yearly.every(d => d.spend === 0)`. If the DB is truly empty, the `OverviewEmptyState` renders instead, never showing the heatmap placeholder. This is acceptable but REQ-7 wording implies the heatmap card should show even on empty DB.
- **Middle-click / open-in-new-tab does not work**: Design decision AD-4 documents this as intentional. Cells use `useRouter().push()` not `<a href>`. Acceptable for internal tool.
- **`seedSession` helper in `session.test.ts` creates a new `db.prepare(...)` per call** — the helper is test-local so this doesn't violate the production pattern, but it's a prepared-statement-per-call in tests (minor).

## Added in effectiveness-personal-v2 (2026-04-28 review pass 4)

- `lib/analytics/regression.ts` — pure least-squares helper. Clean TS, no anys.
- `lib/analytics/effectiveness-v2.ts` — constants + pure helpers (palette, level mapping, median, formatInsightLine). Clean.
- `lib/queries/effectiveness-v2.ts` — 6 query functions with full WeakMap PreparedSet. N+1 pattern accepted by spec design (per-session loop in aggregates/quartiles capped by bounded window).
- `components/effectiveness-v2/` — 5 components. CostRatingScatter is correct `'use client'`; others are Server Components.
- `components/overview/activity-heatmap.tsx` — gained `colorScheme` prop; EMERALD_PALETTE extracted to named export. 'use client' inherited from original.
- `app/effectiveness/page.tsx` + `loading.tsx` — Server Component with `force-dynamic`+`nodejs` runtime, same pattern as home page.
- `compaction_events` table added to schema.sql with correct PK + index.
- Parser collects `compact_boundary` events before `CONSUMED_TYPES` filter. Writer inserts them in same transaction as session.

### New known issues (effectiveness-v2 spec)

- `revalidatePath('/effectiveness')` is STILL missing from `app/api/ratings/route.ts` (pre-existing issue, compounded: now a second page needs it).
- `getPersonalEffectivenessAggregates` does N+1 DB lookups per session in window via `getPersonalEffectivenessSession` loop — spec design §1 accepts this for personal-scale DBs (5k sessions max), but it calls `sessionExists` stmt redundantly on each inner call since the IDs are already known valid.
- `effectivenessLevelFor` mapping uses `[0,25)→1, [25,50)→2, [50,75)→3, [75,100]→4` (quartile-fixed breakpoints), which differs from the REQ-24 formula `Math.min(4, Math.ceil(4 * score / 100))`. These produce different results for score=25 (formula gives 1, impl gives 2), score=50 (formula gives 2, impl gives 3), score=75 (formula gives 3, impl gives 4). Spec Design §10 and REQ-24 describe different breakpoint semantics — Design §10 wins.
- `loadCalibration` in effectiveness-v2.ts is a near-duplicate of `getCostCalibration` in calibration.ts, inlined to avoid re-prepare. Acceptable per REQ-16's explicit mandate but creates drift risk if calibration schema evolves.
- `computeAvgMetrics` calls `getPersonalEffectivenessSession` per session which itself calls `sessionExists` — redundant check since the IDs come from `getSessionScores` and are guaranteed to exist.

## Persisting issues (unfixed as of 2026-04-28)

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
