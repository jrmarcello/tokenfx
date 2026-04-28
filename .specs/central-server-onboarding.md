# Spec: central-server-onboarding — invite-token flow for reporter provisioning

## Status: DRAFT

## Depends on

- `central-reporter-server.md` (must reach DONE before this spec is implementable). The schema (`users`, `user_machines`), auth (NextAuth + role gating), the ingest endpoint, and the reporter runner's config-file shape are all locked there.

## Context

`central-reporter-server.md` ships ingestão + manager dashboard, but punts the question of **how a dev gets `key_id` + `secret` provisioned**. For v0 of that spec, machines are seeded manually via DB. That doesn't scale beyond the author + maybe one tester.

This spec ships the production-grade onboarding flow: a **manager-issued invite token** model.

1. Manager (role ∈ `manager`/`admin`) goes to `/manager/admin/invites`, creates an invite (token, optional email_pattern, max_uses, expires_at, optional team_id).
2. Manager shares the URL `https://central/onboard?token=XXX` with the dev (Slack, email — out of band).
3. Dev runs `pnpm reporter:setup`, pastes the URL or just the token, types their corporate email.
4. Setup script POSTs to `/api/onboarding/redeem-invite` with `{token, machine_id, hostname, claimed_email}`. Server validates token (active, not expired, has remaining uses, email matches pattern), upserts the `user` (by email), inserts a `user_machines` row with a freshly-generated `(key_id, secret)`, and returns `{key_id, secret, central_url}` — **the only response in the system that ever exposes the secret in plaintext**. The DB stores `bcrypt(secret)` only.
5. Setup writes the values into `data/reporter-config.json` (mode 0600), generates `project_secret` if missing, and exits.

