import NextAuth from 'next-auth';
// Side-effect import anchors the `next-auth/jwt` module in the resolution
// graph so the `declare module 'next-auth/jwt'` augmentation below resolves.
import 'next-auth/jwt';
import { asc, eq } from 'drizzle-orm';
import { authConfig } from './auth.config';
import {
  buildLocalDevSession,
  isAuthRequired,
} from './auth-required';
import {
  assertNotProductionWithBypass,
  buildE2eBypassProvider,
} from './e2e-bypass-provider';
import { assertFlashSecretAvailable } from './flash-cookie';
import { getDb } from '@/lib/db/client';
import { orgs, users } from '@/lib/db/schema';
import { emailDomain } from './email-hash';
import { evaluateSignIn, loadUserByEmail, loadUserBySsoIdentity } from './load-user';
import { matchActiveInvitesByEmail } from './match-active-invites';
import { getRequestContext } from '@/lib/auth/request-context';
import { writeReplayAuditRow } from './auth-event-log-writer';
import { ipToCity } from './ip-to-city';
import { isStateReplayAuthError } from './replay-detector';
import { evaluateAutoProvision } from './sso-auto-provision';
import { log as logger } from '@root/logger';
import {
  createInvalidCheckHandler,
  extractAudience,
  extractEmailVerified,
  extractIssuer,
} from './auth-helpers';

/**
 * NextAuth `logger.error` hook for the SSO replay-audit-row spec
 * (`.specs/sso-replay-audit-row.md` — closes REQ-FU-1 of oauth-idp-stub
 * + the audit-row half of spec-b TC-I-34).
 *
 * The helper itself lives in `./auth-helpers` as a pure factory so
 * unit tests can inject hand-written stubs for the writer / ipToCity /
 * context provider without pulling Postgres / GeoIP / NextAuth into
 * the Vitest module graph. Here we wire the production dependencies.
 *
 * Failure safety, narrowing, and the rationale for `ssoProvider:
 * 'unknown'` are documented inside `createInvalidCheckHandler`.
 */
const writeReplayAuditRowOnInvalidCheck = createInvalidCheckHandler({
  writer: writeReplayAuditRow,
  ipToCity,
  getRequestContext,
});

// `extractIssuer` (REQ-7 cap @ 512 + REQ-8 happy/edges) and
// `extractEmailVerified` now live in `./auth-helpers` so unit tests
// exercise them without pulling NextAuth into the Vitest module graph.
// See `auth-helpers.ts` for the security note on issuer-claim extraction
// without local signature verification (NextAuth verifies the id_token
// upstream of this code path).

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

