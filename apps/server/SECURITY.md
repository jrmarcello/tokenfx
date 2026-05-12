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

## 6. Deferred E2E coverage

The Playwright spec `apps/server/tests/e2e/sso-auto-provision.spec.ts` is
shipped as a `test.describe.skip` placeholder with a module-level
`console.warn`. Two cases are deferred:

- **TC-E2E-01 / REQ-13** — full Google SSO sign-in completing the OAuth
  round-trip and provisioning a `users` row. Blocked on the absence of a
  stubbed Google OAuth IdP in the Playwright harness. The
  `e2e-bypass-provider` (see `lib/auth/e2e-bypass-provider.ts`) is **not**
  a valid substitute because it bypasses the `signIn` callback entirely
  and therefore exercises neither the auto-provision orchestrator
  (`lib/auth/sso-auto-provision.ts`) nor the audit-log writers.
  **Compensating coverage:** TC-I-01..15 + TC-I-22..27
  (`tests/integration/sso-auto-provision-flow.test.ts`) drive the same
  signIn callback with a synthetic OAuth profile.

- **TC-E2E-02 / REQ-16** — cross-origin POST to `/api/auth/signin`
  returning HTTP 403 + writing a `rejected-csrf` audit row. Tractable
  with the existing `global-setup.ts` (which already binds the dev
  server to `127.0.0.1`) — only blocked on REQ-16 wiring (TASK-9 +
  TASK-11). **Compensating coverage:** TC-I-28..30 + TC-I-44
  (`tests/integration/sso-auto-provision-csrf.test.ts`) exercise the
  same Origin/Referer guard at the integration layer.

**Re-enablement criteria:**

- TC-E2E-02 unlocks the moment the `csrf-origin-guard.ts` helper +
  `apps/server/middleware.ts` matcher extension merge. Flip the
  `describe.skip` to `describe`, replace the `expect.fail(...)` with the
  inline `request.post(...)` block already sketched in the test
  comments, and drop the module-level `console.warn`.
- TC-E2E-01 unlocks once a fake-Google OAuth harness is added (likely a
  separate spike under `tests/e2e/helpers/` that intercepts
  `accounts.google.com` + token-exchange URLs via Playwright route
  handlers). Until then, the integration-test layer carries the load.
