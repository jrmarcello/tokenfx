/**
 * DB-backed helpers for the NextAuth `signIn` + `jwt` callbacks.
 *
 * Lives in its own module (not inside `auth.ts`) so unit/integration tests
 * can import these helpers without dragging the NextAuth runtime + its
 * `next/server` resolution path into the Vitest module graph. Same shape
 * rationale as `./roles.ts` (Edge-safe split) — different reason: here the
 * split is *test* ergonomics, not Edge-safety.
 *
 * Anything in this file may use Drizzle / `pg` (it runs in the Node
 * runtime alongside `auth.ts`). Just no NextAuth imports.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { isRole, type Role } from './roles';

/**
 * Shape returned by `loadUserByEmail`. The JWT callback consumes this to
 * write `userId`, `role`, `orgId` onto the token. `ssoProvider` is the
 * VALUE FETCHED from the DB row and may be `null` for invite-provisioned
 * users that have not completed their first SSO login yet.
 */
export type LoadedUser = {
  userId: string;
  role: Role;
  orgId: string;
  ssoProvider: string | null;
};

/**
 * Look up the user's id + role + orgId + sso_provider from the DB by email
 * ALONE. `users.email` is globally UNIQUE (per spec 3 schema), so an
 * email-only predicate is correct AND necessary: invite-provisioned users
 * have `sso_provider IS NULL`, so the previous `(email, sso_provider)`
 * predicate filtered them out and broke the JWT callback for invitees on
 * their very first SSO login.
 *
 * Returns `null` when the email is not in `users` (legitimate sign-in for
 * which the `signIn` callback has not yet inserted/updated a row, OR a
 * forged JWT for a non-existent email).
 */
export const loadUserByEmail = async (email: string): Promise<LoadedUser | null> => {
  const db = getDb();
  const [row] = await db
    .select({
      id: users.id,
      role: users.role,
      orgId: users.orgId,
      ssoProvider: users.ssoProvider,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) return null;
  if (!isRole(row.role)) return null;
  return {
    userId: row.id,
    role: row.role,
    orgId: row.orgId,
    ssoProvider: row.ssoProvider,
  };
};

/**
 * Existing-row shape passed into `evaluateSignIn` — the `signIn` callback
 * looks the row up by email (UNIQUE) and hands the SSO columns here. Pure
 * structural type; no DB binding.
 */
export type SignInExisting = {
  ssoProvider: string | null;
  ssoSubject: string | null;
};

/**
 * Decision returned by `evaluateSignIn`. The `signIn` callback runs the
 * side effects implied by `kind`:
 *   - `allow`           : nothing to do; existing SSO user matches.
 *   - `bootstrap`       : no row; insert a fresh user (single-org bootstrap).
 *                         The caller verifies the org count and supplies orgId.
 *   - `fill-sso`        : invited user's first SSO login. UPDATE
 *                         `sso_provider` + `sso_subject`.
 *   - `reject-mismatch` : someone else's account claims this email; reject
 *                         (false from the callback) + structured warn.
 */
export type SignInDecision =
  | { kind: 'allow' }
  | { kind: 'bootstrap' }
  | { kind: 'fill-sso'; provider: string; subject: string }
  | { kind: 'reject-mismatch' };

/**
 * Pure decision helper — no DB access. Tested in isolation with hand-
 * written stubs (no mocking framework). The integration suite then asserts
 * the side effects (UPDATE in `fill-sso`, INSERT in `bootstrap`) by mirroring
 * the callback's `loadUserByEmail` → `evaluateSignIn` → DB-write sequence.
 */
export const evaluateSignIn = (
  oauth: { provider: string; providerAccountId: string },
  existing: SignInExisting | null,
): SignInDecision => {
  if (!existing) return { kind: 'bootstrap' };
  if (existing.ssoProvider === null) {
    return { kind: 'fill-sso', provider: oauth.provider, subject: oauth.providerAccountId };
  }
  if (
    existing.ssoProvider === oauth.provider &&
    existing.ssoSubject === oauth.providerAccountId
  ) {
    return { kind: 'allow' };
  }
  return { kind: 'reject-mismatch' };
};
