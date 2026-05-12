/**
 * Pure-function predicate that re-validates an onboarding invite row read
 * under `SELECT ... FOR UPDATE` inside the SSO auto-provision transaction
 * (REQ-15, central-server-onboarding-v2-sso).
 *
 * Two threads can race to consume the same invite token. The
 * candidate-selection query runs **without** a row lock; once a winner is
 * chosen we re-read the row with `FOR UPDATE` to serialize the consumption
 * step. The re-read can reveal the invite was revoked / expired / fully
 * consumed in the meantime — this predicate is the single source of truth
 * for that decision.
 *
 * Extracted from the prior inline check (+ `onAfterSelectForUpdate` test
 * seam) so the logic is unit-testable without spinning up a DB or relying
 * on stubbed transaction hooks.
 *
 * Precedence is INTENTIONAL and TESTED — when multiple invalidations
 * apply simultaneously, the predicate reports them in this order:
 *
 *   1. `revoked`   — `revokedAt !== null && revokedAt <= currentTimeMs`
 *   2. `expired`   — `expiresAt <= currentTimeMs` (inclusive boundary)
 *   3. `exhausted` — `usedCount >= maxUses`
 *
 * Why revoked wins: a revocation is an explicit operator action; surfacing
 * "expired" or "exhausted" when the row was actively revoked would obscure
 * the operational signal in audit logs and UI messaging.
 *
 * Why expired beats exhausted: the time check is independent of any
 * redemption activity; reporting "exhausted" for a row that's already past
 * its expiration would mislead the caller into thinking the row was still
 * "live" right up until the last redemption.
 *
 * The `>=` on `usedCount`/`maxUses` covers over-redemption — i.e. if a
 * concurrency bug elsewhere ever bumps `usedCount` past `maxUses`, this
 * predicate still reports `exhausted` rather than `{ valid: true }`.
 *
 * The `<=` (inclusive) on expiration matches Postgres' `expires_at < now()`
 * semantics: the SQL filter would have excluded a row whose `expires_at`
 * equals the current moment, so the predicate must agree to keep behavior
 * consistent across the candidate-selection and re-validation steps.
 */

export type InviteRow = {
  token: string;
  revokedAt: Date | null;
  expiresAt: Date;
  usedCount: number;
  maxUses: number;
};

export type RevalidateResult =
  | { valid: true }
  | { valid: false; reason: 'revoked' | 'expired' | 'exhausted' };

export const revalidateInvite = (
  invite: InviteRow,
  currentTimeMs: number,
): RevalidateResult => {
  if (
    invite.revokedAt !== null &&
    invite.revokedAt.getTime() <= currentTimeMs
  ) {
    return { valid: false, reason: 'revoked' };
  }

  if (invite.expiresAt.getTime() <= currentTimeMs) {
    return { valid: false, reason: 'expired' };
  }

  if (invite.usedCount >= invite.maxUses) {
    return { valid: false, reason: 'exhausted' };
  }

  return { valid: true };
};
