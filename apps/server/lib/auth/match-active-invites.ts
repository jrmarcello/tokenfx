/**
 * DB query helper: returns active onboarding invites whose `email_pattern`
 * matches the given email (REQ-5, central-server-onboarding-v2-sso).
 *
 * Used by the SSO auto-provision flow on first-login: when a federated
 * (Google/Microsoft/...) user lands without a `users` row, we look up
 * pending invites whose `email_pattern` matches their email and, if exactly
 * one matches, auto-provision them into the invite's org/team.
 *
 * "Active" = NOT revoked, NOT expired, NOT exhausted. All three conditions
 * are filtered at the SQL layer so the in-memory pattern-match step receives
 * the smallest possible candidate set.
 *
 * Pattern matching itself runs in JS via the existing `matchEmailPattern`
 * helper — the actual `*@domain.com` glob is too narrow to express
 * efficiently in SQL while preserving the homoglyph / NFC guards that live
 * in `matchEmailPattern`. The DB returns rows; we filter by pattern in JS.
 *
 * Index alignment: the SQL filter is shaped to match the partial index
 * `idx_invites_email_pattern_active` (migration 0004) — i.e.
 * `WHERE revoked_at IS NULL`. The additional `expires_at > now()` and
 * `used_count < max_uses` predicates are applied on the index-narrowed set.
 */
import { and, gt, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { onboardingInvites } from '@/lib/db/schema';
import { matchEmailPattern } from './match-email-pattern';

export type ActiveInvite = {
  token: string;
  orgId: string;
  teamId: string | null;
  emailPattern: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  allowedSsoProviders: string[];
};

/**
 * Returns all active invites whose `email_pattern` matches the given email.
 *
 * The DB query filters by activity status only (revoked / expired /
 * exhausted). The in-memory pass applies the `matchEmailPattern` rules —
 * NFC normalization, case-insensitive domain comparison, exact local-part
 * match, homoglyph rejection, IDN-to-punycode canonicalization.
 *
 * Returns an empty array when no active invite matches. The caller is
 * responsible for deciding what "exactly one match" means in business terms
 * (REQ-7 ambiguity handling).
 */
export const matchActiveInvitesByEmail = async (
  email: string,
): Promise<ActiveInvite[]> => {
  const db = getDb();

  // SQL filter aligned with `idx_invites_email_pattern_active`
  // (partial index WHERE revoked_at IS NULL). Pulling `email_pattern IS
  // NOT NULL` here would also be a candidate, but auto-provision is the
  // ONLY caller and it requires a pattern by design — we keep that
  // invariant in JS so the helper stays useful for any future caller
  // that wants to inspect null-pattern invites too.
  const rows = await db
    .select({
      token: onboardingInvites.token,
      orgId: onboardingInvites.orgId,
      teamId: onboardingInvites.teamId,
      emailPattern: onboardingInvites.emailPattern,
      maxUses: onboardingInvites.maxUses,
      usedCount: onboardingInvites.usedCount,
      expiresAt: onboardingInvites.expiresAt,
      allowedSsoProviders: onboardingInvites.allowedSsoProviders,
    })
    .from(onboardingInvites)
    .where(
      and(
        isNull(onboardingInvites.revokedAt),
        gt(onboardingInvites.expiresAt, sql`now()`),
        lt(onboardingInvites.usedCount, onboardingInvites.maxUses),
      ),
    );

  // In-memory pattern match. `matchEmailPattern(pattern, email)` handles
  // NFC + lowercase + domain canonicalization internally.
  return rows.filter((r) => matchEmailPattern(r.emailPattern, email.trim()));
};
