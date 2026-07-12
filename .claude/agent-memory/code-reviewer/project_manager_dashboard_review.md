---
name: manager-dashboard apps/server review (2026-07-11)
description: Findings from reviewing apps/server manager dashboard pages, Drizzle queries, auth wiring, ingest API, CSV export
metadata:
  type: project
---

Reviewed apps/server (Next.js 15 + Postgres + Drizzle + NextAuth v5) manager dashboard end-to-end: pages, queries, middleware/auth wiring, reporter ingest API, CSV export, alert-ack org scoping.

**Why:** recorded so future reviews of this app don't re-derive the same architectural facts and know which issues are still open.

**How to apply:** reference when reviewing new manager-dashboard pages, Drizzle queries, or auth changes in apps/server.

## Confirmed correct (don't re-flag)

- `fix-manager-alert-ack-org-scoping.md` fix is fully applied: `performDismissAnomaly` in `lib/queries/manager-dismissed.ts` is the single source of truth for cross-org guard + UPSERT; both `app/api/manager/dismiss-anomaly/route.ts` and `app/manager/health/dismiss-action.ts` delegate to it identically.
- Middleware matcher only covers `/manager/*` and `/me/*`, but every route outside it (`/api/manager/dismiss-anomaly`, `/api/internal/cron/*`, `/api/admin/cleanup`, `/api/ingest`, `/api/onboarding/*`) self-gates via session-role check or constant-time shared-secret compare (`assertInternalCronAuth`, bearer-auth). No auth gap.
- `_drilldown/render.tsx` (shared by `/manager/devs/[devId]` and `/manager/check-in/[devId]`) has explicit cross-org `notFound()` guard PLUS a type-level required `audit: AuditContext` param on every `lib/queries/manager-drilldown.ts` export — makes it a compile error to query dev-level data without writing the audit row first. Good pattern, worth citing as the reference implementation for anti-surveillance features.
- E2E auth bypass guard (`lib/auth/e2e-bypass-provider.ts assertNotProductionWithBypass`) matches CLAUDE.md's documented `TOKENFX_AUTH_BYPASS_ALLOWED` contract exactly.
- CSV export routes (`audit-log/export`, `teams/[id]/export`) have CSRF-on-GET same-origin guards, cross-org 404s (anti-probing), row-cap truncation headers, never leak plaintext email (peppered hash prefix only via `lib/csv/format.ts` which has a correct OWASP formula-injection guard).
- `/api/ingest` batch endpoint: two-level Zod validation, bcrypt+60s-cache bearer auth, SHA-256 payload idempotency, per-machine rate limit, single-transaction rollback.

## Open findings (not yet fixed as of 2026-07-11)

1. SHOULD FIX: `/manager/outcomes` and `/manager/audit-log` pages are fully built and working but have **no persistent nav link** in `app/manager/layout.tsx`. Outcomes is referenced nowhere outside its own page/tests. Audit-log is only reachable via the one-shot `FirstAutoProvisionBanner`. Biggest "looks unfinished in a demo" risk in the app even though nothing is actually broken. There's already a `{/* Section: nav-links */}` anchor comment in layout.tsx clearly intended for exactly this addition.

2. SHOULD FIX: `components/manager/trend-chart.tsx` `currency-usd` formatter is fixed at 2 decimal places. Used by `app/manager/outcomes/page.tsx` for the cost-per-merged-LOC trend chart, where typical values are $0.001–$0.05 — will render as a flat "$0.00" line while the KPI tile above it (using `formatCurrency4`, 4dp) shows real precision. Needs a 4dp `TrendValueFormat` variant.

3. SHOULD FIX: no `loading.tsx`/`error.tsx` for most manager routes — only `manager/invites/*` and `manager/audit-log/*` have them. `/manager`, `/manager/teams`, `/manager/effectiveness`, `/manager/outcomes`, `/manager/health`, `/manager/admin/users`, drilldown pages all lack both. Blank-page-until-fully-loaded + generic Next.js error page on DB hiccup during a live demo.

4. SHOULD FIX (perf, cross-ref data-reviewer): `lib/queries/overview.ts:loadSessionsForOrg` — the `session_model_cost`/`session_dominant` CTE scans `model_breakdown_agg` with no org filter before joining down to the already-org-scoped `s`/`u`. Not a tenant leak (final rows still correctly scoped) but a full cross-tenant table scan on `/manager`'s hot path.

5. NICE TO HAVE: `app/manager/effectiveness/page.tsx:26-31` doc comment says compositeAvg is a "placeholder" — code has since moved on to correctly read `team_metrics_daily.composite_avg` with a documented fallback. Comment is stale, not the code.

6. NICE TO HAVE: prepared statements not memoized in `lib/queries/overview.ts` / `lib/queries/manager-v2.ts` (same debt pattern already flagged for `otel.ts`/`reconcile.ts` in [[project_state]]).
