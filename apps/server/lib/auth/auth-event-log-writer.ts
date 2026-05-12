/**
 * Append-only writer for `auth_event_log` rows.
 *
 * Spec: .specs/central-server-onboarding-v2-sso.backend.md (TASK-5)
 * Schema: lib/db/schema.ts → `authEventLog` (REQ-10 of
 *   .specs/central-server-onboarding-v2-sso.schema-migrations.md)
 *
 * Privacy invariants (spec b REQ-4, threat-model §Logging):
 *   - The caller is responsible for hashing `email` → `emailHash` and
 *     `ssoSubject` → `ssoSubjectHash` via `lib/auth/email-hash.ts` BEFORE
 *     calling this writer. The function intentionally refuses to accept
 *     raw email / subject inputs — there is no overload that would let a
 *     caller pass plaintext PII into the audit table.
 *   - `user_agent` is truncated to ≤512 chars at the write boundary
 *     (REQ-4 — defense in depth even if the upstream caller forgets).
 *
 * Outcome semantics (spec a REQ-10 CHECK constraint):
 *   The 10-value enum covers every SSO sign-in decision (1 acceptance +
 *   9 rejection reasons). 'rate-limited' is NOT a member — rate-limited
 *   attempts log to `onboarding_redemption_log` only (spec b REQ-12 +
 *   Decisão #16). Passing an out-of-domain outcome will surface as a
 *   Postgres `check_violation` at INSERT time.
 */

import { getDb } from '@/lib/db/client';
import { authEventLog } from '@/lib/db/schema';

import { truncateUserAgent } from './truncate-user-agent';

export type AuthEventOutcome =
  | 'accepted-sso-auto'
  | 'rejected-public-domain'
  | 'rejected-multiple-matches'
  | 'rejected-no-match'
  | 'rejected-race'
  | 'rejected-csrf'
  | 'rejected-replay'
  | 'rejected-cross-idp'
  | 'rejected-pre-existing-binding'
  | 'email-not-verified';

export type AuthEventInput = {
  readonly ssoProvider: string;
  readonly iss: string;
  readonly emailHash: string;
  readonly ssoSubjectHash: string | null;
  readonly ip: string | null;
  readonly city: string | null;
  readonly userAgent: string | null;
  readonly outcome: AuthEventOutcome;
};

/**
 * Insert one row in `auth_event_log` for an SSO sign-in attempt.
 *
 * Caller MUST pass peppered hashes (NEVER raw email / subject). The
 * function applies `truncateUserAgent` to `user_agent` so callers do not
 * need to pre-truncate. `occurred_at` defaults to `now()` at the DB layer
 * (column DEFAULT in schema).
 */
export const writeAuthEvent = async (input: AuthEventInput): Promise<void> => {
  const db = getDb();
  await db.insert(authEventLog).values({
    ssoProvider: input.ssoProvider,
    iss: input.iss,
    emailHash: input.emailHash,
    ssoSubjectHash: input.ssoSubjectHash,
    ip: input.ip,
    city: input.city,
    userAgent: input.userAgent === null ? null : truncateUserAgent(input.userAgent),
    outcome: input.outcome,
  });
};
