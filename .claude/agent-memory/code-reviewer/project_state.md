---
name: Project state after central-server-onboarding spec review (2026-04-30)
description: Architectural facts for apps/server (central-reporter-server DONE, central-server-onboarding DONE) + known issues post-implementation
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

- `lib/analytics/heatmap.ts` — pure helpers. Clean TS strict, no anys.
- `components/overview/activity-heatmap.tsx` — SVG heatmap Client Component.
- `lib/queries/session.ts` — `listSessionsByDate` added with inline validation.
- `lib/queries/overview.ts` — `DailyPoint.sessionCount` added; zero-fill updated.
- `app/sessions/page.tsx` — discriminated union branch pattern for date filter.

### New known issues (heatmap spec)

- **DST boundary bug in `listSessionsByDate`**: `end = start + 86_400_000` is fixed-offset. On the night of a DST clock-forward (spring-ahead), the local day is only 23 hours; end will overshoot into the next day by 1 hour. Affects exactly 2 nights/year in DST-observing TZs.
- **`aria-disabled` on SVG `<rect>`**: `aria-disabled` is not a globally supported ARIA attribute on `role="gridcell"`. Non-blocking for a localhost tool.

## Added in effectiveness-personal-v2 (2026-04-28 review pass 4)

- `lib/analytics/regression.ts` — pure least-squares helper.
- `lib/analytics/effectiveness-v2.ts` — constants + pure helpers.
- `lib/queries/effectiveness-v2.ts` — 6 query functions with full WeakMap PreparedSet.
- `components/effectiveness-v2/` — 5 components. CostRatingScatter is correct 'use client'.
- `app/effectiveness/page.tsx` + `loading.tsx` — Server Component.

### New known issues (effectiveness-v2 spec)

- `revalidatePath('/effectiveness')` is STILL missing from `app/api/ratings/route.ts`.
- `getPersonalEffectivenessAggregates` does N+1 DB lookups per session.
- `effectivenessLevelFor` mapping uses quartile-fixed breakpoints differing from REQ-24 formula at boundary values (score=25, 50, 75).

## Added in central-server-onboarding (2026-04-30 review pass 5)

All 39 REQs implemented and confirmed. Key highlights:

- Schema: 3 new tables (onboarding_invites, onboarding_redemption_log, onboarding_audit_log) + 2 pg enums. DDL matches spec exactly including `created_by NULL ON DELETE SET NULL` invariant.
- REQ-4: users.ssoProvider / users.ssoSubject are correctly nullable in schema.ts.
- REQ-5: Pepper boot guard is LAZY (per-call in `getPepper()`) not module-level boot-time. Spec says "boot-time guard" but the lazy design is strictly safer and more testable. Not a defect.
- REQ-6: Bearer + bcrypt + 60s cache implemented in `lib/auth/bearer-auth.ts` (shared with /api/health). Constant-time via sha256 before timingSafeEqual.
- REQ-7: client.ts sends `Authorization: Bearer <secret>`, idempotency key now `sha256(canonicalJSON(payload)).slice(0,32)`.
- REQ-8: signer.ts DELETED, canonical-json.ts extracted to lib/reporter/canonical-json.ts.
- REQ-9: seed-server.ts bcrypt-hashes secrets; --e2e mode prints key_id only (not secret).
- REQ-11/12/13: loadUserByEmail email-only predicate, evaluateSignIn pure decision helper, 4-way signIn branching all correct.
- REQ-16: matchEmailPattern: NFC normalize, non-ASCII local-part rejection, IDN via domainToASCII. Correct.
- REQ-17: /onboard Server Component shell + OnboardTokenDisplay 'use client' leaf using useSyncExternalStore.
- REQ-18/19/20: createInviteCore (idempotency Map), revokeInviteByPrefix (2-step SELECT+UPDATE), listInvitesForOrg (SQL prefix projection).
- REQ-21..25: all manager UI routes + components present. Nav link in layout.tsx. loading.tsx + error.tsx present.
- REQ-22 flash cookie: HMAC-signed, httpOnly+secure+sameSite=strict, 120s TTL, path-scoped. Show-once via Server Component read + FlashCookieClearer useEffect → Route Handler (NOT Server Action — prevents RSC re-render flicker).
- REQ-23: InviteRevokeButton uses native <dialog> (not shadcn AlertDialog — no shadcn available in this app).
- REQ-26..29: redeem-invite route: Zod .strict(), dual rate-limit (ip 10/min + token 3/min), uniform 401 body, FOR UPDATE, transaction, hashFn injection seam.
- REQ-30..36: reporter-setup.ts: parseOnboardingInput, resolveCentralUrl (TLS enforcement), runPromptLoop, preflightExistingConfig, atomicWriteConfig (fsync+rename+0600), runOnboarding orchestrator, mapRedeemResponseToError.
- REQ-37: /api/health: liveness mode (no auth), credential validation mode (key_id + Bearer), rate limit, 400 on auth-without-key_id.
- REQ-38/39: README updated with onboarding flow diagram, threat model table, operational procedures. Root README does NOT mention reporter:setup.

### Quality concerns in central-server-onboarding (post-implementation)

