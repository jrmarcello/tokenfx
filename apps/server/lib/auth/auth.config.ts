import { NextResponse } from 'next/server';
import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Okta from 'next-auth/providers/okta';
import { isRole } from './roles';

/**
 * Edge-safe NextAuth config — split per Auth.js v5 conventions so the
 * Next.js middleware (which runs in Edge runtime) does NOT pull `pg`
 * (which depends on Node's `crypto` module that Edge forbids).
 *
 * Rules for this file:
 *
 *   1. NO imports from `@/lib/db/*` or anything that transitively pulls
 *      `pg` / `drizzle-orm/node-postgres` / `bcrypt` / `node:crypto`.
 *   2. Providers + signIn page + Edge-safe `authorized()` callback ONLY.
 *      DB-backed callbacks (`signIn`, `session`, `jwt with DB lookup`)
 *      live in `./auth.ts` (Node-only).
 *   3. The middleware uses this config directly to gate `/manager/*`.
 *      The full app uses the merged config from `./auth.ts`.
 *
 * REQ-16 + REQ-17 pre-conditions are encoded in `authorized()`. Role +
 * orgId are persisted on the JWT by `auth.ts:jwt()` so this callback can
 * read them without a DB hit (Edge-safe).
 */
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Okta({
      clientId: process.env.OKTA_CLIENT_ID,
      clientSecret: process.env.OKTA_CLIENT_SECRET,
      issuer: process.env.OKTA_ISSUER,
    }),
  ],
  pages: {
    signIn: '/api/auth/signin',
  },
  callbacks: {
    // Edge-safe mirror of token → session.user for role + orgId. Required
    // because NextAuth's default token→session mapping copies only the
    // standard claims (name/email/image/sub); our custom `role` and `orgId`
    // would otherwise vanish before `authorized()` reads them. This callback
    // is intentionally a pure projection — NO DB hits, NO `pg` imports —
    // so it remains Edge-safe. The Node-runtime `auth.ts` re-exports its
    // own session callback that does the same mirroring (with the JWT
    // pre-augmented by its `jwt()` callback's DB lookup).
    session({ session, token }) {
      if (session.user) {
        if (typeof token.userId === 'string') {
          session.user.id = token.userId;
        }
        if (isRole(token.role)) {
          session.user.role = token.role;
        }
        if (typeof token.orgId === 'string') {
          session.user.orgId = token.orgId;
        }
      }
      return session;
    },
    // Edge-safe gate — middleware calls this for every request. Reads role
    // from `auth.user` (populated by the `session` callback above from the
    // JWT, which `auth.ts:jwt()` keeps fresh against the DB on every Node
    // request).
    authorized({ request, auth }) {
      const path = request.nextUrl.pathname;

      // manager-dashboard-v2 (REQ-17): `/me/*` is for any authenticated user
      // (member/manager/admin) — no role gate. They only see their own data.
      if (path.startsWith('/me')) {
        return !!auth?.user;
      }

      if (!path.startsWith('/manager')) return true;

      if (!auth?.user) return false; // → redirect to signIn

      const role = auth.user.role;

      if (path.startsWith('/manager/admin') && role !== 'admin') {
        return new NextResponse('Admin role required', { status: 403 });
      }
      if (role !== 'manager' && role !== 'admin') {
        return new NextResponse('Manager role required', { status: 403 });
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
