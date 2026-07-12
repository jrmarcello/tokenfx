# Central Server — Security Operations Guide

Audience: ops team running migrations + engineers extending the auth subsystem.

This document codifies the app-role / migration-role contract that protects the
SSO-auto-provision audit logs from tampering. It complements the threat model
in `.specs/central-server-onboarding-v2-sso.threat-model.md`.

## 1. Audit-log tamper-evidence contract

Per `.specs/central-server-onboarding-v2-sso.threat-model.md` §Compliance and
§Tamper-evidence, the following tables are **append-only at the DB role level**
(not just code-level):

- `onboarding_redemption_log`
- `onboarding_audit_log`
- `auth_event_log`

The contract:

- The **app role** (the role used by `DATABASE_URL` at runtime) has only
  `INSERT` and `SELECT` on these tables. `UPDATE` and `DELETE` are explicitly
  `REVOKE`'d by migration 0004.
- A separate **migration role** (superuser or table owner) runs DDL — including
  schema migrations and any operational data corrections that require modifying
  audit rows. Such corrections are rare; treat them as a security event,
  document them in the incident log, and require dual-authorization.

This satisfies:

- **ISO 27001 A.12.4.2** — protection of log information / tamper-evidence.
- **SOC 2 CC7.2** — forensic readiness and detection of unauthorized changes.

## 2. Migration role-name convention

