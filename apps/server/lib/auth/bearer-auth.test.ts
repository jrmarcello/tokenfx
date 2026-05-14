/**
 * Unit tests for `bearer-auth.ts`.
 *
 * Covers:
 *   - `parseBearerAuthorization` — RFC 7235 scheme parsing (happy + edge).
 *   - `verifyKeySecret` — bcrypt verification + cache rotation invariant
 *     (REQ-23 / TC-U-27, TC-U-28, TC-U-28b).
 *
 * Conventions:
 *   - Hand-written stubs only (no mocking framework).
 *   - `bcrypt` is injected via the `deps` parameter to `verifyKeySecret`
 *     so tests can count compare calls deterministically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';

import {
  BCRYPT_COST,
  __hasCachedVerification,
  __resetIngestAuthCache,
  parseBearerAuthorization,
  verifyKeySecret,
} from './bearer-auth';

/**
 * Hand-written bcrypt stub: counts `compare` calls and returns a result
 * determined by a per-call predicate. No mocking framework; we just hand
 * the function in via the `deps` DI seam.
 */
type BcryptDep = { compare: typeof bcrypt.compare };

const makeCountingBcrypt = (
  predicate: (secret: string, hash: string) => boolean,
): { dep: BcryptDep; calls: { count: number } } => {
  const calls = { count: 0 };
  const dep: BcryptDep = {
    // Match bcrypt.compare's overloaded signature. We only need the Promise
    // overload; the callback overload is irrelevant in this codebase.
    compare: (async (secret: string, hash: string): Promise<boolean> => {
      calls.count += 1;
      return predicate(secret, hash);
    }) as typeof bcrypt.compare,
  };
  return { dep, calls };
};

describe('parseBearerAuthorization', () => {
  it.each([
    { header: 'Bearer abc', expected: { ok: true, value: 'abc' } },
    { header: 'bearer abc', expected: { ok: true, value: 'abc' } },
    { header: 'BEARER abc', expected: { ok: true, value: 'abc' } },
    { header: 'Bearer   token-with-spaces-skipped', expected: { ok: true, value: 'token-with-spaces-skipped' } },
  ])('accepts valid header $header', ({ header, expected }) => {
    expect(parseBearerAuthorization(header)).toEqual(expected);
  });

  it.each([
    { header: null, label: 'null' },
    { header: '', label: 'empty string' },
    { header: 'BearerXYZ', label: 'missing space' },
    { header: 'Basic abc', label: 'wrong scheme' },
    { header: 'Token xxx', label: 'wrong scheme (Token)' },
    { header: 'Bearer ', label: 'empty token after scheme' },
    { header: 'Bearer    ', label: 'all-space token' },
    { header: '  Bearer x', label: 'leading whitespace' },
    { header: 'Bearer x  ', label: 'trailing whitespace' },
    { header: 'Bearer a b', label: 'embedded whitespace in token' },
  ])('rejects $label', ({ header }) => {
    expect(parseBearerAuthorization(header)).toEqual({ ok: false });
  });
});

describe('BCRYPT_COST', () => {
  it('is exported as 10 (Auth0/Stripe minimum recommendation)', () => {
    expect(BCRYPT_COST).toBe(10);
  });
});

describe('verifyKeySecret', () => {
  afterEach(() => {
    __resetIngestAuthCache();
    vi.useRealTimers();
  });

  const KEY_ID = 'k_test';
  const P1 = 'plaintext-secret-one';
  const H1 = '$2b$10$hash-for-P1';
  const H2 = '$2b$10$hash-for-P2';

  it('TC-U-27 (security): rejects rotated-hash mismatch immediately (no 60s stale)', async () => {
    // First call: P1 valid vs H1. Cache populates with secretHash=H1.
    const first = makeCountingBcrypt((secret, hash) => secret === P1 && hash === H1);
    expect(await verifyKeySecret(KEY_ID, P1, H1, { bcrypt: first.dep })).toBe(true);
    expect(first.calls.count).toBe(1);
    expect(__hasCachedVerification(KEY_ID)).toBe(true);

    // DB hash rotates to H2. Caller submits P1 again. P1 is valid vs H1
    // but invalid vs H2. Expected: false IMMEDIATELY, no cache-skip.
    // bcrypt is invoked with (P1, H2) and returns false.
    const second = makeCountingBcrypt((secret, hash) => secret === P1 && hash === H1);
    expect(await verifyKeySecret(KEY_ID, P1, H2, { bcrypt: second.dep })).toBe(false);
    // bcrypt MUST be called — the design forbids cache-skip.
    expect(second.calls.count).toBe(1);
    // Defensive: cache entry for KEY_ID is cleared after a rotation mismatch.
    expect(__hasCachedVerification(KEY_ID)).toBe(false);
  });

  it('TC-U-28 (happy): 2nd call with same plaintext+hash still runs bcrypt (no skip)', async () => {
    // The spec REQ-23 explicitly removes the bcrypt-skip optimization.
    // Both calls must invoke bcrypt.compare. The cache exists only to
    // detect rotation; it never short-circuits verification.
    const counting = makeCountingBcrypt((secret, hash) => secret === P1 && hash === H1);

    expect(await verifyKeySecret(KEY_ID, P1, H1, { bcrypt: counting.dep })).toBe(true);
    expect(counting.calls.count).toBe(1);

    expect(await verifyKeySecret(KEY_ID, P1, H1, { bcrypt: counting.dep })).toBe(true);
    expect(counting.calls.count).toBe(2);
  });

  it('TC-U-28b (edge): cache hit with TTL expired re-runs bcrypt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const first = makeCountingBcrypt((secret, hash) => secret === P1 && hash === H1);
    expect(await verifyKeySecret(KEY_ID, P1, H1, { bcrypt: first.dep })).toBe(true);
    expect(first.calls.count).toBe(1);
    expect(__hasCachedVerification(KEY_ID)).toBe(true);

    // Advance 61s — past TTL (60s).
    vi.advanceTimersByTime(61_000);
    expect(__hasCachedVerification(KEY_ID)).toBe(false);

    const second = makeCountingBcrypt((secret, hash) => secret === P1 && hash === H1);
    expect(await verifyKeySecret(KEY_ID, P1, H1, { bcrypt: second.dep })).toBe(true);
    // bcrypt re-runs because the cache entry was stale (expired TTL).
    expect(second.calls.count).toBe(1);
    // Cache re-populated.
    expect(__hasCachedVerification(KEY_ID)).toBe(true);
  });

  it('returns false for invalid plaintext on cold cache and does NOT populate cache', async () => {
    const counting = makeCountingBcrypt(() => false);
    expect(await verifyKeySecret(KEY_ID, 'wrong-secret', H1, { bcrypt: counting.dep })).toBe(false);
    expect(counting.calls.count).toBe(1);
    expect(__hasCachedVerification(KEY_ID)).toBe(false);
  });

  it('defaults to the real bcrypt module when deps is omitted (DI seam preserves behavior)', async () => {
    // Hash P1 with the real bcrypt at the configured cost, then verify.
    // This guards against a regression where the DI seam shadows the
    // production bcrypt import.
    const realHash = await bcrypt.hash(P1, BCRYPT_COST);
    expect(await verifyKeySecret(KEY_ID, P1, realHash)).toBe(true);
    expect(__hasCachedVerification(KEY_ID)).toBe(true);
    expect(await verifyKeySecret(KEY_ID, 'wrong', realHash)).toBe(false);
  });
});
