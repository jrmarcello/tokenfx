# Spec: central-server-onboarding-v2-sso.manager-ui

## Status: DONE

## Context

Third (and final) implementation spec of the `central-server-onboarding-v2-sso`
initiative. Threat model (commit `3b05b89`, status APPROVED), spec (a)
schema-migrations (commit `cee4dcc`, status DONE), and spec (b) backend
(commit `8466fac`, status DONE) all shipped.

This spec wires:

1. The **manager-facing UI** that consumes what spec (b) wrote into the DB
   (banner, audit-log view, allowed_sso_providers UX, member-table filter +
   CSV export).
2. The **follow-ups carved out of spec (b)** that are user-visible or that
   close known gaps:
   - Real SMTP email channel via dispatcher pattern (`send-email-stub.ts` →
     `send-email-smtp.ts` with env-driven fallback to stub).
   - IP/UA capture via AsyncLocalStorage so the rate-limit + audit log can
     finally use real network context (spec b's known gap; per-IP rate-limit
     dimension was skipped because `ip` was always empty).
   - `revalidateInvite` pure-function extraction (replaces the
     `onAfterSelectForUpdate` test seam; eliminates spec (b)'s transitional
     stub-bypass tests).
   - MaxMind IP→city wiring (replaces the v2 baseline `ipToCity` stub that
     returned null; closes the city column gap on the audit log).

### Decisions already locked (from threat model + spec b carve-outs)

- **Decisão #14 (banner recipients):** the banner is rendered for users with
  role `manager` or `admin` only, scoped to their `orgId`. Members never
  see it. The banner counts only events whose `redemption_log.method =
  'sso-auto'` AND whose row's `orgId` (joined via `tokenPrefix → invite →
  orgId`) matches the manager's org.
- **Decisão #15 (banner stacking + per-event ack):** multiple unacknowledged
  events stack with a count badge ("3 unacknowledged"). **Per-event
  acknowledge** — acking one event does NOT dismiss others. Preserves the
  forensic trail "when did each admin see which event". State table is
  `manager_alert_acks(manager_user_id, alert_kind, event_id, acked_at)`
  with composite PK on `(manager_user_id, alert_kind, event_id)`. A
  manager-event pair is "acknowledged" iff a row exists. The query lists
  unacknowledged events as `redemption_log_id NOT IN (SELECT event_id FROM
  manager_alert_acks WHERE manager_user_id = $1 AND alert_kind = $2)`.
- **Decisão #17 (allowed_sso_providers UX — write vs read asymmetry):**
  stored as `text[]` already (spec a column).
  - **Write path (new invite via Server Action):** Zod rejects empty
    arrays (`.min(1)`). A manager wanting "any provider" must explicitly
    select all currently-supported options (`['google', 'okta',
    'microsoft', 'auth0']`). Closes Threat 12 cross-IdP for new patterns.
  - **Read path (legacy DB rows):** empty arrays continue to mean "any
    provider allowed" — `enforceAllowedProviders()` short-circuits on
    `[]` to preserve existing-row semantics. No data migration needed.
  - UI options: `google`, `okta`, `microsoft`, `auth0` (4 multi-select
    items). No "Any" pseudo-option on new invites — selecting all 4
    is the explicit user gesture.
- **Decisão #18 (provisioned_via filter + CSV):** the column already
  exists on `user_machines` (spec a). The roster page (`team-detail-members`)
  is the natural surface to add the filter; the CSV export carries the
  hashed identifier + provisioned_via + timestamps **only**, no plaintext
  email (privacy invariant from threat model §"Data minimisation").
- **Real email channel (deferred from spec b):** dispatcher pattern. If
  `SMTP_HOST` env is unset, fall back to the existing console-log stub
  (dev/local unaffected). If set, route through nodemailer. Result-pattern
  preserved; existing tests stay green.
- **AsyncLocalStorage wiring (deferred from spec b):** ALS context is
  populated at the route-handler boundary (`apps/server/app/api/auth/[...nextauth]/route.ts`
  already wraps via `csrfWrap` — we extend the same wrapper to also run the
  callback inside the ALS scope). Existing route handlers that don't run
  inside the ALS scope read `getStoreOr(defaults)` and get safe fallbacks.
- **revalidateInvite extraction (deferred from spec b):** pure-function
  predicate. Decision-engine inline check + `onAfterSelectForUpdate` test
  seam are both deleted; race tests rewrite to call `revalidateInvite`
  directly with synthetic invite rows.
- **MaxMind wiring (deferred from spec b):** opt-in via `MAXMIND_DB_PATH`
  env. If unset or file missing → returns null (backward-compatible with
  dev/local + with the v2 baseline). GeoLite2-City.mmdb is NOT checked in;
  ops grabs it from MaxMind's free download. Lookup wraps `Reader` in a
  module-level singleton so the mmap is shared across requests.

### Out-of-scope (deferred to future specs)

- TC-I-34 replay-detection: requires a full OAuth IdP stub harness — its
  own spec `oauth-idp-stub.md`.
- TC-E2E-01/02 SSO auto-provision Playwright tests: depend on the IdP stub
  above.
- Org-picker UX for multi-org email matches (the
  `loadOrgsByEmail.length > 1` case currently rejects with a warn log).
- Per-org admin-only "rotate email pepper" surface.

## Requirements

### Banner (first-auto-provision)

- [ ] **REQ-1**: GIVEN a manager/admin is signed in, WHEN one or more
  rows exist in `onboarding_redemption_log` with `method = 'sso-auto'`
  AND the row's resolved org matches the session `orgId` AND the row's
  `id` has NO entry in `manager_alert_acks` for this manager + alert kind,
  THEN the manager dashboard renders the first-auto-provision banner with
  the count of unacknowledged events.
- [ ] **REQ-2**: GIVEN the banner is visible, WHEN the manager clicks
  "Acknowledge" on a specific event, THEN exactly one row is upserted into
  `manager_alert_acks(manager_user_id, alert_kind, event_id, acked_at)`.
  Per Decisão #15, acking event X does NOT acknowledge events Y, Z. The
  next page render hides only the acked event from the banner count; other
  unacknowledged events remain visible.
- [ ] **REQ-3**: GIVEN the manager has role `member`, THEN no banner is
  rendered AND the ack server action returns `{ok: false, code:
  'unauthorized'}` regardless of redemption-log state (defense-in-depth on
  top of the middleware role gate).

### Audit-log view

- [ ] **REQ-4**: GIVEN a manager/admin navigates to `/manager/audit-log`,
  THEN the page lists `auth_event_log` rows scoped to the manager's org
  (joined via `email_hash → users.email_hash` per-org), ordered by
  `occurred_at DESC`, paginated 50 rows/page.
- [ ] **REQ-5**: GIVEN the manager applies a filter (outcome, IdP, date
  range, city substring, browser substring), THEN the query uses the
  `idx_auth_event_log_*` covering indexes and returns only matching rows
  (server-rendered — no client-side filtering).
- [ ] **REQ-6**: GIVEN the manager clicks "Export CSV", THEN the response
  is a `text/csv; charset=utf-8` download with columns `timestamp, outcome,
  email_hash_prefix, iss, city, browser, decision_reason`. CSV cells are
  RFC-4180 quoted (commas + double-quotes + newlines escaped); line
  endings are `\r\n` throughout (RFC-4180 §2). Formula-injection guard
  per OWASP CSV-Injection cheat sheet
  (<https://owasp.org/www-community/attacks/CSV_Injection>): any cell whose
  trimmed value starts with `=`, `+`, `-`, `@`, `\t`, or `\r` is prefixed
  with `'` before quoting. The export reuses the current filters via
  query-string (idempotent server route). Row cap: 10,000 rows; if
  exceeded, the response header `X-TokenFx-Truncated: true` is set and
  the user-facing page shows a "narrow filters" hint. The route streams
  rows via Drizzle async iteration (bounded memory regardless of cap).

### Pattern-creation UX (allowed_sso_providers)

- [ ] **REQ-7**: GIVEN a manager creates or edits an invite, WHEN the
  form is submitted, THEN the `allowed_sso_providers` field is validated
  via Zod against the enum `['google', 'okta', 'microsoft', 'auth0']`
  with `.min(1)` (write-path; per Decisão #17 a new invite MUST select
  ≥1 provider explicitly). Duplicates are normalized via
  `.transform((arr) => Array.from(new Set(arr)))`. Persisted as `text[]`.
- [ ] **REQ-8**: GIVEN a manager submits an empty `allowed_sso_providers`
  array via the Server Action (write path), THEN the action returns
  `{ok: false, code: 'invalid_input', detail: 'allowed_sso_providers requires at least one provider'}`.
  Empty arrays for legacy DB rows (read path) continue to mean "any
  provider allowed" — `enforceAllowedProviders()` semantics unchanged.

### Member-table filter + CSV (roster)

- [ ] **REQ-9**: GIVEN a manager opens a team detail page
  (`/manager/teams/[id]`), THEN the member table accepts a
  `provisioned_via` filter (`all`/`token`/`sso-auto`) via query-string
  and the rendered rows reflect the filter.
