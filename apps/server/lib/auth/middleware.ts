import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import type { Role } from './auth';

/**
 * Minimal `auth()` shape `requireRole` depends on. Decoupled from NextAuth's
 * concrete `auth` export so tests can pass a hand-written stub without
 * `vi.mock`. Production callers omit the param — the default lazily imports
 * `./auth` (avoids loading NextAuth in unrelated test runs).
 */
export type AuthFn = () => Promise<Session | null>;

const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('./auth');
  return mod.auth();
};

/**
 * Gate a route handler / middleware on (a) presence of a session and (b)
 * membership of `session.user.role` in `allowed`.
 *
 * Returns:
 *  - `NextResponse.redirect('/api/auth/signin', 307)` — no session
 *    (REQ-16: unauthenticated GETs to `/manager` redirect to sign-in).
 *  - `NextResponse(403)` — authenticated but role not allowed
 *    (REQ-17: members hitting `/manager`, managers hitting `/manager/admin`).
 *  - `null` — pass through.
 *
 * `auth` is injected for testability — see `middleware.test.ts`.
 */
export const requireRole = async (
  req: NextRequest,
  allowed: ReadonlyArray<Role>,
  auth: AuthFn = lazyDefaultAuth,
): Promise<NextResponse | null> => {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL('/api/auth/signin', req.url));
  }
  const role = session.user.role;
  if (!role || !allowed.includes(role)) {
    return new NextResponse('Manager role required', { status: 403 });
  }
  return null;
};
