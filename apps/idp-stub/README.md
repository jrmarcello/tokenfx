# @tokenfx/idp-stub

Local OIDC IdP stub emulating an Okta-compatible OAuth server. Used by
the `apps/server` test suite to unblock 7 deferred SSO E2E + integration
TCs that require a real OIDC provider in the loop (see
`.specs/oauth-idp-stub.md` Context for the full origin story).

**Not for production use.** Localhost-only, no rate limiting, no
authentication on the admin endpoints.

## Run

```bash
# From repo root
pnpm idp-stub

# Or directly
pnpm --filter @tokenfx/idp-stub start
```

Env vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `IDP_STUB_PORT` | `3001` | Port to bind |
| `IDP_STUB_BASE_URL` | `http://localhost:${IDP_STUB_PORT}` | Public base URL — used to compose discovery doc URLs and the `iss` claim. **NextAuth's verifier requires `iss === discovery.issuer`**, so this must match what NextAuth fetches. |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/openid-configuration` | OIDC discovery doc |
| GET | `/jwks` | Public JWKS (RS256) |
| GET | `/authorize` | OAuth authorize endpoint — 302 redirects to `redirect_uri` with `code` + `state` |
| POST | `/token` | Token exchange — returns RS256-signed `id_token` (claims from current scenario) |
| POST | `/admin/scenario` | Merge a partial scenario override into the active scenario (JSON body) |
| POST | `/admin/scenario/reset` | Reset active scenario to documented defaults |

## Scenario control

The active scenario is process-lifetime in-memory state controlling the
claims of the next `/token` response. JSON body for `/admin/scenario`
matches `ScenarioOverrideSchema`:

```ts
{
  email?: string;            // valid email, 1-254 chars
  email_verified?: boolean;
  sub?: string;              // 1-255 chars
  aud?: string;              // 1-255 chars
  exp?: number;              // positive int (seconds since epoch)
  iat?: number;              // positive int
  jti?: string;              // 1-255 chars
  nonce?: string;            // 1-255 chars
  forceIssOverride?: string; // override the iss claim — for cross-IdP rejection tests
}
```

`/admin/scenario` is **merge-only** (last-write-wins per field).
`/admin/scenario/reset` reverts to defaults — POSTing `{}` to
`/admin/scenario` is a no-op merge, NOT a reset.

## NextAuth integration (for tests)

Point NextAuth's Okta provider at the stub:

```bash
OKTA_ISSUER=http://localhost:3001
OKTA_CLIENT_ID=test-client
OKTA_CLIENT_SECRET=test-secret
TOKENFX_SSO_ISSUERS_OKTA=http://localhost:3001
```

The `apps/server/lib/auth/auth.config.ts` Okta provider reads these
envs unchanged — no code change needed.

## Security notes

- The stub does NOT validate the `code` returned from `/authorize` —
  any string is accepted at `/token`. This is intentional (it's a
  stub, not an enforcement layer).
- `redirect_uri` is allow-listed: must start with `IDP_STUB_BASE_URL`
  OR `http://localhost` OR `http://127.0.0.1`. Off-host and
  `javascript:` URIs are rejected with 400. This is defense-in-depth
  to prevent the stub from being accidentally exploited as an
  open-redirect tool during local development.
- The stub logs at `console.warn` / `console.error` only. No PII is
  echoed back in error responses — only generic `{error:{message}}`
  shapes.
- JWKS is public-only: TC-U-02 enforces that `Object.keys(publicJwk)`
  excludes `['d','p','q','dp','dq','qi']`.

## Test the stub

```bash
pnpm --filter @tokenfx/idp-stub test --run
pnpm --filter @tokenfx/idp-stub typecheck
```
