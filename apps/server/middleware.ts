import NextAuth from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { authConfig } from '@/lib/auth/auth.config';
import { isAuthRequired, isLocalhostHost } from '@/lib/auth/auth-required';

/**
 * Next.js root middleware — gates `/manager/*` and `/me/*`.
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
 */

const ssoMiddleware = NextAuth(authConfig).auth;

const localhostMiddleware = (request: NextRequest): NextResponse => {
  const host = request.headers.get('host');
  if (!isLocalhostHost(host)) {
    return NextResponse.json(
      { error: 'forbidden', code: 'localhost-only' },
      { status: 403 },
    );
  }
  return NextResponse.next();
};

const middleware = ((request: NextRequest, ...rest: unknown[]) => {
  if (!isAuthRequired(process.env)) {
    return localhostMiddleware(request);
  }
  // Delegate to NextAuth's middleware for the SSO path. The `as never`
  // cast bridges the overloaded NextAuth `auth` signature; the call site
  // here only invokes the `(req, ctx?) => response` form.
  return (ssoMiddleware as (req: NextRequest, ...r: unknown[]) => unknown)(
    request,
    ...rest,
  );
}) as typeof ssoMiddleware;

export { middleware };

export default middleware;

export const config = {
  // manager-dashboard-v2 (REQ-17): `/me/visibility` is gated to authenticated
  // users (any role) so devs can see what their manager sees about them and
  // the chronological drilldown audit log.
  matcher: ['/manager/:path*', '/me/:path*'],
};
