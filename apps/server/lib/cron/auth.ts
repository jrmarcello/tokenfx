import { timingSafeEqual } from 'node:crypto';

/**
 * Boot-time guard. If `NODE_ENV='production'` AND `INTERNAL_CRON_SECRET` is
 * unset OR an empty string, throw at module-evaluation time.
 *
 * Mirrors the `AUTH_SECRET` guard in `apps/server/lib/auth/auth.ts:18-26`.
 *
 * Why empty-string is rejected: `Buffer.from('')` and `Buffer.from('')` are
 * both zero-length buffers, and `timingSafeEqual` on two zero-length buffers
 * returns `true`. Without this guard, an empty `INTERNAL_CRON_SECRET` would
 * let any cron caller (including one that omits the header entirely — see
 * the `?? ''` fallback below) authenticate. Better to refuse to boot.
 *
 * Test runs (`NODE_ENV !== 'production'`) bypass the guard so unit tests can
 * exercise individual code paths without seeding env vars at process spawn
 * time. The runtime fallback in `assertInternalCronAuth` below still
 * defensively rejects empty-secret configurations.
 */
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.INTERNAL_CRON_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      'INTERNAL_CRON_SECRET is required (non-empty) in production. Refusing to boot — an empty secret would let any cron caller pass timingSafeEqual.',
    );
  }
}

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

  // Defensive runtime check — the boot guard already covers production, but
  // in test/dev a missing secret should still produce a clean 401 instead of
  // accidentally letting a zero-length match through.
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
