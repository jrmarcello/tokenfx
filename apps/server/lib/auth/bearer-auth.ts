/**
 * Bearer-token authentication helpers for `/api/ingest` and `/api/health`
 * (central-server-onboarding REQ-6, REQ-37).
 *
 * Wire format: `Authorization: Bearer <secret>` (RFC 6750 / RFC 7235).
 * The plaintext `<secret>` is bcrypt-compared against `user_machines.secret_hash`.
 *
 * Two reasons this lives in its own module:
 *
 *   1. Two routes need the SAME verification cache. If `/api/ingest` and
 *      `/api/health` each held their own `Map<key_id, plaintext>`, the
 *      "warm health probe → cold ingest" pattern would pay bcrypt twice.
 *      A shared module-level Map keeps them aligned.
 *   2. The header-parser is shared. Reimplementing RFC 7235 case-insensitive
 *      scheme handling in two places would invite drift.
 *
 * Cache trade-off: plaintext secrets sit in process memory for up to 60s
 * after the first successful verification. Process memory is the existing
 * trust boundary — an attacker with code execution in the server process
 * already has the DB connection string. The cache is never persisted, never
 * logged, never serialized.
 *
 * Bcrypt cost: 10 (~25ms on commodity hardware). Industry minimum
 * recommendation per Auth0/Stripe — cost 12 (~100ms) saturates the ingest
 * hot path at ~40 pushes/sec/core, which is unacceptable for the dashboard's
 * batch sizes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';

/**
 * Bcrypt cost factor used by the seed and the verifier. Exported so tests
 * and the seed share one source of truth (no drift between hashing-side and
 * verifying-side configuration).
 */
export const BCRYPT_COST = 10;

/**
 * Cache TTL: 60s. Matches the plaintext window the server is willing to
 * keep in memory. Picked at the small end of the credible range — long
 * enough to cover a typical batch interval, short enough that a stolen
 * Bearer is still rate-limited by bcrypt within a minute.
 */
const CACHE_TTL_MS = 60_000;

type CacheEntry = {
  /** Plaintext secret last verified. */
  readonly plaintext: string;
  /** Epoch ms after which the entry is considered stale. */
  readonly expiresAt: number;
};

/**
 * Module-level cache: `key_id -> plaintext`. Per-process; reset between
 * test runs via `__resetIngestAuthCache`. Reading and writing this Map is
 * safe in Node's single-threaded event loop without explicit locking.
 */
const verificationCache = new Map<string, CacheEntry>();

/**
 * Constant-time string comparison via byte-equal Buffer + bitwise XOR.
 *
 * `crypto.timingSafeEqual` requires equal-length buffers; we hash both sides
 * to fixed-width before comparing so an attacker cannot probe length via
 * timing. Hashing here is NOT for security (the inputs are already the
 * authenticated secret on both sides); it normalizes length and lets
 * `timingSafeEqual` work safely.
 *
 * Using a plain `===` would be fine for trust-boundary semantics (we already
 * verified the secret via bcrypt), but the spec asks for "constant-time
 * string-compare (microseconds)" so we use the dedicated primitive.
 */
const constantTimeStringEqual = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
};

export type BearerParseResult =
  | { ok: true; value: string }
  | { ok: false };

/**
 * Parse an `Authorization` header value, returning the bearer token if and
 * only if the scheme is `bearer` (case-insensitive per RFC 7235 §2.1) and
 * the token is non-empty.
 *
 * Rejected cases (all return `{ok: false}`):
 *   - `null` (header absent)
 *   - empty string
 *   - missing space (`BearerXYZ`)
 *   - wrong scheme (`Basic abc`, `Token xxx`)
 *   - empty token (`Bearer `, `Bearer    `)
 *   - leading/trailing whitespace on the header value (`  Bearer x`)
 *
 * The token itself is taken verbatim — we don't trim it, because RFC 6750
 * tokens are opaque and a token with embedded whitespace would be
 * cryptographically invalid anyway (bcrypt would reject it on the next step).
 */
export const parseBearerAuthorization = (
  header: string | null,
): BearerParseResult => {
  if (header === null) return { ok: false };
  // Reject leading/trailing whitespace explicitly. Per RFC 7230, header
  // field values shouldn't carry surrounding OWS once parsed; if a client
  // sends padded values we treat it as malformed to keep the parse strict.
  if (header !== header.trim()) return { ok: false };
  // Find the first whitespace to split scheme/token. RFC 7235 BNF is
  // `auth-scheme 1*SP token68` — exactly one space is the common case but
  // 1+ spaces is permitted. We accept 1+ to be lenient with proxies.
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx <= 0) return { ok: false };
  const scheme = header.slice(0, spaceIdx);
  if (scheme.toLowerCase() !== 'bearer') return { ok: false };
  // Skip the run of spaces after the scheme.
  let tokenStart = spaceIdx + 1;
  while (tokenStart < header.length && header[tokenStart] === ' ') {
    tokenStart += 1;
  }
  if (tokenStart >= header.length) return { ok: false };
  const token = header.slice(tokenStart);
  if (token.length === 0) return { ok: false };
  // Reject embedded whitespace in the token (defensive; bearer tokens per
  // RFC 6750 are token68 = ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/"
  // optionally with "=" padding — never SP).
  if (/\s/.test(token)) return { ok: false };
  return { ok: true, value: token };
};

/**
 * Verify that `secret` matches `secretHash` (bcrypt) for the given `keyId`.
 *
 * Cache flow:
 *   - Cache hit AND TTL valid: constant-time compare against cached plaintext.
 *     - Match → return true (skip bcrypt entirely).
 *     - Mismatch → fall through to bcrypt.compare (don't blindly reject; the
 *       cached plaintext could be stale if the secret was just rotated).
 *   - Cache miss OR TTL expired: bcrypt.compare. On match, update the cache.
 *
 * The cache stores plaintext only AFTER bcrypt confirms it (we never seed
 * the cache with an unverified value). Plaintext lifetime ≤ TTL.
 */
export const verifyKeySecret = async (
  keyId: string,
  secret: string,
  secretHash: string,
): Promise<boolean> => {
  const now = Date.now();
  const cached = verificationCache.get(keyId);
  if (cached && cached.expiresAt > now) {
    if (constantTimeStringEqual(cached.plaintext, secret)) {
      return true;
    }
    // Cached secret didn't match — either the caller has the wrong secret,
    // or the secret was rotated. Fall through to bcrypt.
  }

  const ok = await bcrypt.compare(secret, secretHash);
  if (!ok) return false;

  verificationCache.set(keyId, {
    plaintext: secret,
    expiresAt: now + CACHE_TTL_MS,
  });
  return true;
};

/**
 * Test-only: clear the verification cache. Both `/api/ingest` and
 * `/api/health` re-export this so test files can reset auth state without
 * importing this module directly.
 */
export const __resetIngestAuthCache = (): void => {
  verificationCache.clear();
};

/**
 * Test-only: probe whether a `keyId` currently has a fresh cache entry.
 * Used by TC-I-71e to assert the bcrypt-skip path was taken.
 */
export const __hasCachedVerification = (keyId: string): boolean => {
  const entry = verificationCache.get(keyId);
  return entry !== undefined && entry.expiresAt > Date.now();
};