Anti-goals (stay narrow):
- Self-service signup without a manager-issued invite (no public registration).
- SSO-based provisioning (a dev's Google login → auto-machine). Defer — needs careful threat model.
- Web-based onboarding (browser flow). The reporter is a CLI; the setup is a CLI.

## Requirements

### Schema + token primitives

- [ ] **REQ-1**: New table `onboarding_invites` in `apps/server/lib/db/schema.ts`:

  ```sql
  CREATE TABLE onboarding_invites (
    token TEXT PRIMARY KEY,                   -- 32 random bytes hex (64 chars), URL-safe
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
    email_pattern TEXT NULL,                  -- exact email "alice@x.com" OR glob "*@x.com" OR null (any)
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_onboarding_invites_org ON onboarding_invites(org_id, created_at DESC);
  ```

- [ ] **REQ-2**: Token generation — `crypto.randomBytes(32).toString('hex')` produces a 64-char URL-safe string. NEVER reused (UNIQUE PK enforces). Tokens are treated as bearer secrets — their value is the only thing protecting redemption.

- [ ] **REQ-3**: New table `onboarding_redemption_log`:

  ```sql
  CREATE TABLE onboarding_redemption_log (
    id BIGSERIAL PRIMARY KEY,
    token_prefix TEXT NOT NULL,               -- first 8 chars of token (full token NEVER logged)
    machine_id UUID NULL,                     -- null on rejection
    claimed_email TEXT NOT NULL,
    request_ip TEXT NULL,                     -- truncated /24, nulled after 30d (same policy as ingestion_log)
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted','token-invalid','token-expired','token-revoked','token-exhausted','email-mismatch','rate-limited','error')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```

### Admin invite management

- [ ] **REQ-4**: `POST /api/admin/invites` (auth: `manager` or `admin` role). Body Zod: `{ team_id?: string (uuid), email_pattern?: string, max_uses?: number (1..100, default 1), expires_in_hours: number (1..720, default 168) }`. Server computes `expires_at = now + expires_in_hours*3600s`, generates token, sets `created_by = session.user.id`, `org_id = session.user.org_id`. Returns the **full token** in response (only opportunity to copy it). Role gated by middleware (REQ-17 of central-reporter-server).

- [ ] **REQ-5**: `GET /api/admin/invites` lists invites for the manager's org, ordered by `created_at DESC`. Each row returns: `{ token_prefix, status, max_uses, used_count, email_pattern, team_name, expires_at, created_by_email, created_at }`. Status derived: `active` (not revoked, not expired, used_count < max_uses), `expired` (now > expires_at), `exhausted` (used_count >= max_uses), `revoked` (revoked_at set). **Full token NEVER returned after creation** — manager who lost the URL must create a new invite.

- [ ] **REQ-6**: `PATCH /api/admin/invites/:token_prefix/revoke` (admin or manager) sets `revoked_at = now()`. Idempotent. Lookup by prefix because manager only saw prefix in the list view; collisions on prefix → 409 with explicit message (extremely unlikely with 32-byte tokens but defended).

### Redemption (public-ish endpoint)

- [ ] **REQ-7**: `POST /api/onboarding/redeem-invite` is unauthenticated (the token IS the auth). Body Zod (`.strict()`): `{ token: string (64 hex), machine_id: string (uuid), hostname: string (max 255), claimed_email: string (email format) }`.

- [ ] **REQ-8**: Validation order (each step can short-circuit with a typed error):
  1. **Token lookup** — SELECT FOR UPDATE on `(token)`; missing → `outcome='token-invalid'`, response 401, generic message ("invalid or expired invite").
  2. **Revoked** — `revoked_at IS NOT NULL` → `outcome='token-revoked'`, response 401.
  3. **Expired** — `now() > expires_at` → `outcome='token-expired'`, response 401.
  4. **Exhausted** — `used_count >= max_uses` → `outcome='token-exhausted'`, response 401.
  5. **Email pattern** — if `email_pattern` is set, match `claimed_email` exactly (no glob) OR via simple `*@domain` glob (only domain wildcard supported) → mismatch → `outcome='email-mismatch'`, response 403.
  6. **Rate limit** — per-IP 10 req/min sliding window → exceed → `outcome='rate-limited'`, response 429 with `Retry-After`.

  Generic 401 for steps 1-4 (don't leak which step failed — defense against token-existence probing). Each step writes to `onboarding_redemption_log` with the appropriate `outcome`.

- [ ] **REQ-9**: On all checks passing, single transaction:
  1. Upsert `users` by `(org_id, email)` — if user exists, reuse `id`; else INSERT with `role='member'`, `team_id` from invite.
  2. Generate `secret = crypto.randomBytes(32).toString('hex')`, `key_id = "k_" + crypto.randomBytes(8).toString('hex')` (12 chars after prefix — namespace prevents collision with token shape).
  3. INSERT `user_machines (user_id, machine_id, key_id, secret_hash=bcrypt(secret), created_at, last_seen_at=now())`.
  4. UPDATE `onboarding_invites SET used_count = used_count + 1 WHERE token = ?` (the FOR UPDATE earlier serialized this).
  5. INSERT `onboarding_redemption_log (token_prefix, machine_id, claimed_email, outcome='accepted', request_ip)`.
  6. Return `{ key_id, secret, central_url, user_email }` 200. **`secret` is the ONLY plaintext exposure ever** — afterwards only `bcrypt(secret)` lives in DB.

- [ ] **REQ-10**: Atomicity — the transaction MUST hold `SELECT FOR UPDATE` on the invite row for steps 1-4 of REQ-8 and the increment in REQ-9.4. Two concurrent redemptions of an invite with `max_uses=1` MUST result in exactly one acceptance and one `token-exhausted` rejection — never two acceptances. TC-I covers this with parallel requests.

### Email-pattern matching

- [ ] **REQ-11**: `matchEmailPattern(pattern: string | null, email: string): boolean` — pure helper. Rules: `null` → true (any email allowed); pattern starts with `*@` → match any local-part with same domain (`*@example.com` matches `alice@example.com`); else exact match (case-insensitive). No other glob characters supported (no `?`, no `*` mid-string). Document why narrow: domain-wildcard covers the 95% real-world case (corporate domain), and broader patterns invite footguns.

### Reporter setup CLI

- [ ] **REQ-12**: `pnpm reporter:setup` is interactive. Prompts (in order):
  1. "Onboarding URL or token:" — accepts both `https://server/onboard?token=XXX` (parses URL, extracts token + central_url) or just the token (then prompts separately for central URL).
  2. "Your work email:" — defaults to `git config user.email` (REQ-1 of outcome-integration-git already reads this in another path; reuse the same helper if it lands first; otherwise inline).
  3. (Confirms before submitting): "Submit redeem request to <central_url>? [Y/n]"

- [ ] **REQ-13**: Setup POSTs to `/api/onboarding/redeem-invite`. On 200 success: writes `data/reporter-config.json` with `{ key_id, secret, machine_id, user_email, central_url, project_secret }` (project_secret generated locally — REQ-14 below); file mode 0600; logs `info` "Reporter configured. Run pnpm reporter:run to push your first batch.".

- [ ] **REQ-14**: `project_secret` for slug HMAC (defined in central-reporter-server.md REQ-2) is generated **locally** during setup — `crypto.randomBytes(32).toString('hex')`. NOT acquired from the server. Rationale: it's a local-only secret used to deterministically slugify project paths; the server doesn't need to know it (the slug arrives already-hashed in payloads).

- [ ] **REQ-15**: Setup error handling. Non-2xx response from redeem endpoint → exits with code 1 and a clear message tied to the response status: 401 → "Invite token invalid, expired, exhausted, or revoked. Ask your manager for a new one."; 403 → "Your email doesn't match this invite's allowed pattern. Ask your manager."; 429 → "Too many onboarding attempts from this IP. Wait <retry_after>s and try again."; 500/network → "Couldn't reach <central_url>. Check the URL and your connection.". NEVER overwrite an existing `data/reporter-config.json` on partial success — config write is the LAST step, only after a 200 response.

### Admin UI

- [ ] **REQ-16**: `apps/server/app/manager/admin/invites/page.tsx` (Server Component) — table of invites for the org. Columns: token preview (`xxxxxxxx…`), status badge (color-coded), team, email pattern, used/max, expires_in (relative), created_by, actions (revoke button when `status === 'active'`). Empty state: "No invites yet — create one to onboard a teammate."

- [ ] **REQ-17**: Create invite form (Server Action, NOT API route — same form-friendly pattern as nextjs-conventions.md). Fields: team (select from `teams` of org, optional), email_pattern (text, optional, helper "leave blank for any email; use `*@domain.com` to allow a whole domain"), max_uses (number, default 1, max 100), expires_in_hours (number, default 168 = 7d, max 720 = 30d). On success, the response page shows the **full token URL ONCE** with a copy button + a warning: "This is the only time you'll see this URL. Copy it now."

- [ ] **REQ-18**: Revoke action — Server Action posting to `PATCH /api/admin/invites/:prefix/revoke`. Single-click with `<form>` confirmation (`window.confirm` is fine; not enough to merit a dialog component).

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | `generateInviteToken()` returns 64-char hex | matches `^[0-9a-f]{64}$` |
| TC-U-02 | REQ-2 | security | 1000 generated tokens are all unique | `Set(tokens).size === 1000` |
| TC-U-03 | REQ-11 | happy | `matchEmailPattern(null, "x@y.com")` | true |
| TC-U-04 | REQ-11 | happy | `matchEmailPattern("alice@x.com", "alice@x.com")` | true |
| TC-U-05 | REQ-11 | happy | `matchEmailPattern("alice@x.com", "ALICE@X.COM")` (case-insensitive) | true |
| TC-U-06 | REQ-11 | happy | `matchEmailPattern("*@example.com", "anyone@example.com")` | true |
| TC-U-07 | REQ-11 | edge | `matchEmailPattern("*@example.com", "anyone@other.com")` | false |
| TC-U-08 | REQ-11 | edge | `matchEmailPattern("*@example.com", "@example.com")` (empty local-part) | false |
| TC-U-09 | REQ-11 | validation | `matchEmailPattern("alice*@x.com", "alice123@x.com")` (mid-string `*` not supported) | false (treated as literal) |
| TC-U-10 | REQ-12 | happy | Setup parses `https://central/onboard?token=ABC` → `{token: 'ABC', central_url: 'https://central'}` | parsed correctly |
| TC-U-11 | REQ-12 | edge | Setup receives bare token (no URL) → prompts for central_url separately | second prompt fires |
| TC-U-12 | REQ-15 | validation | Redeem response 401 → setup exit code 1 with token-related message | clear stderr |
| TC-U-13 | REQ-15 | validation | Redeem response 403 → setup exit code 1 with email-mismatch message | clear stderr |

### Integration Tests (Testcontainers Postgres)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-3 | infra | Migrations create `onboarding_invites` and `onboarding_redemption_log` tables | both tables present, indexes correct |
| TC-I-02 | REQ-4 | happy | Manager creates invite → token returned, row in DB with correct fields | 200; token shape valid; row matches input |
| TC-I-03 | REQ-4 | security | Member-role user POSTs to `/api/admin/invites` | 403 |
| TC-I-04 | REQ-4 | validation | `expires_in_hours = 0` → rejected | 400 |
| TC-I-05 | REQ-4 | validation | `expires_in_hours = 721` (over 30d) → rejected | 400 |
| TC-I-06 | REQ-4 | validation | `max_uses = 0` → rejected | 400 |
| TC-I-07 | REQ-5 | happy | List invites returns rows for org, sorted DESC | rows match seeds |
| TC-I-08 | REQ-5 | security | Manager of org A cannot see invites of org B | rows filtered by session org |
| TC-I-09 | REQ-5 | happy | List response includes `status` derived correctly for each invite (active, expired, exhausted, revoked) | each row has correct status |
| TC-I-10 | REQ-6 | happy | Revoke active invite → row has `revoked_at` set; subsequent redeem fails | revoked, redeem 401 |
| TC-I-11 | REQ-6 | idempotency | Revoke already-revoked invite | 200 (no-op); `revoked_at` unchanged |
| TC-I-12 | REQ-7 | happy | Redeem with valid token + matching email → 200 with `{key_id, secret, central_url}`; user_machines row inserted; bcrypt(secret) stored | ok |
| TC-I-13 | REQ-7, REQ-9 | happy | Re-redeem same token (max_uses=2) by different machine | 200; second user_machines row; used_count=2 |
| TC-I-14 | REQ-8 | edge | Redeem with non-existent token | 401 generic; redemption_log outcome='token-invalid' |
| TC-I-15 | REQ-8 | edge | Redeem with revoked token | 401; outcome='token-revoked' |
| TC-I-16 | REQ-8 | edge | Redeem with expired token | 401; outcome='token-expired' |
| TC-I-17 | REQ-8 | edge | Redeem with exhausted token (used_count=max_uses) | 401; outcome='token-exhausted' |
| TC-I-18 | REQ-8 | edge | Redeem with email_pattern mismatch | 403; outcome='email-mismatch' |
| TC-I-19 | REQ-8 | security | 11 redeem attempts in 60s from same IP | 429 on 11th; outcome='rate-limited' |
| TC-I-20 | REQ-10 | business | 5 parallel redeem requests on invite with max_uses=1 | exactly 1 acceptance, 4 rejections; used_count=1 |
| TC-I-21 | REQ-9 | happy | Redeem creates user if not exists; reuses if exists by email | 1st: user inserted; 2nd: user reused |
| TC-I-22 | REQ-9 | security | bcrypt hash stored, NOT plaintext secret | DB row `secret_hash` ≠ secret; bcrypt verify works |
| TC-I-23 | REQ-3 | happy | All outcomes write redemption_log row with correct outcome value | 1 row per attempt |
| TC-I-24 | REQ-3 | security | redemption_log stores `token_prefix` (first 8 chars) NEVER full token | row's token_prefix.length === 8 |
| TC-I-25 | REQ-9 | edge | Redeem with claimed_email differing in case from existing user (`Alice@X.COM` vs `alice@x.com`) | user reused (case-insensitive lookup) |
| TC-I-26 | REQ-13 | happy | After successful redeem, `data/reporter-config.json` exists with all expected fields and mode 0600 | file present, json valid, mode 0o600 |
| TC-I-27 | REQ-15 | infra | Setup fails to write config (e.g. data/ not writable) | exits non-zero; secret NOT in any file or stdout (zero leakage) |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-16, REQ-17 | happy | Manager logs in, navigates to `/manager/admin/invites`, creates invite | full token URL displayed once; warning copy visible |
| TC-E2E-02 | REQ-5, REQ-16 | happy | Created invite appears in the list with `status='active'`, used_count=0 | row visible; full token NOT in DOM |
| TC-E2E-03 | REQ-18 | happy | Manager clicks revoke on active invite | confirmation, then status changes to 'revoked' |
| TC-E2E-04 | REQ-7..15 | happy | Full flow: manager creates invite → captures token → simulated `pnpm reporter:setup` POSTs to redeem → response 200 → config file written | end-to-end works against running server |
| TC-E2E-05 | REQ-4 | security | Member role visits `/manager/admin/invites` | 403 page |

## Design

### Endpoint summary

| Endpoint | Method | Auth | Body / Params | Response |
| --- | --- | --- | --- | --- |
| `/api/admin/invites` | POST | manager+admin | `{team_id?, email_pattern?, max_uses?, expires_in_hours}` | `{token, expires_at}` |
| `/api/admin/invites` | GET | manager+admin | — | `[{token_prefix, status, ...}]` |
| `/api/admin/invites/:prefix/revoke` | PATCH | manager+admin | — | `{ok: true}` |
| `/api/onboarding/redeem-invite` | POST | none (token IS auth) | `{token, machine_id, hostname, claimed_email}` | `{key_id, secret, central_url}` (200) or generic 401/403/429 |

### Why a separate redemption_log table

Could share `ingestion_log`, but the columns differ (no `payload_size_bytes`, no `accepted_count`; HAS `outcome` enum, `claimed_email`, `token_prefix`). Mixing them blurs both audit trails. Cheap dedicated table > overloaded one.

### Concurrency on redemption

The single `SELECT FOR UPDATE` on the invite row inside the transaction serializes concurrent redemptions for the same token. Postgres handles this natively. TC-I-20 verifies (5 parallel requests on max_uses=1 → exactly 1 win).

### Why generic 401 for token failures

Probing for valid tokens is a real attack — a 401-vs-403-vs-410 distinction lets an attacker enumerate which tokens exist. Single 401 with a generic message neutralizes the probe. Rate limit (REQ-8.6) closes the rest.

### Why URL parsing in setup

Manager shares `https://central/onboard?token=XXX`. Parsing the URL gets us `central_url` for free. If the dev pastes only the token, we ask for the URL separately. Both paths feel ergonomic; second path is the fallback.

### Why server-issued secret (not dev-generated + registered)

Considered: dev generates secret, hashes locally, sends only hash to server. Pros: secret never crosses the network. Cons: complicates the DB write (server has no way to verify the hash matches a real cryptographic primitive — it's just bytes); the dev's machine becomes the trust anchor. Server-issued is simpler and the secret crosses the network once, over TLS, to a trusted central server — same trust model as cloud SaaS API key issuance.

### Files to Create

#### Server (apps/server/)

- `apps/server/lib/db/schema.ts` — extend with `onboarding_invites`, `onboarding_redemption_log` tables + relations
- `apps/server/lib/db/migrations/0001_onboarding.sql` — generated by drizzle-kit
- `apps/server/lib/auth/match-email-pattern.ts` — REQ-11 pure helper
- `apps/server/lib/auth/match-email-pattern.test.ts` — TC-U-03..09
- `apps/server/lib/queries/invites.ts` — admin queries (create, list, revoke)
- `apps/server/lib/queries/invites.test.ts` — TC-I-02..11
- `apps/server/lib/queries/redeem.ts` — redemption logic + transaction
- `apps/server/lib/queries/redeem.test.ts` — TC-I-12..25
- `apps/server/app/api/admin/invites/route.ts` — POST + GET
- `apps/server/app/api/admin/invites/[prefix]/revoke/route.ts` — PATCH
- `apps/server/app/api/onboarding/redeem-invite/route.ts` — POST (no auth middleware)
- `apps/server/app/manager/admin/invites/page.tsx` — list view
- `apps/server/app/manager/admin/invites/create/page.tsx` — create form
- `apps/server/app/manager/admin/invites/actions.ts` — Server Actions (create, revoke)
- `apps/server/components/admin/invite-row.tsx` — single row presentation
- `apps/server/components/admin/invite-create-form.tsx` — form Client Component
- `apps/server/tests/integration/onboarding.test.ts` — TC-I-01..25 server-side
- `apps/server/tests/e2e/admin-invites.spec.ts` — TC-E2E-01..05

#### Reporter (root)

- `scripts/reporter-setup.ts` — REQ-12..15 interactive setup; reuses `lib/reporter/config.ts` (already in central-reporter-server.md)
- `scripts/reporter-setup.test.ts` — TC-U-10..13 (parsing, error mapping)

### Files to Modify

- `package.json` (root) — add `"reporter:setup": "tsx scripts/reporter-setup.ts"`
- `apps/server/app/manager/layout.tsx` — sidebar nav link to `/manager/admin/invites` (admin/manager only)
- `apps/server/middleware.ts` — `/api/onboarding/redeem-invite` is exempt from auth middleware (token IS auth)
- `apps/server/README.md` — document the onboarding flow + threat model (rate limit, generic 401, single secret exposure)

### Dependencies

- `bcrypt` (`apps/server/package.json` — likely already added in central-reporter-server.md REQ-7 for `user_machines.secret_hash`; confirm)
- `node:crypto` (Node stdlib) — token + secret generation
- No new prod deps in root.

## Tasks

- [ ] **TASK-1**: Schema — `onboarding_invites` + `onboarding_redemption_log` tables, drizzle migration, regen + commit migration SQL.
  - files: apps/server/lib/db/schema.ts, apps/server/lib/db/migrations/0001_onboarding.sql
  - depends: central-reporter-server TASK-10 (initial schema + drizzle setup)
  - tests: TC-I-01

- [ ] **TASK-2**: Pure email-pattern helper — `matchEmailPattern`. Hand-written stub-free tests.
  - files: apps/server/lib/auth/match-email-pattern.ts, apps/server/lib/auth/match-email-pattern.test.ts
  - tests: TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09

- [ ] **TASK-3**: Token + key_id generation helpers.
  - files: apps/server/lib/auth/tokens.ts, apps/server/lib/auth/tokens.test.ts
  - tests: TC-U-01, TC-U-02

- [ ] **TASK-4**: Redemption query (`redeemInvite`) — full transaction with FOR UPDATE, all REQ-8 checks, REQ-9 happy-path INSERTs.
  - files: apps/server/lib/queries/redeem.ts, apps/server/lib/queries/redeem.test.ts
  - depends: TASK-1, TASK-2, TASK-3
  - tests: TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-17, TC-I-18, TC-I-19, TC-I-20, TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25

- [ ] **TASK-5**: Admin invites queries — create, list, revoke.
  - files: apps/server/lib/queries/invites.ts, apps/server/lib/queries/invites.test.ts
  - depends: TASK-1, TASK-3
  - tests: TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11

- [ ] **TASK-6**: API routes — admin invites + redeem-invite. Middleware adjustment to exempt `/api/onboarding/*` from auth.
  - files: apps/server/app/api/admin/invites/route.ts, apps/server/app/api/admin/invites/[prefix]/revoke/route.ts, apps/server/app/api/onboarding/redeem-invite/route.ts, apps/server/middleware.ts (exemption)
  - depends: TASK-4, TASK-5
  - tests: covered via TC-I-* by hitting routes through fetch

- [ ] **TASK-7**: Admin UI — `/manager/admin/invites` list + create flow + revoke action.
  - files: apps/server/app/manager/admin/invites/page.tsx, apps/server/app/manager/admin/invites/create/page.tsx, apps/server/app/manager/admin/invites/actions.ts, apps/server/components/admin/invite-row.tsx, apps/server/components/admin/invite-create-form.tsx, apps/server/app/manager/layout.tsx (nav)
  - depends: TASK-6
  - tests: covered by E2E

- [ ] **TASK-8**: Reporter setup CLI — `pnpm reporter:setup` interactive script.
  - files: scripts/reporter-setup.ts, scripts/reporter-setup.test.ts, package.json (script entry)
  - depends: central-reporter-server TASK-8 (lib/reporter/config.ts), TASK-6 (redeem endpoint)
  - tests: TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-I-26, TC-I-27

- [ ] **TASK-SMOKE**: E2E admin flow + end-to-end onboard.
  - files: apps/server/tests/e2e/admin-invites.spec.ts, apps/server/tests/e2e/global-setup.ts (extend seed)
  - depends: TASK-7, TASK-8
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3]              — schema + helpers (disjoint files)
Batch 2: [TASK-4, TASK-5]                       — queries (depend on TASK-1+helpers; separate files)
Batch 3: [TASK-6, TASK-8]                       — API routes vs setup CLI (disjoint files; both depend on different prior tasks)
Batch 4: [TASK-7]                               — admin UI (depends TASK-6)
Batch 5: [TASK-SMOKE]                           — E2E
```

File overlap analysis:

- `apps/server/lib/db/schema.ts` — TASK-1 only (extends; no other task here touches schema)
- `apps/server/middleware.ts` — TASK-6 (one-line edit; no overlap with central-reporter-server's middleware which lives in TASK-12 of that spec)
- `apps/server/app/manager/layout.tsx` — TASK-7 (nav link addition; shared-additive with central-reporter-server TASK-19 if both ship in parallel; sequence them — onboarding spec depends on cs-reporter-server reaching DONE first, so this conflict is moot)
- `package.json` (root) — TASK-8 only

Zero shared-mutative within this spec.

## Validation Criteria

- [ ] `pnpm typecheck:server` passes
- [ ] `pnpm test:server --run` passes (Testcontainers Postgres tests green)
- [ ] `pnpm test:server:e2e` passes
- [ ] `pnpm lint:server` passes
- [ ] **Live validation against real running server**:
  - Author runs `pnpm dev:server`, logs in as admin, creates an invite at `/manager/admin/invites`. Captures the URL.
  - Author runs `pnpm reporter:setup` on a clean machine (or wipes `data/reporter-config.json`), pastes URL, types email. Setup exits 0; config file written with mode 0600 (`stat -f %p data/reporter-config.json`).
  - SQL: `SELECT * FROM user_machines` shows the new row with `secret_hash` (bcrypt prefix `$2b$`).
  - SQL: `SELECT outcome, COUNT(*) FROM onboarding_redemption_log GROUP BY outcome` shows `accepted: 1`.
  - `pnpm reporter:run` (after setup) successfully pushes a batch to `/api/ingest`. Server log shows the request authenticated by the new key_id.
- [ ] **Security validation**:
  - Hand a redacted token (replace last 4 chars) to `pnpm reporter:setup` → exit 1, generic "invalid invite" message; no plaintext secret anywhere on disk.
  - Run 11 redeem requests rapid-fire from `curl` → 11th returns 429.
  - Inspect the redemption_log: full token never present (only `token_prefix`).
- [ ] **Concurrency validation**:
  - Create invite with `max_uses=1`, fire 5 parallel `curl` redeems → exactly 1 succeeds (visible in log table outcomes: 1 accepted, 4 token-exhausted).

## Open Questions

- **Q1 — Token in URL fragment vs query param**: query param (current spec) is logged by web servers and proxies. Fragment (`#token=XXX`) is not sent to server. Tradeoff: fragment-based onboarding requires a lightweight HTML page at `/onboard` that reads the fragment via JS, which the dev visits in a browser, then copies the token to terminal. Adds friction. Counter: invite URLs are shared via Slack/email anyway, where the token is visible. **Sugestão**: keep query param for v1; document that managers should not screenshot URLs.
- **Q2 — Server Action vs API route for create**: REQ-17 uses Server Action (form-friendly), REQ-4 specs an API route (POST `/api/admin/invites`) for the same operation. **Sugestão**: keep both — Server Action calls the underlying query directly (no duplicate logic), API route exposes it for tooling/scripts. The query function `createInvite()` is the single source of truth.
- **Q3 — Should the setup support a non-interactive mode for CI/automation?**: e.g. `pnpm reporter:setup --token=XXX --email=alice@x.com --central-url=https://...`. **Sugestão**: yes, accept these as flags; if all present, skip prompts. Adds 10 lines to TASK-8; valuable for scripted enrollment in larger orgs.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
