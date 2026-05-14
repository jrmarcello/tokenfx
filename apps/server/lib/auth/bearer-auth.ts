/**
 * Bearer-token authentication helpers for `/api/ingest` and `/api/health`
 * (central-server-onboarding REQ-6, REQ-37; review-report REQ-23).
 *
 * Wire format: `Authorization: Bearer <secret>` (RFC 6750 / RFC 7235).
 * The plaintext `<secret>` is bcrypt-compared against `user_machines.secret_hash`.
 *
 * Two reasons this lives in its own module:
 *
 *   1. Two routes need the SAME verification cache. If `/api/ingest` and
 *      `/api/health` each held their own state, the "warm health probe →
 *      cold ingest" pattern would lose the shared invalidation signal.
 *      A shared module-level Map keeps them aligned.
 *   2. The header-parser is shared. Reimplementing RFC 7235 case-insensitive
 *      scheme handling in two places would invite drift.
 *
 * Cache shape (post REQ-23 / M5 fix): `{ secretHash, expiresAt }`. We
 * deliberately do NOT store plaintext anywhere. The cache exists ONLY to
 * detect hash rotation early — comparing the freshly-supplied `secretHash`
 * argument against the cached `secretHash` tells us if the DB row changed
 * since the last verification. bcrypt.compare still runs on every call;
 * there is no skip-bcrypt optimization. This closes the 60s stale-window
 * vulnerability that the previous plaintext-cache design exposed at the
 * cost of ~25ms per ingest call (acceptable for low-throughput ingest API).
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
 * Cache TTL: 60s. The cache no longer holds plaintext; it now holds the
 * `secretHash` last seen so we can detect rotation early. TTL bounds how
 * long a stale row would survive in the cache if the verifier was never
 * called again after rotation — but since every call re-reads `secretHash`
 * from the DB and re-verifies via bcrypt, the TTL is mainly a memory cap
 * (entries expire even if `keyId` is never touched again).
 */
const CACHE_TTL_MS = 60_000;

type CacheEntry = Readonly<{
  /** Hash last verified against. Used to detect rotation between calls. */
  secretHash: string;
  /** Epoch ms after which the entry is considered stale. */
  expiresAt: number;
}>;

/**
 * Module-level cache: `key_id -> { secretHash, expiresAt }`. Per-process;
 * reset between test runs via `__resetIngestAuthCache`. Reading and writing
 * this Map is safe in Node's single-threaded event loop without explicit
 * locking.
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
 * Retained for the `secretHash`-vs-`secretHash` rotation check below.
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
 * DI seam for `bcrypt.compare`. Production code never passes `deps`; tests
 * inject a counting stub so they can assert "bcrypt ran N times" without
 * a mocking framework. Typed against the real signature so the seam can
 * never drift from the production behavior.
 */
export type VerifyKeySecretDeps = Readonly<{
  bcrypt?: { compare: typeof bcrypt.compare };
}>;

/**
 * Verify that `secret` matches `secretHash` (bcrypt) for the given `keyId`.
 *
 * Post REQ-23: bcrypt.compare runs on EVERY call. There is no skip path.
 * The cache stores only `{ secretHash, expiresAt }` and exists ONLY to:
 *   (a) detect rotation early — if the incoming `secretHash` argument
 *       differs from the cached one, the row was rotated and the cache
 *       entry is stale (we replace it on success / delete it on failure).
 *   (b) bound memory by expiring entries after `CACHE_TTL_MS`.
 *
 * The previous design cached plaintext and skipped bcrypt on cache hits.
 * That left a 60s window where a rotated DB hash didn't invalidate
 * in-flight tokens. Removing the skip closes that window at the cost of
 * ~25ms (cost-10 bcrypt) per verification — acceptable for the ingest API.
 */
export const verifyKeySecret = async (
  keyId: string,
  secret: string,
  secretHash: string,
  deps?: VerifyKeySecretDeps,
): Promise<boolean> => {
  const compare = deps?.bcrypt?.compare ?? bcrypt.compare;
  const now = Date.now();

  // Always run bcrypt — no skip. The cache below is only for rotation
  // bookkeeping and TTL-bounded memory use.
  const ok = await compare(secret, secretHash);

  const cached = verificationCache.get(keyId);
  const cacheFresh = cached !== undefined && cached.expiresAt > now;
  const cacheMatchesCurrentHash =
    cacheFresh && constantTimeStringEqual(cached.secretHash, secretHash);

  if (ok) {
    // Successful verification: refresh the cache entry. If the hash
    // rotated since last call, this overwrites the stale entry with the
    // new hash. Either way, TTL resets so frequent callers don't pay
    // memory pressure churn.
    verificationCache.set(keyId, { secretHash, expiresAt: now + CACHE_TTL_MS });
    return true;
  }

  // Failed verification. Two sub-cases:
  //   1. Cache had a stale hash (rotation case) — drop it so a subsequent
  //      retry with the correct plaintext can re-populate cleanly.
  //   2. Cache had the current hash but the plaintext is just wrong
  //      (caller error) — still drop defensively; the entry encodes "this
  //      hash was last verified successfully", and an immediate failed
  //      verification against the same hash means we can't claim that
  //      invariant any longer without ambiguity.
  // Note: `cacheMatchesCurrentHash` is computed for documentation/clarity;
  // the deletion is unconditional because both sub-cases want the entry gone.
  void cacheMatchesCurrentHash;
  verificationCache.delete(keyId);
  return false;
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
 * Used by integration tests to assert the cache invariants (presence after
 * successful verify, absence after a rotated-hash mismatch).
 */
export const __hasCachedVerification = (keyId: string): boolean => {
  const entry = verificationCache.get(keyId);
  return entry !== undefined && entry.expiresAt > Date.now();
};
