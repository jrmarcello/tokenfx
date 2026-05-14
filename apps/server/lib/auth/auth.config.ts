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
      // sso-nonce-replay REQ-1: Auth.js v5's Okta provider defaults to
      // `checks: ['pkce', 'state']` (verified at
      // `@auth/core@0.37.2/src/providers/okta.ts:108`). Adding `'nonce'`
      // enables the nonce-cookie validation path so tampered id_tokens
      // are rejected with `InvalidCheck`. The existing
      // `auth.ts:logger.error` hook (commit 1961b61) already writes the
      // `'rejected-replay'` audit row for any InvalidCheck regardless
      // of kind — no orchestrator changes needed.
      checks: ['pkce', 'state', 'nonce'],
    }),
  ],
  pages: {
    signIn: '/api/auth/signin',
    // sso-replay-audit-row spec REQ-3: NextAuth redirects browsers here
    // on OAuth callback failures (incl. state-replay). The page itself is
    // pure presentational UI — the `auth_event_log` row for replay attempts
    // is written by the `logger.error` hook in `auth.ts` (precise typed-
    // class detection on `InvalidCheck`), not by sniffing `?error=` here.
    error: '/auth/error',
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
    /**
     * REQ-17 (central-server-onboarding-v2-sso): `callbackUrl` allowlist.
     *
     * NextAuth's default `redirect` callback already strips `callbackUrl`
     * values that point off-origin, but the contract is intentionally
     * defensive here — same-origin absolute URLs and relative paths are
     * preserved; anything else collapses to `baseUrl`. This blocks open-
     * redirect chains via crafted `?callbackUrl=https://attacker.example`.
     *
     * Edge-safe: pure string ops, no DB hits.
     */
    redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      return baseUrl;
    },
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
