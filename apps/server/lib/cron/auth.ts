import { timingSafeEqual } from 'node:crypto';

/**
 * Environments where `INTERNAL_CRON_SECRET` MUST be configured at boot. Any
 * env outside this set (development, test, undefined, ad-hoc) bypasses the
 * guard so local dev and unit tests don't need to seed the secret at process
 * spawn time. The runtime fallback in `assertInternalCronAuth` below still
 * defensively rejects empty-secret configurations regardless of environment.
 */
const STRICT_ENVS: ReadonlySet<string> = new Set(['production', 'staging']);

/**
 * Boot-time guard, factored as a pure helper so it can be exercised without
 * `vi.stubEnv` gymnastics. If `NODE_ENV` is in {production, staging} AND
 * `INTERNAL_CRON_SECRET` is unset OR an empty string, throw.
 *
 * Mirrors the `AUTH_SECRET` guard in `apps/server/lib/auth/auth.ts:18-26`.
 *
 * Why empty-string is rejected: `Buffer.from('')` and `Buffer.from('')` are
 * both zero-length buffers, and `timingSafeEqual` on two zero-length buffers
 * returns `true`. Without this guard, an empty `INTERNAL_CRON_SECRET` would
 * let any cron caller (including one that omits the header entirely — see
 * the `?? ''` fallback in `assertInternalCronAuth`) authenticate. Better to
 * refuse to boot.
 *
 * Why staging is included: staging environments handle production-shaped
 * traffic and must enforce the same auth posture as production. A
 * misconfigured staging deploy that silently boots without a secret would
 * accept any caller — same blast radius as production. The cost of failing
 * fast is a clear error message at boot; the cost of NOT failing fast is a
 * silently unauthenticated endpoint.
 */
export const assertCronSecretConfigured = (
  env: NodeJS.ProcessEnv,
): void => {
  const nodeEnv = env.NODE_ENV ?? '';
  if (!STRICT_ENVS.has(nodeEnv)) {
    return;
  }
  const secret = env.INTERNAL_CRON_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      'INTERNAL_CRON_SECRET required in production/staging. Refusing to boot — an empty secret would let any cron caller pass timingSafeEqual.',
    );
  }
};

assertCronSecretConfigured(process.env);

/**
 * Auth failure surfaced by `assertInternalCronAuth`. Routes catch this and
 * return a 401 response. The status field is read by the route handler.
 */
export class CronAuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'CronAuthError';
  }
}

/**
 * Asserts the request carries the correct `x-internal-cron-secret` header.
 *
 * Uses `timingSafeEqual` to defeat timing attacks. Throws `CronAuthError`
 * (status 401) on any mismatch — missing header, wrong value, length
 * mismatch, or empty configuration. Returns `void` on success.
 *
 * `timingSafeEqual` requires equal-length buffers (it throws `RangeError`
 * otherwise), so we short-circuit on a length mismatch first and treat that
 * as a non-match — the user-visible behavior is still a clean 401, never a
 * 500 from the RangeError.
 */
export const assertInternalCronAuth = (req: Request): void => {
  const provided = req.headers.get('x-internal-cron-secret') ?? '';
  const expected = process.env.INTERNAL_CRON_SECRET ?? '';

  // Defensive runtime check — the boot guard already covers production/staging,
  // but in test/dev a missing secret should still produce a clean 401 instead
  // of accidentally letting a zero-length match through.
  if (expected.length === 0) {
    throw new CronAuthError('INTERNAL_CRON_SECRET not configured');
  }

  if (provided.length !== expected.length) {
    throw new CronAuthError('cron auth mismatch');
  }

  const ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    throw new CronAuthError('cron auth mismatch');
  }
};