// onboarding-followups-lowsev (REQ-13): defense-in-depth boot guard for
// the flash-cookie HMAC secret. The AUTH_SECRET guard above (lines 18-26)
// catches the common case; this assertion is the locality-specific check
// — if any future module imports `flash-cookie` directly (NOT via this
// file), it can call `assertFlashSecretAvailable` itself.
assertFlashSecretAvailable(process.env);

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
const nextAuthExports = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    ...(e2eBypassProvider ? [e2eBypassProvider] : []),
  ],
  // Replay-audit hook: Auth.js v5 calls `logger.error(error)` with the
  // raw AuthError instance whenever the OAuth callback fails. We tap
  // this hook to write the `rejected-replay` audit row when the failure
  // is specifically a state/PKCE/nonce check (`InvalidCheck`). All
  // other AuthError types pass through to the default console logger.
  logger: {
    error: (error: Error) => {
      // Defensive: `Promise.resolve().then(...)` converts ANY sync throw
      // in the helper into a microtask-queue rejection that the .catch
      // can swallow. Bare `void asyncFn(error)` would propagate a sync
      // throw through the logger callback into Auth.js's error chain,
      // potentially replacing the redirect-to-error-page with a 500.
      Promise.resolve()
        .then(() => writeReplayAuditRowOnInvalidCheck(error))
        .catch((err: unknown) => {
          logger.warn('auth: logger hook threw synchronously', {
            error_message: err instanceof Error ? err.message : String(err),
          });
        });
      // Forward to default-style logging so the original diagnostic
      // surface (stderr) is preserved.
      // C-1 (REQ-10): detect InvalidCheck via the typed guard instead
      // of an unchecked `as { type?: string }` cast. The guard narrows
      // safely; any other AuthError falls back to `error.name` (Auth.js
      // does not stabilise a `type` field across all subclasses).
      logger.error('next-auth error', {
        error_type: isStateReplayAuthError(error) ? 'InvalidCheck' : error.name,
        error_message: error.message,
      });
    },
  },
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
      // TASK-4 final (REQ-14): lookup by SSO identity FIRST. The
      // `(org_id, sso_provider, sso_subject)` UNIQUE constraint
      // (schema-migrations REQ-2) guarantees ≤1 row globally, so this is
      // unambiguous when the user is already SSO-bound. Skipping
      // `loadUserByEmail` here also avoids the multi-org-collision path
      // entirely for the common case (user already signed in once).
      const ssoMatched = await loadUserBySsoIdentity(
        account.provider,
        account.providerAccountId,
      );
      if (ssoMatched) {
        return true;
      }

      // No SSO-bound row matches. Fall back to email lookup (REQ-11 array
      // return) to handle:
      //   - bootstrap (0 rows for this email)
      //   - fill-sso  (1 row with ssoProvider IS NULL — legacy invite-
      //                provisioned user's first SSO login)
      //   - reject-mismatch (1 row with mismatched ssoProvider/subject —
      //                Threat 11 partial mitigation; full refusal flow is
      //                spec (b))
      //   - ambiguous-multi-org (≥2 rows — same email across orgs, post
      //                schema-migrations REQ-1; org-picker UX in spec (b))
      const existingRows = await db
        .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
        .from(users)
        .where(eq(users.email, user.email))
        .orderBy(asc(users.createdAt));

      const decision = evaluateSignIn(
        { provider: account.provider, providerAccountId: account.providerAccountId },
        existingRows,
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
        case 'ambiguous-multi-org':
          // TASK-3 transitional: the email maps to ≥2 orgs (now legal
          // post-REQ-1). The full UX (org picker) lands in a follow-up
          // backend spec; until then we reject + warn so operators can
          // see the surface in logs. Domain only — never the full email.
          logger.warn('signIn rejected: email maps to multiple orgs (org-picker UX not yet wired)', {
            provider: account.provider,
            emailDomain: emailDomain(user.email),
          });
          return false;
        case 'bootstrap': {
          // central-server-onboarding-v2-sso (TASK-11): try SSO-auto-provision
          // FIRST. If the email matches an active invite's `email_pattern`,
          // delegate to the decision engine (issuer/audience/email_verified
          // checks, public-domain blocklist, transactional invite consumption,
          // audit-log writes). The orchestrator inserts the `users` row inside
          // its own tx; we just return true on accept.
          //
          // NOTE on `account.audience`: NextAuth v5's `Account` type exposes
          // some OIDC claims directly and others only via the raw id_token.
          // We pass an empty string for `audience` when missing — the decision
          // engine's clientId check will then surface as 'rejected-csrf' for
          // forged callbacks, which is the desired behavior.
          //
          // IP / user-agent are threaded into this callback via
          // `AsyncLocalStorage` (see `lib/auth/request-context.ts`). The
          // NextAuth route handler wraps the request in `runInRequestContext`
          // so deep callbacks like `signIn` — which receive no `Request`
          // object — can still read upstream-populated forensics fields.
          // When invoked outside that scope (tests, edge cases), the helper
          // returns empty defaults, preserving the prior hard-coded behavior.
          const matches = await matchActiveInvitesByEmail(user.email);
          if (matches.length >= 1) {
            // NextAuth v5's Account type doesn't expose OIDC `audience` / `iss`
            // claims directly; cast to Record<string, unknown> so the extract*
            // helpers can probe them safely without `any`. Each access is
            // narrowed via typeof checks (no unchecked dereference).
            //
            // fix-sso-e2e-remaining-5 TASK-3: `extractAudience` decodes the
            // id_token (NOT `account.audience` — that's undefined for OIDC
            // providers in Auth.js v5). Before this fix, every Okta callback
            // was rejected as `rejected-csrf` because `audience = ''` never
            // matched the configured clientId.
            const acctRecord = account as unknown as Record<string, unknown>;
            const audience = extractAudience(acctRecord);
            const { ip, userAgent } = getRequestContext();
            const decision = await evaluateAutoProvision({
              email: user.email,
              ssoProvider: account.provider,
              ssoSubject: account.providerAccountId,
              ssoIssuer: extractIssuer(acctRecord),
              audience,
              emailVerified: extractEmailVerified(
                acctRecord,
                user as unknown as Record<string, unknown>,
              ),
              ip,
              userAgent,
              displayName: user.name ?? null,
            });
            if (decision.kind === 'accepted-sso-auto') {
              // `users` + audit rows already written inside the orchestrator's
              // tx. Machine credentials are minted by the standard bearer-auth
              // flow on a subsequent request, mirroring the v1 bootstrap shape.
              return true;
            }
            if (decision.kind === 'rate-limited') {
              logger.warn('sso-auto-provision rate-limited at signIn', {
                dimension: decision.dimension,
                retry_after_sec: decision.retryAfterSec,
                emailDomain: emailDomain(user.email),
              });
              return false;
            }
            // All other rejection kinds — domain only, never the full email.
            logger.warn('sso-auto-provision rejected at signIn', {
              kind: decision.kind,
              emailDomain: emailDomain(user.email),
            });
            return false;
          }
          // No SSO-auto pattern match → fall through to v1 single-org
          // bootstrap (preserved). Reject if 0 or >1 orgs.
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
        // C-3 (REQ-12): exhaustiveness guard. `const _exhaustive: never`
        // forces a tsc error if `SignInDecision.kind` grows a new variant
        // without a corresponding case here. At runtime (JS only — would
        // require the type system to be bypassed), we silent-reject
        // rather than throwing: a 500 inside `signIn` would replace the
        // generic NextAuth error redirect with an opaque crash page,
        // hiding the original cause from the user.
        default: {
          const _exhaustive: never = decision;
          void _exhaustive;
          logger.warn('signIn rejected: unknown decision variant', {
            kind: (decision as { kind: string }).kind,
          });
          return false;
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
        // TASK-3 transitional (REQ-11): `loadUserByEmail` now returns
        // `LoadedUser[]` ordered by created_at ASC. For the single-org
        // case the array is length 1 (or 0). The multi-org case (≥2) is
        // surfaced as a warn here and the oldest row is picked — the
        // full org-picker UX lands in a follow-up backend spec.
        const loaded = await loadUserByEmail(email);
        if (loaded.length >= 2) {
          logger.warn('jwt: email maps to multiple orgs; picking oldest (org-picker UX not yet wired)', {
            emailDomain: emailDomain(email),
            orgCount: loaded.length,
          });
        }
        const picked = loaded[0];
        if (picked) {
          token.userId = picked.userId;
          token.role = picked.role;
          token.orgId = picked.orgId;
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

export const { handlers, signIn, signOut } = nextAuthExports;

/**
 * `auth()` shim — when `AUTH_REQUIRED=false` (localhost open-access mode),
 * returns the synthetic demo session WITHOUT invoking NextAuth. This means
 * no NextAuth machinery runs in localhost mode — zero cookies issued, zero
 * audit-log rows written, zero JWT mint. The middleware
 * (apps/server/middleware.ts) enforces localhost-host before this is called,
 * so reaching here in open-access mode means the request was already gated.
 *
 * When `AUTH_REQUIRED=true` (or unset), the call delegates to NextAuth's
 * own `auth()` — full SSO behavior preserved.
 *
 * Type-cast to preserve NextAuth's overloaded signature for Server
 * Components, route handlers, and middleware-style callers. In localhost
 * mode we only return a Session-shaped object — the `Handler`-wrap overload
 * is never relevant (those calls go through NextAuth's own `handlers`).
 */
export const auth = ((...args: Parameters<typeof nextAuthExports.auth>) => {
  if (!isAuthRequired(process.env)) {
    return Promise.resolve(buildLocalDevSession());
  }
  return (nextAuthExports.auth as (...a: typeof args) => unknown)(...args);
}) as typeof nextAuthExports.auth;

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

