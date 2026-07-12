# Production deploy guide — central reporter server

One page to stand up `apps/server` in production. This is the multi-tenant
manager dashboard + reporter ingestion server (NOT the single-user local
dashboard at the repo root). Localhost open-access mode (`AUTH_REQUIRED=false`)
is **dev/single-machine only** — production runs full SSO.

## 0. Prerequisites

- **Postgres 16** (the app uses `left()`, `json_each`-style JSONB ops, partial
  indexes, and `ALTER TYPE ADD VALUE` migrations).
- An SSO IdP (Okta or Google) with an OAuth client for this app.
- SMTP relay for onboarding/notification email.
- TLS termination in front of the app (reverse proxy or platform). The
  reporter push and SSO both assume HTTPS.

## 1. Required environment (boot fails fast if missing)

| Var | Purpose | Notes |
| --- | --- | --- |
| `NODE_ENV=production` | Enables the production boot guards | Docker image defaults to this |
| `DATABASE_URL` | Postgres connection string | Use the **app-role** (§3), not a superuser |
| `AUTH_SECRET` (or `NEXTAUTH_SECRET`) | JWT signing secret | Boot **refuses** without it in production (`lib/auth/auth.ts`) — no transient-secret fallback |
| `ONBOARDING_EMAIL_HASH_PEPPER` | Peppers `sha256(email)` in audit/redemption logs | Boot **refuses** without it in production (`lib/auth/email-hash.ts`). Store in a secret manager; rotating it invalidates historical hash-to-email correlation |
| `INTERNAL_CRON_SECRET` | Auth for `/api/internal/cron/*` | Required in production/staging (`lib/cron/auth.ts`); constant-time compared |
| `NEXTAUTH_URL` | Canonical external URL | Must match the TLS hostname |
| SSO client vars | `TOKENFX_NEXTAUTH_CLIENT_ID` + provider secret | See your NextAuth provider config |
| `TOKENFX_SSO_ISSUERS_OKTA` | Comma-separated allowed Okta issuers | Empty = no Okta issuers accepted |

**SMTP (required together — `lib/email/send-email.ts`, SECURITY.md §7.7):** if
`SMTP_HOST` is set you MUST also set `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM`. **There is no fail-fast** — a missing/invalid field does NOT crash
boot; the dispatcher logs a `config-error` warning and every `sendEmail`
returns `{ok:false, reason:'config-error'}` (mail silently not delivered). If
`SMTP_HOST` is **unset** it falls back to a console-log stub. Both silent modes
are unacceptable in production, so set the full 5-tuple and confirm real
delivery via the §7 smoke step (there's no boot error to rely on).

**Do NOT set in production:** `AUTH_REQUIRED=false`, `E2E_AUTH_BYPASS`,
`TOKENFX_AUTH_BYPASS_ALLOWED`, `ALLOW_PRODUCTION_SEED`.

**Reverse-proxy note:** the `AUTH_REQUIRED=false` Host guard reads only the raw
`Host` header (never `X-Forwarded-Host`). This is why localhost mode must not
sit behind a public proxy — but in production you run full SSO, so this is moot.

## 2. Database migrations

Run migrations as a **superuser or table owner** (not the runtime role). The
runtime role **must be named `app_runtime`** — migration `0004`'s `REVOKE`
statements are a **hardcoded literal** (`FROM app_runtime`,
`migrations/0004_*.sql:298-300`), not parameterized. `migrate.ts` then runs a
self-heal + invariant step keyed on `TOKENFX_APP_RUNTIME_ROLE` (default
`app_runtime`) and **fails the migration** if the REVOKE didn't land. With the
default role name, no env var is needed:

```bash
pnpm db:server:migrate                              # from repo root (role = app_runtime)
```

For a **non-default role name** you must BOTH edit the literal `app_runtime` in
`0004_sso_auto_provision_schema.sql` AND set `TOKENFX_APP_RUNTIME_ROLE=<role>`
so the migrate.ts step matches. Using `app_runtime` avoids this — recommended.

> Full role-hardening details: `SECURITY.md §2-3`. The runtime role is
> `app_runtime`; the env var is `TOKENFX_APP_RUNTIME_ROLE` (`lib/db/migrate.ts:22-31`,
> `migrations/0004_*.sql:297-302`).

Migrations are forward-only and idempotent where they seed (e.g. the local-org
row, enum `ADD VALUE`s). Re-running is safe.

## 3. Postgres app-role (least privilege)

The runtime `DATABASE_URL` must use a restricted role so a compromised app
cannot rewrite the tamper-evident audit tables. Full checklist in
`SECURITY.md §3`; summary:

```sql
CREATE ROLE app_runtime LOGIN PASSWORD '<from-secret-store>';
GRANT CONNECT ON DATABASE <db> TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT INSERT, SELECT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
```

The migration then REVOKEs `UPDATE`/`DELETE` on the append-only logs
(`onboarding_redemption_log`, `onboarding_audit_log`, `auth_event_log`) from
`app_runtime`. **Verify** post-migration in `psql`: `\dp onboarding_audit_log`
must show only `INSERT, SELECT` for `app_runtime` — no `UPDATE`/`DELETE`. If
they appear, the role wasn't named `app_runtime` (or `TOKENFX_APP_RUNTIME_ROLE`
didn't match); recreate the role with the right name and re-run §2 — the
migration's own assertion should also have failed loudly.

## 4. Build & run

```bash
pnpm install
pnpm build            # (apps/server) next build → .next/standalone
pnpm start            # next start -p 3232
```

Or the standalone Docker image (`apps/server/Dockerfile`, `output: 'standalone'`,
bcrypt rebuilt for the runtime arch). Put it behind your TLS proxy; the app
listens on `PORT` (default 3232).

## 5. Scheduled crons (all POST, `x-internal-cron-secret`)

Schedule these daily via your platform scheduler:

- `POST /api/internal/cron/cleanup-audit-ips` — truncates drilldown-audit IPs
  at 30 days and prunes `manager_notifications` at 90 days.
- `POST /api/internal/cron/retention-prune` — deletes time-series rows older
  than `RETENTION_MONTHS` (default 24, floor 12). See the README "Data
  retention & offboarding" section.
- `POST /api/internal/cron/aggregate-team-metrics`,
  `.../aggregate-team-outcomes`, `.../detect-anomalies` — dashboard rollups.

```bash
curl -fsS -X POST https://<host>/api/internal/cron/retention-prune \
  -H "x-internal-cron-secret: $INTERNAL_CRON_SECRET"
```

## 6. First-run

The first user to sign in for an org is auto-promoted to `admin`. Admins manage
roles, machine revocation, and offboarding under `/manager/admin/*`. Onboard
devs by issuing invites at `/manager/invites` (see the "Onboarding flow" README
section).

## 7. Post-deploy smoke checklist

- [ ] `GET /` returns 200 over HTTPS; SSO sign-in redirects to the IdP.
- [ ] `\dp onboarding_audit_log` shows `INSERT, SELECT` only for `app_runtime`
      (no `UPDATE`/`DELETE`) — the audit tables are tamper-evident.
- [ ] A cron POST with the wrong secret returns 401; with the right one, 200.
- [ ] SMTP: trigger one invite email and confirm delivery (not a console stub).
- [ ] `AUTH_REQUIRED` is unset (or `true`) — `/manager` requires SSO login.
