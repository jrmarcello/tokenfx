---
name: project-security-hardening-lowsev
description: security-hardening-lowsev.md spec review (2026-07-12) — MUST-FIX gaps found in invite-token-hash migration + /api/manager middleware gate; also a reusable apps/server migration gotcha
metadata:
  type: project
---

Spec `.specs/security-hardening-lowsev.md` reviewed 2026-07-12, status DRAFT at review time. Item 3.4 of `docs/execution-plan-2026-07.md` (4 MED/LOW security findings: invite-token hash-at-rest, `/api/manager/*` middleware matcher gap, `/api/ingest` docstring drift, `central_url` https-unless-loopback).

## Findings that must be re-checked when this spec's next iteration/implementation is reviewed

1. **`apps/server/lib/auth/auth.config.ts`'s `authorized()` callback has NO branch for `/api/manager` paths** (only `/me` and `/manager`). For any path not starting with `/manager` or `/me` it falls through to `return true` unconditionally. The spec's REQ-3 (401 JSON for unauthenticated `/api/manager/*` in SSO mode) is designed as a `middleware.ts`-only fix (matcher extension), but the actual gating decision lives in `authorized()` — extending just the matcher routes `/api/manager/*` through `ssoMiddleware` → `authorized()` → unconditional `true`. The fix needs a new branch in `auth.config.ts` mirroring the existing pattern of returning a `NextResponse` directly from `authorized()` (already done there for `/manager/admin` 403s, lines ~159-164). **This file was missing from every task's `files:` list.**

2. **General, reusable fact for ANY future apps/server migration spec**: `apps/server/lib/db/migrate.ts` uses `drizzle-orm/node-postgres/migrator`'s `migrate()`, which discovers migrations via `apps/server/lib/db/migrations/meta/_journal.json` (NOT by globbing `*.sql`). Every migration 0000-0006 has a journal entry (`{idx, version, when, tag, breakpoints}`), even though per-migration `meta/NNNN_snapshot.json` files only exist for 0000/0001 (snapshot generation was abandoned once migrations became hand-crafted, starting ~0002/0004). **Any spec adding a new migration file MUST also add its `_journal.json` entry, or the migration is silently never applied.** This spec's Design/Files-to-Create section listed only the `.sql` file, not the journal update — flagged as MUST FIX.

3. **Hidden consumers of `onboarding_invites.token`'s plaintext-prefix assumption**, beyond what the spec's own "Consumidores do token a ajustar" grep found:
   - `apps/server/lib/queries/manager-alerts.ts` (`loadFirstAutoProvisionAlert` line ~138, `acknowledgeAlert` line ~228) JOINs `onboarding_redemption_log.token_prefix = LEFT(onboarding_invites.token, 8)` — breaks silently (zero matches) once `token` is a hash. Not listed in any task. There IS an existing integration test (`apps/server/tests/integration/manager-alerts-banner.test.ts`) that would likely catch this at `pnpm test:server` time — not a silent-to-prod risk, but unplanned rework.
   - `apps/server/lib/auth/sso-auto-provision.ts` (3 call sites: lines ~364, ~641-642, ~659) and `apps/server/lib/auth/match-active-invites.ts` (`ActiveInvite` type + select never expose `token_prefix`) derive audit-log prefixes via `.token.slice(0,8)` — post-hash this writes the hash's prefix into `onboarding_redemption_log.token_prefix`, contradicting the spec's own Threat Model §6 invariant ("token_prefix continua sendo o único identificador exibido/logado"). The spec's reasoning ("hash serve, não precisa de plaintext") answered the wrong question — these paths don't need plaintext, but they DO need the *correct* prefix, which requires reading the new `token_prefix` column, not slicing `.token`.

4. **pgcrypto IS available** — `apps/server/lib/db/migrations/0000_init.sql:5` has `CREATE EXTENSION IF NOT EXISTS pgcrypto;`, a hard dependency of the whole schema (used for `gen_random_uuid()` everywhere). The spec hedged between pgcrypto `digest()` and "JS-hash-in-runner... o padrão deste repo em `lib/db/migrate.ts`" — that file reference is WRONG (it's the root project's unrelated SQLite migrator for the personal-dashboard app, not `apps/server`'s Postgres/Drizzle migrator). The real project precedent for avoiding pgcrypto (`apps/server/lib/queries/audit-log.ts:234-267`, cited also in `.specs/central-server-onboarding-v2-sso.manager-ui.md:848`) is about a repeated *query-time* portability concern, not a one-time migration — doesn't transfer here. Correct call: use SQL-side `digest()`/`sha256()` directly in the migration file.

5. Migration's data-mutation step (`UPDATE token = hash(token)`) has no idempotency guard, and a naive length/format check can't distinguish plaintext from hash — both are 64 lowercase hex chars (`generateInviteToken` = `randomBytes(32).toString('hex')`; `sha256(...).digest('hex')` = same shape). Must gate on the new `token_prefix` column being NULL, combining backfill+hash into one statement.

## Why

These are exactly the kind of "spec looks complete, self-review claims a grep was done, but cross-cutting consumers were missed" gaps that recur in this codebase's SSO/onboarding spec chain (see also [[project_sso_threat_model]] for a similar pattern in spec (b)/(c)). Worth checking proactively next time too: grep the WHOLE `apps/server` tree for `onboardingInvites.token` / `left(token` / `token.slice(0, 8)` / `token.slice(0,8)` before declaring a "consumers verified" list complete.

## How to apply

When `security-hardening-lowsev.md` is re-reviewed (post-fix) or executed via `/ralph-loop`, verify: (a) `auth.config.ts` is in TASK-4's scope with a passing TC for `/api/manager/*` + no session → 401 JSON, (b) `_journal.json` has the 0007 entry, (c) `manager-alerts.ts` + `sso-auto-provision.ts` + `match-active-invites.ts` all read `token_prefix` (not `token`) for display/audit purposes, (d) the migration uses SQL-side hashing with a `token_prefix IS NULL` idempotency guard. Also apply fact #2 (journal requirement) to ANY other spec that adds an `apps/server/lib/db/migrations/*.sql` file.
