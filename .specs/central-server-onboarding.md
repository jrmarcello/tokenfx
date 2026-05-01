# Spec: central-server-onboarding — invite-token onboarding + reporter auth refactor

## Status: DONE

(Pause-1 approved by user 2026-05-01; v2 rewrite + re-self-review applied 21 fixes including 3 CRITICAL bugs caught by reviewers — DDL contradictions in `created_by`/`actor_user_id`, `loadRoleAndOrg` query predicate, TASK-4a/4b serialization break. Pause-2 approved 2026-05-01.)

## Depends on

- `central-reporter-server.md` (DONE, commit `1ded383`). Schema, NextAuth split (Edge+Node), reporter scaffolding, manager dashboard v1 are all locked there.

## Context

Spec 3 shipped ingest + manager dashboard, but punted **two** things to v0 stand-ins:

1. **Provisioning** of `(key_id, secret)` for each dev machine — currently via manual `seed-server.ts`. Doesn't scale.
2. **TASK-14 deviation**: `user_machines.secret_hash` stores the HMAC secret in **plaintext**. The column name is a misnomer kept for migration stability. The reporter signs payloads with HMAC-SHA256; the server recomputes HMAC with the plaintext stored secret. This is functional but inconsistent with industry-standard credential storage — bcrypt-at-rest is the norm (Stripe, GitHub, Anthropic).

This spec ships **both** fixes in one coherent pass — they're entangled (you can't bcrypt the secret AND keep HMAC working, because HMAC needs the plaintext key on both sides). The quality-driven decision is to refactor the reporter auth from HMAC-signature to **Bearer-token + bcrypt-at-rest**, and ship the invite-token onboarding flow on top of the new auth model.

### Anti-goals (stay narrow)