Migration `0004_sso_auto_provision_schema.sql` and all future migrations that
`REVOKE` privileges on audit tables use the psql variable `:"app_role"` for the
role name (see threat model §Decisão #10).

**Migration runner contract:**

```bash
psql --variable=app_role="${TOKENFX_APP_DB_ROLE:-app_role}" \
  --file=apps/server/lib/db/migrations/0004_sso_auto_provision_schema.sql
```

Via the Drizzle migrator: the runner script (or the `pnpm db:server:migrate`
invocation) must inject `--variable=app_role=...` derived from the
`TOKENFX_APP_DB_ROLE` environment variable.

**Default values:**

- `TOKENFX_APP_DB_ROLE` unset → falls back to the literal `app_role`.
- Local dev + testcontainers: create the role explicitly so the `REVOKE`
  resolves:

  ```sql
  CREATE ROLE app_role LOGIN PASSWORD 'dev-only';
  GRANT INSERT, SELECT ON onboarding_redemption_log TO app_role;
  GRANT INSERT, SELECT ON onboarding_audit_log TO app_role;
  GRANT INSERT, SELECT ON auth_event_log TO app_role;
  ```

  Migration 0004's `REVOKE UPDATE, DELETE` then takes precedence on those
  tables; UPDATE/DELETE on non-audit tables stay available via the broader
  grants in §3.

## 3. Role provisioning checklist (ops)

When deploying to a new environment:

1. Provision the app-role:

   ```sql
   CREATE ROLE app_role LOGIN PASSWORD '<from-secret-store>';
   ```

2. Grant base privileges:

   ```sql
   GRANT CONNECT ON DATABASE <db> TO app_role;
   GRANT USAGE ON SCHEMA public TO app_role;
   GRANT INSERT, SELECT, UPDATE, DELETE
     ON ALL TABLES IN SCHEMA public TO app_role;
   ```

   These broad UPDATE/DELETE grants are intentional for non-audit tables.

3. Apply migrations as a superuser (or table owner). Pass
   `--variable=app_role=<the-role-from-step-1>` so the `REVOKE` statements in
   `0004` (and any future audit-touching migrations) target the correct role:

   ```bash
   TOKENFX_APP_DB_ROLE=app_role pnpm db:server:migrate
   ```

4. Verify post-migration. In `psql`:

   ```text
   \dp onboarding_redemption_log
   \dp onboarding_audit_log
   \dp auth_event_log
   ```

   Each must show `INSERT, SELECT` for `app_role` and **no** `UPDATE` or
   `DELETE`. If any of those appears, the variable was not injected — re-run
   step 3 with the correct value.

## 4. Forensic query examples

After a (hypothetical) SSO IdP-breach event, the on-call engineer queries
`auth_event_log` to identify affected sessions. The indexes added by migration
0004 keep these queries cheap.

```sql
-- All sign-ins from the compromised IdP after T
-- (uses idx_auth_event_log_iss_occurred)
SELECT email_hash, occurred_at, outcome
FROM auth_event_log
WHERE iss = 'https://compromised-idp.example.com'
  AND occurred_at >= '2026-05-01T00:00:00Z'
ORDER BY occurred_at;
```

```sql
-- All events for a specific user
-- (uses idx_auth_event_log_subject_occurred)
SELECT iss, ip, city, occurred_at, outcome
FROM auth_event_log
WHERE sso_subject_hash = '<hash>'
ORDER BY occurred_at DESC;
```

Couple these with `user_machines.revoked_at` to bulk-invalidate sessions of
affected users:

```sql
UPDATE user_machines
SET revoked_at = NOW()
WHERE user_id IN (
  SELECT DISTINCT user_id
  FROM auth_event_log
  WHERE iss = 'https://compromised-idp.example.com'
    AND occurred_at >= '2026-05-01T00:00:00Z'
    AND outcome = 'success'
);
```

(The `UPDATE` above runs against `user_machines`, **not** an audit table — the
app role retains `UPDATE` on operational tables.)

## 5. Threat-model references

See `.specs/central-server-onboarding-v2-sso.threat-model.md`:

- §Compliance §Tamper-evidence
- §Threat 4 (IdP-breach forensics)
- §Decisão #10 (REVOKE role-name strategy)

## 6. Live SSO E2E coverage (idp-stub)

The former `test.describe.skip` placeholder
(`apps/server/tests/e2e/sso-auto-provision.spec.ts`) has been **deleted**.
Its two deferred cases are now covered by **live** Playwright e2e tests
driving a real OIDC round-trip against a local IdP stub:

- **IdP stub** — `apps/idp-stub/` is an Okta-compatible OIDC server
  (Hono + jose, RS256 `id_token`s NextAuth's verifier accepts). Spec:
  `.specs/oauth-idp-stub.md`. Wiring is env-driven only
  (`OKTA_ISSUER=http://localhost:3001`, `OKTA_CLIENT_ID`,
  `OKTA_CLIENT_SECRET`, `TOKENFX_SSO_ISSUERS_OKTA`) — no
  `auth.config.ts` changes. Scenario claims are set per-test via
  `POST /admin/scenario`.

- **TC-E2E-01 / REQ-13** — full SSO sign-in (signin → IdP → callback →
  session → gated page) with auto-provisioned `users` row. Live in
  `tests/e2e/sso-flow.spec.ts`. Because the flow goes through the real
  `signIn` callback, it exercises the auto-provision orchestrator
  (`lib/auth/sso-auto-provision.ts`) and the audit-log writers — unlike
  the `e2e-bypass-provider`, which remains unsuitable for this purpose.

- **TC-E2E-02 / REQ-16** — cross-origin signin initiation rejected with
  HTTP 403. Live in `tests/e2e/sso-flow.spec.ts`.

Integration coverage (TC-I-01..15, TC-I-22..30, TC-I-44 in
`tests/integration/sso-auto-provision-flow.test.ts` and
`tests/integration/sso-auto-provision-csrf.test.ts`) remains in place as
the fast-feedback layer for the same paths.

**How the stub runs:**

- **Local** — `tests/e2e/global-setup.ts` spawns `@tokenfx/idp-stub`
  before the dev server and exports the `OKTA_*` env vars; stub stdio is
  captured (with redaction) to `tests/e2e/.logs/idp-stub.log`.
- **Docker smoke profile** — the root `docker-compose.yaml` `smoke`
  profile runs a `tokenfx-idp-stub` service (port bound to
  `127.0.0.1:3001`); the server container depends on its healthcheck and
  points `OKTA_ISSUER` at it. The stub's `checkBootEnv` refuses
  `NODE_ENV=production` at boot, so it cannot ship in a real deployment.

Related specs: `.specs/oauth-idp-stub.md` (stub + TC-E2E-01/02 closure),
`.specs/sso-e2e-live-execution.md` (remaining manager-ui e2e promoted to
live), `.specs/sso-replay-audit-row.md` (replay audit-row e2e).

## 7. Manager UI privacy + safety invariants (spec c)

Addendum tied to the manager-dashboard work in
`.specs/central-server-onboarding-v2-sso.manager-ui.md`. Backlinks: threat
model commit `3b05b89`, spec (a) commit `cee4dcc`, spec (b) commit `8466fac`.

### 7.1 Audit-log view privacy

The `/manager/audit` view and its CSV export render **only**
`email_hash_prefix` (first 8 chars of `email_hash`). Plaintext email is
**never** surfaced to managers — not in the table, not in the row-detail
drawer, not in the CSV. The full hash and any PII stay server-side.

### 7.2 Roster CSV privacy

The roster export (`/manager/users.csv`) ships exactly four columns:
`email_hash_prefix`, `provisioned_via`, `created_at`, `last_login_at`.
**No plaintext email. No raw IP.** Adding columns requires a privacy
review + spec amendment.

### 7.3 Banner forensic trail

Per Decisão #15: per-event acks preserve "when did each admin see which
event". No bulk-dismiss endpoint. Re-acking an already-acked event is a
no-op — `acked_at` is **never** refreshed (preserves first-ack
forensic timestamp).

### 7.4 CSV formula-injection guard

All CSV exports run cells through the OWASP-aligned escaper: any cell
starting with `=`, `+`, `-`, `@`, `\t`, or `\r` is prefixed with a single
apostrophe (`'`). See
<https://owasp.org/www-community/attacks/CSV_Injection>. The guard lives
in `lib/csv/escape.ts` and is exercised by every CSV route's tests.

### 7.5 CSV row cap

Every CSV route caps output at **10,000 rows**. When the underlying query
yields more, the response sets `X-TokenFx-Truncated: true` and stops
emitting. Streaming is via Drizzle async iteration (bounded memory — no
full result-set buffering).

### 7.6 SMTP send safety

The nodemailer transport sets explicit timeouts: `connectionTimeout=5s`,
`greetingTimeout=5s`, `socketTimeout=10s`. Worst-case stalled SMTP server
returns `transient` in under 15 seconds. The auth flow **never** blocks
on email delivery — invite emails are dispatched fire-and-forget after
the signIn callback returns (per REQ-22/23 from spec b).

### 7.7 SMTP fallback contract

If `SMTP_HOST` is unset, the dispatcher silently falls back to a
console-log stub. This is a **dev/local-only** invariant. Production
deployments **must** set the full 5-tuple:
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`.
Missing `SMTP_FROM` when `SMTP_HOST` **is** set fails fast at module
init (no silent degradation).

### 7.8 AsyncLocalStorage scope

`getRequestContext()` (defined in `lib/auth/request-context.ts`) is
populated **only** inside the NextAuth route handler. Calling it from
Server Components or `lib/queries/*` reads empty defaults silently —
those callsites run outside the ALS scope.

Documented callers (the only legitimate ones):

- `lib/auth/auth.ts` — the `signIn` callback
- `lib/auth/auth-event-log-writer.ts`
- `lib/auth/sso-auto-provision.ts`

Any new caller outside the NextAuth handler path is a bug.

### 7.9 Rate-limit per-IP bucket invariant

After spec (c) removed the empty-IP guard, an empty `ip` keys into bucket
`''`. This bucket is **isolated** from `per-email_hash` and
`per-sso_subject` dimensions (verified by TC-I-34b). Empty-IP collapse
is an acceptable artifact for legitimate request paths where the source
IP truly is unknown — collisions only affect the IP dimension, never
the email or subject dimensions.

### 7.10 MaxMind opt-in

GeoIP enrichment is opt-in via `MAXMIND_DB_PATH`. When unset,
`ipToCity()` returns null and the audit log's `city` column stays null
(graceful degradation — no failures).

Production ops downloads `GeoLite2-City.mmdb` from MaxMind (free,
account required). The test fixture is a synthetic file generated by
`mmdbwriter` (checked into the repo for CI determinism — avoids the
MaxMind license requirement at test time).
