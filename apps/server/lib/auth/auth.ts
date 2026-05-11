import NextAuth from 'next-auth';
// Side-effect import anchors the `next-auth/jwt` module in the resolution
// graph so the `declare module 'next-auth/jwt'` augmentation below resolves.
import 'next-auth/jwt';
import { eq } from 'drizzle-orm';
import { authConfig } from './auth.config';
import {
  assertNotProductionWithBypass,
  buildE2eBypassProvider,
} from './e2e-bypass-provider';
import { getDb } from '@/lib/db/client';
import { orgs, users } from '@/lib/db/schema';
import { emailDomain } from './email-hash';
import { evaluateSignIn, loadUserByEmail } from './load-user';
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

// fix-e2e-auth-bypass (REQ-4): refuse to boot if the e2e-only Credentials
// bypass is enabled in production. Mirrors the AUTH_SECRET guard above. The
// `buildE2eBypassProvider` builder itself is pure-function-of-env (no
// prod-check) — this module-scope call is the canonical fail-fast.
assertNotProductionWithBypass(process.env);

const e2eBypassProvider = buildE2eBypassProvider(process.env);

/**
 * Role typing + narrowing has moved to `./roles.ts` so the Edge-safe
 * `auth.config.ts` can share the same `isRole` check without pulling
 * this module's `pg`/Drizzle imports. Re-exported here for backward
 * compatibility with prior imports from this file.
 */
export type { Role } from './roles';
import type { Role } from './roles';
import { isRole } from './roles';

// DB-backed helpers (`loadUserByEmail`, `evaluateSignIn`) live in
// `./load-user.ts` so integration tests can import them without dragging
// NextAuth into Vitest's module graph. Re-exported here so any non-test
// caller that already does `from '@/lib/auth/auth'` keeps working.
export {
  evaluateSignIn,
  loadUserByEmail,
  type LoadedUser,
  type SignInDecision,
  type SignInExisting,
} from './load-user';