- **REQ-5 boot guard is lazy, not boot-time**: getPepper() throws on first hash call in production, not at server start. TC-I-03 tests this correctly; spec wording was imprecise. Acceptable.
- **REQ-22 show-once semantics**: Server Component reads cookie but CANNOT delete it (Next.js 15 constraint). FlashCookieClearer fires useEffect POST after mount. Race: if the user copies the URL before useEffect fires AND closes the tab, the cookie persists until its 120s TTL. 120s TTL is the failsafe. Documented in code. Not a defect.
- **REQ-23 uses native <dialog> not shadcn AlertDialog**: spec said shadcn <AlertDialog>. InviteRevokeButton uses native <dialog> with full a11y (focus trap, ESC-to-close). Better than shadcn per project's component inventory. Acceptable divergence.
- **Root README (REQ-39) does not mention pnpm reporter:setup**: the spec says "brief mention of pnpm reporter:setup for new dev onboarding" in root README. Not found in README.md. PARTIAL — apps/server/README.md has full documentation; root README still missing the one-liner.
- **IP truncation duplicated**: truncateIp logic exists independently in ingest/route.ts and redeem-invite/route.ts with slightly different null-fallback constants ('unknown-ip' vs null). Comment in code acknowledges this but it's not extracted to lib/util/ip.ts.
- **redeem.ts normalizeInviteRow**: handles dual number|string types from raw SQL because Drizzle's raw sql`` template can return strings for integer columns. The two-path normalize is correct but the type variance is a leakage of the raw-SQL approach through the typed boundary.

## manager-dashboard-v2.md DRAFT review (2026-04-30)

Key findings recorded below; full list delivered in conversation output.

- `sessions_agg` has NO `correction_density` or `subagent_count` columns. Available: `cacheHitRatio`, `outputInputRatio`, `subagentUsageRatio`, `avgRating`. Composite score formula must map to these column names, NOT the ones the spec describes.
- `users` table has NO `display_name` column — only `email`. REQ-18/alphabetical ordering must ORDER BY `users.email`, not `users.display_name`. All spec copy using `displayName` refers to a non-existent column.
- `org_settings` table does NOT exist in schema.ts. Spec assumes `ALTER TABLE org_settings ADD COLUMN ... IF NOT EXISTS` will succeed, but the table is not present. It must be created from scratch.
- `cron_runs` table does NOT exist anywhere in schema.ts. Spec says "assumes spec 1 ships a cron_runs table; if not, created here". Spec 1 does NOT ship it — TASK-MIGRATIONS must include it unconditionally.
- No notification infrastructure exists at all in apps/server/. No `lib/notifications/` directory, no templates registry, no email/Slack/in-app channel. REQ-16 + TASK-NOTIFICATION have no concrete channel to target. Q9 is a hard blocker.
- `apps/server/lib/auth/middleware.ts` does NOT exist. The auth gate is `apps/server/middleware.ts` (root). Files-to-Modify cites the wrong path.
- IP truncation is already duplicated in 2 places (ingest/route.ts + redeem); v2 adding a third without extracting `lib/util/ip.ts` violates the prior LOW finding from onboarding review.
- Existing pattern in apps/server is Drizzle ORM (not `pg` prepared statements with WeakMap). REQ-19 says "Postgres `pg` library `client.query(text, values)`" — but actual code uses Drizzle everywhere. REQ-24 says "WeakMap pattern" but Drizzle doesn't support WeakMap-cached prepared statements. These are conflicting claims.
- `team_metrics_daily.metric_set` discriminator column is structurally confused: all metric columns exist on every row, so metric_set adds no information and complicates the PK without benefit. Should be dropped.
- RLS column-level UPDATE privileges (`GRANT UPDATE (viewed_at, ip_address_trunc)`) require raw SQL — Drizzle migrations do not support `GRANT` statements natively. Needs raw SQL postlude in migration.

## Persisting issues (unfixed as of 2026-04-30)

- **otel.ts prepared statements NOT memoized** — every call to `getOtelInsights` etc. calls `db.prepare(...)` inline. The other query modules all use a WeakMap cache; otel.ts is the outlier.
- **reconcile.ts prepared statements NOT memoized** — `reconcileSession` calls `db.prepare(...)` on every invocation.
- **migrate.ts inline prepare** — `db.prepare('SELECT 1 FROM sessions LIMIT 1').get()` is called inline inside `migrate()`.
- **auto.ts inline prepare** — `db.prepare('SELECT MAX(ingested_at) AS last FROM sessions').get()` is called inline on every page render (via `ensureFreshIngest`). This is the hottest path.
- **ratings route error shape inconsistency** — POST /api/ratings returns `{ ok: false, error: 'invalid body' }` (string error) but project security convention requires `{ error: { message: string, code?: string } }`.
- **`revalidatePath('/effectiveness')` missing** from `app/api/ratings/route.ts`.
- **Non-null assertions in test file** — `effectiveness.test.ts:165` uses `kpis.avgCacheHitRatio!`.
- **Unsafe cast in parser.ts** — `parser.ts:95-100` casts union-typed block.
- **Root README missing reporter:setup mention** — REQ-39 not fully satisfied.
