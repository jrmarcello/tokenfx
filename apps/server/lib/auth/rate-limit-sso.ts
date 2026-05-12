import {
  checkRateLimits,
  type RateLimitDimensionInput,
  type RateLimitResult,
} from '@/lib/queries/rate-limit';

export type SsoRateLimitInput = {
  ip: string;
  emailHash: string;
  ssoSubjectHash: string | null;
};

/**
 * Layered SSO sign-in rate-limit (3 dimensions, first-violation
 * short-circuits per `checkRateLimits` semantics):
 *
 *   per-IP            : 10 attempts / 5 min  (anti-burst from one origin)
 *   per-email-hash    : 3  / 24h            (anti-enumeration per identity)
 *   per-sso-subject   : 5  / 24h            (anti-cred-stuffing per subject)
 *
 * Threat-model references: Threat 6 M6.2 (enumeration), backed by spec b
 * §Decisão #5. In-memory sliding window per process (same constraint as
 * v1 redeem-flow rate-limit; shared-store upgrade deferred).
 *
 * `ssoSubjectHash` is nullable because rate-limit fires BEFORE OAuth
 * callback completes in some flows (e.g., during signin initiation, the
 * subject claim is not yet known). When null, only ip + emailHash
 * dimensions are checked.
 */
export const checkSsoRateLimit = (input: SsoRateLimitInput): RateLimitResult => {
  const dimensions: RateLimitDimensionInput[] = [];
  // SECURITY: when `ip` is empty (TASK-11 known gap — NextAuth signIn
  // callback doesn't surface request context), the per-IP dimension would
  // collapse every attempt into a single bucket, creating a DoS-amplification
  // vector against the (per-email_hash + per-sso_subject_hash) dimensions for
  // a victim. Skip the per-IP dimension when ip is empty — the per-email_hash
  // (3/24h) and per-sso_subject_hash (5/24h) caps still bound attacker reach.
  if (input.ip.length > 0) {
    dimensions.push({
      name: 'ip',
      key: input.ip,
      limit: 10,
      windowMs: 5 * 60 * 1000,
    });
  }
  dimensions.push({
    name: 'email_hash',
    key: input.emailHash,
    limit: 3,
    windowMs: 24 * 60 * 60 * 1000,
  });
  if (input.ssoSubjectHash !== null) {
    dimensions.push({
      name: 'sso_subject_hash',
      key: input.ssoSubjectHash,
      limit: 5,
      windowMs: 24 * 60 * 60 * 1000,
    });
  }
  return checkRateLimits(dimensions);
};

/**
 * Test seam: clears all SSO rate-limit counters. Mirrors
 * `__resetRateLimits` from `lib/queries/rate-limit.ts`.
 */
export { __resetRateLimits as __resetSsoRateLimit } from '@/lib/queries/rate-limit';