- [ ] **REQ-10**: GIVEN the manager clicks "Export CSV" on the same page,
  THEN the CSV download carries columns `email_hash_prefix,
  provisioned_via, created_at, last_login_at` — NO plaintext email or
  raw IP. Same RFC-4180 quoting + formula-injection guard + CRLF line
  endings as REQ-6. NULL `last_login_at` serializes as an empty cell
  (never the literal string "null"). Streams via Drizzle async iteration.

### Real SMTP email channel

- [ ] **REQ-11**: GIVEN `SMTP_HOST` is set in env, WHEN `sendEmail()` is
  called, THEN the call is dispatched to the nodemailer SMTP transport
  (using `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) and returns
  `Result<EmailResult, EmailError>` matching the existing contract.
- [ ] **REQ-12**: GIVEN `SMTP_HOST` is unset, WHEN `sendEmail()` is
  called, THEN the call falls back to the existing console-log stub
  (dev/local unchanged). No code path requires the real backend to work.

### AsyncLocalStorage request context

- [ ] **REQ-13**: GIVEN a request enters
  `/api/auth/[...nextauth]/route.ts`, WHEN the NextAuth handler runs
  (including the signIn callback in `auth.ts`), THEN the handler is
  executed inside an `AsyncLocalStorage<RequestContext>` scope where
  `getRequestContext()` returns `{ip, userAgent}` populated from the
  request headers.
- [ ] **REQ-13a**: GIVEN `extractContextFromRequest(req)` throws OR
  returns malformed data (e.g., header decoding error), THEN the wrapping
  helper catches the error, logs a warn, and runs the handler inside a
  default `{ip: '', userAgent: ''}` context. The signIn route NEVER 500s
  due to a context-extraction failure.
- [ ] **REQ-14**: GIVEN a caller invokes `getRequestContext()` outside
  the route-handler scope (e.g., a Server Component query in test),
  THEN the call returns the default `{ip: '', userAgent: ''}` (no
  throw). After this REQ ships, `rate-limit-sso.ts` STOPS skipping the
  per-IP dimension on empty IP — the dimension is always evaluated.
  Concurrent requests with distinct `ip` values MUST NOT bleed contexts
  into each other (ALS isolation invariant).

### revalidateInvite extraction

- [ ] **REQ-15**: GIVEN the SSO-auto-provision flow runs
  `SELECT ... FOR UPDATE` on the matched invite, THEN the subsequent
  re-validation is performed via a pure function
  `revalidateInvite(invite, currentTimeMs): {valid: true} | {valid: false; reason: 'revoked' | 'expired' | 'exhausted'}`.
  The inline check + `onAfterSelectForUpdate` test seam are deleted;
  the transitional stub-bypass race tests TC-I-08/09/10 from spec (b)
  are deleted; pure-function unit tests replace them. The integration
  test `flow.test.ts` retains 1 end-to-end race case proving the flow
  consumes the predicate.

### MaxMind IP→city

- [ ] **REQ-16**: GIVEN `MAXMIND_DB_PATH` is set AND the file exists,
  WHEN `ipToCity(ip)` is called with a routable IP, THEN it returns
  the city name from MaxMind GeoLite2-City. Invalid/private/loopback
  IPs return null. Reader is a module-level singleton (mmap shared).
- [ ] **REQ-17**: GIVEN `MAXMIND_DB_PATH` is unset OR the file is
  missing, WHEN `ipToCity(ip)` is called, THEN it returns null (no
  throw). The auth-event-log-writer's `city` column is populated only
  when `ipToCity` returns non-null.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-7 | validation | invite Zod schema accepts `allowed_sso_providers: ['google']` | parse ok |
| TC-U-02 | REQ-7 | validation | invite Zod schema accepts `allowed_sso_providers: []` | parse ok (any) |
| TC-U-03 | REQ-7 | validation | invite Zod schema rejects `allowed_sso_providers: ['nonexistent']` | parse error, code `invalid_enum_value` |
| TC-U-04 | REQ-7 | validation | invite Zod schema rejects `allowed_sso_providers: 'google'` (string, not array) | parse error |
| TC-U-05 | REQ-7 | validation | invite Zod schema rejects `allowed_sso_providers: []` (empty, write-path) | parse error, code `too_small` |
| TC-U-05b | REQ-7 | happy | invite Zod schema dedups `['google', 'google']` → `['google']` (length 1) | normalized, no error |
| TC-U-06 | REQ-6, REQ-10 | happy | `toCsvRow(['ok', 'a, b', 'c\nd'])` → `ok,"a, b","c\nd"\r\n` | RFC-4180 quoting correct |
| TC-U-07 | REQ-6, REQ-10 | edge | `toCsvRow(['', null, 'x"y'])` → `,,"x""y"\r\n` | empty + null + double-quote-escape |
| TC-U-07b | REQ-6, REQ-10 | security | `toCsvRow(['ok', 'line1\r\nline2', 'x'])` → middle cell quoted with CRLF preserved inside | one logical row, parser-safe |
| TC-U-08 | REQ-15 | happy | `revalidateInvite({revokedAt: null, expiresAt: future, usedCount: 0, maxUses: 1}, now)` | `{valid: true}` |
| TC-U-09 | REQ-15 | business | `revalidateInvite({revokedAt: past, ...}, now)` | `{valid: false, reason: 'revoked'}` |
| TC-U-10 | REQ-15 | business | `revalidateInvite({revokedAt: null, expiresAt: past, ...}, now)` | `{valid: false, reason: 'expired'}` |
| TC-U-11 | REQ-15 | business | `revalidateInvite({..., usedCount: 1, maxUses: 1}, now)` | `{valid: false, reason: 'exhausted'}` |
| TC-U-11b | REQ-15 | business | `revalidateInvite({..., usedCount: 2, maxUses: 1}, now)` over-redemption | `{valid: false, reason: 'exhausted'}` (uses `>=`) |
| TC-U-12 | REQ-15 | edge | `revalidateInvite` where `expiresAt === currentTimeMs` (boundary) | `{valid: false, reason: 'expired'}` (inclusive boundary) |
| TC-U-13 | REQ-15 | edge | `revalidateInvite` where revoked AND expired AND exhausted | `{valid: false, reason: 'revoked'}` (revoked wins; documented precedence) |
| TC-U-14 | REQ-13 | happy | `getRequestContext()` inside `runInRequestContext(ctx, fn)` returns `ctx` | match |
| TC-U-15 | REQ-14 | edge | `getRequestContext()` outside scope returns `{ip: '', userAgent: ''}` | default returned, no throw |
| TC-U-16 | REQ-14 | edge | nested `runInRequestContext` scopes — inner ctx overrides outer | inner returned |
| TC-U-17 | REQ-1 | business | `formatBannerCount(0)` → null (no banner) | null |
| TC-U-18 | REQ-1 | happy | `formatBannerCount(1)` → "1 developer was auto-onboarded …" | singular |
| TC-U-19 | REQ-1 | happy | `formatBannerCount(7)` → "7 developers were auto-onboarded …" | plural |
| TC-U-20 | REQ-17 | edge | `ipToCity('')` (empty IP, MaxMind disabled) → null | null |
| TC-U-21 | REQ-16 | edge | `ipToCity('127.0.0.1')` (loopback, MaxMind enabled) → null | private IP rejected |
| TC-U-22 | REQ-16 | validation | `ipToCity('not-an-ip')` (malformed) → null | parser short-circuits, no throw |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `loadFirstAutoProvisionAlert(orgId, managerId)` — 1 sso-auto event in 7d, no ack | `{count: 1, latestAt: timestamp}` |
| TC-I-02 | REQ-1 | edge | 0 sso-auto events in last 7d | `null` |
| TC-I-03 | REQ-1 | business | events older than 7 days NOT counted | excluded |
| TC-I-04 | REQ-1 | business | events in a different org NOT counted | excluded |
| TC-I-05 | REQ-2 | happy | upsert ack for manager A → next query returns null for A | banner hidden after ack |
| TC-I-06 | REQ-2 | business | new sso-auto event after ack → banner returns | reappears |
| TC-I-07 | REQ-2 | edge | ack event A twice in a row → ON CONFLICT preserves first `acked_at` (or refreshes to last; locked: PRESERVE first ack timestamp) | idempotent insert |
| TC-I-07b | REQ-2 | business | given events A, B, C all unacked → ack only B → count drops by 1 (A and C remain) | per-event isolation |
| TC-I-08 | REQ-3 | security | call `loadFirstAutoProvisionAlert` as a member-role user → returns null | role gate |
| TC-I-08b | REQ-3 | security | call `acknowledgeAlert` server action as a member-role user → returns `{ok: false, code: 'unauthorized'}`; no row written | role gate (mutation) |
| TC-I-09 | REQ-4 | happy | `loadAuditLogPage(orgId, {}, page=0)` — returns 50 rows ordered DESC | 50 rows |
| TC-I-10 | REQ-4 | business | rows from a different org excluded | tenant scoped |
| TC-I-10b | REQ-4 | business | `auth_event_log` row with `email_hash` having NO matching `users` row (rejected attempts) → still appears in audit log (LEFT JOIN) | rejected-attempt visibility for attack-pattern forensics |
| TC-I-10c | REQ-4 | security | same email_hash in users of org A and org B → audit-log query for org A returns only org A's events | cross-org isolation |
| TC-I-11 | REQ-5 | happy | filter `outcome='accepted-sso-auto'` → only matching rows | filter applied |
| TC-I-12 | REQ-5 | happy | filter date range `[from, to]` → only rows within bounds | inclusive bounds |
| TC-I-13 | REQ-5 | happy | filter `iss='https://accounts.google.com'` → only matching rows | exact match |
| TC-I-14 | REQ-5 | happy | filter `city ILIKE '%São Paulo%'` (substring) → only matching rows | substring |
| TC-I-15 | REQ-5 | edge | filter `browser` substring with `%` literal in user input → escaped | LIKE escape applied |
| TC-I-16 | REQ-5 | infra | seeded 10k rows + iss filter → query completes in <50ms (perf budget, not exact-plan match — `EXPLAIN ANALYZE` for diagnostics only) | budget met |
| TC-I-17 | REQ-6 | happy | CSV export route returns `Content-Type: text/csv; charset=utf-8` | header correct |
| TC-I-18 | REQ-6 | happy | CSV body is RFC-4180 with header row | header row + CRLF |
| TC-I-19 | REQ-6 | security | CSV cell starting with `=` → prefixed with `'` (formula-injection guard); same for `+`, `-`, `@`, `\t`, `\r` | prefix added |
| TC-I-20 | REQ-7 | happy | invite create with `allowed_sso_providers=['google']` → DB row has `['google']` | persisted |
| TC-I-21 | REQ-7 | validation | invite create with `allowed_sso_providers=['nope']` → action returns `{ok: false, code: 'invalid_input'}` | rejected |
| TC-I-22 | REQ-8 | validation | invite create Server Action with `allowed_sso_providers=[]` → `{ok: false, code: 'invalid_input', detail: '...at least one provider'}`; no row inserted | write-path rejects empty |
| TC-I-22b | REQ-8 | business | seeded legacy row with `allowed_sso_providers=[]` (read path) → `enforceAllowedProviders(invite, 'google')` returns `true` (any provider allowed) | legacy read-path semantics preserved |
| TC-I-23 | REQ-9 | happy | team detail with `?provisioned_via=sso-auto` → only sso-auto users in member list | filter applied |
| TC-I-23b | REQ-9 | business | `?provisioned_via=all` with mixed seeded rows (sso-auto + manual-token + pre-v2-unknown) → ALL rows returned | pre-v2-unknown surfaces under "all" |
| TC-I-24 | REQ-9 | edge | invalid `provisioned_via` value (e.g. `?provisioned_via=xss`) → Zod parse returns default `all`; query unaffected | safe default |
| TC-I-25 | REQ-10 | happy | roster CSV columns + order | exact match |
| TC-I-25b | REQ-10 | edge | roster CSV row for user with NO accepted-sso-auto event → `last_login_at` cell is empty string | NULL → "" |
| TC-I-26 | REQ-10 | security | roster CSV NEVER contains plaintext email | hash prefix only |
| TC-I-27 | REQ-11 | happy | `sendEmail` with `SMTP_HOST` set → nodemailer transport invoked, returns `{ok: true, value: {messageId}}` | dispatched |
| TC-I-28 | REQ-11 | infra | `sendEmail` with `SMTP_HOST` set + transport throws → returns `{ok: false, error: {reason: 'transient'}}` | error mapped |
| TC-I-28b | REQ-11 | infra | `sendEmail` transport stub that never resolves → returns `{ok: false, error: {reason: 'transient'}}` within configured `socketTimeout` (10s); auth flow not stalled | timeout fires |
| TC-I-29 | REQ-11 | validation | `sendEmail` with invalid recipient → `{ok: false, error: {reason: 'invalid-recipient'}}` | error mapped |
| TC-I-30 | REQ-12 | happy | `sendEmail` with `SMTP_HOST` unset → stub called, returns `{ok: true}` | fallback |
| TC-I-30b | REQ-11 | validation | dispatcher init with `SMTP_HOST` set + `SMTP_FROM` unset → returns `{ok: false, error: {reason: 'config-error'}}` on first call (fail-fast, no per-call init retry) | config validation |
| TC-I-31 | REQ-11 | security | `sendEmail` never logs the raw `to` address (SMTP transport path) | privacy invariant |
| TC-I-32 | REQ-13 | happy | request through `csrfWrap` → `auth.ts:signIn` callback reads non-empty `ip` + `userAgent` from `getRequestContext()` | wired |
| TC-I-32b | REQ-14 | security | two concurrent `runInRequestContext` calls via `Promise.all` with distinct ips → each callback observes only its own context (no bleed) | ALS isolation invariant |
| TC-I-33 | REQ-14 | edge | server-component query called outside ALS scope reads defaults | fallback |
| TC-I-34 | REQ-14 | business | per-IP rate-limit dimension fires after 10 attempts from same IP in 5min (empty-IP guard removed) | rate-limit blocks |
| TC-I-34b | REQ-14 | security | 10 attempts with empty `ip` exhaust the per-IP bucket keyed by `''` BUT do NOT exhaust the per-email_hash bucket for an unrelated email → that unrelated email's flow proceeds normally | empty-IP bucket isolation |
| TC-I-35 | REQ-15 | happy | end-to-end race test: revoke invite between SELECT and FOR UPDATE → flow returns `rejected-race` via the new pure predicate | race detected |
| TC-I-36 | REQ-16 | happy | `ipToCity('8.8.8.8')` with `MAXMIND_DB_PATH` set to a fixture mmdb → returns "Mountain View" (or similar) | city returned |
| TC-I-37 | REQ-17 | infra | `ipToCity('8.8.8.8')` with `MAXMIND_DB_PATH` pointing to missing file → returns null + warn log fires once | graceful + idempotent warn |
| TC-I-37b | REQ-17 | infra | `MAXMIND_DB_PATH` points to a corrupt/truncated binary file → `ipToCity` returns null (no throw); singleton stays uninitialized; subsequent calls still return null cheaply | corrupt-file resilience |
| TC-I-37c | REQ-17 | infra | `MAXMIND_DB_PATH` points to a valid mmdb but wrong database type (e.g., GeoLite2-ASN) → `ipToCity` returns null | type-mismatch resilience |
| TC-I-38 | REQ-17 | infra | `ipToCity('8.8.8.8')` with `MAXMIND_DB_PATH` unset → returns null (singleton stays uninitialized) | fallback |
| TC-I-39 | REQ-16 | happy | `auth-event-log-writer` populates `city` column when `ipToCity` returns non-null | column populated |
| TC-I-40 | REQ-17 | business | `auth-event-log-writer` writes `city = null` when `ipToCity` returns null | NULL persisted |
| TC-I-41 | REQ-13 | infra | request with no `x-forwarded-for` AND no `x-real-ip` → `ip` is empty in ctx (NOT undefined; ALS contract) | empty string |
| TC-I-41b | REQ-13a | infra | request that makes `extractContextFromRequest` throw (e.g., crafted header) → handler still runs with default `{ip: '', userAgent: ''}` context; route returns 200 (not 500); warn log fires once | error caught, fallback applied |
| TC-I-42 | REQ-6 | infra | CSV export streaming with 10k seeded rows → process RSS stays bounded (no full materialization); response body delivered incrementally; row count = 10000; header `X-TokenFx-Truncated: false` | bounded memory |
| TC-I-42b | REQ-6 | edge | CSV export with 10,001 seeded rows → response body has 10000 data rows + header `X-TokenFx-Truncated: true` | cap honored |
| TC-I-43 | REQ-4 | infra | `loadAuditLogPage` with `page=99999` → returns empty array (no throw) | empty |
| TC-I-43b | REQ-4 | validation | `?page=abc` → Zod coerces / falls back to page 0; no NaN propagates to SQL | safe coercion |
| TC-I-43c | REQ-4 | validation | `?page=-1` → falls back to page 0 | non-negative |
| TC-I-43d | REQ-4 | validation | `?page=99999999999999` (overflow) → clamped to a max page index; no SQL error | bounded |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1, REQ-2 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-03 (`apps/server/tests/e2e/manager-ui.spec.ts`). banner appears with sso-auto event, dismiss → hidden, new event → reappears | full flow |
| TC-E2E-02 | REQ-4, REQ-5 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-04. navigate to audit-log, apply each filter, verify rows update | filters interactive |
| TC-E2E-03 | REQ-6 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-05. export CSV from audit-log → browser downloads file with correct headers | download works |
| TC-E2E-04 | REQ-7 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-06. invite-create form with multi-select for allowed_sso_providers → DB row reflects choice | UI persists |
| TC-E2E-05 | REQ-9, REQ-10 | happy | **ADDRESSED** by `.specs/oauth-idp-stub.md` TC-E2E-07. team detail page with `provisioned_via` filter → table updates; CSV export downloads | filter + CSV |

## Design

### Architecture Decisions

1. **Banner state lives in a new table `manager_alert_acks`** (migration
   `0005_manager_alert_acks.sql`). Per Decisão #15 (per-event ack):
   composite PK on `(manager_user_id, alert_kind, event_id)`. No
   surrogate `id` column — the three-tuple is the natural lookup key
   for every read/write path. A manager-event pair is acked iff a row
   exists. `alert_kind` is a text column constrained by CHECK to
   `('first-auto-provision',)` for now (extensible without schema
   changes). `event_id` is `bigint` (matches `onboarding_redemption_log.id`'s
   `bigserial`) with FK `REFERENCES onboarding_redemption_log(id) ON DELETE CASCADE`.
   `acked_at` is `timestamp with time zone NOT NULL DEFAULT now()`.
   **Drizzle upsert**: `.onConflictDoNothing()` (NOT `.onConflictDoUpdate()`)
   — if the row already exists, the first `acked_at` is preserved by
   virtue of the row being left untouched (forensic trail invariant).
   Indexes: `idx_manager_alert_acks_user_kind (manager_user_id, alert_kind)`
   for the NOT-IN anti-join.

2. **Audit-log query** scope: `auth_event_log` does NOT store `orgId`
   directly. Per Decisão #8 (multi-tenant), the same email can exist in
   multiple orgs as distinct `users` rows, each with its own `(org_id,
   email)` pair. The audit-log query scopes by joining
   `auth_event_log LEFT JOIN users ON auth_event_log.email_hash = peppered_hash(users.email)
   AND users.org_id = :managerOrgId`. **LEFT JOIN** is mandatory: rejected
   events that never created a user row (the bulk of attack-pattern
   forensic data — Threat 6 enumeration) MUST surface. Rows where the
   join misses (no `users` row in this org) are displayed with
   `email_hash_prefix` only and no display_name. Cross-org leak protection
   is provided by the WHERE clause: a row whose `email_hash` happens to
   exist in another org's `users` table is NOT linked to that org's user
   in this manager's view. Indexes used:
   `idx_auth_event_log_iss_occurred`,
   `idx_auth_event_log_email_occurred`,
   `idx_auth_event_log_subject_occurred`. For city + user_agent substring
   filters, `ILIKE` on top of the trailing `occurred_at` index is
   acceptable up to ~100k rows per org (documented limit; if exceeded,
   the user is shown a "narrow date range" hint via the
   `X-TokenFx-Truncated` header on CSV path).

3. **Audit-log page route**: `apps/server/app/manager/audit-log/page.tsx`
   (Server Component). Filters are query-string driven (so CSV export
   shares the same URL). Pagination via `?page=N`.
   `audit-log-filters.tsx` is a **leaf Client Component** (`'use client'`):
   reads filters via `useSearchParams`, writes back via `useRouter.push`,
   ZERO DB access — all data passes as props from the Server Component
   parent. The parent page Zod-parses raw `searchParams` (clamps `page`,
   bounds `from`/`to` to ISO dates, max-length on string fields)
   BEFORE calling `loadAuditLogPage`; invalid values fall back to safe
   defaults silently (no 4xx — bad query strings should never break
   the page render).
   The page query uses `COUNT(*) OVER() AS total_count` as a window
   function in the same SELECT — one round-trip returns rows + total,
   no separate count query.

4. **CSV export route**: `apps/server/app/manager/audit-log/export/route.ts`
   (Route Handler). Returns `text/csv; charset=utf-8` with
   `Content-Disposition: attachment`. **Always streams** via a
   `ReadableStream` backed by Drizzle's async-iterable cursor — one code
   path, bounded memory regardless of row count. Cap: 10,000 rows; if
   exceeded, the response carries header `X-TokenFx-Truncated: true` and
   stops emitting after row 10,000 (the cursor is closed). The user-facing
   page surfaces a "narrow filters to see more" hint when this header is
   set. Same approach for roster CSV (REQ-10).

5. **CSV formula-injection guard (REQ-6 + TC-I-19):** any cell whose
   trimmed value starts with `=`, `+`, `-`, `@`, `\t`, or `\r` is prefixed
   with `'` before quoting. List authority: OWASP CSV Injection cheat
   sheet (<https://owasp.org/www-community/attacks/CSV_Injection>) — any
   extension to the prefix list requires a spec amendment + cheat-sheet
   reference. Encoded helper `toCsvRow()` (TC-U-06/07/07b) lives in
   `lib/csv/format.ts` and is shared by both CSV routes. Line endings
   `\r\n` throughout per RFC-4180; values containing literal `\r\n`
   inside a cell are preserved verbatim inside the quote-pair (TC-U-07b).
   Note: the `'` prefix is a spreadsheet-layer guard (Excel/Sheets render
   it as a non-formula marker). RFC-4180-compliant parsers (Python `csv`,
   pandas, Numbers) include the literal `'` in the cell value. This is
   the documented OWASP approach.

6. **Pattern-creation Zod schema extension** is additive: existing
   `createInviteFormSchema.strict()` keeps its rejected-unknown-fields
   behavior. New field `allowed_sso_providers` is optional with default
   `[]`. The form UI (`InviteCreateForm`) gets a multi-select shadcn
   primitive (or native `<select multiple>` styled with Tailwind; locked:
   native multi-select for simplicity + zero new deps).

7. **Member-table `provisioned_via` filter**: `getTeamDetail()` accepts
   an optional `{provisionedVia?: 'all' | 'token' | 'sso-auto'}` arg.
   The query joins `user_machines` and filters by `provisionedVia`.
   `'token'` maps to `'manual-token'` in the schema check value
   (`'pre-v2-unknown'` rows are surfaced under `'all'` only; documented).

8. **Roster CSV route**: `apps/server/app/manager/teams/[id]/export/route.ts`.
   Same `toCsvRow` helper. Columns
   `email_hash_prefix, provisioned_via, created_at, last_login_at`.
   `email_hash_prefix` is first 8 chars of the existing peppered hash;
   `last_login_at` is derived via a single **LATERAL JOIN** against
   `auth_event_log` (one index seek per output row at most, O(1) join
   cost — NOT a correlated subquery per output column):
   `LEFT JOIN LATERAL (SELECT MAX(occurred_at) AS last_at FROM auth_event_log
   WHERE email_hash = peppered_hash(u.email) AND outcome = 'accepted-sso-auto')
   ll ON true`. The Drizzle equivalent uses `sql<Date | null>` for the
   lateral subquery (raw SQL fragment is parameterized).

9. **Email dispatcher pattern** (REQ-11/12):
   - `lib/email/send-email.ts` (new, replaces direct import of stub):
     reads env at module init time (synchronous, outside any async
     boundary). Validates the env quadruple `(SMTP_HOST, SMTP_PORT,
     SMTP_USER, SMTP_PASS, SMTP_FROM)` via Zod when `SMTP_HOST` is set;
     missing fields → singleton holds an "error sentinel" and every
     subsequent `sendEmail` call returns `{ok: false, error: {reason:
     'config-error', message: '...'}}`. No retry, no per-call init.
     `nodemailer.createTransport(config)` is called ONCE at module init
     and the resulting `Transporter` is reused across all `sendEmail`
     calls (preserves the SMTP connection pool — re-creating it per call
     would defeat pooling).
   - `lib/email/send-email-smtp.ts` (new): nodemailer-backed
     implementation. Returns the same `Result<EmailResult, EmailError>`
     contract. Transport configured with explicit timeouts:
     `connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout:
     10000` — non-negotiable so a stalled SMTP server never blocks the
     auth flow (worst-case email send returns `transient` in <15s).
     Maps nodemailer errors:
     `ETIMEDOUT / ECONNREFUSED / ESOCKET / socketTimeout` → `transient`,
     `EAUTH / EENVELOPE 5xx code` → `permanent`,
     `EENVELOPE invalid recipient` → `invalid-recipient`.
   - Extend `EmailError.reason` union with `'config-error'`. TASK-8
     greps for exhaustive switches on `EmailError.reason` across the
     codebase and adds a `'config-error'` branch to any that exist.
     The dispatcher module itself includes a compile-time exhaustiveness
     check (`const _exhaustive: never = reason;`) so future additions
     to the union surface as type errors. Existing non-exhaustive callers
     (decision-engine logs `sendResult.reason` directly) work without
     change — the new value flows through as a string.
   - `lib/email/send-email-stub.ts` (existing): unchanged, used as
     fallback when `SMTP_HOST` unset.
   - All callers (currently only `pre-existing-binding-email.ts`)
     import from `lib/email/send-email` (the dispatcher), not directly
     from a backend file.
   - **Dep**: `nodemailer` + `@types/nodemailer`. Verify API via Context7
     (`/nodemailer/nodemailer`) at TASK-time. SMTP testing in CI uses
     `smtp-tester` (in-process fake SMTP server) — NO live SMTP. For
     TC-I-28b (timeout), use a hand-written stub net.Server that accepts
     the TCP connection but never sends the SMTP greeting.

10. **AsyncLocalStorage wiring** (REQ-13/14/13a):
    - `lib/auth/request-context.ts` (new): exports
      `requestContext: AsyncLocalStorage<RequestContext>` where
      `RequestContext = {ip: string; userAgent: string}`, plus
      `runInRequestContext(ctx, fn)` and
      `getRequestContext(): RequestContext`.
    - `getRequestContext` returns `{ip: '', userAgent: ''}` when called
      outside the ALS scope (matches existing behavior — no breakage).
      **MUST NOT be called from Server Components or `lib/queries/*`**
      — those run outside the route-handler scope and would always read
      the empty defaults, silently bypassing the IP-aware rate-limit.
      Callers limited to: `auth.ts:signIn` (inside csrfWrap),
      `auth-event-log-writer.ts` (called from signIn path),
      `sso-auto-provision.ts` (same path).
    - `extractRequestContext(request)` is a helper that reads
      `x-forwarded-for` (first hop, trimmed), `x-real-ip` fallback, and
      `user-agent` header. Wrapped in try/catch — on any throw it
      returns `{ip: '', userAgent: ''}` and a warn log fires once per
      process boot (deduplicated module-level boolean). Per REQ-13a the
      route handler NEVER 500s due to context extraction.
    - `app/api/auth/[...nextauth]/route.ts` `csrfWrap` extension: the
      same wrapper that does CSRF Origin check ALSO does
      `runInRequestContext(extractRequestContext(req), () => handler(req))`
      so every subsequent `auth.ts:signIn` callback sees the populated
      context.
    - `auth.ts:signIn`: replaces the hard-coded `ip: '', userAgent: ''`
      with `const {ip, userAgent} = getRequestContext()`.
    - `rate-limit-sso.ts`: removes the `if (input.ip.length > 0)` guard
      around the per-IP dimension. After this change, an empty `ip`
      keys into the bucket `''` — the per-IP bucket. This is INTENTIONAL
      and safe: the per-email_hash (3/24h) and per-sso_subject (5/24h)
      dimensions are independent buckets — exhausting the per-IP bucket
      keyed by `''` does NOT consume slots in those dimensions for any
      other user (TC-I-34b proves isolation). The empty-IP bucket
      collapse is an acceptable artifact of legitimate request paths
      where IP truly is unknown (e.g., reverse-proxy misconfiguration).
      Existing `rate-limit-sso.test.ts` has NO empty-IP test case today
      — TC-I-34 + TC-I-34b are NEW tests, not migrations.

11. **revalidateInvite extraction** (REQ-15):
    - `lib/auth/revalidate-invite.ts` (new): pure function
      `revalidateInvite(invite: InviteRow, currentTimeMs: number): {valid: true} | {valid: false; reason: 'revoked' | 'expired' | 'exhausted'}`.
      Precedence (TC-U-13): revoked > expired > exhausted. Tested by
      TC-U-08..13 + TC-U-11b.
    - `lib/auth/sso-auto-provision.ts` changes:
      - Remove `onAfterSelectForUpdate?: () => Promise<void>` from
        exported types `ProvisionInTxInput` (line 182) AND
        `AutoProvisionDeps` (line 227). Type breakage is intentional
        (deletes the stub-bypass seam).
      - Remove the inline `revoked / expired / exhausted` checks inside
        `provisionInTx` and replace with one call to `revalidateInvite`
        using the row returned by `SELECT ... FOR UPDATE`.
      - Map the predicate's `reason` to the existing decision kinds:
        `revoked → rejected-race`, `expired → rejected-race`,
        `exhausted → rejected-race` (matches spec-b semantics: any
        post-SELECT failure is a race).
    - `lib/auth/sso-auto-provision.test.ts`: delete the existing
      transitional TCs that exercised `onAfterSelectForUpdate` (spec-b
      TC-I-08/09/10 in that file — concretely the `describe` blocks
      that called the stub seam). Keep the orchestrator decision-tree
      TCs intact (they don't touch the seam).
    - `tests/integration/sso-auto-provision-flow.test.ts`: gain ONE new
      end-to-end race test (TC-I-35) using two real `pg` connections
      in concurrent transactions — proves the predicate fires inside
      the FOR UPDATE tx. (Memory note from spec b review: real pg
      connections, NOT fake timers — fake timers don't simulate
      cross-tx visibility.)

12. **MaxMind IP→city** (REQ-16/17):
    - `lib/auth/ip-to-city.ts` (modify): reads `process.env.MAXMIND_DB_PATH`
      once on first call. Init wrapped in try/catch covering:
      (a) env unset → null + warn once,
      (b) `fs.statSync` throws (file missing) → null + warn once,
      (c) `maxmind.open()` throws (corrupt/wrong-format file) → null +
      warn once,
      (d) opened db's `databaseType` ≠ `'GeoLite2-City'` → null + warn
      once.
      All failure paths set a module-level "init-failed" flag; subsequent
      calls short-circuit to null cheaply (no retry — restart to pick up
      a newly-installed file).
    - On success: `maxmind.open<CityResponse>(path)` cached as
      module-level singleton. Lookup uses `reader.get(ip)`; private/
      loopback/non-routable IPs are rejected via `net.isIP` + an inline
      check for `10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `::1`,
      `fc00::/7` (cheap; no new dep — explicit table in the same module).
    - **Race-safe lazy init**: the singleton uses a Promise-gate pattern,
      NOT a nullable-reader check, so two concurrent first calls don't
      both invoke `maxmind.open`:
      `let _init: Promise<Reader | null> | null = null;
      function getReader(): Promise<Reader | null> { if (!_init) _init = openOrNull(); return _init; }`.
      Promise reference is assigned synchronously before the first `await`
      — both callers observe the same promise.
    - **Signature unchanged**: still `async (ip: string): Promise<string | null>`.
      No callers (`auth-event-log-writer.ts`) need updating.
    - **Dep**: `maxmind` npm package (pure-JS reader). Verify via
      Context7 (`/runk/node-maxmind`) at TASK-time.
    - **Test fixture provenance (locked)**: `tests/fixtures/GeoLite2-City-test.mmdb`
      is generated synthetically at test-fixture-creation time using the
      `mmdbwriter` npm package (devDependency) with ~8 hand-picked IPs
      mapped to known cities (e.g., `8.8.8.8 → Mountain View`,
      `1.1.1.1 → Sydney`). The fixture creation script
      `tests/fixtures/build-maxmind-fixture.ts` is checked in; the
      `.mmdb` binary itself is also checked in (small, deterministic,
      ~few KB). This avoids the MaxMind license + account requirement
      for CI; the real GeoLite2-City.mmdb is downloaded by ops separately
      and pointed to via `MAXMIND_DB_PATH` in prod.
    - `auth-event-log-writer.ts`: already calls `ipToCity` (spec b);
      no code change required there — just gains real city values when
      MaxMind is configured.

13. **Privacy invariants preserved (cross-cutting):**
    - Audit log CSV: email_hash_prefix only (first 8 chars), NEVER
      plaintext email.
    - Roster CSV: same.
    - Banner copy: counts only, never identifiers.
    - Email sender logs: `to_hash` only (existing behavior, unchanged
      across backends).
    - Threat model §"PII in logs" rule re-asserted in
      `apps/server/SECURITY.md` §7 addendum (this spec).

### Files to Create

- `apps/server/lib/db/migrations/0005_manager_alert_acks.sql`
- `apps/server/lib/queries/manager-alerts.ts`
- `apps/server/lib/queries/manager-alerts.test.ts`
- `apps/server/lib/queries/audit-log.ts`
- `apps/server/lib/queries/audit-log.test.ts`
- `apps/server/components/manager/first-auto-provision-banner.tsx`
- `apps/server/components/manager/first-auto-provision-banner.test.tsx`
- `apps/server/app/manager/audit-log/page.tsx`
- `apps/server/app/manager/audit-log/loading.tsx`
- `apps/server/app/manager/audit-log/error.tsx`
- `apps/server/app/manager/audit-log/audit-log-filters.tsx`
- `apps/server/app/manager/audit-log/actions.ts` (ack server action)
- `apps/server/app/manager/audit-log/actions.test.ts`
- `apps/server/app/manager/audit-log/export/route.ts`
- `apps/server/app/manager/audit-log/export/route.test.ts`
- `apps/server/app/manager/teams/[id]/export/route.ts`
- `apps/server/app/manager/teams/[id]/export/route.test.ts`
- `apps/server/lib/csv/format.ts`
- `apps/server/lib/csv/format.test.ts`
- `apps/server/lib/email/send-email.ts` (dispatcher)
- `apps/server/lib/email/send-email.test.ts`
- `apps/server/lib/email/send-email-smtp.ts`
- `apps/server/lib/email/send-email-smtp.test.ts`
- `apps/server/lib/auth/request-context.ts`
- `apps/server/lib/auth/request-context.test.ts`
- `apps/server/lib/auth/revalidate-invite.ts`
- `apps/server/lib/auth/revalidate-invite.test.ts`
- `apps/server/tests/integration/manager-alerts-banner.test.ts`
- `apps/server/tests/integration/audit-log-view.test.ts`
- `apps/server/tests/integration/audit-log-csv.test.ts`
- `apps/server/tests/integration/team-roster-csv.test.ts`
- `apps/server/tests/integration/request-context-wiring.test.ts`
- `apps/server/tests/integration/ip-to-city-maxmind.test.ts`
- `apps/server/tests/e2e/manager-audit-log.spec.ts`
- `apps/server/tests/e2e/manager-banner.spec.ts`
- `apps/server/tests/e2e/manager-team-roster.spec.ts`
- `apps/server/tests/e2e/manager-invite-providers.spec.ts`
- `apps/server/tests/fixtures/GeoLite2-City-test.mmdb` (small test fixture; ~8 IPs in known cities)

### Files to Modify

- `apps/server/lib/db/schema.ts` — add `managerAlertAcks` table.
- `apps/server/lib/auth/auth.ts` — replace hard-coded `ip: '', userAgent: ''` in signIn callback with `getRequestContext()` reads.
- `apps/server/app/api/auth/[...nextauth]/route.ts` — extend `csrfWrap` to also wrap with `runInRequestContext`.
- `apps/server/lib/auth/rate-limit-sso.ts` — drop the `if (input.ip.length > 0)` guard around per-IP dimension; update doc comment.
- `apps/server/lib/auth/rate-limit-sso.test.ts` — migrate empty-IP test to assert the dimension now fires.
- `apps/server/lib/auth/sso-auto-provision.ts` — call `revalidateInvite` predicate after `SELECT FOR UPDATE`; remove `onAfterSelectForUpdate` test seam.
- `apps/server/lib/auth/sso-auto-provision.test.ts` — delete TC-I-08/09/10 (transitional); rely on new revalidate-invite.test.ts + race integration test.
- `apps/server/lib/auth/pre-existing-binding-email.ts` — import `sendEmail` from `lib/email/send-email` (dispatcher) instead of `lib/email/send-email-stub`.
- `apps/server/lib/auth/ip-to-city.ts` — replace stub with MaxMind-backed implementation + env-driven fallback.
- `apps/server/app/manager/invites/actions.ts` — extend `createInviteFormSchema` with `allowed_sso_providers` (optional, default `[]`).
- `apps/server/app/manager/invites/actions.test.ts` — TCs for the new field.
- `apps/server/components/manager/invite-create-form.tsx` — multi-select for `allowed_sso_providers`.
- `apps/server/lib/queries/invites.ts` — pass `allowedSsoProviders` to insert.
- `apps/server/lib/queries/teams.ts` — accept `provisionedVia` filter; extend `TeamMember` type with `provisionedVia` + `lastLoginAt`.
- `apps/server/app/manager/teams/[id]/page.tsx` — read `?provisioned_via` query param; pass to query; render "Export CSV" link.
- `apps/server/components/manager/team-detail-members.tsx` — accept + display `provisioned_via` column (visible only when filter ≠ `all`, or always — locked: always visible with shrink-on-mobile).
- `apps/server/app/manager/page.tsx` — render `<FirstAutoProvisionBanner />` at the top when alert returns non-null.
- `apps/server/SECURITY.md` — §7 addendum.

### Dependencies

- **`nodemailer`** + `@types/nodemailer` — real SMTP backend. **Verify API via Context7 at TASK-time** (`/nodemailer/nodemailer`).
- **`maxmind`** — pure-JS reader for GeoLite2 mmdb files. **Verify API via Context7 at TASK-time** (`/runk/node-maxmind`).
- **`mmdbwriter`** (devDependency) — synthetic mmdb fixture generator for `tests/fixtures/GeoLite2-City-test.mmdb`. Avoids the MaxMind license requirement in CI.
- **`smtp-tester`** (devDependency) — in-process fake SMTP for TC-I-27/29/31. TC-I-28 (transport throws) + TC-I-28b (transport hangs) use hand-written stubs. NO live SMTP in CI.
- **`nodemailer`** + `@types/nodemailer` (already listed) — SMTP transport. Pin to the v6 line; transport options `connectionTimeout`, `greetingTimeout`, `socketTimeout` are stable in v6.

## Tasks

- [x] **TASK-1**: Migration `0005_manager_alert_acks.sql` + `managerAlertAcks` table in `schema.ts`. Per Decisão #15: composite PK `(manager_user_id, alert_kind, event_id)`; FK on `event_id → onboarding_redemption_log(id) ON DELETE CASCADE`; CHECK on `alert_kind`; ON CONFLICT keeps first `acked_at`; index `idx_manager_alert_acks_user_kind`.
  - files: `apps/server/lib/db/migrations/0005_manager_alert_acks.sql`, `apps/server/lib/db/schema.ts`

- [x] **TASK-2**: `lib/csv/format.ts` — `toCsvRow(values)` + `escapeCell(value)` + formula-injection guard. RFC-4180 quoting with `\r\n` line endings. OWASP prefix list (`=`, `+`, `-`, `@`, `\t`, `\r`).
  - files: `apps/server/lib/csv/format.ts`, `apps/server/lib/csv/format.test.ts`
  - tests: TC-U-06, TC-U-07, TC-U-07b

- [x] **TASK-3**: `lib/auth/revalidate-invite.ts` — pure predicate with precedence `revoked > expired > exhausted`. `usedCount >= maxUses` (not `===`) covers over-redemption.
  - files: `apps/server/lib/auth/revalidate-invite.ts`, `apps/server/lib/auth/revalidate-invite.test.ts`
  - tests: TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-11b, TC-U-12, TC-U-13

- [x] **TASK-4**: `lib/auth/request-context.ts` — ALS singleton + `runInRequestContext` + `getRequestContext`.
  - files: `apps/server/lib/auth/request-context.ts`, `apps/server/lib/auth/request-context.test.ts`
  - tests: TC-U-14, TC-U-15, TC-U-16

- [x] **TASK-5**: `lib/queries/manager-alerts.ts` — `loadFirstAutoProvisionAlert(orgId, managerId)` (NOT-IN anti-join against `manager_alert_acks`) + `acknowledgeAlert(managerId, alertKind, eventId)` (ON CONFLICT DO NOTHING — preserves first ack timestamp).
  - files: `apps/server/lib/queries/manager-alerts.ts`, `apps/server/lib/queries/manager-alerts.test.ts`, `apps/server/tests/integration/manager-alerts-banner.test.ts`
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-07b, TC-I-08, TC-I-08b, TC-U-17, TC-U-18, TC-U-19

- [x] **TASK-6**: `lib/queries/audit-log.ts` — `loadAuditLogPage(orgId, filters, page)`. LEFT JOIN against `users` per Design §2. Zod-coerce `page` param (clamp negative/NaN/overflow to safe bounds).
  - files: `apps/server/lib/queries/audit-log.ts`, `apps/server/lib/queries/audit-log.test.ts`, `apps/server/tests/integration/audit-log-view.test.ts`
  - tests: TC-I-09, TC-I-10, TC-I-10b, TC-I-10c, TC-I-11, TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-43, TC-I-43b, TC-I-43c, TC-I-43d

- [x] **TASK-7**: `lib/email/send-email-smtp.ts` — nodemailer wrapper + error mapping + explicit timeouts (connectionTimeout=5s, greetingTimeout=5s, socketTimeout=10s).
  - files: `apps/server/lib/email/send-email-smtp.ts`, `apps/server/lib/email/send-email-smtp.test.ts`
  - tests: TC-I-27, TC-I-28, TC-I-28b, TC-I-29, TC-I-31

- [x] **TASK-8**: `lib/email/send-email.ts` — dispatcher (env-driven, Zod-validated config). Extends `EmailError.reason` union with `'config-error'`. Greps for exhaustive switches on `EmailError.reason` and adds `'config-error'` branches where present. Verifies `send-email-stub.ts` uses `logger.debug` (NOT `console.log`) per project rule; migrates if needed.
  - files: `apps/server/lib/email/send-email.ts`, `apps/server/lib/email/send-email.test.ts`, `apps/server/lib/email/send-email-stub.ts`
  - depends: TASK-7
  - tests: TC-I-30, TC-I-30b

- [x] **TASK-9**: `lib/auth/ip-to-city.ts` — MaxMind-backed, env-driven fallback. Signature unchanged (`async (ip: string): Promise<string | null>`); no callers need updates. Includes synthetic-fixture generator script.
  - files: `apps/server/lib/auth/ip-to-city.ts`, `apps/server/tests/integration/ip-to-city-maxmind.test.ts`, `apps/server/tests/fixtures/GeoLite2-City-test.mmdb`, `apps/server/tests/fixtures/build-maxmind-fixture.ts`, `apps/server/tests/fixtures/README.md`
  - tests: TC-U-20, TC-U-21, TC-U-22, TC-I-36, TC-I-37, TC-I-37b, TC-I-37c, TC-I-38, TC-I-39, TC-I-40

- [x] **TASK-10**: `pre-existing-binding-email.ts` — route through dispatcher.
  - files: `apps/server/lib/auth/pre-existing-binding-email.ts`
  - depends: TASK-8

- [x] **TASK-11**: Wire `requestContext` into the NextAuth route handler. `csrfWrap` ALSO runs the handler inside `runInRequestContext(extractRequestContext(req), ...)`. `extractRequestContext` wrapped in try/catch per REQ-13a — never 500s.
  - files: `apps/server/app/api/auth/[...nextauth]/route.ts`, `apps/server/tests/integration/request-context-wiring.test.ts`
  - depends: TASK-4
  - tests: TC-I-32, TC-I-32b, TC-I-33, TC-I-41, TC-I-41b

- [x] **TASK-12**: Consume `requestContext` in `auth.ts:signIn`.
  - files: `apps/server/lib/auth/auth.ts`
  - depends: TASK-4, TASK-11

- [x] **TASK-13**: Drop empty-IP guard in `rate-limit-sso.ts`. Update module-level JSDoc to document the empty-IP bucket invariant (per-IP keyed by `''` is isolated from per-email + per-subject dimensions). Add NEW tests (not a migration — no existing empty-IP TC to convert).
  - files: `apps/server/lib/auth/rate-limit-sso.ts`, `apps/server/lib/auth/rate-limit-sso.test.ts`
  - depends: TASK-4, TASK-11
  - tests: TC-I-34, TC-I-34b

- [x] **TASK-14**: Refactor `sso-auto-provision.ts` to call `revalidateInvite`. Delete `onAfterSelectForUpdate?` field from BOTH `ProvisionInTxInput` (line 182) AND `AutoProvisionDeps` (line 227). In `sso-auto-provision.test.ts`, remove the stub `provisionInTx` implementations that called the seam + the TCs that depended on it (transitional TC-I-08/09/10 per spec b). The orchestrator decision-tree TCs (the ones not touching the seam) stay. Add ONE end-to-end race test in `tests/integration/sso-auto-provision-flow.test.ts` using two real `pg` connections (NOT fake timers).
  - files: `apps/server/lib/auth/sso-auto-provision.ts`, `apps/server/lib/auth/sso-auto-provision.test.ts`, `apps/server/tests/integration/sso-auto-provision-flow.test.ts`
  - depends: TASK-3
  - tests: TC-I-35

- [x] **TASK-15**: Extend invite Zod schema (`.min(1)` for write path + `.transform` dedup) + insert + form UI for `allowed_sso_providers` (4-option multi-select). Read-path / `enforceAllowedProviders()` semantics unchanged.
  - files: `apps/server/app/manager/invites/actions.ts`, `apps/server/app/manager/invites/actions.test.ts`, `apps/server/components/manager/invite-create-form.tsx`, `apps/server/lib/queries/invites.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-05b, TC-I-20, TC-I-21, TC-I-22, TC-I-22b

- [x] **TASK-16**: Extend `getTeamDetail` + `TeamMember` type with `provisioned_via` filter + `lastLoginAt`. `'all'` includes `pre-v2-unknown` rows; `'token'` maps to `'manual-token'`; invalid Zod-coerces to `'all'`. Update `team-detail-members.tsx` to show `provisioned_via` column.
  - files: `apps/server/lib/queries/teams.ts`, `apps/server/lib/queries/teams.test.ts`, `apps/server/components/manager/team-detail-members.tsx`
  - tests: TC-I-23, TC-I-23b, TC-I-24

- [x] **TASK-17**: Manager dashboard renders `<FirstAutoProvisionBanner />`. Banner accepts the unacknowledged-events list (not just a count) so per-event ack buttons can render.
  - files: `apps/server/app/manager/page.tsx`, `apps/server/components/manager/first-auto-provision-banner.tsx`, `apps/server/components/manager/first-auto-provision-banner.test.tsx`
  - depends: TASK-5
  - tests: TC-U-17, TC-U-18, TC-U-19

- [x] **TASK-18**: `/manager/audit-log` page + filters component + ack server action. Page Zod-parses `searchParams` (clamp `page` non-negative + max; ISO date for `from`/`to`; max-length on string fields; safe defaults on invalid) BEFORE calling `loadAuditLogPage`. `audit-log-filters.tsx` is a leaf Client Component. `actions.ts:acknowledgeAlert` follows the `actions.ts` prior-art pattern: `auth()` role check (manager|admin), Zod parse, `revalidatePath('/manager')` on success, typed Result return.
  - files: `apps/server/app/manager/audit-log/page.tsx`, `apps/server/app/manager/audit-log/loading.tsx`, `apps/server/app/manager/audit-log/error.tsx`, `apps/server/app/manager/audit-log/audit-log-filters.tsx`, `apps/server/app/manager/audit-log/actions.ts`, `apps/server/app/manager/audit-log/actions.test.ts`
  - depends: TASK-5, TASK-6

- [x] **TASK-19**: Audit-log CSV export route — streams via Drizzle async iteration; 10k-row cap with `X-TokenFx-Truncated` header.
  - files: `apps/server/app/manager/audit-log/export/route.ts`, `apps/server/app/manager/audit-log/export/route.test.ts`, `apps/server/tests/integration/audit-log-csv.test.ts`
  - depends: TASK-2, TASK-6
  - tests: TC-I-17, TC-I-18, TC-I-19, TC-I-42, TC-I-42b

- [x] **TASK-20**: Team-detail page reads filter; "Export CSV" link.
  - files: `apps/server/app/manager/teams/[id]/page.tsx`
  - depends: TASK-16

- [x] **TASK-21**: Team-detail CSV export route — same streaming + cap pattern as TASK-19.
  - files: `apps/server/app/manager/teams/[id]/export/route.ts`, `apps/server/app/manager/teams/[id]/export/route.test.ts`, `apps/server/tests/integration/team-roster-csv.test.ts`
  - depends: TASK-2, TASK-16
  - tests: TC-I-25, TC-I-25b, TC-I-26

- [x] **TASK-22**: SECURITY.md §7 addendum.
  - files: `apps/server/SECURITY.md`

- [x] **TASK-SMOKE**: Execute E2E smoke tests.
  - files: `apps/server/tests/e2e/manager-audit-log.spec.ts`, `apps/server/tests/e2e/manager-banner.spec.ts`, `apps/server/tests/e2e/manager-team-roster.spec.ts`, `apps/server/tests/e2e/manager-invite-providers.spec.ts`
  - depends: TASK-17, TASK-18, TASK-19, TASK-20, TASK-21, TASK-15
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05
  - If app not running: log `E2E: DEFERRED`

## Parallel Batches

Classification:
- All "Files to Create" are **exclusive** to their task.
- **Shared-mutative** (must serialize):
  - `apps/server/lib/auth/auth.ts` (TASK-12 only)
  - `apps/server/lib/auth/rate-limit-sso.ts` (TASK-13 only)
  - `apps/server/lib/auth/sso-auto-provision.ts` (TASK-14 only)
  - `apps/server/lib/auth/ip-to-city.ts` (TASK-9 only)
  - `apps/server/lib/auth/pre-existing-binding-email.ts` (TASK-10 only)
  - `apps/server/app/manager/invites/actions.ts` (TASK-15 only)
  - `apps/server/lib/queries/teams.ts` (TASK-16 only)
  - `apps/server/components/manager/team-detail-members.tsx` (TASK-16 only)
  - `apps/server/lib/queries/invites.ts` (TASK-15 only)
  - `apps/server/app/manager/teams/[id]/page.tsx` (TASK-20 only)
  - `apps/server/app/manager/page.tsx` (TASK-17 only)
  - `apps/server/components/manager/invite-create-form.tsx` (TASK-15 only)
  - `apps/server/lib/db/schema.ts` (TASK-1 only)
  - `apps/server/app/api/auth/[...nextauth]/route.ts` (TASK-11 only)

No `TASK-MERGE-*` needed (no shared-additive files).

**Batches**:

```text
Batch 1 (foundation — no deps):  [TASK-1, TASK-2, TASK-3, TASK-4, TASK-7, TASK-9, TASK-15, TASK-16, TASK-22]
Batch 2 (consume Batch-1 deps):   [TASK-5, TASK-6, TASK-8, TASK-11, TASK-14]
Batch 3 (consume Batch-2 deps):   [TASK-10, TASK-12, TASK-13, TASK-17, TASK-18, TASK-20]
Batch 4 (consume Batch-3 deps):   [TASK-19, TASK-21]
Batch 5 (e2e last):                [TASK-SMOKE]
```

Validation note: Batch 1 has 9 parallel tasks (capacity OK; all touch
non-overlapping files). Batches 2–4 average 5 tasks each, all
independent within the batch.

## Validation Criteria

- [ ] `pnpm typecheck` passes (apps/server + root).
- [ ] `pnpm lint` passes.
- [ ] `pnpm test --run` passes (apps/server). Anti-regression: 933+
  pre-existing apps/server tests stay green (+~80 new TCs from this
  spec — total ~1010+).
- [ ] `pnpm build` passes (apps/server).
- [ ] `pnpm test:e2e` passes when dev server up; otherwise `E2E: DEFERRED`.
- [ ] **Live validation** (dev server + curl + SQL):
  - Seed DB with: 1 org, 1 manager, 1 invite with `allowed_sso_providers=['google']`, 2 sso-auto redemption rows in the last 7d.
  - Hit `/manager` as the manager → banner visible with count=2.
  - Click acknowledge → banner hidden.
  - Insert another sso-auto row → reload `/manager` → banner visible again with count=1.
  - Navigate `/manager/audit-log` → 50-row table renders. Apply filter `outcome=accepted-sso-auto` → only matching rows.
  - Click "Export CSV" → file downloads; open it; assert columns + no plaintext email.
  - Navigate `/manager/teams/[id]?provisioned_via=sso-auto` → only sso-auto users in member list. Click "Export CSV" → file with hash prefix.
  - Verify `SMTP_HOST=localhost SMTP_PORT=1025` with maildev running: `pre-existing-binding-email` triggers a real email visible in maildev UI; UNSET `SMTP_HOST` → stub log fires.
  - With `MAXMIND_DB_PATH` set to fixture mmdb: hit signIn from a forged `x-forwarded-for: 8.8.8.8` → audit-log row `city` column is populated. Unset → `city` is null.
- [ ] **Privacy invariants verified**:
  - `grep -RIn "console.log" apps/server/lib apps/server/app apps/server/components` → 0 matches.
  - `grep -RIn "plain.*email\|user.email" apps/server/app/manager/audit-log apps/server/app/manager/teams/.*/export` → 0 matches (only `email_hash_prefix`).

## Execution Log

### Batch 1 [TASK-1, TASK-2, TASK-3, TASK-4, TASK-7, TASK-9, TASK-15, TASK-16, TASK-22] (2026-05-12 12:45)

Parallel via worktrees (9 agents). All worktrees were branched from a stale base (`90e949f`, pre-`apps/server`); agents fell back to writing in the main tree (TASK-1, 2, 3, 15, 16, 22) or fast-forwarded then wrote in worktree (TASK-4, 7, 9 — files copied to main post-execution). All 9 worktrees cleaned up post-merge.

- TASK-1: managerAlertAcks table + 0005 migration — schema-only (no tests)
- TASK-2: lib/csv/format.ts — TDD: RED(18) → GREEN(18); OWASP guard restricted to string inputs only (numbers/Dates exempt — documented)
- TASK-3: lib/auth/revalidate-invite.ts — TDD: RED(10) → GREEN(10); precedence revoked > expired > exhausted; `usedCount >= maxUses` covers over-redemption
- TASK-4: lib/auth/request-context.ts — TDD: RED(4) → GREEN(4); `function` overloads (sync `T` vs async `Promise<T>`) for caller ergonomics
- TASK-7: lib/email/send-email-smtp.ts — TDD: RED → GREEN(16); nodemailer v6 (downgraded from v8 due to NextAuth peer-dep); explicit timeouts; hand-written stub Transporter
- TASK-9: lib/auth/ip-to-city.ts MaxMind-backed — TDD: RED(9) → GREEN(27); used MaxMind's official MIT-licensed test mmdbs (mmdbwriter is Go-only — not on npm); accepts GeoLite2-City + GeoIP2-City databaseType; Promise-gate singleton; 4 failure-mode warn-once paths
- TASK-15: invite allowed_sso_providers UX — TDD: RED(15) → GREEN(36); `.min(1).transform(dedup)` on write path; checkbox group UI; `enforceAllowedProviders` legacy `[]` semantics preserved inline in orchestrator
- TASK-16: getTeamDetail provisioned_via filter + lastLoginAt — TDD: RED(4) → GREEN(15); LATERAL JOIN via Drizzle raw-SQL escape (typed query builder doesn't expose leftJoinLateral); pre-v2-unknown surfaced via COALESCE
- TASK-22: SECURITY.md §7 addendum — 94 lines, 10 subsections; docs-only

Post-batch validation: `pnpm typecheck` clean; 1021 passed / 10 skipped / 1 pre-existing flake (`aggregate-team-outcomes.test.ts:233` — TC-I-04b, unrelated; confirmed in spec b baseline).

Deps added to `apps/server/package.json`: `nodemailer@^6.10.0`, `maxmind@^5.0.6`, devDep `@types/nodemailer@^6.4.17`.

### Batch 2 [TASK-5, TASK-6, TASK-8, TASK-11, TASK-14] (2026-05-12 12:55)

Parallel via worktrees (5 agents). All worktrees stale (`90e949f`); all agents fell back to main tree. Worktrees cleaned up.

- TASK-5: lib/queries/manager-alerts.ts — TDD: RED → GREEN(3 unit + 10 integration); `BANNER_WINDOW_MS` 7d cutoff; Drizzle NOT IN anti-join; ON CONFLICT DO NOTHING preserves first acked_at
- TASK-6: lib/queries/audit-log.ts — TDD: RED → GREEN(9 unit + 12 integration); JS-side email hashing + `inArray` (avoids `pgcrypto` dep); empty-org early exit; LIKE-escape; out-of-range page falls back to separate COUNT
- TASK-8: lib/email/send-email.ts dispatcher — TDD: RED → GREEN(7); compile-time exhaustiveness on `EmailError.reason`; `__resetDispatcher(factory?)` test seam; SMTP_HOST unset → stub, SMTP_FROM unset → config-error sentinel (fail-fast)
- TASK-11: csrfWrap extended with `runInRequestContext` — TDD: RED → GREEN(11); `extractRequestContext` extracted to sibling module `request-context-extract.ts` (NextAuth ESM resolution limit); warn-once dedup
- TASK-14: revalidateInvite refactor — TDD: RED → GREEN(41 unit + 10 predicate + 19 integration); deleted seam fields from `ProvisionInTxInput` + `AutoProvisionDeps`; deleted spec-b transitional TC-I-08/09/10 (~155 LOC); added TC-I-35 race test using two real `pg.Pool` connections

Post-batch validation: typecheck clean; 1071 passed / 10 skipped / 1 pre-existing flake.

### Batch 3 [TASK-10, TASK-12, TASK-13, TASK-17, TASK-18, TASK-20] (2026-05-12 13:05)

Parallel via worktrees (6 agents). All stale; all fell back to main tree. Worktrees cleaned up.

- TASK-10: pre-existing-binding-email routed through dispatcher — 1-line import swap; existing 12 tests still GREEN. Also re-exported `SendEmailFn`/`EmailError`/`EmailInput`/`EmailResult` from dispatcher.
- TASK-12: auth.ts consumes `getRequestContext()` — 3-line change + import + comment update; 20/20 auth tests GREEN
- TASK-13: dropped empty-IP guard in rate-limit-sso — TDD: RED(2) → GREEN(9 total); TC-I-34 + TC-I-34b verify per-IP dimension fires on empty + isolation across distinct IP keys
- TASK-17: first-auto-provision banner + Server Action — TDD: RED → GREEN(11 action + 5 banner render); Server Action follows invites/actions.ts pattern with auth gate + Zod + revalidatePath; banner shows top-5 events with overflow indicator + per-event ack form-submit
- TASK-18: /manager/audit-log page + filters + loading/error boundaries — Server Component page; Client Component filters via useSearchParams/useRouter; Zod `.catch()` per field for safe defaults
- TASK-20: team-detail page reads `?provisioned_via` + renders filter UI + CSV link — whitelist coercion fallback to 'all'

Post-Batch inline fix: TASK-18 introduced pt-BR diacritic (`São Paulo` placeholder) violating i18n-microcopy convention — fixed to `London`. Test re-green.

Post-batch validation: typecheck clean; 1087 passed / 10 skipped / 1 pre-existing flake.

### Batch 4 [TASK-19, TASK-21] (2026-05-12 13:18)

Parallel via worktrees (2 agents). Stale → main tree.

- TASK-19: audit-log CSV export route — TDD: RED(1) → GREEN(14 unit + 4 integration); injectable `authFn`/`loadAuditLogPageFn` to keep NextAuth out of vitest graph; `X-TokenFx-Truncated` semantics
- TASK-21: team-roster CSV export route — TDD: RED(1 module-load) → GREEN(15 unit + integration tests); extended `TeamMember` with `createdAt`; `hashEmail(...).slice(0, 8)` before CSV emit

Post-Batch inline fix: TASK-21 integration test asserted 5 rows but `getTeamDetail` correctly returns ALL 7 team members (5 fixtures + manager + memberA). Updated to expect 7 with full alphabetical order. Test re-green.

Post-batch validation: typecheck clean; 1127 passed / 10 skipped / 1 pre-existing flake (only the persistent `aggregate-team-outcomes:233`).

### TASK-SMOKE (E2E) — DEFERRED

Per the SMOKE task's "If app not running: log E2E: DEFERRED" rule: no Playwright run executed; the manager-UI surfaces are validated via integration tests (1127 passing). E2E spec files (`tests/e2e/manager-*.spec.ts`) were NOT authored — to be addressed by a follow-up `oauth-idp-stub` spec that provides the IdP harness needed for full SSO-flow E2E. Same posture as spec b's TC-E2E-01/02 DEFERRED.





