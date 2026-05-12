/**
 * Redemption-log writer (central-server-onboarding REQ-2, REQ-28).
 *
 * One row per redeem attempt that reaches the DB layer (rate-limited and
 * Zod-rejected requests are NOT logged here — see REQ-27 step 0/1 + the
 * route handler. That guard sits ABOVE this helper so DoS-amplification
 * attackers can't fill the log table by spraying garbage).
 *
 * Privacy invariant: this module NEVER writes `claimed_email` to the row.
 * Callers pass an already-derived `emailDomain` (coarse audit signal) and
 * `emailHash` (peppered SHA-256 — see `lib/auth/email-hash.ts`). Storing
 * the raw email here would silently break TC-I-57's column-scan assertion.
 *
 * The `outcome` value is the pgEnum from `onboardingOutcomeEnum`. We accept
 * the type alias `OnboardingOutcome` rather than a wider `string` so a typo
 * in a calling site fails at compile time.
 */
import { onboardingRedemptionLog } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Pre-existing pgEnum literals — keep in sync with `onboardingOutcomeEnum`
 * in `lib/db/schema.ts`. Using a TS literal union (instead of importing the
 * Drizzle enum's value type) gives IDEs better autocomplete and lets the
 * test stubs reference the strings directly.
 */
export type OnboardingOutcome =
  // v1 values (migration 0001)
  | 'accepted'
  | 'token-invalid'
  | 'token-expired'
  | 'token-revoked'
  | 'token-exhausted'
  | 'email-mismatch'
  | 'rate-limited'
  | 'validation-error'
  | 'infra-error'
  // v2 SSO-auto values (migration 0004 — central-server-onboarding-v2-sso).
  // Inserted by the auto-provision flow (TASK-10) into
  // `onboarding_redemption_log` with `method='sso-auto'`.
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

export type WriteRedemptionLogParams = {
  /** First 8 chars of the redeem token. The full token is NEVER logged. */
  tokenPrefix: string;
  /** UUID — NULL on rejection (no `user_machines` row was created). */
  machineId: string | null;
  /** Lower-cased domain after the last `@`. Always non-NULL. */
  emailDomain: string;
  /** Peppered SHA-256 hex; `lib/auth/email-hash.ts:hashEmail` is the only producer. */
  emailHash: string;
  /** Truncated /24 (IPv4) or /48 (IPv6). Already redacted by the caller. */
  requestIp: string | null;
  outcome: OnboardingOutcome;
  /**
   * Provenance of this redemption row. 'manual-token' (default) for the v1
   * invite-token redeem flow. 'sso-auto' for SSO auto-provision rows written
   * by `evaluateAutoProvision` (central-server-onboarding-v2-sso, TASK-10).
   * Constrained by the `onboarding_redemption_log_method_check` CHECK.
   */
  method?: 'manual-token' | 'sso-auto';
  /** SSO context — populated only when `method='sso-auto'`. NULL otherwise. */
  ssoProvider?: string | null;
  /** Peppered SHA-256 hex of the SSO subject (`sub`). NEVER the raw value. */
  ssoSubjectHash?: string | null;
  /** OIDC issuer URL (`iss`). NULL for manual-token flow. */
  iss?: string | null;
  /** Full UA — caller is responsible for truncation if required at storage. */
  userAgent?: string | null;
};

/**
 * Insert a row into `onboarding_redemption_log`. Accepts either the top-level
 * Drizzle `Db` or a `DrizzleTx` so the redeem flow can write inside its own
 * transaction (atomic with the user_machines INSERT) while other callers
 * (e.g. future direct-from-route writes for rate-limited-but-still-logged
 * cases) can pass `db` directly.
 */
export const writeRedemptionLog = async (
  db: Db | DrizzleTx,
  params: WriteRedemptionLogParams,
): Promise<void> => {
  await db.insert(onboardingRedemptionLog).values({
    tokenPrefix: params.tokenPrefix,
    machineId: params.machineId,
    emailDomain: params.emailDomain,
    emailHash: params.emailHash,
    requestIp: params.requestIp,
    outcome: params.outcome,
    // Optional SSO-flow columns — omitted defaults to the column's own
    // DEFAULT ('manual-token' for `method`; NULL for the SSO fields).
    ...(params.method !== undefined ? { method: params.method } : {}),
    ...(params.ssoProvider !== undefined ? { ssoProvider: params.ssoProvider } : {}),
    ...(params.ssoSubjectHash !== undefined
      ? { ssoSubjectHash: params.ssoSubjectHash }
      : {}),
    ...(params.iss !== undefined ? { iss: params.iss } : {}),
    ...(params.userAgent !== undefined ? { userAgent: params.userAgent } : {}),
  });
};
