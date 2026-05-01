/**
 * Email hashing + domain extraction for the onboarding redemption-log.
 *
 * Why peppered SHA-256 (not bcrypt, not plain SHA-256):
 * - We need to count *unique emails that tried to redeem* without storing the
 *   email itself. SHA-256 is fast and deterministic — perfect for an audit
 *   index where each row is checked rarely; bcrypt would add latency to the
 *   redeem hot path with no security benefit (we never compare hashes).
 * - The pepper prevents a leaked DB from being trivially reversed via a
 *   rainbow table of common emails. Because the pepper lives in the
 *   environment (not the DB), an attacker would need both the DB dump AND
 *   process-level access to mount a brute-force.
 *
 * Why the pepper is env-supplied:
 * - It's a long-lived secret rotatable independently of the database. Putting
 *   it in `process.env.ONBOARDING_EMAIL_HASH_PEPPER` mirrors the existing
 *   `AUTH_SECRET` posture (see `auth.ts`).
 * - In development we fall back to a deterministic constant so local dev/test
 *   doesn't require any setup; production REFUSES to boot without an
 *   explicit value (boot guard — TC-I-03 / REQ-5).
 *
 * Normalization rules applied before hashing:
 * - Unicode NFC normalization so canonically equivalent strings produce the
 *   same hash (e.g. precomposed `í` U+00ED vs `i` + combining acute U+0301).
 * - Lower-cased so `Alice@X.COM` and `alice@x.com` collapse to one identity.
 *
 * The companion `emailDomain` helper extracts the part after the last `@`
 * (RFC-5321 quoted-local-parts split on the LAST `@`) and lower-cases it.
 * The redemption log stores `email_domain` for coarse audit signal alongside
 * `email_hash`; the two columns together cost ~80 bytes/row.
 */
import { createHash } from 'node:crypto';

/**
 * Deterministic pepper used in non-production environments. Keeping the
 * fallback shared across dev/test means hashes are reproducible across
 * developer machines and CI without anyone needing to set the env var.
 */
const DEV_PEPPER_FALLBACK = 'tokenfx-dev-pepper';

/**
 * Resolves the pepper at call time. Production with no pepper throws to
 * refuse hashing rather than silently using a weak default. The check is
 * lazy (per-call) so test fixtures that flip `NODE_ENV` between cases work
 * predictably without module-evaluation order surprises.
 */
const getPepper = (): string => {
  const env = process.env.ONBOARDING_EMAIL_HASH_PEPPER;
  if (env !== undefined && env !== '') return env;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ONBOARDING_EMAIL_HASH_PEPPER is required in production. Refusing to hash with a dev fallback.',
    );
  }
  return DEV_PEPPER_FALLBACK;
};

/**
 * Boot-time guard (REQ-5): refuse to start the server in production
 * without a pepper. Mirrors the `AUTH_SECRET` boot guard in `auth.ts`
 * — fails fast at module evaluation rather than waiting for the first
 * `hashEmail()` call. Test runs (NODE_ENV=test, SKIP_PG_TESTS=1) are
 * exempt so vitest can flip env vars per-case without a module reload.
 *
 * Re-runs `getPepper()` for its side effect (the throw); the return
 * value is intentionally discarded. This file is imported by
 * `redeem.ts` and the redemption-log writer, both of which load eagerly
 * with the server, so the guard fires at boot.
 */
export const assertEmailHashPepperConfigured = (): void => {
  if (process.env.NODE_ENV !== 'production') return;
  // Re-derive: throws iff the prod env has no pepper set.
  void getPepper();
};

if (process.env.NODE_ENV === 'production') {
  assertEmailHashPepperConfigured();
}

/**
 * Hashes an email for the onboarding redemption log.
 *
 * @param email - The raw email as submitted by the client.
 * @param pepper - Optional explicit pepper. When omitted, the env-resolved
 *   pepper is used. Tests pass an explicit pepper to assert determinism /
 *   pepper-divergence without touching `process.env`.
 * @returns Hex-encoded SHA-256 of `nfc(lower(email)) + pepper`.
 */
export const hashEmail = (email: string, pepper?: string): string => {
  const normalized = email.normalize('NFC').toLowerCase();
  const p = pepper ?? getPepper();
  return createHash('sha256').update(normalized + p).digest('hex');
};

/**
 * Extracts the domain portion of an email (lower-cased) for coarse audit
 * logging. Splits on the LAST `@` so RFC-5321 quoted local-parts containing
 * `@` (e.g. `"a@b"@x.com`) still resolve to the right domain. Returns
 * `'unknown'` for malformed inputs without an `@` so the caller can always
 * insert a non-NULL value into `onboarding_redemption_log.email_domain`.
 */
export const emailDomain = (email: string): string => {
  const idx = email.lastIndexOf('@');
  return idx >= 0 ? email.slice(idx + 1).toLowerCase() : 'unknown';
};
