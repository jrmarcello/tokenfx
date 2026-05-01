import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth/auth.config';

/**
 * Next.js root middleware — gates `/manager/*`.
 *
 * REQ-16 + REQ-17: gating logic lives in `auth.config.ts:authorized()`
 * (Edge-safe — reads role/orgId from JWT, NOT from the DB). The DB-backed
 * jwt callback in `auth.ts` keeps the JWT fresh; this middleware then
 * runs in Next.js Edge runtime without pulling `pg`/`bcrypt`/`node:crypto`.
 *
 * Auth.js v5 split per their docs: middleware uses ONLY the Edge-safe
 * `authConfig`. The full `auth()` (with DB callbacks) is exported from
 * `lib/auth/auth.ts` for Server Components and Route Handlers.
 */
export const { auth: middleware } = NextAuth(authConfig);

export default middleware;

export const config = {
  matcher: ['/manager/:path*'],
};
