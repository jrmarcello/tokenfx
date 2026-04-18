---
name: Project state after batch-4
description: Key architectural facts and known issues discovered during the post-batch-4 full code review (2026-04-18)
type: project
---

MVP is complete through 5 batches. All tests pass. Stack: Next.js 16 + React 19 + Tailwind v4 + better-sqlite3 + Vitest + Playwright.

**Why:** Recorded after the first full review pass so future review sessions start with known debt.

**How to apply:** Cross-reference against new changes to see what was fixed vs what persists.

Known issues (unfixed as of 2026-04-18):

- `Result<T,E>` is defined independently in `lib/ingest/transcript/types.ts` AND inline in `lib/ingest/otel/parser.ts` — no shared canonical location.
- `getTurns` in `lib/queries/session.ts` (lines 197-210) creates dynamic IN-clause prepared statements per call instead of reusing them — violates the module-level prepared statement rule.
- `migrate(db)` is called on every page render and every API request hit; it should be called once at startup, not per-request.
- `revalidatePath` in `app/api/ratings/route.ts` (line 34) passes `turnId` instead of `sessionId` — the path `/sessions/<turnId>` almost certainly doesn't exist.
- `TranscriptViewer` component (`components/transcript-viewer.tsx`) is missing `'use client'` but uses `RatingWidget` which is a Client Component — this works today because RSC can render Client Components, but the component itself renders no server data so it would be cleaner as a Client Component or the `RatingWidget` boundary is already correct.
- `fs-paths.ts` uses `as unknown as { parentPath?: string; path?: string }` double cast to work around missing Dirent type — acceptable workaround, but warrants a comment.
- `lib/analytics/scoring.ts` and `lib/ingest/transcript/parser.ts` both define the same STRONG_CORRECTION / MILD_CORRECTION regexes — duplication.
