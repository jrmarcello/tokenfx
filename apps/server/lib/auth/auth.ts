import NextAuth from 'next-auth';
// Side-effect import anchors the `next-auth/jwt` module in the resolution
// graph so the `declare module 'next-auth/jwt'` augmentation below resolves.
import 'next-auth/jwt';
import { and, eq } from 'drizzle-orm';
import { authConfig } from './auth.config';
import { getDb } from '@/lib/db/client';
import { orgs, users } from '@/lib/db/schema';
import { log as logger } from '@root/logger';

// Fail-fast on missing auth secret in production. Auth.js v5 falls back to a
// transient generated secret in dev (with only a console.warn); in production
// that fallback would let any attacker mint a session JWT — we'd rather refuse
// to boot. Test runs (NODE_ENV=test, SKIP_PG_TESTS=1, Playwright) are exempt
// because globalSetup injects a deterministic secret at spawn time.
if (
  process.env.NODE_ENV === 'production' &&
  !process.env.AUTH_SECRET &&
  !process.env.NEXTAUTH_SECRET
) {
  throw new Error(
    'AUTH_SECRET (or NEXTAUTH_SECRET) is required in production. Refusing to boot to avoid signing JWTs with a transient secret.',
  );
}

/**
 * Role typing + narrowing has moved to `./roles.ts` so the Edge-safe
 * `auth.config.ts` can share the same `isRole` check without pulling
 * this module's `pg`/Drizzle imports. Re-exported here for backward
 * compatibility with prior imports from this file.
 */
export type { Role } from './roles';
import type { Role } from './roles';
import { isRole } from './roles';

/**
 * Look up the user's role + orgId from the DB by email + sso_provider.
 * Used by the JWT callback to persist these fields onto the token so the
 * Edge-safe middleware can read them without a DB hit (Edge-safe).
 *
 * Returns `null` when the user has no row yet (race between signIn and jwt
 * callbacks, or DB hiccup) — JWT keeps any pre-existing values.
 */
const loadRoleAndOrg = async (
  email: string,
  ssoProvider: string,
): Promise<{ role: Role; orgId: string } | null> => {
  const db = getDb();
  const [row] = await db
    .select({ role: users.role, orgId: users.orgId })
    .from(users)
    .where(and(eq(users.email, email), eq(users.ssoProvider, ssoProvider)))
    .limit(1);
  if (!row) return null;
  if (!isRole(row.role)) return null;
  return { role: row.role, orgId: row.orgId };
};

/**
 * Full NextAuth instance — extends the Edge-safe `authConfig` with
 * DB-backed callbacks (Drizzle/`pg` only run here, never on Edge).
 *
 * - `signIn`: REQ-16 — upsert into `users` on first sign-in.
 * - `jwt`: persist `role` + `orgId` on the JWT so middleware reads them
 *   from the token (no DB hit on hot path). DB lookup runs on initial
 *   sign-in AND on subsequent visits when role might have changed.
 * - `session`: re-attach role/orgId to `session.user` for Server Components
 *   that read `auth()` directly (e.g. `app/manager/layout.tsx`).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    /**
     * REQ-16: on first sign-in, upsert into `users` keyed on (email,
     * sso_provider). Default role = 'member'.
     *
     * Org provisioning is intentionally deferred to
     * `central-server-onboarding.md`. For v0, this callback only inserts when
     * a single org exists (single-tenant bootstrap) — otherwise the sign-in
     * is rejected and the user lands on the NextAuth error page. Production
     * deployments must seed an org row via `apps/server/scripts/seed-server.ts`
     * before any user signs in.
     */
    async signIn({ user, account }) {
      if (!user?.email || !account?.provider) {
        logger.warn('signIn rejected: missing email or provider', {
          provider: account?.provider ?? null,
          hasEmail: !!user?.email,
        });
        return false;
      }
      if (!account.providerAccountId) {
        logger.warn('signIn rejected: missing providerAccountId', {
          provider: account.provider,
        });
        return false;
      }

      const db = getDb();
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, user.email), eq(users.ssoProvider, account.provider)))
        .limit(1);

      if (existing.length > 0) {
        return true;
      }

      // No row yet — bootstrap insert. Pick the org iff exactly one exists;
      // otherwise refuse (multi-tenant onboarding belongs to the carved-out
      // spec). See central-server-onboarding.md.
      const allOrgs = await db.select({ id: orgs.id }).from(orgs).limit(2);
      if (allOrgs.length !== 1) {
        // Operator visibility: a misconfigured deployment (0 orgs not yet
        // seeded, or >1 orgs without onboarding wired up) blocks every
        // sign-in attempt with NextAuth's generic error page. Log so it's
        // diagnosable. Email is hashed-out; we record the domain only.
        const domain = user.email.split('@')[1] ?? 'unknown';
        logger.warn('signIn rejected: org count not 1 (single-tenant bootstrap)', {
          provider: account.provider,
          orgCount: allOrgs.length,
          emailDomain: domain,
        });
        return false;
      }

      await db.insert(users).values({
        orgId: allOrgs[0].id,
        email: user.email,
        ssoProvider: account.provider,
        ssoSubject: account.providerAccountId,
        role: 'member',
      });

      return true;
    },
    /**
     * Persist `ssoProvider`, `role`, and `orgId` on the JWT so the Edge
     * middleware reads them without a DB hit (Edge runtime forbids `pg`).
     *
     * Strategy:
     *   - On initial sign-in (`account` present), record `ssoProvider` and
     *     do the DB lookup to attach `role` + `orgId`.
     *   - On subsequent calls (no `account`), refresh `role` + `orgId` from
     *     the DB so role promotions/demotions reflect on the next request.
     *     Cost: ~1ms per token validation; acceptable for a manager UI.
     */
    async jwt({ token, account }) {
      if (account?.provider) {
        token.ssoProvider = account.provider;
      }
      const email = typeof token.email === 'string' ? token.email : null;
      const ssoProvider = typeof token.ssoProvider === 'string' ? token.ssoProvider : null;
      if (email && ssoProvider) {
        const roleAndOrg = await loadRoleAndOrg(email, ssoProvider);
        if (roleAndOrg) {
          token.role = roleAndOrg.role;
          token.orgId = roleAndOrg.orgId;
        } else {
          // Hardening (security review C2): when DB lookup returns null,
          // do NOT preserve any pre-existing role/orgId on the token. A
          // forged JWT with role='admin' for an unknown email would
          // otherwise survive this callback unchanged and the downstream
          // session callback would mirror the forged role into
          // session.user.role. Clearing breaks that escalation path —
          // unknown user = no role = layout/middleware deny.
          delete token.role;
          delete token.orgId;
        }
      }
      return token;
    },
    /**
     * Mirror role/orgId from the JWT onto `session.user` for Server
     * Components reading `auth()`. No DB hit here — the JWT already carries
     * the values (populated by `jwt()` above).
     */
    async session({ session, token }) {
      if (session.user) {
        if (isRole(token.role)) {
          session.user.role = token.role;
        }
        if (typeof token.orgId === 'string') {
          session.user.orgId = token.orgId;
        }
      }
      return session;
    },
  },
});

declare module 'next-auth' {
  interface Session {
    user?: {
      email?: string | null;
      name?: string | null;
      image?: string | null;
      role?: Role;
      orgId?: string;
    };
  }
  interface User {
    role?: Role;
    orgId?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    ssoProvider?: string;
    role?: Role;
    orgId?: string;
  }
}
