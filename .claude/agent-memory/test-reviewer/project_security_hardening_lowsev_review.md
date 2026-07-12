---
name: security-hardening-lowsev-review
description: 2026-07-12 DRAFT review — auth.config.ts /api/manager gap, manager-alerts.ts token-prefix JOIN regression, migration-0007 testability wall + journal-lag risk, TC-U-01/02 ID collision
metadata:
  type: project
---

Reviewed `.specs/security-hardening-lowsev.md` Test Plan on 2026-07-12 (status DRAFT). Spec hashes
`onboarding_invites.token` at rest (sha256, new `token_prefix` column for UI/audit correlation), adds
`/api/manager/*` to the middleware matcher (401 JSON in SSO mode / 403 Host in localhost mode), and
adds an https-unless-loopback `.refine()` to `central_url`.

## MUST FIX (all confirmed by reading current source, not inferred from spec prose)

1. **`auth.config.ts`'s `authorized()` callback has no `/api/manager` branch.** Only `/manager` and
   `/me` prefixes are special-cased (`auth.config.ts:149-165`); `/api/manager/*` falls through
   `if (!path.startsWith('/manager')) return true;` (line 153) and is treated as authorized
   unconditionally, session or no session. Expanding the middleware `matcher` (the spec's only
   planned change) does NOT achieve REQ-3's SSO-mode 401 gate by itself. `auth.config.ts` is absent
   from Files to Modify.
2. **`manager-alerts.ts:138` and `:180` JOIN `onboarding_redemption_log.token_prefix` against a LIVE
   `LEFT(onboarding_invites.token, 8)`.** Once `token` stores a hash, this join permanently stops
   matching (the log's prefix is captured from historical plaintext at write time; `invites.token`
   becomes a hash) — the manager dashboard's "first auto-provision" alert banner silently returns
   zero rows forever, org-wide. Not mentioned anywhere in the spec (Design, Files to Modify, Test
   Plan). `manager-alerts-banner.test.ts` likely won't catch it either if its fixture raw-INSERTs an
   unhashed literal token, bypassing the real hashing code path.
3. **5+ call sites in `sso-auto-provision.ts` (lines 364, 642, 649, 659, 713, 744) compute
   `tokenPrefix` via `invite.token.slice(0,8)` at runtime.** Post-migration this slices a hash, not
   the plaintext. `ActiveInvite` (`match-active-invites.ts:29-38`) has no `tokenPrefix` field to read
   instead. TC-I-10's wording ("continua funcionando") wouldn't catch this — `tokenPrefix` here only
   feeds audit/log rows, never control flow, so a corrupted value doesn't fail any assertion the TC
   as-worded would make.
4. **TC-I-04 (migration over pre-existing plaintext rows) is structurally infeasible against the
   shared Testcontainers instance.** `tests/integration/setup-pg.ts` applies ALL migrations
   (0000..latest) once in Vitest `globalSetup`, before any test file's `beforeAll` runs — there is no
   "pre-0007" DB state reachable through the standard harness. This exact wall already forced
   `migrate-0004.test.ts`'s TC-I-32 into `it.skip` + a SQL-grep companion (see that file's own
   docstring, lines 12-20, and lines 663-668). The new spec doesn't acknowledge this precedent at
   all — it describes TC-I-04 as an ordinary fixture-seeded integration test.
5. **Migration 0007 risks the journal-lag bug that has already shipped twice in this repo.**
   `apps/server/lib/db/migrations/meta/_journal.json` currently ends at `0006_local_org_seed`.
   Drizzle's production `migrate()` (`lib/db/migrate.ts:120`) only applies migrations registered in
   the journal — unlike the test-only orphan-apply logic in `setup-pg.ts` (lines 56-109) that silently
   papers over the gap in tests. Confirmed real incidents in THIS repo: migration 0003
   (`.specs/fix-e2e-auth-bypass.md:325`) and migrations 0004+0005
   (`.specs/sso-e2e-live-execution.md:602`) both shipped without a journal entry and were silently
   skipped by `pnpm db:migrate` while the test suite stayed green. The spec's "Files to Create" list
   has only the `.sql` file — no `meta/_journal.json` entry, no TASK-SNAPSHOT-equivalent step, no TC
   verifying the production runner (not just the test orphan-apply path) actually applies 0007.
