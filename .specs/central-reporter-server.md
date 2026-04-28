# Spec: central-reporter-server — manager view across many devs (cost + adoption MVP)

## Status: DRAFT

## Context

TokenFx today is local-first, single-user. Each dev runs the dashboard against their own `~/.claude/projects/` JSONL transcripts and a local SQLite DB. There is no way for a manager to see **org-wide** Claude Code consumption (cost) or **adoption** (DAU/WAU/MAU, who's actually using it) — yet that's the question every engineering leader funding the seat actually has.

This spec ships the **MVP of a centralized manager view**, scoped intentionally narrow:

- **Q2-A — Cost**: org-wide spend, calibrated (Claude Max ratio aware); per-team and per-user spend trends.
- **Q2-B — Adoption**: DAU/WAU/MAU, total active users, per-team active users.

Effectiveness/health metrics (composite score, correction density, rating distribution at org scope) are **explicitly out of scope** here — they ship in a follow-up spec once cost+adoption are validated against real data. Same for individual-vs-individual rankings (deliberate non-goal — privacy + culture concern).

### Architecture (LOCKED)

Decisions are not up for debate in this spec. They're encoded as REQs that the implementation must satisfy:

1. **Sibling app, same repo**: a new Next.js 15 app at `apps/server/` with its own `package.json`. The existing `app/` (personal dashboard) is untouched. Shared code (`lib/analytics/*`, `lib/db/types.ts` for shared row shapes) is imported via TypeScript path mapping — **no pnpm workspace migration**. Rationale: workspaces add an entire toolchain layer (lockfile reshuffles, hooks rewrite, CI-matrix work, two `node_modules` graphs) for one shared `lib/` dir that two apps read. Path mapping costs one `tsconfig.json` line and ships today.
2. **Backend**: Postgres for the central server. `better-sqlite3` is for the local app **only**; never imported from `apps/server/`.
3. **Auth**: NextAuth (Auth.js v5) with Google Workspace + Okta providers (env-configurable). Role gating via a `users.role` column.
4. **Push reporter**, not pull: each dev's local TokenFx runs an opt-in reporter (`lib/reporter/`) that ships **sanitized aggregates** to the central server. Pull is impossible — transcripts live on each dev's machine.
5. **Local-first preserved**: reporter is opt-in. Devs without a reporter still get the existing personal dashboard, unchanged.
6. **Privacy-by-construction**: a Zod allowlist drops anything not on the explicit allowed-fields list before serialization. Prompt content, assistant text, tool inputs/results, full filesystem paths, and rating notes never leave the dev's machine.

### Decisions locked (must trace to code)

| Decision | Reason | REQ |
| --- | --- | --- |
| Sibling app at `apps/server/`, no pnpm-workspaces | Smallest delta to ship; no toolchain churn | REQ-30 |
| Postgres central | Multi-user concurrency, real types, JSON columns; SQLite limited | REQ-12 |
| **Drizzle ORM** (not Kysely) | Schema-first TS types match our "Zod at boundary, typed everywhere" pattern; built-in migration generator; lighter than Prisma | REQ-13 |
| HMAC-SHA256 over canonical JSON for reporter signing | Symmetric secret per dev; proof-of-origin without PKI infra; canonical JSON ensures signature stable | REQ-5 |
| Idempotency key = `(user_id, session_id, payload_hash)` | Re-pushing the same session is a no-op; mutation only when payload changes | REQ-15 |
| Per-machine secret + per-dev install (not per-user-account) | Devs may use multiple machines; rotating one doesn't disrupt others; the per-machine `machine_id` lands in `ingestion_log` for audit | REQ-7 |
| Postgres test strategy: **Testcontainers (real Postgres in Docker)**, NOT a SQLite adapter | We use Postgres-only features (`JSONB`, `ON CONFLICT (...) DO UPDATE`, `tstzrange`, generated columns); SQLite-shim adapters silently misrepresent behavior. CI cost is one-time container pull. Local fallback: skip with `SKIP_PG_TESTS=1`. | REQ-22 |
| Reporter offline buffer = separate SQLite file `data/reporter-queue.db` | Doesn't pollute the dashboard DB; trivial to wipe on auth failure; reuses `better-sqlite3` already on disk | REQ-9 |
| **NO** dev-vs-dev ranking, **NO** per-session drill-down for managers in v1 | Privacy + culture; aggregate-only view; revisit only after explicit org consent feature | REQ-26 |
| **NO** Server Actions on `apps/server/` ingestion route | External CLI/cron caller — Route Handler with HMAC is the right primitive | REQ-14 |
| Cost calibration on the server **reuses the local heuristic** by importing `lib/analytics/cost-calibration.ts`'s pure helper, but the calibration **table** is per-user (each dev has their own Claude plan ratio) | Different devs may be on different plans (Pro vs Max5x vs Max20x); a global org rate would mis-attribute by 4× | REQ-19 |

## Requirements

> Every REQ uses GIVEN/WHEN/THEN. Inclusivity of bounds is stated explicitly.

### Reporter (in current repo, scope to dev's machine)

- [ ] **REQ-1 (privacy allowlist — strict)**: GIVEN a sanitized payload is being constructed for a session WHEN any field outside the explicit allowlist is present in the input row THEN it MUST NOT appear in the output payload, regardless of its content. Allowlist (frozen): `session_id`, `started_at`, `ended_at`, `project_slug`, `git_branch`, `cc_version`, `total_input_tokens`, `total_output_tokens`, `total_cache_read_tokens`, `total_cache_creation_tokens`, `total_cost_usd`, `total_cost_usd_otel`, `turn_count`, `tool_call_count`, `model_breakdown[]` (each: `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`), `tool_counts` (map of `tool_name -> count`), `avg_rating` (number or null), `cache_hit_ratio`, `output_input_ratio`, `subagent_usage_ratio`. **PROHIBITED — must never appear**: `user_prompt`, `assistant_text`, `tool_uses_json`, `tool_calls.input_json`, `tool_calls.result_json`, full `cwd`, `source_file`, ratings notes (only the `rating` numeric stays).
- [ ] **REQ-2 (project_slug derivation)**: GIVEN a session row with `cwd = "/Users/alice/work/secret-project-roadmap"` and `project = "-Users-alice-work-secret-project-roadmap"` WHEN the sanitizer derives `project_slug` THEN the output is **HMAC-SHA256(project_secret, last_path_segment)** truncated to first 16 hex chars (e.g. `slug:a3f81b29c4d7e612`). Rationale: stable across pushes for the same project (so manager sees grouping) but non-reversible (manager cannot recover `secret-project-roadmap`). The `project_secret` is per-dev install (different from the auth HMAC secret), persisted in `data/reporter-config.json`.
- [ ] **REQ-3 (Zod schema is the boundary)**: GIVEN the sanitizer produces a `SanitizedSessionPayload` WHEN any field violates the Zod schema (wrong type, NaN, negative count, unknown field via `.strict()`) THEN sanitization returns `{ ok: false, error }` and the session is NOT pushed. The schema MUST use `.strict()` on every object so unknown keys are rejected, not silently stripped — defense against adding a field upstream and forgetting to extend the allowlist.
- [ ] **REQ-4 (red-team fuzz)**: GIVEN a synthetic input row that injects 100+ random extra fields with names like `secret_key`, `__proto__`, `password`, `prompt_text` WHEN sanitizer runs THEN none of those keys appear in the output payload (verified by deep-key inspection in test).
- [ ] **REQ-5 (HMAC signing)**: GIVEN a sanitized payload `P` and the per-machine secret `S` WHEN `signer.sign(P, S)` runs THEN the signature is `hex(HMAC-SHA256(S, canonicalJSON(P)))`, where `canonicalJSON` sorts object keys lexicographically at every level and uses no whitespace. The signed envelope is `{ payload: P, signature, key_id, machine_id, version }` where `version=1`.
- [ ] **REQ-6 (signature stability)**: GIVEN the same payload `P` (logically equal but with key order or whitespace differences) WHEN signed twice THEN both signatures are byte-equal — proves canonical JSON is deterministic.
- [ ] **REQ-7 (per-machine secret — provisioning is a separate spec)**: GIVEN a dev's machine has been provisioned with `(key_id, secret, machine_id, user_email, central_url)` THEN those values live in `data/reporter-config.json` (file mode 0600) and are read by the runner. **The provisioning flow itself (how the dev acquires `key_id` + `secret` from the central server) is out of scope for this spec** — see the follow-up spec `central-server-onboarding.md` (invite-token redemption flow + admin invite UI). For v0 of THIS spec (testing/dev), `user_machines` rows are seeded directly via SQL or `apps/server/scripts/seed-server.ts`, and `data/reporter-config.json` is written by hand. Once `central-server-onboarding.md` ships, `pnpm reporter:setup` becomes the user-facing entry point. The shape of `data/reporter-config.json` is locked here so both specs target the same artifact: `{ key_id: string, secret: string, machine_id: string (uuid), user_email: string, central_url: string, project_secret: string }`. `project_secret` is generated locally on first run if absent (32 random bytes hex) — independent of the central-server secret.
- [ ] **REQ-8 (push client retries)**: GIVEN the reporter posts a batch to `${TOKENFX_CENTRAL_URL}/api/ingest` WHEN the request fails with HTTP 5xx or network error THEN retry with exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (max 6 attempts, max 63s total). HTTP 4xx (except 429) does NOT retry — it's a contract bug, not a transient. HTTP 429 honors `Retry-After` header up to 60s.
- [ ] **REQ-9 (offline buffer)**: GIVEN the central server is unreachable for >10 minutes WHEN the runner triggers and queue length > 0 THEN sessions accumulate in `data/reporter-queue.db` (separate SQLite, schema: `id PRIMARY KEY, session_id, payload_hash, created_at, attempt_count, last_error`). On reconnection, oldest-first drain. Queue is **bounded** at 10,000 entries — beyond that, oldest dropped with `lib/logger.warn` (not silently).
- [ ] **REQ-10 (runner cadence)**: GIVEN `pnpm reporter:run` (or the scheduled cron/launchd unit) fires WHEN it executes THEN it: (a) selects sessions with `started_at >= last_pushed_at - 1h` OR `ingested_at > last_pushed_at` (catches updates), (b) sanitizes each, (c) batches up to 50 per request, (d) pushes, (e) on success records `last_pushed_at` per session in a new local table `reporter_pushed_sessions(session_id PK, payload_hash, pushed_at)`. The 1h overlap window catches OTEL-late updates without exploding payload size.
- [ ] **REQ-11 (reporter is opt-in — concrete gate)**: GIVEN a dev never provisioned `data/reporter-config.json` WHEN they use TokenFx normally (`pnpm dev`, `pnpm ingest`, `pnpm watch`) THEN no network call to any external host happens. Two structural guarantees enforce this: (a) **No transitive import** — `lib/reporter/**` is NEVER imported by `app/**`, `lib/queries/**`, or `lib/ingest/**`. Verifiable via `grep -rE "from ['\"]@?/?lib/reporter" app/ lib/queries/ lib/ingest/` returning zero matches (CI assertion in TC-I-11). (b) **Runtime gate** — every reporter entry point (`scripts/reporter-once.ts`, `scripts/reporter-setup.ts`, the `runReporter()` exported by `lib/reporter/runner.ts`) checks `fs.existsSync(path.join(process.cwd(), 'data/reporter-config.json'))` as the FIRST line; if absent, logs `info` "reporter not configured (run pnpm reporter:setup)" and returns without any further imports of `client.ts`/`signer.ts` (lazy-imported AFTER the gate). Test: `rm data/reporter-config.json && pnpm reporter:run` exits 0 with the info log and zero outbound network (asserted via `nock.disableNetConnect()` for the test duration).

### Central server (`apps/server/`)

- [ ] **REQ-12 (Postgres schema)**: GIVEN the server starts with a fresh empty Postgres database WHEN migrations run THEN the schema includes tables: `orgs`, `teams`, `users`, `user_machines` (one user → many machines, each with its own HMAC secret hash), `sessions_agg` (one row per `(user_id, session_id)`), `model_breakdown_agg`, `tool_count_agg`, `ingestion_log`, `cost_calibration_per_user`. Schema spelled out under Design.
- [ ] **REQ-13 (Drizzle ORM)**: GIVEN any DB access in `apps/server/` WHEN it executes THEN it goes through Drizzle (no raw `pg.Client.query` strings except in the migration runner and emergency CLI tools). Schema lives in `apps/server/lib/db/schema.ts`. Migrations are generated via `drizzle-kit generate` and committed to `apps/server/lib/db/migrations/`.
- [ ] **REQ-14 (ingest route)**: GIVEN `POST /api/ingest` receives a request WHEN the request body is valid THEN: (a) signature verified against `user_machines.secret_hash` lookup by `key_id`; (b) Zod-validated against `SanitizedSessionPayload[]`; (c) UPSERT on `(user_id, session_id)` — payload hash compared, no-op if unchanged; (d) `ingestion_log` row written; (e) response `{ accepted: number, skipped: number, rejected: number, errors: Array<{session_id, reason}> }`. Bad signature → 401; malformed body → 400; unknown `key_id` → 401; rate limit (per-machine 100 req/min) → 429.
- [ ] **REQ-15 (idempotency)**: GIVEN the same payload is posted twice WHEN the second request lands THEN `accepted=0, skipped=N` (payload hash matches existing row); `ingestion_log` still records the second request (audit trail). GIVEN the payload changed WHEN posted THEN `accepted=N`, the row is updated, and `ingestion_log` records the diff (size_bytes_before, size_bytes_after).
- [ ] **REQ-16 (auth — SSO)**: GIVEN a user navigates to `/manager` unauthenticated WHEN the middleware runs THEN they're redirected to `/api/auth/signin` (NextAuth). On callback, the user is upserted into `users` (key: SSO `email` + `provider`). Role default = `member`.
- [ ] **REQ-17 (auth — role gating)**: GIVEN a user with `role = 'member'` WHEN they hit any `/manager/*` route THEN middleware returns 403 with a friendly "no manager access" page. `role IN ('manager', 'admin')` allows entry. Admin-only: `/manager/admin/*` (role assignment). Roles assigned via direct DB or admin UI.
- [ ] **REQ-18 (manager overview — cost)**: GIVEN the org has ≥1 user with sessions in the last 30d WHEN a manager visits `/manager` THEN the page shows: (a) total org spend (calibrated, sum of `effective_cost_usd` per session) for 7d/30d/90d, (b) trend curve (daily) for 30d, (c) breakdown by team (table: team name, spend 30d, active_users_7d, sparkline), (d) source mix tooltip ("X otel · Y calibrated · Z list").
- [ ] **REQ-19 (per-user calibration)**: GIVEN user A pushes sessions with OTEL data and user B does not WHEN the server computes calibrated cost THEN user A's effective cost uses user A's own ratio (recomputed on every ingest); user B's effective cost falls back to the org-global ratio (sum of OTEL/local across all users). The per-user calibration table key is `(user_id, family)`. Reuses `effectiveCostForSession` from `lib/analytics/cost-calibration.ts` directly — Postgres adapter loads the calibration map once per request.
- [ ] **REQ-20 (manager overview — adoption)**: GIVEN ≥1 user has session activity THEN `/manager` displays DAU (last 1d), WAU (last 7d), MAU (last 30d) — defined as **distinct users with ≥1 session whose `started_at` falls in the window**. Includes a DAU 30-day trend curve. "Total seats" is `count(users)`; "Active 30d" is MAU; "Activation %" = MAU/seats.
- [ ] **REQ-21 (team detail)**: GIVEN a manager visits `/manager/teams/[id]` WHEN the team has ≥1 user THEN the page shows: (a) team spend trend, (b) per-user spend table (alphabetical, NOT ranked by spend — anti-leaderboard) showing `email | sessions_30d | spend_30d` only, (c) DAU 30d for the team, (d) top 10 project_slugs by spend (slugs only — non-reversible). NO drill-down into individual sessions in v1.
- [ ] **REQ-22 (Postgres test strategy)**: GIVEN integration tests for ingestion and queries WHEN the test suite runs THEN tests use **Testcontainers** to spin up a real Postgres 16 container; the container is shared across the suite (one `globalSetup`); `SKIP_PG_TESTS=1` env var skips with `it.skip` so devs without Docker can run unit tests only. Migrations run once at container startup.
- [ ] **REQ-23 (privacy boundary doc)**: GIVEN a new dev or stakeholder reads `apps/server/README.md` WHEN they finish the Privacy section THEN they see: (a) the exact allowlist, (b) what is NEVER sent (with examples), (c) how to audit a payload before push (`pnpm reporter:once --dry-run` prints the JSON), (d) revocation procedure (rotate machine secret on central server). Same section linked from root `README.md`.
- [ ] **REQ-24 (CI for both apps)**: GIVEN a PR touches `apps/server/**` or root `lib/**` WHEN CI runs THEN both `pnpm typecheck` and `pnpm typecheck:server` execute; same for `lint`, `test`, `build`. Hook scripts (`stop-validate.sh`) updated to discover and run both.
- [ ] **REQ-25 (sanitizer reused server-side at the boundary, defense-in-depth)**: GIVEN the server receives a payload WHEN it parses the body THEN it runs the SAME `SanitizedSessionPayload` Zod schema (imported from a shared location, see Design) — even though clients are trusted to sanitize, the server re-validates. Catches: (a) compromised reporter pushing prohibited fields, (b) future bugs in the reporter that leak data.
- [ ] **REQ-26 (no rankings, no drill-down)**: GIVEN a manager view in v1 WHEN any UI renders a per-user list THEN it is alphabetical or grouped by team — never sorted descending by spend. No route exists at `/manager/users/[id]/sessions/[session_id]` — the central server stores aggregates only, no per-turn data, so drill-down is structurally impossible.
- [ ] **REQ-27 (machine_id in audit log)**: GIVEN an ingestion request lands WHEN `ingestion_log` is written THEN the row includes `machine_id`, `payload_size_bytes`, `accepted_count`, `rejected_count`, `received_at`, `user_id`, `request_ip` (truncated /24 for IPv4, /48 for IPv6 — minimal forensic, max privacy). `request_ip` purges to NULL after 30 days via a daily cleanup query.
- [ ] **REQ-28 (empty states)**: GIVEN an org with zero users (fresh install, admin only) WHEN visiting `/manager` THEN the page renders an onboarding card: "No data yet — share `pnpm reporter:setup` URL with your team." No crash, no NaN, no 500.
- [ ] **REQ-29 (reporter dry-run)**: GIVEN `pnpm reporter:once --dry-run` runs WHEN it executes THEN it prints the canonical JSON of the next batch to stdout and exits — no network, no DB write. Used for privacy audits.
- [ ] **REQ-30 (no workspace migration)**: GIVEN the repo structure WHEN `apps/server/` imports from `lib/analytics/` or `lib/db/types.ts` THEN it does so via TypeScript path mapping in `apps/server/tsconfig.json` (`"paths": { "@root/*": ["../../lib/*"] }`); root `package.json` is unchanged in dependency layout (sibling `apps/server/package.json` has its own deps); no `pnpm-workspace.yaml` is added.

## Test Plan

> Privacy is paramount — error/security TCs heavily outnumber happy paths. Coverage target: every REQ ≥1 TC; every Zod field with a boundary; every route with happy + each error status + idempotency; every external dep (HTTP, Postgres, signing) with an infra-failure TC.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | Sanitizer with valid full row → produces payload with all 20 allowed fields (counting `model_breakdown[]` and `tool_counts` as 1 each) | All allowlist fields present, types correct |
| TC-U-02 | REQ-1 | security | Input row carries `user_prompt: "secret credentials"` → sanitize | Output deep-key set does NOT contain `user_prompt`; assert via `JSON.stringify(out).includes("secret credentials") === false` |
| TC-U-03 | REQ-1 | security | Input row carries `assistant_text` (entire transcript) → sanitize | Field absent in output; transcript content not present anywhere |
| TC-U-04 | REQ-1 | security | Input row carries `tool_uses_json: '[{"input":{"path":"/Users/alice/.ssh/id_rsa"}}]'` → sanitize | Field absent; `id_rsa` substring not present in any output value |
| TC-U-05 | REQ-1 | security | Input row carries `cwd: "/Users/alice/private"` and `source_file: "/Users/alice/.claude/projects/x.jsonl"` → sanitize | Neither field present; `/Users/alice` not present in any output value |
| TC-U-06 | REQ-1 | security | Input row carries rating note `note: "the model leaked my AWS key"` → sanitize | `note` not in output; only the numeric `rating` value bubbles up via `avg_rating` |
| TC-U-07 | REQ-4 | security | **Red-team fuzz**: input row spread with 100 randomly named extra fields including `password`, `__proto__`, `prompt_text`, `private_key`, `secret_token`, `apiKey`, `auth.bearer` | Zero of those keys appear in output; deep walker confirms |
| TC-U-08 | REQ-3 | validation | Zod `.strict()` rejects unknown key `foo` injected at root | `{ ok: false, error: ZodError }` |
| TC-U-09 | REQ-3 | validation | Zod rejects negative `total_input_tokens = -5` | `{ ok: false }` |
| TC-U-10 | REQ-3 | validation | Zod rejects `total_input_tokens = NaN` | `{ ok: false }` |
| TC-U-11 | REQ-3 | validation | Zod rejects `total_input_tokens = Infinity` | `{ ok: false }` |
| TC-U-12 | REQ-3 | boundary | Zod accepts `total_input_tokens = 0` (valid min, inclusive) | `{ ok: true }` |
| TC-U-13 | REQ-3 | boundary | Zod accepts `total_input_tokens = Number.MAX_SAFE_INTEGER` | `{ ok: true }` |
| TC-U-14 | REQ-3 | boundary | Zod rejects `total_input_tokens = Number.MAX_SAFE_INTEGER + 1` (loses precision) | `{ ok: false }` |
| TC-U-15 | REQ-3 | boundary | Zod rejects `started_at > ended_at` (logical invariant) | `{ ok: false }` |
| TC-U-16 | REQ-3 | boundary | Zod accepts `avg_rating = null` | `{ ok: true }` |
| TC-U-17 | REQ-3 | validation | Zod rejects `avg_rating = 2` (out of [-1,1]) | `{ ok: false }` |
| TC-U-18 | REQ-3 | validation | Zod rejects `avg_rating = -1.0001` | `{ ok: false }` |
| TC-U-19 | REQ-3 | boundary | Zod accepts `avg_rating = -1` and `avg_rating = 1` (boundary inclusive) | `{ ok: true }` |
| TC-U-20 | REQ-2 | happy | `deriveProjectSlug("/Users/alice/work/foo", secret="abc")` → `slug:<16hex>` | Output matches `^slug:[0-9a-f]{16}$`; deterministic across calls |
| TC-U-21 | REQ-2 | security | Same project path with two different secrets produces two different slugs | Slugs differ; non-correlatable across orgs |
| TC-U-22 | REQ-2 | edge | `cwd` ending in trailing slash, `cwd` with unicode, `cwd` empty | All produce valid slug; empty cwd → `slug:empty` constant or rejected (decision: rejected with sanitizer error) |
| TC-U-23 | REQ-5 | happy | `signer.sign(payload, secret)` → 64-hex-char signature | Length = 64, all `[0-9a-f]` |
| TC-U-24 | REQ-6 | happy | Sign same logical payload with key reorder + whitespace differences | Both signatures byte-equal |
| TC-U-25 | REQ-5 | security | `signer.verify(payload, sig, secret)` with 1-byte-tampered payload | Returns `false` |
| TC-U-26 | REQ-5 | security | `signer.verify` with wrong secret | Returns `false` |
| TC-U-27 | REQ-5 | edge | Empty payload `{}` is signable and verifiable | Roundtrip works |
| TC-U-28 | REQ-1 | happy | `model_breakdown` array of 3 models, each with 5 numeric fields | All present, no extras |
| TC-U-29 | REQ-1 | security | `model_breakdown[0]` carries injected `prompt: "secret"` | `prompt` not in output; rest of model entry valid |
| TC-U-30 | REQ-1 | happy | `tool_counts: {Edit: 12, Read: 30}` | Output map shape preserved; values non-negative |
| TC-U-31 | REQ-1 | validation | `tool_counts: {Edit: -1}` | Sanitizer rejects (negative) |
| TC-U-32 | REQ-19 | business | `effectiveCostForSession` reused from `lib/analytics/cost-calibration.ts` with per-user calibration map | Same cascade behavior as local — verified by importing existing tests |

### Integration Tests — reporter (root repo)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| ~~TC-I-01~~ | — | — | **MOVED to `central-server-onboarding.md`** (interactive setup happy path) | — |
| ~~TC-I-02~~ | — | — | **MOVED to `central-server-onboarding.md`** (interactive setup, server unreachable) | — |
| TC-I-01a | REQ-7 | happy | Hand-written `data/reporter-config.json` with all required fields → `runReporter()` reads and proceeds | Config parsed, runner uses values |
| TC-I-01b | REQ-7 | validation | `data/reporter-config.json` missing `key_id` field → `runReporter()` exits with clear error | Non-zero exit; error names the missing field |
| TC-I-01c | REQ-7 | happy | Config exists without `project_secret` → `scripts/reporter-config-init.ts` generates 32-byte hex and writes back | File updated with `project_secret`; mode preserved at 0600 |
| TC-I-03 | REQ-8 | infra | Push to mock server returning 500, then 200 | Retries with backoff; second attempt succeeds; `attempt_count` recorded |
| TC-I-04 | REQ-8 | edge | Push to mock returning 400 | NO retry; logs error; queue entry stays for inspection |
| TC-I-05 | REQ-8 | edge | Push to mock returning 429 with `Retry-After: 5` | Waits 5s, retries once, succeeds |
| TC-I-06 | REQ-9 | happy | Server unreachable for 3 push cycles | Queue grows to 3 entries; on connectivity, all drained oldest-first |
| TC-I-07 | REQ-9 | edge | Queue length hits 10,000 → push 10,001st session | Oldest dropped; warn logged; session count cap respected |
| TC-I-08 | REQ-10 | happy | Runner against seeded local DB with 30 sessions | Sanitizes 30, batches in `ceil(30/50) = 1` request; records `last_pushed_at` for all |
| TC-I-09 | REQ-10 | idempotency | Run runner twice in a row with no new sessions | Second run pushes 0 sessions (all `payload_hash` unchanged) |
| TC-I-10 | REQ-10 | business | Session updated locally (rating added) → next runner cycle | Re-pushed with new payload_hash; server registers update |
| TC-I-11 | REQ-11 | security | Run `pnpm dev` (personal dashboard) without setup | Zero outbound network calls; reporter module not loaded (verified via require-tree inspection or environment guard) |
| TC-I-12 | REQ-29 | happy | `pnpm reporter:once --dry-run` against seeded local DB | Prints canonical JSON; no network; no DB writes |

### Integration Tests — central server (`apps/server/`, Testcontainers)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-20 | REQ-12, REQ-13 | infra | Migrations run from empty Postgres | All tables created; idempotent re-run no-ops |
| TC-I-21 | REQ-14 | happy | `POST /api/ingest` with valid signed batch of 5 sessions | 200; body `{accepted: 5, skipped: 0, rejected: 0}`; rows present |
| TC-I-22 | REQ-14 | security | Tampered signature | 401; no DB write |
| TC-I-23 | REQ-14 | security | Unknown `key_id` | 401; no DB write |
| TC-I-24 | REQ-14 | validation | Body fails Zod (extra field via strict) | 400; error mentions field name |
| TC-I-25 | REQ-14 | validation | Body has `user_prompt` field at root (server-side defense — REQ-25) | 400; even though signature was valid, payload rejected |
| TC-I-26 | REQ-15 | idempotency | Push same batch twice | First: `accepted=5`, second: `accepted=0, skipped=5`; `ingestion_log` has 2 rows |
| TC-I-27 | REQ-15 | business | Push session with payload change (e.g. new `avg_rating`) | `accepted=1`; row updated in `sessions_agg` |
| TC-I-28 | REQ-14 | infra | Postgres connection drops mid-request | 500 with sanitized message; no partial write (transaction rolls back) |
| TC-I-29 | REQ-14 | edge | Empty batch `[]` | 200 with `accepted=0`; ingestion_log records empty push |
| TC-I-30 | REQ-14 | edge | Batch of 1 with invalid session_id format | Whole-batch reject? OR per-session error? **Decision**: per-session — `accepted=0, rejected=1, errors:[{session_id, reason}]`; valid sessions in same batch still ingested |
| TC-I-31 | REQ-14 | security | Rate limit: 101 requests in 60s from same machine_id | 429 on req 101; `Retry-After` header present |
| TC-I-32 | REQ-19 | happy | Push 2 OTEL+local sessions for user A; query effective cost | Per-user calibration applied; ratio matches `SUM(otel)/SUM(local)` |
| TC-I-33 | REQ-19 | edge | User B has zero OTEL sessions; query effective cost | Falls back to org-global ratio (across all users) |
| TC-I-34 | REQ-19 | edge | Org has zero OTEL sessions globally | All sessions show `source: 'list'`; no crash |
| TC-I-35 | REQ-18 | happy | Seed 3 users in 2 teams, push 30 sessions; query `/manager` data | Spend numbers match SUM by team and global; trend curve has 30 daily points |
| TC-I-36 | REQ-20 | happy | Seed sessions across 30 days, 3 distinct users active in last 7 days | DAU calc returns 3; MAU returns N (test computes expected) |
| TC-I-37 | REQ-20 | edge | Zero sessions in window | DAU=0, WAU=0, MAU=0; no NaN |
| TC-I-38 | REQ-21 | happy | Team detail query for team T with 5 users | Returns alphabetical (NOT spend-sorted) list; per-user spend correct |
| TC-I-39 | REQ-26 | security | No route exists at `/manager/users/:id/sessions/:sid` | Hitting it returns 404 (route file does not exist) |
| TC-I-40 | REQ-27 | happy | Successful ingest writes ingestion_log row | Row has machine_id, IP truncated, accepted_count |
| TC-I-41 | REQ-27 | infra | Daily cleanup query runs after 31 days | `request_ip` set to NULL on rows older than 30d |
| TC-I-42 | REQ-16 | happy | Unauthenticated GET `/manager` | 302 → `/api/auth/signin` |
| TC-I-43 | REQ-17 | security | Authenticated user with `role=member` GETs `/manager` | 403 |
| TC-I-44 | REQ-17 | happy | Authenticated user with `role=manager` GETs `/manager` | 200 |
| TC-I-45 | REQ-17 | security | Authenticated `manager` GETs `/manager/admin/users` | 403 (admin-only) |
| TC-I-46 | REQ-17 | happy | `admin` GETs `/manager/admin/users` | 200 |
| TC-I-47 | REQ-28 | edge | Org with zero pushed sessions, manager visits `/manager` | Renders onboarding card; no NaN, no crash |
| TC-I-48 | REQ-25 | security | Server-side Zod runs even when client-signed | Test posts a hand-crafted signed payload with `user_prompt` field; server rejects 400 |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-18 | happy | Seed central DB with 2 teams, 5 users, 60 sessions; manager logs in via test SSO; visits `/manager` | Page renders; org spend KPI present (data-testid="kpi-spend-30d"); team table has 2 rows; trend chart visible |
| TC-E2E-02 | REQ-20 | happy | `/manager` shows DAU/WAU/MAU KPIs | All 3 visible; numbers match seed |
| TC-E2E-03 | REQ-21 | happy | Click team row → `/manager/teams/[id]` | Per-user table renders alphabetically; no spend ranking; project_slugs visible |
| TC-E2E-04 | REQ-17 | security | Member-role user logs in, hits `/manager` | 403 page; no manager data leaked |
| TC-E2E-05 | REQ-28 | edge | Empty org (admin user, no pushed sessions) | Onboarding card visible; no crash |

## Design

### Architecture Decisions

#### Repo layout

```
tokenfx/
├── app/                      # existing personal dashboard (untouched)
├── apps/
│   └── server/               # NEW: central manager server
│       ├── app/              # Next.js 15 App Router (manager UI + API)
│       ├── lib/db/           # Drizzle schema + migrations + client
│       ├── lib/queries/      # Postgres queries (server-only)
│       ├── lib/auth/         # NextAuth config
│       ├── package.json      # own deps (next, react, pg, drizzle-orm, next-auth, zod)
│       ├── tsconfig.json     # paths: { "@root/*": ["../../lib/*"] }
│       └── README.md         # privacy boundary doc
├── lib/                      # shared
│   ├── analytics/            # imported by both apps
│   ├── reporter/             # NEW (root): sanitizer, signer, client, runner
│   ├── db/                   # local SQLite (existing)
│   └── ...
├── scripts/
│   ├── install-reporter.sh   # NEW: launchd/systemd installer
│   └── reporter-once.ts      # NEW: one-off + dry-run
└── package.json              # adds dev:server, build:server, etc
```

#### Postgres schema (Drizzle, summarized — full schema in `apps/server/lib/db/schema.ts`)

```ts
// orgs: tenants
orgs: { id uuid PK, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now() }

// teams: subdivision of org
teams: { id uuid PK, org_id uuid REFERENCES orgs(id), name text NOT NULL, created_at timestamptz }

// users: linked to SSO subject
users: {
  id uuid PK,
  org_id uuid REFERENCES orgs(id),
  team_id uuid REFERENCES teams(id) NULL,         // unassigned users allowed
  email text UNIQUE NOT NULL,
  sso_provider text NOT NULL,                      // 'google' | 'okta'
  sso_subject text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
}

// user_machines: one user → many machines (per-laptop secret)
user_machines: {
  id uuid PK,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  machine_id uuid NOT NULL,
  key_id text UNIQUE NOT NULL,                     // public id used in signing envelope
  secret_hash text NOT NULL,                        // bcrypt of the HMAC secret
  created_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz NULL
}

// sessions_agg: one row per (user_id, session_id) — the aggregate
sessions_agg: {
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  payload_hash text NOT NULL,                      // SHA-256 of canonical payload, for idempotency
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  project_slug text NOT NULL,
  git_branch text NULL,
  cc_version text NULL,
  total_input_tokens bigint NOT NULL,
  total_output_tokens bigint NOT NULL,
  total_cache_read_tokens bigint NOT NULL,
  total_cache_creation_tokens bigint NOT NULL,
  total_cost_usd numeric(14,6) NOT NULL,
  total_cost_usd_otel numeric(14,6) NULL,
  turn_count integer NOT NULL,
  tool_call_count integer NOT NULL,
  avg_rating numeric(4,3) NULL,
  cache_hit_ratio numeric(4,3) NULL,
  output_input_ratio numeric(8,4) NULL,
  subagent_usage_ratio numeric(4,3) NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
}
CREATE INDEX idx_sessions_agg_started ON sessions_agg(started_at);
CREATE INDEX idx_sessions_agg_user_started ON sessions_agg(user_id, started_at);

// model_breakdown_agg: child of sessions_agg
model_breakdown_agg: {
  user_id, session_id, model text NOT NULL,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens bigint,
  cost_usd numeric(14,6),
  PRIMARY KEY (user_id, session_id, model),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions_agg(user_id, session_id) ON DELETE CASCADE
}

// tool_count_agg: child
tool_count_agg: {
  user_id, session_id, tool_name text, count integer NOT NULL,
  PRIMARY KEY (user_id, session_id, tool_name),
  FOREIGN KEY (user_id, session_id) REFERENCES sessions_agg(user_id, session_id) ON DELETE CASCADE
}

// cost_calibration_per_user: per-user, per-family ratio
cost_calibration_per_user: {
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  family text NOT NULL,                            // 'opus' | 'sonnet' | 'haiku' | 'global'
  effective_rate numeric(6,4) NOT NULL,
  sample_session_count integer NOT NULL,
  sum_otel_cost numeric(14,6) NOT NULL,
  sum_local_cost numeric(14,6) NOT NULL,
  last_updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, family)
}

// ingestion_log: audit
ingestion_log: {
  id bigserial PK,
  user_id uuid,
  machine_id uuid NOT NULL,
  key_id text NOT NULL,
  payload_size_bytes integer NOT NULL,
  accepted_count integer NOT NULL,
  skipped_count integer NOT NULL,
  rejected_count integer NOT NULL,
  request_ip text NULL,                            // truncated; nulled by cleanup after 30d
  received_at timestamptz NOT NULL DEFAULT now(),
  errors_json jsonb NULL
}
CREATE INDEX idx_ingestion_log_received ON ingestion_log(received_at);
CREATE INDEX idx_ingestion_log_user ON ingestion_log(user_id, received_at);
```

#### Sanitizer algorithm (lib/reporter/sanitizer.ts)

```ts
import { z } from "zod";

// Frozen Zod schema — strict() everywhere, deny unknown keys.
export const SanitizedSessionPayload = z.object({
  session_id: z.string().min(1).max(128),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative(),
  project_slug: z.string().regex(/^slug:[0-9a-f]{16}$/),
  git_branch: z.string().max(255).nullable(),
  cc_version: z.string().max(64).nullable(),
  total_input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // ...all 18 allowed fields with explicit Zod validators
  model_breakdown: z.array(z.object({
    model: z.string().max(128),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cache_read_tokens: z.number().int().min(0),
    cache_creation_tokens: z.number().int().min(0),
    cost_usd: z.number().min(0),
  }).strict()),
  tool_counts: z.record(z.string().max(64), z.number().int().min(0).max(1_000_000)),
  avg_rating: z.number().min(-1).max(1).nullable(),
  cache_hit_ratio: z.number().min(0).max(1).nullable(),
  output_input_ratio: z.number().min(0).nullable(),
  subagent_usage_ratio: z.number().min(0).max(1).nullable(),
}).strict()                                         // unknown keys at root → reject
  .refine(p => p.started_at <= p.ended_at, { message: "started_at > ended_at" });

// Sanitizer takes a SQLite session row + its turns/tool_calls aggregation
// and produces a payload by EXPLICITLY constructing each allowlist field —
// it never spreads the input row. This is a structural guarantee: a new field
// added upstream cannot leak via spread, only via explicit code change.
export const sanitizeSession = (input: SessionWithAggs, ctx: { projectSecret: string }):
  Result<SanitizedPayload, SanitizeError> => {
  const candidate = {
    session_id: input.id,
    started_at: input.started_at,
    ended_at: input.ended_at,
    project_slug: deriveProjectSlug(input.cwd, ctx.projectSecret),
    git_branch: input.git_branch,
    // ... explicit field-by-field
  };
  return SanitizedSessionPayload.safeParse(candidate)
    .pipe(toResult);                                // safeParse → Result<T, ZodError>
};
```

#### Signer (lib/reporter/signer.ts)

```ts
import { createHmac } from "node:crypto";

// Canonical JSON: sorted keys at every level, no whitespace, no trailing comma.
// Uses recursive sort, NOT JSON.stringify replacer (replacer doesn't sort nested
// keys deterministically across Node versions).
export const canonicalJSON = (value: unknown): string => { /* recursive sorter */ };

export const sign = (payload: unknown, secret: string): string =>
  createHmac("sha256", secret).update(canonicalJSON(payload)).digest("hex");

export const verify = (payload: unknown, signature: string, secret: string): boolean => {
  const expected = sign(payload, secret);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
};
```

#### Reporter client (lib/reporter/client.ts)

Exponential backoff: `[1000, 2000, 4000, 8000, 16000, 32000]ms`. On `Retry-After` header (429), use header value capped at 60000ms. On 4xx (except 429), no retry — log and surface to runner. Idempotency-Key header = `sha256(user_id + session_id + payload_hash)`.

#### Reporter runner (lib/reporter/runner.ts)

Reads from `lib/db/client.ts` (the local SQLite). Joins:
- `sessions` for the row
- `turns` aggregated by model for `model_breakdown`
- `tool_calls` aggregated by tool_name for `tool_counts`
- `ratings` joined to turns for `avg_rating`

Tracks pushed state in NEW local table `reporter_pushed_sessions(session_id PK, payload_hash, pushed_at)` — added via root migration in `lib/db/schema.sql`.

#### Server ingest route (`apps/server/app/api/ingest/route.ts`)

**Two-level validation flow** (resolves the envelope-vs-items semantics — REQ-3 + REQ-14 + REQ-25 + TC-I-24/30):

```text
Level 1: ENVELOPE (whole-batch reject on failure)
  IngestEnvelopeSchema = z.object({
    version: z.literal(1),
    key_id: z.string().min(1),
    machine_id: z.string().uuid(),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    payload: z.array(z.unknown()).max(50),     // unknown-typed; items validated at level 2
  }).strict()                                   // unknown root keys → batch reject 400

Level 2: PAYLOAD ITEMS (per-session reject; siblings still ingest)
  for each item in envelope.payload:
    parsed = SanitizedSessionPayload.safeParse(item)
    if (!parsed.success): errors.push({session_id: item.session_id ?? '<unknown>', reason: parsed.error.message}); continue
    accepted.push(parsed.data)
```

```ts
export const POST = async (req: Request) => {
  // 1. Parse envelope with IngestEnvelopeSchema.strict() — 400 on shape failure.
  // 2. Look up user_machines row by key_id; 401 if absent or revoked_at is not NULL.
  // 3. Verify HMAC signature with secret_hash via timingSafeEqual → 401 on mismatch.
  // 4. For each payload[] item: re-validate with SanitizedSessionPayload (level 2).
  //    Collect per-item rejections in `errors[]`; valid items proceed.
  // 5. Rate-limit check (per machine_id) → 429 with Retry-After.
  // 6. Open Drizzle transaction:
  //    - For each valid payload: UPSERT sessions_agg ON CONFLICT (user_id, session_id)
  //      WHERE payload_hash IS DISTINCT FROM EXCLUDED.payload_hash.
  //    - Replace model_breakdown_agg + tool_count_agg children.
  //    - Append ingestion_log row (audit even on partial reject).
  //    - Recompute cost_calibration_per_user for this user (only if any session had OTEL).
  // 7. Return { accepted, skipped, rejected, errors }. Status 200 even when rejected > 0
  //    (siblings made it). Only envelope-level failures or auth failures return 4xx.
};
```

Rate limit (REQ-14, REQ-31 implicit): in-memory counter keyed by `(machine_id, minute_bucket)`. Acceptable for v1 single-instance server; upgrade to Redis if multi-instance.

#### Manager queries (apps/server/lib/queries/)

- `getOrgOverview(orgId)`: spend windows + DAU/WAU/MAU + team breakdowns. **Cost calibration is computed in JS, not SQL**: the query SELECTs raw fields (`total_cost_usd`, `total_cost_usd_otel`, `model` for family derivation, `user_id`); a single load of `cost_calibration_per_user` rows for the org is mapped to the same `Calibration` shape used by `lib/analytics/cost-calibration.ts`; then `effectiveCostForSession` is invoked per-row in JS to compute `effective_cost_usd`. Aggregation (sum by team, by user) happens after JS calibration. Rationale: ONE source of truth for the cascade (otel → calibrated → list); SQL `CASE` would silently diverge as the cascade evolves. Same pattern as outcome spec 1 REQ-14 and effectiveness-v2 spec REQ-16. **No SQL CASE for cost.**
- `getTeamDetail(teamId)`: per-user spend (alphabetical, NEVER sorted by spend), DAU 30d, top project slugs. Same JS-side calibration approach.
- All queries Drizzle, prepared statements via Drizzle's parameterized `sql\`\`` template tag.

#### Sharing the analytics layer

`apps/server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@root/*": ["../../lib/*"] }
  },
  "include": ["app/**/*", "lib/**/*", "../../lib/analytics/**/*", "../../lib/result.ts"]
}
```

Imports from server look like `import { effectiveCostForSession } from "@root/analytics/cost-calibration"`. Pure helpers only — anything that touches `better-sqlite3` is excluded from the path map (the path map is permissive, but the rule is enforced via ESLint rule `no-restricted-imports` blocking `@root/db/client` from `apps/server/`).

#### Test strategy for Postgres

`apps/server/vitest.config.ts` configures `globalSetup` that:
1. Boots a Postgres 16 Testcontainer (single instance for whole suite).
2. Runs Drizzle migrations against it.
3. Exports the connection string as env var.
4. Each test gets a fresh schema (via `BEGIN; ... ROLLBACK` per test, OR truncate tables per test — pick truncate for simplicity since some tests need committed reads for triggers).

`SKIP_PG_TESTS=1` skips the entire `apps/server/tests/integration/**` suite.

### Files to Create

#### Reporter (root)

- `lib/reporter/types.ts` — `SanitizedSessionPayload`, `SanitizedPayloadEnvelope`, `Result` re-exports
- `lib/reporter/sanitizer.ts` — `sanitizeSession`, `deriveProjectSlug`
- `lib/reporter/sanitizer.test.ts` — TC-U-01..22, TC-U-28..31
- `lib/reporter/signer.ts` — `canonicalJSON`, `sign`, `verify`
- `lib/reporter/signer.test.ts` — TC-U-23..27
- `lib/reporter/client.ts` — `pushBatch` with retry/backoff
- `lib/reporter/client.test.ts` — TC-I-03, TC-I-04, TC-I-05 (mock fetch)
- `lib/reporter/runner.ts` — `runReporter` reads local DB, sanitizes, batches, calls client
- `lib/reporter/runner.test.ts` — TC-I-08, TC-I-09, TC-I-10
- `lib/reporter/queue.ts` — offline buffer SQLite (separate from main DB)
- `lib/reporter/queue.test.ts` — TC-I-06, TC-I-07
- `lib/reporter/config.ts` — read/write `data/reporter-config.json` with mode 0600
- `scripts/install-reporter.sh` — launchd plist (macOS) / systemd unit (Linux)
- `scripts/reporter-once.ts` — CLI (`--dry-run` flag)
- `scripts/reporter-setup.ts` — `pnpm reporter:setup` interactive setup

#### Server (`apps/server/`)

- `apps/server/package.json`
- `apps/server/tsconfig.json` (with `paths` for `@root/*`)
- `apps/server/next.config.ts`
- `apps/server/postcss.config.mjs`, `tailwind.config.ts`
- `apps/server/drizzle.config.ts`
- `apps/server/.env.example`
- `apps/server/lib/db/schema.ts` — Drizzle schema
- `apps/server/lib/db/client.ts` — Postgres pool + Drizzle instance
- `apps/server/lib/db/migrations/` — generated SQL migrations (committed)
- `apps/server/lib/db/migrate.ts` — runs migrations on boot/CLI
- `apps/server/lib/auth/auth.ts` — NextAuth config (Google + Okta)
- `apps/server/lib/auth/middleware.ts` — role gating helper
- `apps/server/lib/queries/overview.ts` — org-wide spend + DAU/WAU/MAU
- `apps/server/lib/queries/teams.ts` — team list + detail
- `apps/server/lib/queries/calibration.ts` — per-user cost calibration recompute
- `apps/server/lib/queries/*.test.ts` — TC-I-32..38, TC-I-47
- `apps/server/lib/ingest/sanitizer-shared.ts` — re-exports `SanitizedSessionPayload` from `lib/reporter/types.ts` via `@root/reporter/types` so server-side validation matches client (REQ-25)
- `apps/server/middleware.ts` — Next middleware: SSO + role gates
- `apps/server/app/layout.tsx`, `app/page.tsx` (landing → /manager redirect)
- `apps/server/app/api/auth/[...nextauth]/route.ts`
- ~~`apps/server/app/api/auth/register-machine/route.ts`~~ **moved to `central-server-onboarding.md`**
- `apps/server/app/api/ingest/route.ts` — TC-I-21..31, TC-I-48
- `apps/server/app/manager/layout.tsx`
- `apps/server/app/manager/page.tsx` — overview (REQ-18, REQ-20)
- `apps/server/app/manager/teams/page.tsx`
- `apps/server/app/manager/teams/[id]/page.tsx` — REQ-21
- `apps/server/app/manager/admin/users/page.tsx` — admin role assignment
- `apps/server/components/manager/*` — KPI cards, trend charts (Recharts), team table
- `apps/server/tests/integration/ingest.test.ts` — Testcontainers setup
- `apps/server/tests/integration/queries.test.ts`
- `apps/server/tests/integration/auth.test.ts` — TC-I-42..46
- `apps/server/tests/integration/setup-pg.ts` — Testcontainers globalSetup
- `apps/server/vitest.config.ts`
- `apps/server/playwright.config.ts`
- `apps/server/tests/e2e/manager.spec.ts` — TC-E2E-01..05
- `apps/server/tests/e2e/global-setup.ts`
- `apps/server/README.md` — privacy boundary (REQ-23)
- `apps/server/scripts/seed-server.ts` — seeds Postgres for E2E

### Files to Modify (root)

- `package.json` — add scripts: `reporter:setup`, `reporter:once`, `reporter:run`, `dev:server`, `build:server`, `typecheck:server`, `test:server`, `test:server:e2e`, `lint:server`, `db:server:migrate`, `db:server:generate`
- `.gitignore` — `data/reporter-queue.db`, `data/reporter-config.json`, `apps/server/.env*`
- `lib/db/schema.sql` — add `reporter_pushed_sessions` table
- `lib/db/migrate.ts` — idempotent creation of new table
- `lib/logger.ts` — used by reporter (no change required, just imported)
- `README.md` — link to `apps/server/README.md`; section on reporter opt-in
- `.claude/hooks/stop-validate.sh` — discover `apps/server/` and run its typecheck/lint/test
- `tsconfig.json` (root) — exclude `apps/server/**` from root project to keep two TS projects independent

### Dependencies

#### Root (existing repo) — add:
- `@types/node` (existing)
- No new prod deps for reporter — uses `node:crypto`, `better-sqlite3` (existing), `zod` (existing)

#### `apps/server/package.json` — new app:

Production:
- `next@^15.0.0`
- `react@^19.0.0` and `react-dom@^19.0.0`
- `pg@^8.13.0` (Postgres driver)
- `drizzle-orm@^0.36.0`
- `next-auth@^5.0.0-beta` (Auth.js v5; if beta unstable at impl time, fall back to `next-auth@^4` and update REQ-16 — flag in spec review)
- `zod@^4` (matches root)
- `recharts@^3` (matches root) for trend charts
- `tailwindcss@^4`
- `@radix-ui/*` per shadcn/ui needs

Dev:
- `drizzle-kit@^0.30.0`
- `@testcontainers/postgresql@^10` and `testcontainers@^10`
- `vitest@^4`
- `@playwright/test@^1.59`
- `tsx`
- `eslint@^9` + the same shared config as root

[NEEDS CLARIFICATION]: NextAuth v5 beta vs v4 stable — pick at impl time based on stability. Both APIs documented; this spec assumes v5 patterns (App Router native).

## Tasks

> Tasks are scoped tightly enough that each fits a single PR-equivalent unit. `files:` lists are concrete; `depends:` enforces ordering; `tests:` triggers TDD where applicable.

### Foundation

- [ ] **TASK-1**: Add reporter local-DB tracking table.
  - files: lib/db/schema.sql, lib/db/migrate.ts
  - tests: TC-I-09 (idempotency)
- [ ] **TASK-2**: Repo hooks + scripts setup for sibling app.
  - files: package.json (root), .gitignore, tsconfig.json (root, exclude apps/server), .claude/hooks/stop-validate.sh
  - tests: —
- [ ] **TASK-3**: `apps/server/` scaffold — package.json, tsconfig (with paths), next.config, tailwind, drizzle.config, .env.example, empty `app/layout.tsx` + `app/page.tsx`, `vitest.config.ts`.
  - files: apps/server/package.json, apps/server/tsconfig.json, apps/server/next.config.ts, apps/server/postcss.config.mjs, apps/server/tailwind.config.ts, apps/server/drizzle.config.ts, apps/server/.env.example, apps/server/app/layout.tsx, apps/server/app/page.tsx, apps/server/vitest.config.ts, apps/server/.gitignore
  - depends: TASK-2
  - tests: —

### Reporter (root repo) — privacy core

- [ ] **TASK-4**: Sanitizer + Zod schema + slug derivation. Tests cover privacy fuzzing and boundaries — privacy is the spec's #1 invariant.
  - files: lib/reporter/types.ts, lib/reporter/sanitizer.ts, lib/reporter/sanitizer.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-U-22, TC-U-28, TC-U-29, TC-U-30, TC-U-31
- [ ] **TASK-5**: HMAC signer + canonical JSON + verify.
  - files: lib/reporter/signer.ts, lib/reporter/signer.test.ts
  - tests: TC-U-23, TC-U-24, TC-U-25, TC-U-26, TC-U-27
- [ ] **TASK-6**: Offline queue (separate SQLite at `data/reporter-queue.db`).
  - files: lib/reporter/queue.ts, lib/reporter/queue.test.ts
  - depends: TASK-4
  - tests: TC-I-06, TC-I-07
- [ ] **TASK-7**: Push client with retry/backoff.
  - files: lib/reporter/client.ts, lib/reporter/client.test.ts
  - depends: TASK-5
  - tests: TC-I-03, TC-I-04, TC-I-05
- [ ] **TASK-8**: Runner — reads local DB, sanitizes, batches, calls client, marks pushed.
  - files: lib/reporter/runner.ts, lib/reporter/runner.test.ts, lib/reporter/config.ts
  - depends: TASK-1, TASK-4, TASK-5, TASK-6, TASK-7
  - tests: TC-I-08, TC-I-09, TC-I-10
- [ ] **TASK-9**: Local setup utilities — `pnpm reporter:once --dry-run` (REQ-29), `scripts/install-reporter.sh` (cron registration), and `scripts/reporter-config-init.ts` (validates a hand-written `data/reporter-config.json` shape, generates `project_secret` if missing). **Note**: `pnpm reporter:setup` (the interactive onboarding entry point that fetches `key_id`/`secret` from the central server) lives in `central-server-onboarding.md`; for v0 of THIS spec, devs hand-write the config file from a seeded `user_machines` row. TC-I-01/02 (interactive setup happy/error) move to the onboarding spec — only the config-validation TCs remain here.
  - files: scripts/reporter-once.ts, scripts/install-reporter.sh, scripts/reporter-config-init.ts
  - depends: TASK-8
  - tests: TC-I-11, TC-I-12

### Server — schema + auth

- [ ] **TASK-10**: Drizzle schema + migrations + client + migrate runner.
  - files: apps/server/lib/db/schema.ts, apps/server/lib/db/client.ts, apps/server/lib/db/migrate.ts, apps/server/lib/db/migrations/0000_init.sql (generated)
  - depends: TASK-3
  - tests: TC-I-20
- [ ] **TASK-11**: Testcontainers globalSetup for Postgres in tests.
  - files: apps/server/tests/integration/setup-pg.ts, apps/server/vitest.config.ts (extension)
  - depends: TASK-10
  - tests: — (infra for other tests)
- [ ] **TASK-12**: NextAuth v5 setup with Google + Okta + role middleware.
  - files: apps/server/lib/auth/auth.ts, apps/server/lib/auth/middleware.ts, apps/server/middleware.ts, apps/server/app/api/auth/[...nextauth]/route.ts
  - depends: TASK-10
  - tests: TC-I-42, TC-I-43, TC-I-44, TC-I-45, TC-I-46

### Server — ingest

- [ ] **TASK-13**: Shared sanitized payload schema importable on server.
  - files: apps/server/lib/ingest/sanitizer-shared.ts
  - depends: TASK-3, TASK-4
  - tests: — (re-export, validated via TC-I-25, TC-I-48)
- [ ] **TASK-14**: `POST /api/ingest` — signature verify, Zod re-validate, UPSERT, ingestion_log, per-user calibration recompute.
  - files: apps/server/app/api/ingest/route.ts, apps/server/lib/queries/calibration.ts, apps/server/tests/integration/ingest.test.ts
  - depends: TASK-10, TASK-11, TASK-13
  - tests: TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25, TC-I-26, TC-I-27, TC-I-28, TC-I-29, TC-I-30, TC-I-31, TC-I-40, TC-I-48
- [ ] **TASK-15**: ~~`POST /api/auth/register-machine`~~ **MOVED to `central-server-onboarding.md`** (carved-out spec). For v0 of this spec, `user_machines` rows are seeded via `apps/server/scripts/seed-server.ts` (admin DB seeding). Reporter-side `data/reporter-config.json` is hand-written for testing. No production-grade onboarding endpoint in this spec.
  - files: apps/server/scripts/seed-server.ts (extended to support manual machine seeding)
  - depends: TASK-10
  - tests: — (manual seeding verified by TC-I-21 happy-path which assumes a seeded machine)
- [ ] **TASK-16**: ingestion_log IP cleanup cron (daily).
  - files: apps/server/app/api/admin/cleanup/route.ts, apps/server/lib/queries/cleanup.ts
  - depends: TASK-14
  - tests: TC-I-41

### Server — manager UI

- [ ] **TASK-17**: Overview queries + per-user calibration application via shared `effectiveCostForSession`.
  - files: apps/server/lib/queries/overview.ts, apps/server/lib/queries/overview.test.ts
  - depends: TASK-14
  - tests: TC-I-32, TC-I-33, TC-I-34, TC-I-35, TC-I-36, TC-I-37, TC-I-47
- [ ] **TASK-18**: Team queries (alphabetical, no rankings).
  - files: apps/server/lib/queries/teams.ts, apps/server/lib/queries/teams.test.ts
  - depends: TASK-14
  - tests: TC-I-38, TC-I-39
- [ ] **TASK-19**: Manager UI — `/manager`, `/manager/teams`, `/manager/teams/[id]` pages with KPI cards, trend chart, team table.
  - files: apps/server/app/manager/layout.tsx, apps/server/app/manager/page.tsx, apps/server/app/manager/teams/page.tsx, apps/server/app/manager/teams/[id]/page.tsx, apps/server/components/manager/*
  - depends: TASK-12, TASK-17, TASK-18
  - tests: — (covered by E2E)
- [ ] **TASK-20**: Admin UI — role assignment.
  - files: apps/server/app/manager/admin/users/page.tsx, apps/server/app/manager/admin/users/actions.ts
  - depends: TASK-19
  - tests: TC-I-45, TC-I-46

### Privacy doc + smoke

- [ ] **TASK-21**: Privacy boundary docs (server README + root README link).
  - files: apps/server/README.md, README.md (root: link section)
  - depends: TASK-19
  - tests: — (manual review)
- [ ] **TASK-22**: Server seed script + Playwright config.
  - files: apps/server/scripts/seed-server.ts, apps/server/playwright.config.ts, apps/server/tests/e2e/global-setup.ts
  - depends: TASK-19
  - tests: —
- [ ] **TASK-SMOKE**: E2E manager flows.
  - files: apps/server/tests/e2e/manager.spec.ts
  - depends: TASK-22, TASK-20
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]                            — root prep (lib/db/schema.sql vs root scripts)
Batch 2: [TASK-3, TASK-4, TASK-5]                    — apps/server scaffold + sanitizer + signer (disjoint)
Batch 3: [TASK-6, TASK-7, TASK-10]                   — queue, client, drizzle schema (disjoint dirs)
Batch 4: [TASK-8, TASK-11, TASK-12, TASK-13]         — runner, testcontainers, auth, shared schema (disjoint)
Batch 5: [TASK-9, TASK-14]                           — install scripts vs ingest route (disjoint)
Batch 6: [TASK-15, TASK-16, TASK-17, TASK-18]        — register-machine, cleanup, overview queries, team queries (disjoint files)
Batch 7: [TASK-19]                                   — manager UI (depends overview+teams)
Batch 8: [TASK-20, TASK-21, TASK-22]                 — admin UI, docs, seed (disjoint)
Batch 9: [TASK-SMOKE]                                — E2E
```

File overlap analysis:

- `lib/db/schema.sql` + `lib/db/migrate.ts`: TASK-1 only.
- `package.json` (root): TASK-2 only.
- `tsconfig.json` (root): TASK-2 only.
- `apps/server/package.json` and scaffold files: TASK-3 only; later tasks add files inside `apps/server/` but never touch `package.json` after scaffold.
- `apps/server/vitest.config.ts`: TASK-3 (initial) → TASK-11 (extension for testcontainers). **shared-additive**, sequential batches handle it.
- `apps/server/middleware.ts`: TASK-12 only.
- `apps/server/lib/db/schema.ts`: TASK-10 only.
- `apps/server/lib/queries/calibration.ts`: TASK-14 (creates) — overview/teams import but don't modify it.
- All E2E files: TASK-SMOKE only; seed script in TASK-22.
- Reporter files (`lib/reporter/*`): each task creates its own files; TASK-8 imports prior files but doesn't modify them.

Zero shared-mutative overlaps. Up to 4 worktrees parallel in Batch 4 and Batch 6.

## Validation Criteria

- [ ] `pnpm typecheck` passes (root)
- [ ] `pnpm typecheck:server` passes (apps/server)
- [ ] `pnpm lint` and `pnpm lint:server` pass
- [ ] `pnpm test --run` passes (root, including reporter unit + integration)
- [ ] `pnpm test:server --run` passes (apps/server, including Testcontainers PG)
- [ ] `pnpm build` and `pnpm build:server` pass
- [ ] `pnpm test:e2e` (root) passes — existing personal dashboard untouched
- [ ] `pnpm test:server:e2e` passes — manager flows
- [ ] **Privacy validation against real data**:
  - Run `pnpm reporter:once --dry-run` against the author's local DB; visually inspect the JSON for the absence of `user_prompt`, `assistant_text`, `cwd`, full paths, rating notes
  - Push 1 batch to a local server instance; query Postgres `SELECT * FROM sessions_agg` — confirm only allowlist columns, never any prompt/assistant content
- [ ] **Cost validation against real data**:
  - Manager `/manager` shows org spend that matches the per-user calibrated total from the local dashboard within 1¢
  - Per-user calibration ratio for the author matches what the local `cost_calibration` table shows
- [ ] **Adoption validation**:
  - Seed 5 fake users with sessions across 30 days; confirm DAU/WAU/MAU match hand-computed values
- [ ] **Security validation**:
  - Hand-craft a payload with a `user_prompt` field, sign correctly, push → server returns 400 (defense-in-depth REQ-25 confirmed)
  - Tamper signature → 401
  - Use revoked machine → 401

## Execution Log

- 2026-04-28: **User-review pass — 5 fixes aplicados + carve out**:
  - **B1 (DRY contradiction)**: Design "Manager queries" agora lockado em **JS via `effectiveCostForSession`** — REQ-19 e Design ficam consistentes. SQL CASE para custo foi explicitamente vetado. Mantém o pattern das outras specs (outcome-integration-git REQ-14, effectiveness-personal-v2 REQ-16) — uma única fonte de verdade pra cascata otel→calibrated→list.
  - **B2 (gap no provisionamento) + scope-out**: o fluxo de aquisição de `key_id`/`secret` (`POST /api/auth/register-machine` + `pnpm reporter:setup` interativo) foi **carved out** para `central-server-onboarding.md` (spec separada com invite tokens emitidos pelo manager). Esta spec ship: ingestão + dashboard manager + provisionamento manual via DB seed (suficiente pra testar end-to-end, sem cara pra usuário). Affected: REQ-7 reescrito apontando pra spec nova; TASK-15 e Files to Create marcados MOVED; TASK-9 reduzido pra config-validation local; TC-I-01/02 movidos. Razão pro carve out: spec 3 já com 22 tasks/65 TCs, onboarding adiciona 4-6 REQs+tasks+TCs sem dependência das outras peças — vira PR menor e revisável.
  - **M1 (validação ambígua)**: Adicionada subseção **"Two-level validation flow"** explícita no Design da rota de ingest. Envelope `.strict()` (whole-batch reject em campos extras na raiz); items em `payload[]` validados individualmente com per-session error em vez de derrubar batch. Resolve a ambiguidade entre TC-I-24 e TC-I-30.
  - **M2 (TC-I-11 vago)**: REQ-11 ganhou **gate concreto** — todo entry-point do reporter checa `fs.existsSync('data/reporter-config.json')` ANTES de qualquer import network-side; sem config, exit 0 com info-log e zero outbound (assertado via `nock.disableNetConnect()`). Mais um grep CI bloqueia import transitivo de `lib/reporter/**` em `app/`/`lib/queries/`/`lib/ingest/`.
  - **Mi1**: Contagem do allowlist corrigida 18→20 fields (TC-U-01).
  - Status: DRAFT permanece. Pre-implementation, lock final do `data/reporter-config.json` shape esperado pelos dois specs (já documentado em REQ-7).
