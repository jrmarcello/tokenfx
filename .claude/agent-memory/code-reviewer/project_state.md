---
name: Project state after manager-dashboard-v2-followups spec review (2026-05-02) — updated 2026-05-14 pre-release review
description: Architectural facts for apps/server post-manager-v2; known issues and design decisions locked for follow-up spec
type: project
---

MVP is complete. OTEL features added (5 metrics with graceful degradation). All tests pass. Stack: Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui + better-sqlite3 + Vitest + Playwright.

**Why:** Recorded after the manager-dashboard-v2-followups spec review to track locked design decisions and outstanding issues. Updated 2026-05-14 after full pre-release /review sweep.

**How to apply:** Cross-reference against new changes to see what was fixed vs what persists.

## Fixed since last review

- `Result<T,E>` is now canonical in `lib/result.ts`; `types.ts` re-exports it.
- `lib/analytics/scoring.ts` and `lib/ingest/transcript/parser.ts` correction-regex duplication resolved.
- `getTurns` in `lib/queries/session.ts` now uses WeakMap-cached `PreparedSet`.
- sso-replay-audit-row: `void writeReplayAuditRowOnInvalidCheck` now wrapped with `Promise.resolve().then(...).catch(...)` at the call site.

## Added in 2026-05-14 pre-release review (new issues found)

- **SHOULD FIX: `switch (decision.kind)` in `auth.ts:332` lacks `never` fallback** — all 5 arms of `SignInDecision` are covered but there is no `default: { const _exhaustive: never = decision; }` guard. If a new kind is added to `SignInDecision` without updating this switch, TypeScript will NOT catch it because the switch is inside an `async signIn({ user, account })` callback whose return type is `Promise<boolean | string>` — the switch can fall through returning `undefined` (which NextAuth coerces to `false`). Silently rejected logins with no log line are the risk.

- **SHOULD FIX: `apps/server/lib/db/migrate.ts` uses `console.log` / `console.error`** — lines 15 and 19 in the `if (require.main === module)` CLI path. Convention: use `lib/logger.ts`. Even for CLI scripts the project logger is preferred because it respects `LOG_LEVEL` and emits structured output. Low priority because this path only runs manually, but it's a convention violation.

- **SHOULD FIX: `extractRows` pattern not extracted in `manager-v2.ts`** — 11 copy-pasted `Array.isArray(result) ? (result as unknown as Row[]) : ((result as unknown as { rows: Row[] }).rows ?? [])` blocks across 7 query files. `me-visibility.ts` and `manager-drilldown.ts` already have a local `extractRows<Row>` helper. `manager-v2.ts` — the largest file with 5 of the 11 instances — does not. Extracting it reduces unsafe casts and makes future Drizzle API changes a one-line fix.

- **NICE TO HAVE: `parser.ts:181` redundant `as string` cast** — `block.text as string` is unnecessary after `block.type === 'text' && 'text' in block` because the Zod schema's first arm already types `text: string`. The passthrough third arm is why TS still has the union ambiguity; the `as string` is technically required but could be eliminated by removing the passthrough arm or narrowing via a helper.

- **NICE TO HAVE: `parser.ts:245` redundant `as string` cast** — `(usage.service_tier as string)` after `typeof usage.service_tier === 'string'` is vacuous.

## Persisting issues (unfixed as of 2026-05-14)

- **otel.ts prepared statements NOT memoized** — every call to `getOtelInsights` etc. calls `db.prepare(...)` inline.
- **reconcile.ts prepared statements NOT memoized** — `reconcileSession` calls `db.prepare(...)` on every invocation.
- **migrate.ts inline prepare** — `db.prepare('SELECT 1 FROM sessions LIMIT 1').get()` is called inline inside `migrate()`.
- **auto.ts inline prepare** — `db.prepare('SELECT MAX(ingested_at) AS last FROM sessions').get()` is called inline on every page render.
- **ratings route error shape inconsistency** — POST /api/ratings returns `{ ok: false, error: 'invalid body' }` (string error) but convention requires `{ error: { message: string, code?: string } }`.
- **`revalidatePath('/effectiveness')` missing** from `app/api/ratings/route.ts`.
- **Non-null assertions in test file** — `effectiveness.test.ts:165` uses `kpis.avgCacheHitRatio!`.
- **Root README missing reporter:setup mention** — REQ-39 not fully satisfied.
- **IP truncation third instance** — still not extracted to `lib/util/ip.ts`.
- **`vi.fn()` usage in `e2e-bypass-provider.test.ts`** — project rule requires hand-written stubs only.