6. **TC-U-01/TC-U-02 collide with pre-existing TC-IDs in `apps/server/lib/auth/tokens.test.ts`**
   (already used for `generateInviteToken`'s hex-format and uniqueness tests, lines 5 and 10). The
   spec skips TC-U-03 — presumably to dodge `generateKeyId`'s existing TC-U-03 (line 20) — but reuses
   01/02 anyway. Inconsistent, and would put two same-ID `it()` blocks testing unrelated functions in
   the same file.
7. **No TC for SSO-mode authenticated-with-correct-role passthrough** (or wrong-role → 403) on
   `/api/manager/*`. Only localhost-mode passthrough (TC-I-09) is tested. REQ-3's own text
   ("autenticada/localhost válido → passa ao handler") and Threat Model item 5 both call for the
   authenticated-SSO branch explicitly. Directly downstream of finding #1 — there's no happy-path SSO
   test that would even catch a broken `authorized()` fix.

## SHOULD FIX
- `scripts/reporter-config-init.ts:35-44` has its own duplicate `ConfigSchema` with the same
  unguarded `central_url: z.string().url()` — needs the same refine (or a shared-schema refactor);
  absent from Files to Modify.
- TC-I-11 (docstring-only, REQ-5, "sem TC executável" by the spec's own admission) sits inside the
  "Integration Tests (apps/server, Postgres real)" table header — same mislabeling pattern flagged
  before in [[project_fix_sso_issuer_host_bridge_review]] (manual-test-posing-as-automated-TC).
- The existing byte-uniformity regression test (`redeem-route.test.ts:583`, literally named
  `TC-I-49`) is only referenced in prose (Validation Criteria) — not table-ized as a tracked TC in
  this spec's own Test Plan.
- TC-I-07/08/09 (middleware) likely need zero Postgres — `authorized()` is Edge-safe with no DB call
  on the relevant paths. Labeling them under the Postgres-real table header risks an implementer
  wrapping them in an unnecessary `SKIP_PG_TESTS` guard, silently cutting fast-feedback coverage for
  no-Docker dev environments.
- `lib/reporter/config.test.ts` does not exist yet — this spec creates the FIRST test file for that
  module. Worth backfilling the pre-existing untested throw paths (file-read failure, JSON-parse
  failure, other missing/invalid fields) while the file is being created, not just the new
  `central_url` refine.
- Substring-attack boundary only covers `localhost.evil.com` (TC-U-06); the `127.0.0.1.evil.com` /
  `[::1].evil.com` variants are untested.

**Why:** this is the most deeply source-verified review in the family so far — every MUST FIX was
confirmed against actual current code (not inferred from the spec's own prose), including direct
greps of two PRIOR specs' Execution Logs proving the journal-lag bug is a recurring, not
hypothetical, failure mode in this exact repo.

**How to apply:** when reviewing any spec that changes what a column *stores* (plaintext → derived
value), grep every read-site of that column across the WHOLE repo (`.slice(`, `LEFT(`, `left(`), not
just the files the spec's own Design section names — `manager-alerts.ts` and `sso-auto-provision.ts`
were both silent casualties the spec author missed by reasoning file-by-file instead of
column-by-column. When reviewing any spec that adds a new numbered Drizzle migration, always check
`meta/_journal.json` is listed in Files to Modify — this repo has shipped the journal-lag bug twice
already (`.specs/fix-e2e-auth-bypass.md:325`, `.specs/sso-e2e-live-execution.md:602`). When a TC
plans to seed "pre-existing" DB state for a migration test, check `tests/integration/setup-pg.ts`
first — the shared-container-migrates-everything-upfront pattern makes that infeasible without a
dedicated harness, and `migrate-0004.test.ts` (TC-I-32/32b) is the established skip+grep-companion
precedent to follow or consciously upgrade from.
