import { NextResponse, type NextRequest } from 'next/server';
import { isAuthRequired, isLocalhostHost } from './auth-required';

/**
 * Localhost-only open-access guard + root-middleware dispatcher.
 *
 * Extracted from `middleware.ts` so both are unit-testable WITHOUT importing
 * the root middleware — which eagerly constructs `NextAuth(authConfig).auth`,
 * pulling `next-auth`'s main entry (`lib/env.js` → the extensionless
 * `import 'next/server'`) that Vitest's ESM resolver cannot load (the same
 * reason `lib/auth/middleware.ts` lazy-imports `./auth`). This module is
 * Edge-safe: it imports only `next/server` + `auth-required`, never
 * `next-auth` or `pg`. Mirrors the `auth.config.ts` split pattern.
 */

/**
 * AUTH_REQUIRED=false mode: reject any non-loopback `Host` with 403, else
 * pass the request through untouched (open access on localhost). Only the
 * raw `Host` header is honored — `X-Forwarded-Host` is NOT (reverse-proxy
 * threat model documented in `middleware.ts`).
 */
export const localhostMiddleware = (request: NextRequest): NextResponse => {
  const host = request.headers.get('host');
  if (!isLocalhostHost(host)) {
    // `{error:{message,code}}` per .claude/rules/security.md (was a bare
    // `{error:'forbidden',code:...}` string, off-shape).
    return NextResponse.json(
      { error: { message: 'forbidden', code: 'localhost-only' } },
      { status: 403 },
    );
  }
  return NextResponse.next();
};

/**
 * The delegate the root middleware hands off to for the SSO path — NextAuth's
 * `auth` handler. Injected into `buildRootMiddleware` (DI seam, mirroring
 * `lib/auth/middleware.ts`'s `AuthFn`) so the AUTH_REQUIRED dispatch is
 * testable without the NextAuth runtime.
 */
export type SsoHandler = (
  request: NextRequest,
  ...rest: readonly unknown[]
) => unknown;

/**
 * Builds the root middleware: the localhost host-gate when
 * `AUTH_REQUIRED=false`, otherwise delegate to the injected NextAuth SSO
 * handler. `process.env` is read per-request (not captured at build time) so
 * the mode reflects the current environment.
 */
export const buildRootMiddleware =
  (ssoHandler: SsoHandler) =>
  (request: NextRequest, ...rest: readonly unknown[]): unknown => {
    if (!isAuthRequired(process.env)) {
      return localhostMiddleware(request);
    }
    return ssoHandler(request, ...rest);
  };
