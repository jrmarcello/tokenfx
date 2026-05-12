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
 *
 * Shape post central-server-onboarding-v2-sso (REQ-11..13):
 *   - `loadUserByEmail` returns `LoadedUser[]` (0..N rows). The `(org_id,
 *     email) UNIQUE` constraint replaced the old global `email UNIQUE`
 *     in REQ-2, so the same address may appear in multiple orgs.
 *   - `loadUserBySsoIdentity(provider, subject)` is the post-auto-provision
 *     happy-path lookup keyed by `(sso_provider, sso_subject)`. Defensive
 *     throw if >1 row (catastrophic constraint drift; should be unreachable).
 *   - `evaluateSignIn` accepts the array shape and adds a new
 *     `ambiguous-multi-org` decision for `length >= 2`.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { isRole, type Role } from './roles';

/**
 * Shape returned by `loadUserByEmail` / `loadUserBySsoIdentity`. The JWT
 * callback consumes this to write `userId`, `role`, `orgId` onto the
 * token. `ssoProvider` is the VALUE FETCHED from the DB row and may be
 * `null` for invite-provisioned users that have not completed their first
 * SSO login yet.
 */
export type LoadedUser = {
  userId: string;
  role: Role;
  orgId: string;
  ssoProvider: string | null;
};

/**
 * Look up users by email. Returns 0..N rows ordered by `created_at ASC`
 * (so "pick first" is deterministic across runs).
 *
 * Post-`(org_id, email) UNIQUE` migration (schema-migrations spec REQ-1),
 * an email is no longer globally unique — the same address may appear in
 * multiple orgs. Callers must handle the array shape explicitly; the
 * transitional jwt/signIn callbacks pick the oldest row + emit a warn
 * until the org-picker UX lands.
 */
export const loadUserByEmail = async (email: string): Promise<LoadedUser[]> => {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      orgId: users.orgId,
      ssoProvider: users.ssoProvider,
    })
    .from(users)
    .where(eq(users.email, email))
    .orderBy(asc(users.createdAt));
  return rows.flatMap((r) =>
    isRole(r.role)
      ? [{ userId: r.id, role: r.role, orgId: r.orgId, ssoProvider: r.ssoProvider }]
      : [],
  );
};

/**
 * Look up user by SSO identity `(provider, subject)`. The `(org_id,
 * sso_provider, sso_subject)` UNIQUE constraint (REQ-2) guarantees ≤1 row
 * for any given (provider, subject) within a single org; across orgs the
 * pair is globally non-unique only in the catastrophic "same identity
 * binds two orgs" drift case. If >1 row is observed this helper THROWS —
 * it never silently picks first, since doing so would mask an integrity
 * violation that operators need to investigate.
 */
export const loadUserBySsoIdentity = async (
  provider: string,
  subject: string,
): Promise<LoadedUser | null> => {
  const db = getDb();
  // Fetch up to 2 — enough to detect the >1 case without materializing a
  // potentially-large set if constraint drift is much worse than 1 extra.
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      orgId: users.orgId,
      ssoProvider: users.ssoProvider,
    })
    .from(users)
    .where(and(eq(users.ssoProvider, provider), eq(users.ssoSubject, subject)))
    .limit(2);

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Privacy: do NOT log the subject value — it may correlate to a real
    // identity. Surface only counts + provider so operators can locate
    // the offending rows via SQL.
    throw new Error(
      `invariant violation: multiple users matched SSO identity (provider=${provider}, subject=<redacted>): ${rows.length} rows`,
    );
  }
  const row = rows[0];
  // Drizzle's typing infers `rows[0]` as possibly-undefined under noUncheckedIndexedAccess.
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
 * Existing-row shape passed into `evaluateSignIn`. Pure structural type;
 * no DB binding. The caller (signIn callback) hands an array because
 * post-`(org_id, email) UNIQUE` an email may resolve to N rows.
 */
export type SignInExisting = {
  ssoProvider: string | null;
  ssoSubject: string | null;
};

/**
 * Decision returned by `evaluateSignIn`. The `signIn` callback runs the
 * side effects implied by `kind`:
 *   - `allow`               : nothing to do; existing SSO user matches.
 *   - `bootstrap`           : no row; insert a fresh user (single-org
 *                             bootstrap). Caller verifies the org count
 *                             and supplies orgId.
 *   - `fill-sso`            : invited user's first SSO login. UPDATE
 *                             `sso_provider` + `sso_subject`.
 *   - `reject-mismatch`     : someone else's account claims this email;
 *                             reject (false from the callback) + warn.
 *   - `ambiguous-multi-org` : the email exists in ≥2 orgs. Transitional:
 *                             the callback logs warn + picks first;
 *                             follow-up backend spec adds the org-picker
 *                             UX surface that resolves this deterministically.
 */
export type SignInDecision =
  | { kind: 'allow' }
  | { kind: 'bootstrap' }
  | { kind: 'fill-sso'; provider: string; subject: string }
  | { kind: 'reject-mismatch' }
  | { kind: 'ambiguous-multi-org' };

/**
 * Pure decision helper — no DB access. Tested in isolation with hand-
 * written stubs (no mocking framework). The integration suite then asserts
 * the side effects (UPDATE in `fill-sso`, INSERT in `bootstrap`) by mirroring
 * the callback's `loadUserByEmail` → `evaluateSignIn` → DB-write sequence.
 *
 * Decision tree:
 *   length === 0           → bootstrap
 *   length >= 2            → ambiguous-multi-org
 *   length === 1 + null    → fill-sso (payload from `oauth`)
 *   length === 1 + match   → allow
 *   length === 1 + diff    → reject-mismatch
 */
export const evaluateSignIn = (
  oauth: { provider: string; providerAccountId: string },
  existing: SignInExisting[],
): SignInDecision => {
  if (existing.length === 0) return { kind: 'bootstrap' };
  if (existing.length >= 2) return { kind: 'ambiguous-multi-org' };
  // Exactly one row.
  const row = existing[0];
  if (!row) return { kind: 'bootstrap' };
  if (row.ssoProvider === null) {
    return { kind: 'fill-sso', provider: oauth.provider, subject: oauth.providerAccountId };
  }
  if (
    row.ssoProvider === oauth.provider &&
    row.ssoSubject === oauth.providerAccountId
  ) {
    return { kind: 'allow' };
  }
  return { kind: 'reject-mismatch' };
};