/**
 * Full NextAuth instance — extends the Edge-safe `authConfig` with
 * DB-backed callbacks (Drizzle/`pg` only run here, never on Edge).
 *
 * - `signIn`: invite-aware bootstrap/fill/allow/reject (REQ-13).
 * - `jwt`: persist `userId` + `role` + `orgId` on the JWT so middleware
 *   reads them from the token (no DB hit on hot path).
 * - `session`: re-attach id/role/orgId to `session.user` for Server
 *   Components reading `auth()` directly.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    ...(e2eBypassProvider ? [e2eBypassProvider] : []),
  ],
  callbacks: {
    ...authConfig.callbacks,
    /**
     * REQ-13: handle invite-provisioned users with `sso_provider IS NULL`.
     * Existing-user lookup is now email-only (UNIQUE per schema). The
     * decision is delegated to the pure `evaluateSignIn` helper so the
     * branching is independently testable.
     *
     *   - bootstrap (no row)        → insert iff exactly one org exists.
     *   - fill-sso (row, sso NULL)  → UPDATE sso_provider/sso_subject. The
     *     freshly-updated row is what `loadUserByEmail` will read in the
     *     subsequent `jwt()` callback (READ COMMITTED, same connection).
     *   - allow (row matches)       → no DB write.
     *   - reject-mismatch           → false + structured warn (domain only).
     */
    async signIn({ user, account }) {
      if (!user?.email || !account?.provider) {
        logger.warn('signIn rejected: missing email or provider', {
          provider: account?.provider ?? null,
          hasEmail: !!user?.email,
        });
        return false;
      }
      // fix-e2e-auth-bypass: short-circuit for the e2e-only Credentials
      // provider. `authorize` in `e2e-bypass-provider.ts` already validated
      // the user against the seeded DB (and the boot-guard + env gate ensure
      // this branch only runs in dev/test). The OAuth provider/subject
      // mismatch logic below does not apply — credentials sign-in has no
      // `providerAccountId` to validate beyond what `authorize` returned.
      if (account.provider === 'credentials') {
        return true;
      }
      if (!account.providerAccountId) {
        logger.warn('signIn rejected: missing providerAccountId', {
          provider: account.provider,
        });
        return false;
      }

      const db = getDb();
      const [row] = await db
        .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
        .from(users)
        .where(eq(users.email, user.email))
        .limit(1);

      const decision = evaluateSignIn(
        { provider: account.provider, providerAccountId: account.providerAccountId },
        row ?? null,
      );

      switch (decision.kind) {
        case 'allow':
          return true;
        case 'fill-sso':
          // manager-dashboard-v2 (REQ-18): populate display_name from the
          // OAuth profile name on the SSO-fill branch. Only set if the
          // provider actually returned a name (NextAuth's `user.name` is
          // nullable). Existing display_name is overwritten on each fill;
          // this is intentional — `name` reflects the latest SSO claim.
          await db
            .update(users)
            .set({
              ssoProvider: decision.provider,
              ssoSubject: decision.subject,
              ...(user.name ? { displayName: user.name } : {}),
            })
            .where(eq(users.email, user.email));
          return true;
        case 'reject-mismatch':
          // Privacy: log the domain only, never the full email. Hand off
          // to `emailDomain` (TASK-3) so the audit signal is consistent
          // with the redemption-log conventions.
          logger.warn('signIn rejected: SSO provider/subject mismatch on existing email', {
            provider: account.provider,
            emailDomain: emailDomain(user.email),
          });
          return false;
        case 'bootstrap': {
          // No row yet — single-org bootstrap. Reject if 0 or >1 orgs.
          const allOrgs = await db.select({ id: orgs.id }).from(orgs).limit(2);
          if (allOrgs.length !== 1) {
            logger.warn('signIn rejected: org count not 1 (single-tenant bootstrap)', {
              provider: account.provider,
              orgCount: allOrgs.length,
              emailDomain: emailDomain(user.email),
            });
            return false;
          }
          // manager-dashboard-v2 (REQ-18): populate display_name from OAuth
          // profile.name on bootstrap insert. Nullable — providers that
          // don't expose a name leave it NULL and `displayLabelFor()` falls
          // back to email local-part.
          await db.insert(users).values({
            orgId: allOrgs[0].id,
            email: user.email,
            ssoProvider: account.provider,
            ssoSubject: account.providerAccountId,
            role: 'member',
            displayName: user.name ?? null,
          });
          return true;
        }
      }
    },
    /**
     * Persist `userId` + `role` + `orgId` on the JWT so the Edge
     * middleware reads them without a DB hit (Edge runtime forbids `pg`).
     *
     * Lookup predicate is email-only — matches `loadUserByEmail`'s shape
     * change in REQ-12. `ssoProvider` is no longer needed for the lookup;
     * it is recorded on the token only as audit/tracing metadata.
     */
    async jwt({ token, account }) {
      if (account?.provider) {
        token.ssoProvider = account.provider;
      }
      const email = typeof token.email === 'string' ? token.email : null;
      if (email) {
        const loaded = await loadUserByEmail(email);
        if (loaded) {
          token.userId = loaded.userId;
          token.role = loaded.role;
          token.orgId = loaded.orgId;
        } else {
          // Hardening (security review C2): when DB lookup returns null,
          // do NOT preserve any pre-existing userId/role/orgId on the
          // token. A forged JWT with role='admin' for an unknown email
          // would otherwise survive this callback unchanged and the
          // downstream session callback would mirror the forged role
          // into session.user.role. Clearing breaks that escalation
          // path — unknown user = no claims = layout/middleware deny.
          delete token.userId;
          delete token.role;
          delete token.orgId;
        }
      }
      return token;
    },
    /**
     * Mirror id/role/orgId from the JWT onto `session.user` for Server
     * Components reading `auth()`. No DB hit here — the JWT already
     * carries the values (populated by `jwt()` above).
     */
    async session({ session, token }) {
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
  },
});

declare module 'next-auth' {
  interface Session {
    user?: {
      id?: string;
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
    userId?: string;
    ssoProvider?: string;
    role?: Role;
    orgId?: string;
  }
}