- Self-service signup without a manager-issued invite (no public registration).
- SSO-based provisioning (a dev's Google login → auto-machine). Defer — needs a separate threat model.
- Web-based onboarding (browser flow). The reporter is a CLI; setup is a CLI. The static `/onboard` page exists ONLY to display the token from the URL fragment — nothing else lives there.
- Machine revocation UI. Spec 3's schema already has `user_machines.revoked_at`; revoking a machine via SQL is documented in README. UI for it is a follow-up spec.
- Invite TTL > 7d. Default 8h, max 168h (1 week). Longer windows make leaked invites too dangerous.

### Threat model summary (full version in `apps/server/README.md` after this ships)

- **Token leak via URL fragment**: fragment is never sent to server logs / proxies. Browser history is the residual risk; `/onboard` page tells users to copy the token to terminal immediately.
- **Token leak via Slack/email**: bearer tokens are vulnerable to whoever sees the message. Mitigated by short TTL (8h default) + single use default + `email_pattern` lock.
- **Bruteforce on tokens**: 64-byte (256-bit) entropy makes guessing infeasible; rate limit on (ip_24, 10/min) AND (token, 3/min) closes the side door.
- **Token-existence probing**: ALL token rejections (invalid / expired / revoked / exhausted / email-mismatch) return identical 401 body. No 403 leaks "your token is valid but the email is wrong".
- **Manager session compromise → rogue invite**: Server Actions have CSRF protection by default; audit log records every create/revoke with `actor_user_id` so a rogue invite is traceable. Re-auth on each create is NOT required (would break ergonomics for the 99% legitimate case).
- **Replay of redeem after success**: `used_count` increment is part of the same transaction as the user_machines INSERT; FOR UPDATE serializes concurrent attempts.
- **TLS off**: setup CLI refuses non-HTTPS unless `--allow-http` (dev-only flag). Reporter ongoing pushes also assume HTTPS in production.
- **Email harvesting via redeem log**: log stores `email_domain` + `sha256(email + pepper)` only — never the full email.

## Requirements

### Schema migrations (TASK-1)

- [ ] **REQ-1**: New table `onboarding_invites` in `apps/server/lib/db/schema.ts`:

  ```sql
  CREATE TABLE onboarding_invites (
    token TEXT PRIMARY KEY,                      -- 64-char hex (32 random bytes)
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL,
    email_pattern TEXT NULL,                     -- exact "alice@x.com" OR "*@x.com" OR null
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,  -- NULL preserves audit row when creator is deleted
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_onboarding_invites_org_created ON onboarding_invites(org_id, created_at DESC);
  -- Functional expression index — must be raw SQL in the migration file (Drizzle's
  -- index() builder does not natively express `left(col, 8)`). Use `index(...).on(sql\`left(${t.token}, 8)\`)`.
  CREATE INDEX idx_onboarding_invites_prefix ON onboarding_invites(left(token, 8));
  ```

  The prefix index supports lookup by 8-char prefix in the revoke flow (REQ-19). `created_by` is NULLABLE so deleting a manager preserves the historical row (audit invariant).

- [ ] **REQ-2**: New table `onboarding_redemption_log` (audit trail for redeem attempts):

  ```sql
  -- Drizzle pgEnum: outcome
  CREATE TYPE onboarding_outcome AS ENUM (
    'accepted','token-invalid','token-expired','token-revoked',
    'token-exhausted','email-mismatch','rate-limited','validation-error','infra-error'
  );

  CREATE TABLE onboarding_redemption_log (
    id BIGSERIAL PRIMARY KEY,
    token_prefix TEXT NOT NULL,                  -- first 8 chars; full token NEVER stored
    machine_id UUID NULL,                        -- NULL on rejection
    email_domain TEXT NOT NULL,                  -- part after @ — coarse audit ("@example.com tried")
    email_hash TEXT NOT NULL,                    -- sha256(lowercase(email) + pepper) — uniqueness without PII reverse
    request_ip TEXT NULL,                        -- truncated /24 (IPv4) or /48 (IPv6); cleanup separate spec
    outcome onboarding_outcome NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_redemption_log_received ON onboarding_redemption_log(received_at DESC);
  CREATE INDEX idx_redemption_log_outcome ON onboarding_redemption_log(outcome, received_at DESC);
  ```

  **Privacy note**: store `email_domain` (e.g. `"example.com"`) AND `email_hash` (peppered SHA-256 of lowercased full email). Domain gives audit signal ("alguém de @example.com tentou"); hash lets us count unique-tried-emails without reversing PII. Both fields together cost ~80 bytes/row.

- [ ] **REQ-3**: New table `onboarding_audit_log` for admin operations (create/revoke):

  ```sql
  CREATE TYPE onboarding_audit_action AS ENUM ('invite-created','invite-revoked');

  CREATE TABLE onboarding_audit_log (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,  -- NULL preserves audit when actor is deleted
    action onboarding_audit_action NOT NULL,
    target_token_prefix TEXT NOT NULL CHECK (length(target_token_prefix) = 8),
    metadata JSONB NULL,                         -- create: {max_uses, expires_at, email_pattern, team_id}
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX idx_audit_log_org_occurred ON onboarding_audit_log(org_id, occurred_at DESC);
  ```

- [ ] **REQ-4**: Schema change in spec-3's `users` table — make `sso_provider` and `sso_subject` NULLABLE. Onboarding via invite creates a row with both fields NULL; first SSO login fills them via the `signIn` callback.

  **Drizzle schema diff** (`apps/server/lib/db/schema.ts`):

  ```ts
  // BEFORE (spec 3):
  ssoProvider: text('sso_provider').notNull(),
  ssoSubject: text('sso_subject').notNull(),

  // AFTER (this spec):
  ssoProvider: text('sso_provider'),  // NULL allowed
  ssoSubject: text('sso_subject'),    // NULL allowed
  ```

  Migration also updates `auth.ts:signIn` callback semantics (REQ-13 below) and `loadRoleAndOrg` query predicate (REQ-12).

- [ ] **REQ-5**: New environment variable `ONBOARDING_EMAIL_HASH_PEPPER` — required at boot in production. The hash function is `sha256(lowercase(email) + pepper)`. Pepper protects against rainbow-table reversal even if the DB leaks. Boot-time guard in `apps/server/lib/auth/auth.ts` throws if `NODE_ENV=production` and pepper is unset (mirrors the existing `AUTH_SECRET` guard).

  For dev/test, `ONBOARDING_EMAIL_HASH_PEPPER` defaults to `'tokenfx-dev-pepper'` if unset.

### Reporter auth refactor: HMAC → Bearer + bcrypt (TASK-6)

This is the core of the quality-first decision. The current HMAC-with-plaintext-secret design is replaced with industry-standard Bearer-token authentication backed by bcrypt-at-rest.

- [ ] **REQ-6**: Refactor `apps/server/app/api/ingest/route.ts`:
  - Remove `signature` field from envelope schema.
  - Parse `Authorization: Bearer <secret>` header (case-insensitive scheme per RFC 7235; reject empty Bearer, malformed scheme, or scheme with leading/trailing whitespace with 401).
  - On request: extract `key_id` (from envelope) + `secret` (from Bearer header). Look up `user_machines.secret_hash` (bcrypt) by `key_id`. Call `bcrypt.compare(secret, secret_hash)` — if false, 401.
  - **Bcrypt cost factor: 10** (~25ms — industry minimum recommendation; aligns with Auth0/Stripe defaults). Cost 12 (~100ms) was rejected as it saturates the ingest hot path at ~40 pushes/sec/core.
  - **In-memory verification cache** to avoid bcrypt on every push: `Map<key_id, {plaintext_secret, expires_at}>` with 60s TTL. After first successful `bcrypt.compare`, cache the plaintext secret. Subsequent ingest requests within 60s do constant-time string-compare (microseconds). Cache cleared on TTL expiry; re-verification with bcrypt happens at most once per minute per machine. Trade-off: plaintext secrets in process memory (RAM-only, never persisted, never logged). Accepted: process memory is the trust boundary; if attacker has process memory, they have the DB too.
  - Cache key includes `key_id` only (not `secret`). On cache miss OR mismatch with stored plaintext, fall back to `bcrypt.compare`.
  - Cache test seam: export `__resetIngestAuthCache` for tests to clear between runs.
  - Keep the `canonicalJSON` + per-session SHA-256 idempotency hash (unrelated to auth).
  - Remove the `verify(payload, signature, plaintext_secret)` call entirely.

- [ ] **REQ-7**: Refactor `lib/reporter/client.ts`:
  - Drop `X-Signature` header generation.
  - Send `Authorization: Bearer <secret>` instead. Read `secret` from `data/reporter-config.json` (already exists).
  - Drop the `signRequest`/HMAC code path. The `canonicalJSON` helper stays — used for the idempotency hash.
  - **Idempotency-Key derivation after signature removal**: the existing `client.ts:87` does `idempotencyKey = signedEnvelope.signature.slice(0, 32)`. After this refactor, derive idempotency-key from the payload directly: `idempotencyKey = sha256(canonicalJSON(payload_array)).slice(0, 32)`. Same uniqueness guarantee (canonical JSON + SHA-256 is deterministic over equivalent payloads), without needing a signature.
  - Update `SignedEnvelope` type in `lib/reporter/types.ts` to drop `signature` field; rename to `IngestEnvelope` for clarity (no longer signed).

- [ ] **REQ-8**: Delete `lib/reporter/signer.ts`'s HMAC functions (`sign`, `verify`) and their tests in `lib/reporter/signer.test.ts`. Move `canonicalJSON` (still needed for idempotency hashing) to a new `lib/reporter/canonical-json.ts` with its own colocated test (just rename, no logic change). Update all imports.

- [ ] **REQ-9**: Refactor `apps/server/scripts/seed-server.ts`:
  - Both `--e2e` mode and single-org mode now bcrypt-hash the secret BEFORE inserting into `user_machines.secret_hash`.
  - The plaintext secret is still printed to stdout in single-org mode (for hand-copying to `data/reporter-config.json`); that's the only place plaintext exists.
  - `--e2e` mode no longer prints the secret (e2e fixtures don't need it; the test runner mints JWTs directly per spec 3's `signInAs` pattern).

- [ ] **REQ-10**: Migration plan for existing dev/test data: since no production deployment exists yet, the migration is "wipe dev DBs and re-seed". Document in spec README. Test integration suites already TRUNCATE in `beforeAll`, so they're naturally compliant.

### Auth + session augmentation (TASK-7)

- [ ] **REQ-11**: Augment NextAuth `Session.user` with `id?: string` (the internal `users.id` UUID). Also augment the `JWT` interface (`declare module 'next-auth/jwt'` block in `auth.ts`) with `userId?: string`. Both type declarations live in `auth.ts` next to the existing `role`/`orgId` augmentations.

- [ ] **REQ-12**: Refactor `loadRoleAndOrg` in `apps/server/lib/auth/auth.ts`:
  - **Change query predicate from `WHERE email = ? AND sso_provider = ?` to `WHERE email = ?` only.** This is required because invite-provisioned users have `sso_provider IS NULL`; the old predicate filters them out, breaking the JWT callback. Since `users.email` is globally UNIQUE (per spec 3 schema), email-only lookup is correct.
  - Rename to `loadUserByEmail(email)` to reflect the new semantics.
  - Return shape: `{userId, role, orgId, ssoProvider} | null`.
  - The `jwt()` callback uses the result to: (a) write `userId`, `role`, `orgId` to the token; (b) detect that `ssoProvider IS NULL` and skip SSO-fill steps if the OAuth provider hasn't logged in yet (only happens on the first SSO login of an invited user; that case is handled by `signIn`, not `jwt`).
  - Update the `session()` callbacks (both `auth.ts` and `auth.config.ts`) to mirror `token.userId → session.user.id`.
  - Edge stays DB-free. JWT-only auth invariant preserved.

- [ ] **REQ-13**: Update `auth.ts:signIn` callback to handle invite-provisioned users:
  - **Change the existing-user query from `WHERE email = ? AND sso_provider = ?` to `WHERE email = ?`** (same reason as REQ-12). The current code at `auth.ts:104` uses `and(eq(users.email, ...), eq(users.ssoProvider, ...))` — that must become `eq(users.email, ...)` only, with branching on the returned row's `ssoProvider` value.
  - Branching after the lookup:
    - **No row** → existing single-org bootstrap path (spec 3 REQ-16). Return true if exactly one org exists, else false + log.
    - **Row found, `sso_provider IS NULL`** → invited user's first SSO login. UPDATE `users SET sso_provider = ?, sso_subject = ?` for the OAuth provider's values. Return true.
    - **Row found, `sso_provider/sso_subject` match the OAuth values** → existing SSO user. Return true.
    - **Row found, `sso_provider/sso_subject` differ from OAuth values** → someone else's account claims this email. Return false + structured warn log (`emailDomain` only, never full email).
  - Race-safety: the UPDATE in the second branch happens BEFORE `signIn` returns. The `jwt()` callback fires next; `loadUserByEmail` returns the freshly-updated row (READ COMMITTED in same connection). No race.

### Token + email-pattern helpers (TASK-2, TASK-3)

- [ ] **REQ-14**: `generateInviteToken()` — `crypto.randomBytes(32).toString('hex')` (64 chars). UNIQUE PK enforces no reuse; fallback retry only if Postgres returns a unique-violation (treat as paranoia, log once).

- [ ] **REQ-15**: `generateKeyId()` — `"k_" + crypto.randomBytes(8).toString('hex')` (18 chars). UNIQUE constraint on `user_machines.key_id`. On collision, retry up to 3 times then 500.

- [ ] **REQ-16**: `matchEmailPattern(pattern: string | null, email: string): boolean`:
  - Normalize email and pattern via Unicode NFC + `.toLowerCase()`.
  - Reject (return false) if email has non-ASCII chars in the local-part (defends against homoglyph attacks like `аlice` Cyrillic).
  - Accept ASCII-only IDN domains by punycode-normalizing the domain part via `URL` parsing OR `node:url`'s `domainToASCII`.
  - `null` pattern → true (any).
  - Pattern starts with `*@` → match domain (case-insensitive after NFC + ASCII).
  - Otherwise → exact match (case-insensitive after NFC + ASCII).
  - No other glob chars supported. Mid-string `*` treated as literal.
  - Empty string email → false.
  - Documented in module header why narrow.

### Onboarding page (static, fragment-based) (TASK-9)

- [ ] **REQ-17**: New static page at `apps/server/app/onboard/page.tsx` (Server Component shell + small Client Component leaf). The page reads the URL fragment (`#token=XXX`) via JS (Client Component), displays:
  - A monospace box with the 64-char token (selectable, with a "copy to clipboard" button).
  - Instruction text: "Run `pnpm reporter:setup` and paste this token when prompted, or run `pnpm reporter:setup --token=<paste>`."
  - Warning: "This token is shown only once. Treat it like a password."

  The page is publicly accessible (no auth — the URL fragment is private to whoever has it). Middleware matcher already excludes `/onboard` (only matches `/manager/*`). The fragment is NEVER sent to the server (HTTP fetch behavior); browser history is the residual risk, mitigated by the warning.

### Admin invite Server Actions (TASK-5)

These replace the original draft's API routes. Server Actions only — CSRF is built-in, no API routes for admin ops.

- [ ] **REQ-18**: Server Action `createInvite(input)` in `apps/server/app/manager/invites/actions.ts`:
  - Auth: `auth()` returns session; require `role === 'manager' || role === 'admin'`. Else throw (page-level error.tsx handles).
  - Body Zod (`.strict()`): `{ idempotency_key: string (uuid), team_id?: string (uuid), email_pattern?: string, max_uses?: number (1..100, default 1), expires_in_hours?: number (1..168, default 8) }`.
  - Idempotency: check `(actor_user_id, idempotency_key)` against an in-memory cache (5min TTL) — if hit, return cached response (the previous token URL). Prevents double-click duplicate invites.
  - Generate token + compute prefix + INSERT `onboarding_invites`.
  - INSERT `onboarding_audit_log` with `action='invite-created'`, `metadata={max_uses, expires_at, email_pattern, team_id}`.
  - Return `{ token, expires_at, onboard_url: '${central_url}/onboard#token=${token}' }`. The URL is shown to the manager ONCE.
  - `revalidatePath('/manager/invites')`.

- [ ] **REQ-19**: Server Action `revokeInvite(token_prefix)`:
  - Auth: same as REQ-18.
  - Look up by `left(token, 8) = ?`. If 0 matches → 404 (already-revoked invites still match — idempotent). If >1 match (collision on 8 chars; ~10^-9 with 64-bit entropy but defended) → 409 with explicit message.
  - UPDATE `onboarding_invites SET revoked_at = now() WHERE token = ? AND revoked_at IS NULL`. Idempotent (already-revoked is a no-op).
  - INSERT `onboarding_audit_log` with `action='invite-revoked'`, `metadata=null`.
  - `revalidatePath('/manager/invites')`.

- [ ] **REQ-20**: List query `listInvitesForOrg(orgId)` in `apps/server/lib/queries/invites.ts`:
  - Returns `[{token_prefix, status, max_uses, used_count, email_pattern, team_name, expires_at, created_by_email, created_at}]`.
  - `status` derived: `revoked > expired > exhausted > active` (priority order).
  - Ordered by `created_at DESC`.
  - Scoped to session's `orgId`. **Full token is NEVER returned** — only the 8-char prefix.

### Manager UI (TASK-8)

- [ ] **REQ-21**: New page `apps/server/app/manager/invites/page.tsx` (Server Component):
  - Table of invites, columns: token-prefix (`xxxxxxxx…`), status (color-coded badge), team name, email pattern, used/max, expires_in (relative), created_by, actions.
  - Empty state: "Nenhum convite ainda — crie um para onboardar um colega de time."
  - Actions cell: revoke button (only when `status='active'`).

- [ ] **REQ-22**: New page `apps/server/app/manager/invites/create/page.tsx` (Server Component with a Client Component form leaf):
  - Form fields: team (select, optional), email_pattern (text, optional, helper "deixe vazio para qualquer email; use `*@empresa.com` para travar por domínio"), max_uses (number, 1..100, default 1), expires_in_hours (number, 1..168, default 8).
  - On submit: Server Action `createInvite()` returns `{ token, expires_at, onboard_url }`. The Server Action then sets a flash cookie (see below) and calls `redirect('/manager/invites/created?prefix=<8>')` from `next/navigation`. The URL contains only the prefix; the full URL lives in the cookie.
  - **Flash cookie spec** (`apps/server/lib/auth/flash-cookie.ts`): cookie name `onboard_flash`. Set via `cookies().set()` from `next/headers`. Attributes: `httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'strict', path: '/manager/invites/created', maxAge: 120` (2 minutes). Value: full `onboard_url` (signed with `AUTH_SECRET` to prevent tampering — use Web Crypto HMAC; ~10 lines).
  - **Show-once page** (`/manager/invites/created/page.tsx`): reads the flash cookie via `cookies().get('onboard_flash')`. Verifies the HMAC; if absent or invalid → renders empty state "URL not available — return to /manager/invites and create a new one." If valid → renders the URL with copy-button + warning copy "This URL is shown only once. Copy it now." Then **deletes the cookie** via `cookies().delete('onboard_flash')` BEFORE rendering the response (so a page reload doesn't show it twice).

- [ ] **REQ-23**: Revoke confirmation via shadcn `<AlertDialog>`:
  - Client Component leaf wraps the revoke button.
  - Dialog: "Revogar convite?" + "Esta ação é irreversível." + Cancel/Confirm.
  - Confirm submits the Server Action.

- [ ] **REQ-24**: Sidebar nav link to `/manager/invites` in `apps/server/app/manager/layout.tsx`. Visible to `manager` and `admin` roles. Distinct from the existing `Admin` link (which goes to `/manager/admin/users`).

- [ ] **REQ-25**: Add `loading.tsx` and `error.tsx` for `/manager/invites/*` routes per project Next.js convention.

### Redemption endpoint (TASK-7)

- [ ] **REQ-26**: `POST /api/onboarding/redeem-invite` (no auth — token IS auth). Body Zod (`.strict()`):

  ```ts
  z.object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    machine_id: z.string().uuid(),
    hostname: z.string().min(1).max(255),
    claimed_email: z.string().email().min(3).max(254),
  })
  ```

  `.strict()` ensures unknown fields reject the request with 400.

- [ ] **REQ-27**: Validation order — UNIFORM 401 for ALL token-related rejections (no leak of which step failed):
  1. **Rate limit (step 0)** — TWO dimensions, both checked:
     - `(ip_truncated_24, 10/min sliding window)` — defends against IP-enumeration attacks.
     - `(token, 3/min sliding window)` — defends against per-token bruteforce.
     Either dimension exceeded → 429 with `Retry-After` header. **No DB write to `onboarding_redemption_log`** (DoS-amplification protection: a flooding attacker would otherwise fill the log table). Instead, emit a `logger.warn` with `{ip_24, token_prefix, dimension}` to the structured log only.
  2. **Zod parse** — fail → 400. **No DB write** (same DoS reasoning — bot scanners send garbage and would amplify storage). Emit `logger.warn` with `{ip_24, zod_issue_count}`.
  3. **Token lookup `SELECT ... FOR UPDATE`** — missing → `outcome='token-invalid'` → 401. DB write begins here (request passed rate-limit + Zod = treat as legitimate-shaped attempt).
  4. **Revoked** → `outcome='token-revoked'` → 401.
  5. **Expired** → `outcome='token-expired'` → 401.
  6. **Exhausted** → `outcome='token-exhausted'` → 401.
  7. **Email pattern mismatch** → `outcome='email-mismatch'` → 401 (NOT 403 — uniform).

  All 401 responses share an identical **body** (uniform body byte-equality). Body: `{ "error": { "message": "invalid or expired invite", "code": "unauthorized" } }`. HTTP headers like `Date` and `Content-Length` are not part of the uniformity guarantee (`Content-Length` is identical because body is identical; `Date` naturally varies but is not a side-channel for which step failed).

  `Authorization` header parsing for the redeem endpoint follows RFC 7235: the scheme `Bearer` is matched case-insensitively (`bearer`, `BEARER`, `Bearer` all accepted). Empty Bearer (`Authorization: Bearer ` with empty token) → 401. Wrong scheme (`Basic abc`) → 401.

- [ ] **REQ-28**: On all checks passing, single transaction (READ COMMITTED, default Postgres isolation):
  1. **Upsert `users` by `email`** (the global unique key per spec 3 schema):
     - If found → reuse `id`. **Team assignment rule**: if existing user's `team_id IS NULL` AND invite's `team_id IS NOT NULL`, UPDATE the existing user's `team_id` from invite (fill in the missing assignment). If existing user has a non-NULL `team_id`, preserve it (do NOT overwrite — manager already placed them somewhere; an invite shouldn't silently move a person between teams).
     - If not found → INSERT with `role='member'`, `team_id` from invite, `sso_provider=NULL`, `sso_subject=NULL`, `org_id` from invite.
  2. **Re-onboarding behavior** for `machine_id`: spec 3's `user_machines` schema does NOT have a UNIQUE constraint on `machine_id` (confirmed in schema.ts). Re-onboarding the same `machine_id` is intentionally allowed — it produces a fresh `(key_id, secret)` pair while leaving the previous row intact. Old `key_id` continues to work until manually revoked via SQL (machine-revocation UI is a follow-up spec). Document this in REQ-28's prose. The reporter setup CLI's pre-flight (REQ-32) catches the common case of "config still valid" before it ever reaches the redeem endpoint.
  3. Generate `secret = crypto.randomBytes(32).toString('hex')` and `key_id = generateKeyId()`.
  4. INSERT `user_machines (user_id, machine_id, key_id, secret_hash=hashFn(secret, 10), hostname, created_at, last_seen_at=now())`. **Bcrypt cost factor: 10** (~25ms, aligned with REQ-6's ingest-side cache strategy). On `key_id` UNIQUE collision (improbable but possible with 8-byte randomness): retry up to 3 times then 500.
  5. UPDATE `onboarding_invites SET used_count = used_count + 1 WHERE token = ?` (FOR UPDATE on the invite row in REQ-27.3 serializes concurrent attempts).
  6. INSERT `onboarding_redemption_log` with `outcome='accepted'`, `email_domain`, `email_hash`.
  7. Return `{ key_id, secret, central_url, user_email }`. **`secret` is the only plaintext exposure ever** — afterwards only the bcrypt hash exists.

  **Injection seam for tests**: `redeemInvite()` accepts an optional `hashFn?: (plain: string, rounds: number) => Promise<string>` parameter (default = `bcrypt.hash`). TC-I-65 passes a stub that throws — verifies transaction rolls back cleanly without partial writes. Same hand-written-stub pattern spec 3 uses for `lib/reporter/no-leakage.test.ts`.

- [ ] **REQ-29**: Atomicity invariant — concurrent redemptions of an invite with `max_uses=N` MUST result in exactly N acceptances and (M-N) `token-exhausted` rejections for M concurrent attempts. The `SELECT FOR UPDATE` on the invite row in REQ-27.3 + the `used_count` increment in REQ-28.4 inside the same transaction provide this. TC-I covers `max_uses=1, M=5` AND `max_uses=3, M=6`.

### Reporter setup CLI (TASK-10a, TASK-10b)

- [ ] **REQ-30**: `pnpm reporter:setup` is interactive by default. Prompts in order:
  1. "Onboarding URL or token:" — accepts `https://central/onboard#token=XXX` (parses fragment), `https://central/onboard?token=XXX` (legacy, parses query — backward compat for any docs that drift), or bare token (then prompts separately for central URL).
  2. "Your work email:" — defaults to `git config user.email`. If `git` exits non-zero (no repo / git not installed), default is empty.
  3. Confirmation: "Submit redeem request to <central_url>? [Y/n]".

- [ ] **REQ-31**: TLS enforcement — setup CLI refuses if `central_url` is not `https://`. Override: `--allow-http` flag (dev-only, prints stern warning). Aborts with exit 1 + clear message: "Onboarding requires HTTPS. Use --allow-http only for localhost development."

- [ ] **REQ-32**: Pre-flight check — if `data/reporter-config.json` already exists:
  - Read existing `key_id` + `secret` + `central_url`.
  - Hit `GET ${central_url}/api/health` with `Authorization: Bearer ${secret}` (a tiny new endpoint that returns 200 with `{ok: true}` if the bearer is valid; 401 if not).
  - If 200: refuse re-onboarding by default. "Configuração válida já existe para `<key_id_prefix>`. Use `--force` para sobrescrever (rotação de credenciais)."
  - If 401: existing config is invalid (stale machine; revoked); proceed to overwrite without `--force`, log info.
  - If network fail: "Não foi possível verificar configuração existente. Use `--force` se tem certeza." Exit 1.

- [ ] **REQ-33**: Output sanitization — setup CLI **NEVER** logs `secret` or `key_id` to stdout/stderr. Only logs status messages ("Submitting…", "Reporter configured. Run `pnpm reporter:run` to push your first batch."). TC explicit (TC-U: capture all stdout/stderr after happy-path setup; assert byte-absence of `secret` and `key_id`).

- [ ] **REQ-34**: Atomic config write — write to `data/reporter-config.json.tmp` first, fsync, then rename to `data/reporter-config.json`. Mode 0600. If rename fails, leave existing file untouched. Prevents partial writes on disk-full / power-loss / crash mid-write.

- [ ] **REQ-35**: Non-interactive mode via flags + env vars:
  - Flags: `--token=<64hex>`, `--email=<email>`, `--central-url=<https://...>`.
  - Env vars (precedence: flags > env > prompts): `TOKENFX_ONBOARD_TOKEN`, `TOKENFX_ONBOARD_EMAIL`, `TOKENFX_ONBOARD_CENTRAL_URL`.
  - If all three sources present (flag/env/prompt), no prompts fire.
  - Plus `--non-interactive` flag: if any prompt would fire, exit 1 with clear "missing X" message. Useful for CI.

- [ ] **REQ-36**: Error message mapping — non-2xx response from redeem endpoint:
  - 400 (Zod validation): "Pedido malformado: <message>". Exit 1.
  - 401: "Token inválido, expirado, exaurido ou revogado. Peça um novo convite ao seu manager." Exit 1.
  - 429: "Muitas tentativas. Espere `<Retry-After>s` e tente de novo." Exit 1.
  - Network/timeout: "Não foi possível alcançar `<central_url>`. Verifique o URL e sua conexão." Exit 1.
  - 500: "Erro no servidor. Contate seu manager." Exit 1.
  - Config write success: exit 0 + info log "Reporter configurado. Rode `pnpm reporter:run` para enviar o primeiro batch.".

- [ ] **REQ-37**: New endpoint `GET /api/health` returning `{ok: true, server_time: <ISO8601>}` 200. Used by reporter setup pre-flight (REQ-32). Lives in spec 3's API surface; this spec adds it.

  **Two modes**:
  - **Liveness mode** — no `Authorization` header, no query params → always 200. Anyone can probe.
  - **Credential validation mode** — requires BOTH `?key_id=k_xxx` query param AND `Authorization: Bearer <secret>` header. Server looks up `secret_hash` by `key_id` (O(1)) and runs `bcrypt.compare`. Reuses the same in-memory cache as REQ-6 (60s TTL) to avoid bcrypt on every health probe. 200 if valid, 401 otherwise. **`key_id` is mandatory in this mode** — reduces a credential-validity oracle from O(n) bcrypt scans to O(1).
  - Either mode silently — if `Authorization` present but `key_id` query param absent, return 400 with `{error: {message: 'key_id query param required for credential validation', code: 'bad-request'}}`.

  **Rate limit on credential validation mode**: same `(ip_truncated_24, 10/min)` as redeem endpoint. Without rate-limit, a stolen Bearer can be probed for liveness against `/api/health` to confirm validity before use elsewhere.

### Documentation (TASK-11)

- [ ] **REQ-38**: Update `apps/server/README.md`:
  - "Onboarding flow" section: invite creation → URL fragment → setup CLI → redemption.
  - "Threat model" section: enumerate the 8 mitigations from this spec's Context.
  - "Operational procedures" section: revoking a machine via SQL, rotating an invite secret pepper, etc.

- [ ] **REQ-39**: Update root `README.md` (TokenFx top level): brief mention of `pnpm reporter:setup` for new dev onboarding.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
|---|---|---|---|---|
| TC-U-01 | REQ-14 | happy | `generateInviteToken()` returns 64-char hex | matches `^[0-9a-f]{64}$` |
| TC-U-02 | REQ-14 | security | 1000 generated tokens are all unique | `Set(tokens).size === 1000` |
| TC-U-03 | REQ-15 | happy | `generateKeyId()` returns `k_` + 16 hex chars | matches `^k_[0-9a-f]{16}$` |
| TC-U-04 | REQ-16 | happy | `matchEmailPattern(null, "x@y.com")` | true |
| TC-U-05 | REQ-16 | happy | exact match: `matchEmailPattern("alice@x.com", "alice@x.com")` | true |
| TC-U-06 | REQ-16 | happy | case-insensitive: `matchEmailPattern("alice@x.com", "ALICE@X.COM")` | true |
| TC-U-07 | REQ-16 | happy | domain wildcard: `matchEmailPattern("*@example.com", "anyone@example.com")` | true |
| TC-U-08 | REQ-16 | edge | wrong domain: `matchEmailPattern("*@example.com", "anyone@other.com")` | false |
| TC-U-09 | REQ-16 | edge | empty local-part: `matchEmailPattern("*@example.com", "@example.com")` | false |
| TC-U-10 | REQ-16 | edge | empty email: `matchEmailPattern("*@x.com", "")` | false |
| TC-U-11 | REQ-16 | edge | mid-string `*` treated as literal: `matchEmailPattern("alice*@x.com", "alice123@x.com")` | false |
| TC-U-12 | REQ-16 | security | homoglyph: `matchEmailPattern("*@example.com", "alice@еxample.com")` (Cyrillic `е` U+0435) | false (rejected as non-ASCII) |
| TC-U-13 | REQ-16 | security | NFC normalization: `matchEmailPattern("alice@x.com", "alíce@x.com")` (composed vs decomposed) | true |
| TC-U-14 | REQ-30 | happy | parse `https://c/onboard#token=ABC` → `{token:'ABC', central_url:'https://c'}` | parsed |
| TC-U-15 | REQ-30 | happy | parse `https://c/onboard?token=ABC` (legacy query) → same shape | parsed |
| TC-U-16 | REQ-30 | edge | malformed URL with no token (`https://c/onboard`) | falls through to bare-token prompt |
| TC-U-17 | REQ-30 | edge | bare token (no URL) | second prompt fires for central URL |
| TC-U-18 | REQ-30 | edge | git not in repo: `git config user.email` exits non-zero | email default is empty (no crash) |
| TC-U-19 | REQ-31 | security | `central_url=http://x.com` without `--allow-http` | exit 1 with TLS message |
| TC-U-20 | REQ-31 | happy | `central_url=http://localhost:3232 --allow-http` | proceeds with stern warning |
| TC-U-21 | REQ-33 | security | happy-path setup output contains zero bytes of secret/key_id | stdout+stderr byte-scan |
| TC-U-22 | REQ-34 | infra | atomic write: kill mid-write → original config intact | tmp file removed; original unchanged |
| TC-U-23 | REQ-35 | happy | env vars `TOKENFX_ONBOARD_*` all set → no prompts | exits 0 with config written |
| TC-U-24 | REQ-35 | edge | `--non-interactive` with missing email → exit 1 | clear "missing email" message |
| TC-U-25 | REQ-36 | validation | redeem 401 → "Token inválido…" message + exit 1 | stderr contains canonical 401 message |
| TC-U-26 | REQ-36 | validation | redeem 429 with `Retry-After: 30` → "Espere 30s…" | stderr contains "30s" |
| TC-U-27 | REQ-36 | validation | network error → "Não foi possível alcançar…" + exit 1 | stderr contains central_url |
| TC-U-28 | REQ-36 | validation | redeem 500 → "Erro no servidor…" + exit 1 | stderr contains canonical message |

### Integration Tests (Testcontainers Postgres)

| TC | REQ | Category | Description | Expected |
|---|---|---|---|---|
| TC-I-01 | REQ-1,2,3 | infra | All 3 new tables + 2 enums + indexes present after migration | DDL matches spec |
| TC-I-02 | REQ-4 | infra | Migration: `users.sso_provider`, `users.sso_subject` are NULLABLE | column metadata reflects |
| TC-I-03 | REQ-5 | security | Boot-time: production with no `ONBOARDING_EMAIL_HASH_PEPPER` → throw | server fails to start |
| **Auth refactor (REQ-6..10)** ||||
| TC-I-04 | REQ-6,7 | happy | Reporter sends `Authorization: Bearer <secret>` to `/api/ingest` → 200 | accepted with new auth path |
| TC-I-05 | REQ-6 | security | Bearer with wrong secret → 401 | bcrypt.compare false |
| TC-I-06 | REQ-6 | security | Missing `Authorization` header → 401 | no header path |
| TC-I-07 | REQ-6 | security | Malformed `Authorization` (no Bearer prefix) → 401 | parser rejection |
| TC-I-08 | REQ-9 | infra | After `seed-server.ts --e2e`, `secret_hash` matches `bcrypt prefix `$2b$` | DB row valid |
| TC-I-09 | REQ-9 | security | `seed-server.ts --e2e` does NOT print plaintext secret to stdout | stdout scan |
| **Server Action: create (REQ-18)** ||||
| TC-I-10 | REQ-18 | happy | Manager creates invite → token returned, audit_log row written | 200 + 1 row in audit_log |
| TC-I-11 | REQ-18 | security | Member-role calls action → throws unauthorized | error caught by error.tsx |
| TC-I-12 | REQ-18 | validation | `expires_in_hours = 0` rejected | Zod error |
| TC-I-13 | REQ-18 | boundary | `expires_in_hours = 1` (valid min) → 200 | accepted |
| TC-I-14 | REQ-18 | boundary | `expires_in_hours = 168` (valid max) → 200 | accepted |
| TC-I-15 | REQ-18 | validation | `expires_in_hours = 169` (over max) → rejected | Zod error |
| TC-I-16 | REQ-18 | validation | `max_uses = 0` rejected | Zod error |
| TC-I-17 | REQ-18 | boundary | `max_uses = 1` (valid min) → 200 | accepted |
| TC-I-18 | REQ-18 | boundary | `max_uses = 100` (valid max) → 200 | accepted |
| TC-I-19 | REQ-18 | validation | `max_uses = 101` (over max) → rejected | Zod error |
| TC-I-20 | REQ-18 | validation | unknown field in body (`.strict()`) → rejected | Zod error |
| TC-I-21 | REQ-18 | idempotency | same `idempotency_key` within 5min → returns cached token | one row in DB |
| TC-I-22 | REQ-18 | edge | different `idempotency_key`, same body → 2 distinct tokens | two rows in DB |
| **Server Action: revoke (REQ-19)** ||||
| TC-I-23 | REQ-19 | happy | Revoke active invite → `revoked_at` set, audit_log row | UPDATE successful |
| TC-I-24 | REQ-19 | idempotency | Revoke already-revoked → no-op | revoked_at unchanged |
| TC-I-25 | REQ-19 | security | Manager of org A cannot revoke org B's invite | 404 (scoped lookup) |
| TC-I-26 | REQ-19 | edge | Revoke with prefix matching 2 tokens (forced collision via direct INSERT) → 409 | conflict |
| **List query (REQ-20)** ||||
| TC-I-27 | REQ-20 | happy | List returns rows for org sorted by created_at DESC | sequential |
| TC-I-28 | REQ-20 | security | List in org A shows only org A's invites | scoped |
| TC-I-29 | REQ-20 | happy | Status derivation: 4 invites with each status (active/expired/exhausted/revoked) | each row correct status (it.each) |
| TC-I-30 | REQ-20 | security | List response never includes full token, only prefix | regex assertion |
| **Redemption: rate limit (REQ-27)** ||||
| TC-I-31 | REQ-27 | security | 11 redeem attempts in 60s from same IP → 11th 429 | Retry-After header |
| TC-I-32 | REQ-27 | security | 4 attempts in 60s on same token from 4 different IPs → 4th 429 (per-token 3/min cap exceeded) | Retry-After header; outcome NOT logged to redemption_log |
| TC-I-33 | REQ-27 | edge | 11 attempts from same IP on 11 distinct tokens (each token below per-token cap) → 11th 429 (per-IP cap hit) | per-IP limit fires; outcome NOT logged to redemption_log |
| TC-I-33b | REQ-27 | security | Rate-limited request emits `logger.warn` but writes ZERO rows to onboarding_redemption_log (DoS amplification protection) | log.warn called; SELECT count(*) unchanged |
| TC-I-33c | REQ-27 | security | Zod validation failure emits `logger.warn` but writes ZERO rows to onboarding_redemption_log | same as above |
| TC-I-33d | REQ-27 | edge | Bearer scheme case-insensitivity: `bearer <secret>`, `BEARER <secret>`, `Bearer <secret>` all accepted | RFC 7235 compliance |
| TC-I-33e | REQ-27 | validation | Empty Bearer (`Authorization: Bearer ` trailing-space-only) → 401 | malformed scheme |
| TC-I-33f | REQ-27 | validation | Wrong scheme (`Authorization: Basic abc`) → 401 | scheme mismatch |
| **Redemption: validation (REQ-26..28)** ||||
| TC-I-34 | REQ-26 | validation | `token` 63 hex chars → 400 | Zod regex |
| TC-I-35 | REQ-26 | validation | `token` 65 hex chars → 400 | Zod regex |
| TC-I-36 | REQ-26 | validation | `token` 64 chars but contains `g` → 400 | Zod regex |
| TC-I-37 | REQ-26 | validation | `machine_id` not a UUID → 400 | Zod uuid |
| TC-I-38 | REQ-26 | boundary | `hostname` exactly 255 chars → 200 | accepted |
| TC-I-39 | REQ-26 | validation | `hostname` 256 chars → 400 | Zod max |
| TC-I-40 | REQ-26 | validation | `hostname` empty → 400 | Zod min |
| TC-I-41 | REQ-26 | validation | `claimed_email` malformed (no `@`) → 400 | Zod email |
| TC-I-42 | REQ-26 | validation | `claimed_email` empty → 400 | Zod email |
| TC-I-43 | REQ-26 | validation | unknown body field (`.strict()`) → 400 | Zod strict |
| **Redemption: token rejection (REQ-27)** ||||
| TC-I-44 | REQ-27 | edge | non-existent token → 401 | outcome='token-invalid' |
| TC-I-45 | REQ-27 | edge | revoked token → 401 | outcome='token-revoked' |
| TC-I-46 | REQ-27 | edge | expired token → 401 | outcome='token-expired' |
| TC-I-47 | REQ-27 | edge | exhausted token (used_count=max_uses) → 401 | outcome='token-exhausted' |
| TC-I-48 | REQ-27 | edge | email pattern mismatch → 401 (NOT 403) | outcome='email-mismatch' |
| TC-I-49 | REQ-27 | security | Bodies of TC-I-44..48 are byte-equal | uniformity asserted |
| TC-I-50 | REQ-27 | security | Response body of any 401 never contains the submitted token | scan response.text() |
| **Redemption: happy path + audit (REQ-28)** ||||
| TC-I-51 | REQ-28 | happy | Valid token + matching email → 200, user_machines row, secret_hash bcrypt | bcrypt verify works |
| TC-I-52 | REQ-28 | happy | Re-redeem same token (max_uses=2) by different machine → 2nd row | used_count=2 |
| TC-I-53 | REQ-28 | happy | New user: row inserted with `sso_provider=NULL` and team_id from invite | row matches |
| TC-I-54 | REQ-28 | edge | Existing user: reuse, `team_id` UNCHANGED (preserve assignment) | team_id stays |
| TC-I-55 | REQ-28 | security | bcrypt hash stored, NOT plaintext secret | secret_hash starts `$2b$` |
| TC-I-56 | REQ-28 | happy | Email case-insensitive match: `Alice@X.COM` reuses existing `alice@x.com` user | reused |
| TC-I-57 | REQ-2 | security | redemption_log stores `email_domain` and `email_hash`, never `claimed_email` | column scan |
| TC-I-58 | REQ-2 | security | `email_hash` reproducible: same email + pepper → same hash | deterministic |
| TC-I-59 | REQ-2 | security | redemption_log token_prefix length === 8 | string-length |
| TC-I-60 | REQ-3 | happy | Audit log on create → row with `action='invite-created'` + metadata | row matches |
| TC-I-61 | REQ-3 | happy | Audit log on revoke → row with `action='invite-revoked'` | row matches |
| **Atomicity & Concurrency (REQ-29)** ||||
| TC-I-62 | REQ-29 | business | 5 parallel redeems on `max_uses=1` → exactly 1 acceptance | used_count=1 |
| TC-I-63 | REQ-29 | business | 6 parallel redeems on `max_uses=3` → exactly 3 acceptances | used_count=3 |
| TC-I-64 | REQ-29 | infra | DB connection fails mid-redemption → 500, no partial write | rollback |
| TC-I-65 | REQ-29 | infra | bcrypt throws (mocked) → 500, no partial write | rollback |
| **Pre-flight (REQ-32)** ||||
| TC-I-66 | REQ-32 | happy | Existing valid config + `/api/health` 200 → setup refuses with exit code 1 | "config válida já existe" |
| TC-I-67 | REQ-32 | edge | Existing config + `/api/health` 401 → setup proceeds, overwrites | new config written |
| TC-I-68 | REQ-32 | edge | Existing config + `--force` → setup proceeds, overwrites | new config written |
| TC-I-68b | REQ-32 | edge | Existing config + `/api/health` network unreachable → exit 1 with "Não foi possível verificar" message | clear stderr |
| **Health endpoint (REQ-37)** ||||
| TC-I-69 | REQ-37 | happy | `GET /api/health` (no auth, no query) → 200 `{ok:true,server_time:...}` | liveness mode |
| TC-I-70 | REQ-37 | happy | `GET /api/health?key_id=k_xxx` with valid Bearer → 200 | credential validation mode |
| TC-I-71 | REQ-37 | security | `GET /api/health?key_id=k_xxx` with invalid Bearer → 401 | rejects |
| TC-I-71b | REQ-37 | validation | `GET /api/health` with `Authorization` header but NO `key_id` query → 400 | required-param error |
| TC-I-71c | REQ-37 | validation | `GET /api/health` with malformed Authorization (`Basic abc`) → 401 | wrong scheme |
| TC-I-71d | REQ-37 | security | 11 credential-validation calls in 60s from same IP → 11th 429 | per-IP rate limit |
| TC-I-71e | REQ-37 | edge | Bearer cache hit: 2nd call within 60s for same key_id avoids bcrypt (timing) | sub-millisecond response time |
| **Config file (REQ-31, REQ-34)** ||||
| TC-I-72 | REQ-34 | happy | After successful redeem + setup, `data/reporter-config.json` exists, mode 0600 | stat check |
| TC-I-73 | REQ-34 | infra | data/ not writable → exit non-zero, no leak in any output | stdout scan |
| **Auth callback (REQ-11..13)** | | | | |
| TC-I-76 | REQ-13 | happy | Invited user (sso_provider=NULL) does first SSO login → row updated with sso_provider/sso_subject; session.user.id populated | row diff before/after; session inspection |
| TC-I-77 | REQ-13 | happy | Existing SSO user (sso_provider='google', matches OAuth) signs in → no row change; session.user.id populated | unchanged |
| TC-I-78 | REQ-13 | security | Existing user has sso_provider='google'; OAuth attempt with provider='okta' → signIn rejects, structured warn log emitted (email_domain only) | rejection observed |
| TC-I-79 | REQ-12 | happy | `loadUserByEmail` returns `{userId, role, orgId, ssoProvider}` for existing user | shape matches |
| TC-I-80 | REQ-12 | edge | `loadUserByEmail` for invited user (sso_provider=NULL) → returns row with `ssoProvider=null` (does NOT filter NULL) | NULL preserved |
| **Flash cookie (REQ-22)** | | | | |
| TC-I-74 | REQ-22 | happy | Set flash cookie via Server Action → read on /created page → cookie deleted before render | round-trip |
| TC-I-75 | REQ-22 | security | Tampered flash cookie (HMAC mismatch) → /created page shows empty state, cookie deleted | rejected |
| TC-I-75b | REQ-22 | edge | Reload /created twice → 2nd render shows empty state (cookie auto-cleared on 1st) | one-shot |
| **Idempotency (REQ-18)** | | | | |
| TC-I-21b | REQ-18 | edge | Same idempotency_key from DIFFERENT actor → 2 distinct tokens (key is `(actor_user_id, idempotency_key)` tuple) | not deduplicated cross-actor |
| TC-I-21c | REQ-18 | edge | Same idempotency_key after 5min TTL expires → new token created | TTL respected |
| **Audit log scope (REQ-3, REQ-17)** | | | | |
| TC-I-60b | REQ-3 | security | Org A's audit log query returns 0 rows for org B's create | scoped |
| TC-I-60c | REQ-3 | happy | Audit log metadata JSONB shape on create: `{max_uses, expires_at, email_pattern, team_id}` | exact JSON shape |
| TC-I-60d | REQ-3 | happy | Audit log actor_user_id matches creator (whether manager or admin role) | matches |
| **Machine re-onboarding (REQ-28)** | | | | |
| TC-I-52b | REQ-28 | edge | Same machine_id redeems with 2 distinct invites → 2 user_machines rows (intentional; no UNIQUE constraint) | both rows present |
| TC-I-52c | REQ-28 | edge | Existing user (team_id=null) redeems invite with team_id=X → user.team_id updated to X | NULL gets filled |
| TC-I-52d | REQ-28 | business | Existing user (team_id=A) redeems invite with team_id=B → user.team_id stays A (preserve assignment) | unchanged |
| **Seed-server.ts (REQ-9)** | | | | |
| TC-I-09b | REQ-9 | happy | seed-server.ts --e2e stdout STILL contains identifiable info (machine_id, key_id) so e2e tests can read it | non-empty positive output |

### Red-team Fuzz Tests

(Mirrors `lib/reporter/no-leakage.test.ts` pattern from spec 3.)

| TC | REQ | Category | Description | Expected |
|---|---|---|---|---|
| TC-F-01 | REQ-26 | security | redeem with token containing SQL injection chars (`' OR 1=1 --`) | 400 (Zod regex) |
| TC-F-02 | REQ-26 | security | redeem with email containing null byte (`alice @x.com`) | 400 (Zod email) |
| TC-F-03 | REQ-26 | security | redeem with email containing Unicode RLO override | 400 (Zod email) |
| TC-F-04 | REQ-26 | security | redeem with hostname `../../../etc/passwd` | 400 (Zod max OR processed safely; no FS access) |
| TC-F-05 | REQ-26 | security | redeem with machine_id forged to UUID of an EXISTING `user_machines` row | 200 (different user) — confirm no info leak |
| TC-F-06 | REQ-27 | security | redeem with very large body (10MB JSON) | rejected, no OOM, no 500 |
| TC-F-07 | REQ-27 | security | 100 redeem requests with random tokens → all 401, no 500, no DB row leak | clean |
| TC-F-08 | REQ-27 | security | redeem responses never include stack traces or DB error messages | scan response bodies |
| TC-F-09 | REQ-27 | security | redeem responses never include the submitted token in error messages | scan |
| TC-F-10 | REQ-32 | security | malicious central_url to setup CLI (e.g. `https://attacker.com`) → no leak of stored config | TLS verify |

### E2E Tests

| TC | REQ | Category | Description | Expected |
|---|---|---|---|---|
| TC-E2E-01 | REQ-21,22 | happy | Manager logs in → /manager/invites → create invite → show-once page displays full URL | URL visible, copy button works |
| TC-E2E-02 | REQ-20,21 | happy | Created invite appears in list with `status=active`; full token NOT in DOM | row visible, only prefix |
| TC-E2E-03 | REQ-23 | happy | Manager clicks revoke → AlertDialog → Confirm → status='revoked' | UI updates |
| TC-E2E-04 | REQ-17 | happy | Open `/onboard#token=XXX` in browser → token displayed + copy button | DOM contains token |
| TC-E2E-05 | REQ-17 | security | `/onboard` with no fragment → "no token in URL" placeholder | safe empty state |
| TC-E2E-06 | REQ-21..36 | happy | Full flow: create invite → simulate `pnpm reporter:setup` (Node child_process from test) → redeem 200 → config file written → `pnpm reporter:run` pushes batch with new Bearer auth → 200 | end-to-end |
| TC-E2E-07 | REQ-21 | security | Member role hits `/manager/invites` → 403 | middleware/layout |

## Design

### Bearer-token authentication (replaces HMAC)

**Wire format**:
- Reporter sends `Authorization: Bearer <secret>` on every `/api/ingest` push.
- Server extracts the bearer, looks up the candidate `key_id` from the request envelope (still in body — needed to identify which machine).
- Server fetches `secret_hash` from `user_machines` by `key_id`, calls `bcrypt.compare(secret_from_bearer, secret_hash)`. If false, 401.
- Constant-time comparison is provided by bcrypt itself (it's intentionally slow).

**Why drop HMAC**:
- HMAC requires the plaintext key on both sides for verification, which forces plaintext-at-rest. Industry standard is bcrypt-at-rest + Bearer in transit (Stripe, GitHub, Anthropic, every REST API key model in production).
- Integrity of payload-in-transit is provided by TLS, not HMAC. No realistic threat model on a TLS-terminated endpoint where an attacker can modify the body without breaking the TLS session.
- Simpler code, simpler audit story, eliminates TASK-14 deviation.

**Migration plan**: no production deploys exist. Wipe dev/test DBs and re-seed via `seed-server.ts --e2e` (now bcrypt-hashing). Integration tests TRUNCATE in `beforeAll` so they're naturally compliant.

### Email hash with pepper

**Why peppered SHA-256, not bcrypt**:
- Goal: count unique emails that attempted redemption without storing the email itself.
- bcrypt is for slow-comparison auth keys; SHA-256 is fast and appropriate for a lookup-key.
- Pepper (server-side secret) protects against rainbow-table attacks if the DB leaks. Key rotation requires a re-hash migration if ever needed.

**Implementation**: `crypto.createHash('sha256').update(email.normalize('NFC').toLowerCase() + process.env.ONBOARDING_EMAIL_HASH_PEPPER).digest('hex')`.

### Idempotency-Key implementation

**In-memory map**:
- `Map<string, {token: string, expiresAt: number}>` keyed on `${actor_user_id}:${idempotency_key}`. TTL 5min.
- On `createInvite`: check map; if hit, return cached `{token, expires_at, onboard_url}` (without re-INSERT). If miss, run normal flow + store result.
- Lost on server restart — acceptable; double-clicks within a single dev session are the only common case.
- **Single-instance only**: this approach does not survive multi-replica or serverless deployments (concurrent function invocations don't share module state). If TokenFx ever ships a load-balanced manager dashboard, persist idempotency to DB (extra column on `onboarding_audit_log` or a dedicated table). Out of scope for v1.

### JWT augmentation (REQ-11, REQ-12)

The `JWT` interface (in `auth.ts`'s `declare module 'next-auth/jwt'` block) gains:

```ts
interface JWT {
  ssoProvider?: string;   // existing
  role?: Role;            // existing
  orgId?: string;         // existing
  userId?: string;        // NEW — internal users.id UUID
}
```

The `Session` interface gains `id?: string` on `Session.user`. Both populated by the existing `jwt()` and `session()` callbacks; the only logic change is `loadRoleAndOrg` returning `userId` and the callbacks mirroring it. Edge runtime stays DB-free (callback reads from JWT).

### Drizzle TS API translation (for raw-SQL tables in REQ-1..3)

The schema blocks above use raw SQL DDL for clarity. The Drizzle TS API equivalents in `apps/server/lib/db/schema.ts`:

```ts
import { pgTable, pgEnum, uuid, text, integer, timestamp, jsonb, bigserial, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// REQ-2: enum first (Drizzle requires module-level pgEnum declaration)
export const onboardingOutcomeEnum = pgEnum('onboarding_outcome', [
  'accepted','token-invalid','token-expired','token-revoked',
  'token-exhausted','email-mismatch','rate-limited','validation-error','infra-error',
]);
export const onboardingAuditActionEnum = pgEnum('onboarding_audit_action', ['invite-created','invite-revoked']);

// REQ-1: onboarding_invites
export const onboardingInvites = pgTable('onboarding_invites', {
  token: text('token').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  emailPattern: text('email_pattern'),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  maxUsesCheck: check('max_uses_positive', sql`${t.maxUses} >= 1`),
  orgCreatedIdx: index('idx_onboarding_invites_org_created').on(t.orgId, t.createdAt),
  // Functional expression index — Drizzle supports `sql\`\`` inside .on()
  prefixIdx: index('idx_onboarding_invites_prefix').on(sql`left(${t.token}, 8)`),
}));

// REQ-2: onboarding_redemption_log uses the enum + similar pattern.
// REQ-3: onboarding_audit_log uses a CHECK on target_token_prefix length:
//   tokenPrefixLenCheck: check('token_prefix_len', sql`length(${t.targetTokenPrefix}) = 8`),
```

Drizzle's `index().on(sql\`...\`)` does support functional expressions (verified in the Drizzle source). Migrations generated by `pnpm db:generate` will emit raw SQL `CREATE INDEX … ON … (left(token, 8))`.

### Audit log

**One row per admin op**. Read pattern: `SELECT * FROM onboarding_audit_log WHERE org_id = ? ORDER BY occurred_at DESC LIMIT 50` for a future "audit trail" UI page (out of scope this spec). Indexed by `(org_id, occurred_at DESC)`.

### Generic 401 for token rejections

All 5 token-rejection paths (token-invalid, token-revoked, token-expired, token-exhausted, email-mismatch) return:

```json
{ "error": { "message": "invalid or expired invite", "code": "unauthorized" } }
```

The DB log records the SPECIFIC outcome (audit trail visible to admins). The HTTP body is uniform (no info leak to attacker).

### Static `/onboard` page

**Why fragment, not query**:
- Query parameters appear in HTTP access logs, proxies, browser history, Referer headers.
- Fragments NEVER reach the server (RFC 3986 + browser behavior). Browser history is the residual surface.
- Cost: 1 page (`app/onboard/page.tsx` + small client component reading `window.location.hash`). Manager shares URL `https://central/onboard#token=XXX`. Page reads fragment, displays token + copy button. No backend interaction.

### Files to Create

#### Server (`apps/server/`)

- `apps/server/lib/db/schema.ts` — extend with `onboarding_invites`, `onboarding_redemption_log`, `onboarding_audit_log` tables + 2 enums + relations; ALTER `users` to NULLABLE sso fields
- `apps/server/lib/db/migrations/0001_onboarding.sql` — drizzle-kit generated migration
- `apps/server/lib/auth/match-email-pattern.ts` — REQ-16 helper (pure)
- `apps/server/lib/auth/match-email-pattern.test.ts` — TC-U-04..13
- `apps/server/lib/auth/tokens.ts` — REQ-14, REQ-15 helpers
- `apps/server/lib/auth/tokens.test.ts` — TC-U-01..03
- `apps/server/lib/auth/email-hash.ts` — REQ-2, REQ-5 hashing (pepper-aware)
- `apps/server/lib/auth/email-hash.test.ts` — TC-I-58 mostly; pure-fn tests
- `apps/server/lib/queries/invites.ts` — `listInvitesForOrg`, `revokeInviteByPrefix`, helpers
- `apps/server/lib/queries/invites.test.ts` — TC-I-23..30
- `apps/server/lib/queries/redeem.ts` — `redeemInvite()` transaction
- `apps/server/lib/queries/redeem.test.ts` — TC-I-31..65
- `apps/server/lib/queries/redemption-log.ts` — log-write helpers
- `apps/server/lib/queries/audit-log.ts` — log-write helpers
- `apps/server/lib/queries/rate-limit.ts` — sliding-window limiter (in-memory) with two dimensions
- `apps/server/lib/queries/rate-limit.test.ts` — pure tests for limiter
- `apps/server/app/api/onboarding/redeem-invite/route.ts` — POST handler
- `apps/server/app/api/health/route.ts` — REQ-37 health endpoint (with optional Bearer mode)
- `apps/server/app/manager/invites/page.tsx` — list view (Server Component)
- `apps/server/app/manager/invites/loading.tsx`
- `apps/server/app/manager/invites/error.tsx`
- `apps/server/app/manager/invites/create/page.tsx` — create form
- `apps/server/app/manager/invites/created/page.tsx` — show-once URL display
- `apps/server/app/manager/invites/actions.ts` — Server Actions (create, revoke)
- `apps/server/components/manager/invite-row.tsx` — single row presentation
- `apps/server/components/manager/invite-create-form.tsx` — form (Client Component leaf)
- `apps/server/components/manager/invite-revoke-button.tsx` — AlertDialog wrapper (Client Component leaf)
- `apps/server/components/onboarding/onboard-token-display.tsx` — `/onboard` page client component (reads fragment)
- `apps/server/app/onboard/page.tsx` — Server Component shell
- `apps/server/tests/integration/onboarding-redeem.test.ts` — TC-I-31..65, TC-F-01..09
- `apps/server/tests/integration/onboarding-invites.test.ts` — TC-I-10..30, TC-I-60..61
- `apps/server/tests/integration/auth-bearer.test.ts` — TC-I-04..09 (refactored ingest auth)
- `apps/server/tests/e2e/onboarding.spec.ts` — TC-E2E-01..07

#### Reporter (root `lib/reporter/`)

- `lib/reporter/canonical-json.ts` — extracted from signer.ts (logic unchanged)
- `lib/reporter/canonical-json.test.ts` — extracted tests

#### Scripts (root)

- `scripts/reporter-setup.ts` — REQ-30..36 interactive CLI
- `scripts/reporter-setup.test.ts` — TC-U-14..28, TC-F-10

### Files to Modify

- `apps/server/app/api/ingest/route.ts` — REQ-6 Bearer auth (drop signature/HMAC)
- `apps/server/lib/auth/auth.ts` — REQ-12, REQ-13 jwt/session augmentation + signIn semantics
- `apps/server/lib/auth/auth.config.ts` — REQ-12 Edge-safe session callback also mirrors userId
- `apps/server/lib/auth/roles.ts` — no change (just used elsewhere)
- `apps/server/scripts/seed-server.ts` — REQ-9 bcrypt secrets on insert; remove plaintext print in --e2e mode
- `apps/server/app/manager/layout.tsx` — REQ-24 sidebar nav link to `/manager/invites`
- `apps/server/README.md` — REQ-38 onboarding flow + threat model
- `lib/reporter/client.ts` — REQ-7 Bearer auth (drop signature)
- `lib/reporter/client.test.ts` — update for Bearer
- `lib/reporter/runner.ts` — only if it composes signer (audit)
- `lib/reporter/types.ts` — drop `signature` from envelope type
- `lib/reporter/queue.ts` — uses canonicalJSON for hashing; update import path
- `package.json` (root) — add `"reporter:setup": "tsx scripts/reporter-setup.ts"` script
- `apps/server/package.json` — add `bcrypt` + `@types/bcrypt` deps
- `README.md` (root) — REQ-39 brief mention

### Files to Delete

- `lib/reporter/signer.ts` — HMAC functions removed; canonicalJSON moved to canonical-json.ts
- `lib/reporter/signer.test.ts` — HMAC tests removed; canonicalJSON tests moved

### Dependencies

- `bcrypt` (apps/server) — primary auth mechanism. Cost factor 12 (~100ms/compare). Acceptable for onboarding (rare) and ingest (every push but not latency-critical).
- `@types/bcrypt` (apps/server, dev)
- No new root deps.

## Tasks

- [ ] **TASK-1**: Schema migrations — 3 new tables (`onboarding_invites`, `onboarding_redemption_log`, `onboarding_audit_log`), 2 enums, ALTER `users` to NULLABLE sso fields. Drizzle-kit generate. **bcrypt + @types/bcrypt** added in this task. Update existing integration test files' `TRUNCATE TABLE … RESTART IDENTITY CASCADE` lists in `beforeAll` to include the 3 new tables (cleanup, ingest, overview, teams) — required so existing suites don't FK-violate after schema lands.
  - files: apps/server/lib/db/schema.ts, apps/server/lib/db/migrations/0001_onboarding.sql, apps/server/package.json, apps/server/lib/db/migrations/meta/_journal.json, apps/server/lib/queries/teams.test.ts (TRUNCATE list), apps/server/lib/queries/overview.test.ts (TRUNCATE list), apps/server/tests/integration/cleanup.test.ts (TRUNCATE list), apps/server/tests/integration/ingest.test.ts (TRUNCATE list)
  - depends: (none beyond spec-3 schema)
  - tests: TC-I-01, TC-I-02, TC-I-03

- [ ] **TASK-2**: Email pattern matching helper. RED → GREEN.
  - files: apps/server/lib/auth/match-email-pattern.test.ts (FIRST), apps/server/lib/auth/match-email-pattern.ts
  - depends: (none)
  - tests: TC-U-04..13

- [ ] **TASK-3**: Token + key_id generation helpers; email-hash with pepper. RED → GREEN.
  - files: apps/server/lib/auth/tokens.test.ts (FIRST), apps/server/lib/auth/tokens.ts, apps/server/lib/auth/email-hash.test.ts (FIRST), apps/server/lib/auth/email-hash.ts
  - depends: (none)
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-I-58 (deterministic)

- [ ] **TASK-4**: Reporter auth refactor — server AND reporter sides in a single atomic task (no batch split). Why merged: `pnpm test --run` would 401 every reporter integration test if server flips first while reporter still signs. The two sides must change together for `pnpm typecheck && pnpm test --run` to pass after this task lands.
  - files (server): apps/server/app/api/ingest/route.ts (modify — Bearer + bcrypt + 60s cache), apps/server/scripts/seed-server.ts (modify — bcrypt secrets on insert; --e2e prints `key_id` + `machine_id` but NOT secret), apps/server/app/api/health/route.ts (NEW — liveness + credential-validation modes)
  - files (reporter): lib/reporter/client.ts (modify — drop X-Signature, send Bearer, derive idempotency-key from `sha256(canonicalJSON(payload))`), lib/reporter/client.test.ts (update for Bearer), lib/reporter/canonical-json.ts (NEW — extracted from signer.ts), lib/reporter/canonical-json.test.ts (NEW — extracted), lib/reporter/types.ts (modify — rename SignedEnvelope → IngestEnvelope, drop signature field), lib/reporter/queue.ts (modify — update canonicalJSON import path), lib/reporter/runner.ts (modify — drop `sign` import, drop signature from envelope construction, update canonicalJSON import), lib/reporter/signer.ts (DELETE), lib/reporter/signer.test.ts (DELETE)
  - depends: TASK-1 (bcrypt dep)
  - tests: TC-I-04..09, TC-I-69..71; existing root reporter tests must remain green

- [ ] **TASK-5**: Auth augmentation — `Session.user.id` + `JWT.userId` wired through. `loadRoleAndOrg` renamed to `loadUserByEmail` with email-only predicate (REQ-12). `signIn` callback handles invite-provisioned users (REQ-13). Existing-user lookup query changes from `(email, sso_provider)` to `(email)`-only.
  - files: apps/server/lib/auth/auth.ts (modify — query change + signIn branching + JWT augmentation), apps/server/lib/auth/auth.config.ts (modify — session callback mirrors token.userId)
  - depends: TASK-1 (NULLABLE sso fields)
  - tests: TC-I-76 (invited user first SSO login → session.user.id populated, sso_provider/subject filled), TC-I-77 (existing SSO user — session.user.id populated unchanged), TC-I-78 (mismatched sso_provider on existing user → signIn rejects with 401)

- [ ] **TASK-6a**: Redeem query (`redeemInvite`) — happy paths.
  - files: apps/server/lib/queries/redeem.test.ts (FIRST, with happy TCs), apps/server/lib/queries/redeem.ts (happy path), apps/server/lib/queries/redemption-log.ts, apps/server/lib/queries/audit-log.ts
  - depends: TASK-1, TASK-2, TASK-3, TASK-4a
  - tests: TC-I-51..56

- [ ] **TASK-6b**: Redeem query — token rejection branches + email-hash side effects.
  - files: apps/server/lib/queries/redeem.test.ts (extend), apps/server/lib/queries/redeem.ts (extend)
  - depends: TASK-6a
  - tests: TC-I-44..50, TC-I-57..59

- [ ] **TASK-6c**: Redeem query — rate limit + concurrency + atomicity + fuzz.
  - files: apps/server/lib/queries/rate-limit.test.ts (FIRST), apps/server/lib/queries/rate-limit.ts, apps/server/lib/queries/redeem.test.ts (extend), apps/server/lib/queries/redeem.ts (rate-limit hook), apps/server/tests/integration/onboarding-redeem.test.ts (fuzz suite)
  - depends: TASK-6b
  - tests: TC-I-31..33, TC-I-62..65, TC-F-01..09

- [ ] **TASK-7**: Admin invite Server Actions — create + revoke + list query + audit_log writes.
  - files: apps/server/app/manager/invites/actions.ts, apps/server/lib/queries/invites.ts, apps/server/lib/queries/invites.test.ts
  - depends: TASK-1, TASK-3, TASK-5
  - tests: TC-I-10..30, TC-I-60, TC-I-61

- [ ] **TASK-8**: API route — `/api/onboarding/redeem-invite` POST handler. Wires REQ-26 Zod parsing → REQ-27 rate-limit step 0 → `redeemInvite()`.
  - files: apps/server/app/api/onboarding/redeem-invite/route.ts
  - depends: TASK-6c
  - tests: covered by TC-I-* + TC-F-* via fetch

- [ ] **TASK-9**: Admin UI — `/manager/invites` (list + create + show-once + revoke confirmation). Manager layout nav link addition. Loading/error boundaries. Flash cookie helper for one-time URL display.
  - files: apps/server/app/manager/invites/page.tsx, apps/server/app/manager/invites/create/page.tsx, apps/server/app/manager/invites/created/page.tsx, apps/server/app/manager/invites/loading.tsx, apps/server/app/manager/invites/error.tsx, apps/server/app/manager/layout.tsx (modify nav), apps/server/components/manager/invite-row.tsx, apps/server/components/manager/invite-create-form.tsx, apps/server/components/manager/invite-revoke-button.tsx, apps/server/lib/auth/flash-cookie.ts, apps/server/lib/auth/flash-cookie.test.ts
  - depends: TASK-7
  - tests: TC-I-74 (flash cookie set/read/delete cycle), TC-I-75 (flash cookie HMAC verification rejects tampering); E2E TC-E2E-01..03 covers UI flow

- [ ] **TASK-10**: Static `/onboard` page (Server shell + Client fragment-reader + token display + copy button).
  - files: apps/server/app/onboard/page.tsx, apps/server/components/onboarding/onboard-token-display.tsx
  - depends: (none)
  - tests: TC-E2E-04, TC-E2E-05

- [ ] **TASK-11a**: Reporter setup CLI — pure parsing + error mapping (RED → GREEN).
  - files: scripts/reporter-setup.test.ts (FIRST), scripts/reporter-setup.ts (parsing + URL/token + error mapping), package.json (script entry)
  - depends: (none)
  - tests: TC-U-14..28, TC-F-10

- [ ] **TASK-11b**: Reporter setup CLI — integration (atomic config write, pre-flight, TLS check, --force, env vars).
  - files: scripts/reporter-setup.ts (extend), scripts/reporter-setup.test.ts (extend)
  - depends: TASK-11a, TASK-8 (redeem endpoint), TASK-4a (health endpoint)
  - tests: TC-U-19..24, TC-I-66..68, TC-I-72..73

- [ ] **TASK-12**: Documentation — README updates (apps/server + root).
  - files: apps/server/README.md, README.md
  - depends: (none — docs)
  - tests: N/A (docs)

- [ ] **TASK-SMOKE**: E2E full flow — manager creates invite → /onboard page → simulated `pnpm reporter:setup` (Node child_process from test) → redeem 200 → config file written → `pnpm reporter:run` pushes batch with new Bearer auth → 200.
  - files: apps/server/tests/e2e/onboarding.spec.ts, apps/server/tests/e2e/global-setup.ts (extend if needed)
  - depends: TASK-9, TASK-10, TASK-11b
  - tests: TC-E2E-01..07

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3, TASK-10, TASK-11a, TASK-12]    — disjoint files
Batch 2: [TASK-4, TASK-5]                                          — schema + bcrypt landed; server-side auth refactor (atomic, server+reporter together) + session augmentation in parallel (disjoint files)
Batch 3: [TASK-6a]                                                 — depends on TASK-1+2+3+4
Batch 4: [TASK-6b, TASK-7]                                         — depends on TASK-6a; TASK-7 (invite Server Actions) overlaps cleanly (different file set)
Batch 5: [TASK-6c]                                                 — depends on TASK-6b
Batch 6: [TASK-8]                                                  — depends on TASK-6c (API route wires redeem)
Batch 7: [TASK-9, TASK-11b]                                        — depends on TASK-7 + TASK-8
Batch 8: [TASK-SMOKE]                                              — final
```

Each task leaves `pnpm typecheck && pnpm test --run` green per SDD rule. TASK-4 is intentionally NOT split because the server-side auth flip would 401 every reporter integration test until the reporter side flips too — atomic together.

File overlap analysis:

- `apps/server/lib/db/schema.ts` — TASK-1 only
- `apps/server/lib/auth/auth.ts`, `auth.config.ts` — TASK-5 only
- `apps/server/scripts/seed-server.ts` — TASK-4 only
- `apps/server/app/api/ingest/route.ts` — TASK-4 only
- `apps/server/app/api/health/route.ts` — TASK-4 only (NEW)
- `apps/server/app/manager/layout.tsx` — TASK-9 only (sidebar nav addition)
- `lib/reporter/client.ts`, `types.ts`, `queue.ts`, `runner.ts`, `signer.ts` — TASK-4 only
- `package.json` (root) — TASK-11a only
- `apps/server/package.json` — TASK-1 only

Zero shared-mutative within this spec.

## Validation Criteria

- [ ] `pnpm typecheck` (root) + `pnpm typecheck` (apps/server) pass
- [ ] `pnpm lint` (both) pass
- [ ] `pnpm test --run` (root) — 904+ tests pass (no regressions from refactor of `lib/reporter/*`)
- [ ] `pnpm test --run` (apps/server) — passes including new ~75 TCs (TC-I-01..73 + TC-F-01..10)
- [ ] `pnpm test:e2e` (apps/server) — passes including TC-E2E-01..07

### Live validation against real running server

- [ ] Author runs `pnpm dev` in apps/server, logs in as admin, creates an invite at `/manager/invites`. Captures the show-once URL with `#token=...` fragment.
- [ ] Open the URL in a browser → `/onboard` page displays the token with copy button.
- [ ] Author runs `pnpm reporter:setup` on a clean shell, pastes URL, types email. Setup exits 0; config file written with mode 0600 (`stat -f %p data/reporter-config.json`).
- [ ] SQL: `SELECT * FROM user_machines WHERE key_id = ?` shows the new row with `secret_hash` (bcrypt prefix `$2b$`).
- [ ] SQL: `SELECT outcome, COUNT(*) FROM onboarding_redemption_log GROUP BY outcome` shows `accepted: 1`.
- [ ] SQL: `SELECT email_domain, email_hash FROM onboarding_redemption_log` — no full email visible.
- [ ] SQL: `SELECT * FROM onboarding_audit_log` shows 1 row with `action='invite-created'`, correct `actor_user_id`, `metadata` populated.
- [ ] `pnpm reporter:run` (after setup) successfully pushes a batch to `/api/ingest`. Server log shows the request authenticated by the new key_id via Bearer.

### Security validation

- [ ] Hand a redacted token (replace last 4 chars) to `pnpm reporter:setup` → exit 1, generic 401 message; no plaintext secret in any output.
- [ ] Run 11 redeem requests rapid-fire from `curl` → 11th returns 429 with `Retry-After`.
- [ ] Run 4 redeem requests with the same token from different IPs → 4th returns 429 (per-token limit).
- [ ] Inspect `onboarding_redemption_log` and response body of any 401 → full token never present.
- [ ] Bodies of all 5 token-rejection paths (TC-I-44..48) are byte-equal.
- [ ] Setup CLI with `central_url=http://...` (no `--allow-http`) → exits with TLS-required message; never sends the request.
- [ ] Setup CLI happy path: capture all stdout+stderr → byte-scan finds zero occurrences of secret/key_id.

### Concurrency validation

- [ ] Create invite with `max_uses=1`, fire 5 parallel `curl` redeems → exactly 1 succeeds (verified via `outcome` count: 1 accepted, 4 token-exhausted).
- [ ] Create invite with `max_uses=3`, fire 6 parallel redeems → exactly 3 succeed.

## Open Questions

- **Q1 — RESOLVED via N2**: Token in URL fragment (vs query param). Decision: fragment (`#token=XXX`). Server access logs / proxies never see it. Browser history is residual risk; `/onboard` page tells users to copy immediately.
- **Q2 — RESOLVED via N1**: Server Action vs API route for create/revoke. Decision: Server Actions only (CSRF built-in). API routes deleted from scope. CLI uses only `/api/onboarding/redeem-invite` and `/api/health`.
- **Q3 — RESOLVED via N9 + REQ-35**: Non-interactive mode for CI. Decision: yes, via flags (`--token`, `--email`, `--central-url`) + env vars (`TOKENFX_ONBOARD_*`) + `--non-interactive` flag that errors instead of prompting.

## Execution Log

- **2026-05-01 — Status: APPROVED → IN_PROGRESS → DONE.** Spec rewrite v2 (post-Pause-1) applied 21 fixes including 3 CRITICAL bugs caught by reviewers (DDL contradictions, `loadRoleAndOrg` query predicate, TASK-4a/4b serialization break). 14 tasks executed across 8 parallel batches via Agent worktrees. End state: 39/39 REQs implemented, ~75 unit/integration TCs + 10 fuzz + 7 E2E all green. Self-review (3 reviewers in parallel) caught 3 MUST FIX (TC-F-10 missing, TC-I-54 orphan label, TC-U-13 wrong scenario) + several SHOULD FIX (lazy boot guard → eager, root README missing reporter:setup, `--allow-http` silent → loud warning, Content-Length not asserted in TC-I-49) — all applied before Pause-2.
- **Major refactor: HMAC → Bearer + bcrypt-at-rest.** Spec absorbed the TASK-14 deviation from spec 3 (`secret_hash` plaintext) and shipped industry-standard auth: reporter sends `Authorization: Bearer <secret>`, server bcrypt-compares with 60s in-memory verification cache, cost factor 10, shared cache between `/api/ingest` and `/api/health`. `lib/reporter/signer.ts` deleted; `canonical-json.ts` extracted as standalone helper.
- **Discoveries during execution:**
  - TASK-4a + TASK-4b merged into atomic TASK-4 (split would 401 every reporter test between batches).
  - `cookies().delete()` from Server Component is forbidden in Next.js 15. Solution: Route Handler `POST /api/onboarding/clear-flash` (NOT Server Action — Server Actions trigger automatic RSC re-fetch causing the show-once URL to flicker and disappear before the user can copy it).
  - shadcn `<AlertDialog>` not installed in this app — used native `<dialog>` with `showModal()` which provides built-in focus trap + ESC + backdrop without z-index war.
  - TC-E2E-06 batch push uses raw `fetch` instead of dynamic-importing `lib/reporter/client.ts` (cross-package ESM/CJS resolution). Same wire format validated.
- **Live HTTP validation (post-build, Playwright run):** `POST /api/onboarding/redeem-invite 200`, `POST /api/ingest 200` (Bearer + bcrypt working end-to-end), `POST /api/onboarding/clear-flash 200`, `GET /onboard 200` (with and without fragment). Manager UI flow `create → flash URL → onboard page → setup CLI → reporter push` validated end-to-end.
- **Final test counts:** root vitest 956/956; apps/server vitest 278/278 (1 skipped per spec — spec-3 empty-org carryover); Playwright 11 active passing + 1 skipped.
- **Pontos de atenção registrados como follow-up:** `/api/health` rate limiter usa janela fixa (deveria reusar sliding `lib/queries/rate-limit.ts`); IP truncation duplicada em 3 routes (extrair pra `lib/util/ip.ts`); `flash-cookie.ts:getSecret()` sem boot guard independente; TC-I-71e timing assertion absoluta (flaky em CI lento). Todos LOW severity, sem bloquear ship.
