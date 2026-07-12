import NextAuth from 'next-auth';
import type { NextRequest } from 'next/server';
import { authConfig } from '@/lib/auth/auth.config';
import { buildRootMiddleware } from '@/lib/auth/localhost-guard';

/**
 * Next.js root middleware — gates `/manager/*`, `/me/*`, and `/api/manager/*`.
 *
 * Two modes:
 *
 *   1. AUTH_REQUIRED=false (localhost-only open-access mode for the
 *      initial release). The middleware enforces a Host-header allow-list
 *      (`localhost` / `127.0.0.1` / `[::1]`, with or without port). Non-
 *      localhost hosts get 403 `localhost-only`. Localhost hosts pass
 *      through to the route with no auth check (open access). See
 *      `.specs/auth-optional-mode-and-sso-bugfixes.md` (REQ-2 + REQ-3)
 *      for the threat model — request-time Host check is the actual
 *      enforcement mechanism of the "localhost-only" promise; relying on
 *      `process.env.HOSTNAME` is insufficient because Next.js standalone
 *      hardcodes it and operators can pass `--hostname 0.0.0.0` without
 *      changing it.
 *
 *   2. AUTH_REQUIRED=true (or unset — fail-safe default). The full
 *      NextAuth middleware runs, gating via `authConfig.authorized()`.
 *      DB callbacks live in `auth.ts` (Node-only) — middleware uses
 *      ONLY the Edge-safe `authConfig` per Auth.js v5 docs.
 *
 * `X-Forwarded-Host` is NOT honored — only the raw `Host` header is
 * checked. Documented in CLAUDE.md as: never put apps/server behind a
 * public reverse proxy with AUTH_REQUIRED=false.
 *
 * The dispatch + localhost host-gate themselves live in the Edge-safe,
 * unit-testable `lib/auth/localhost-guard.ts` (security-hardening-lowsev
 * REQ-3). They are NOT inlined here because importing THIS file into a
 * Vitest suite pulls next-auth's main entry (via the `NextAuth` import
 * above), which the ESM loader cannot resolve.
 */

const ssoMiddleware = NextAuth(authConfig).auth;

// `buildRootMiddleware` takes the NextAuth `auth` handler as a DI seam so the
// AUTH_REQUIRED dispatch stays testable without the NextAuth runtime. The
// `as` cast bridges the overloaded NextAuth `auth` signature; the call site
// only invokes the `(req, ctx?) => response` form.
const middleware = buildRootMiddleware(
  ssoMiddleware as (req: NextRequest, ...rest: readonly unknown[]) => unknown,
) as typeof ssoMiddleware;

export { middleware };

export default middleware;

export const config = {
  // manager-dashboard-v2 (REQ-17): `/me/visibility` is gated to authenticated
  // users (any role) so devs can see what their manager sees about them and
  // the chronological drilldown audit log.
  //
  // security-hardening-lowsev (REQ-3): `/api/manager/:path*` added so the
  // JSON API routes are routed through the gate. The matcher alone is a
  // no-op — the matching `/api/manager` branch in `authConfig.authorized()`
  // is what returns 401/403 JSON for them.
  matcher: ['/manager/:path*', '/me/:path*', '/api/manager/:path*'],
};
