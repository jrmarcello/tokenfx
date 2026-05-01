import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hashEmail, emailDomain } from './email-hash';

/**
 * Env-restoration helper. Each test that toggles
 * `NODE_ENV` / `ONBOARDING_EMAIL_HASH_PEPPER` snapshots the prior values and
 * restores them in `afterEach` so we never leak state between tests.
 */
const ENV_KEYS = ['NODE_ENV', 'ONBOARDING_EMAIL_HASH_PEPPER'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let snapshot: Partial<Record<EnvKey, string | undefined>> = {};

// `process.env.NODE_ENV` is typed as `readonly` in @types/node ≥ 20. We need
// to flip it per test (boot guard requires NODE_ENV=production); the cast to
// a mutable record narrows that read-only constraint without disabling
// strict mode globally. Restored in afterEach so no cross-test leak.
const mutableEnv = process.env as Record<string, string | undefined>;
const setEnv = (key: EnvKey, value: string | undefined): void => {
  if (value === undefined) {
    delete mutableEnv[key];
    return;
  }
  mutableEnv[key] = value;
};

beforeEach(() => {
  snapshot = {
    NODE_ENV: process.env.NODE_ENV,
    ONBOARDING_EMAIL_HASH_PEPPER: process.env.ONBOARDING_EMAIL_HASH_PEPPER,
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    setEnv(key, snapshot[key]);
  }
});

describe('hashEmail', () => {
  it('is deterministic: same email + same pepper → same hash', () => {
    const a = hashEmail('alice@x.com', 'pepper-a');
    const b = hashEmail('alice@x.com', 'pepper-a');
    expect(a).toBe(b);
  });

  it('is case-insensitive: Alice@X.COM and alice@x.com produce the same hash', () => {
    const upper = hashEmail('Alice@X.COM', 'pepper-a');
    const lower = hashEmail('alice@x.com', 'pepper-a');
    expect(upper).toBe(lower);
  });

  it('is NFC-normalized: composed and decomposed forms produce the same hash', () => {
    // U+00ED (precomposed "í") vs U+0069 + U+0301 (i + combining acute)
    const composed = 'alíce@x.com';
    const decomposed = 'alíce@x.com';
    expect(hashEmail(composed, 'pepper-a')).toBe(
      hashEmail(decomposed, 'pepper-a'),
    );
  });

  it('produces different hashes for different emails', () => {
    const a = hashEmail('alice@x.com', 'pepper-a');
    const b = hashEmail('bob@x.com', 'pepper-a');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different peppers', () => {
    const a = hashEmail('alice@x.com', 'pepper-a');
    const b = hashEmail('alice@x.com', 'pepper-b');
    expect(a).not.toBe(b);
  });

  it('boot guard (TC-I-03): production with no pepper throws on first call', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('ONBOARDING_EMAIL_HASH_PEPPER', undefined);
    expect(() => hashEmail('alice@x.com')).toThrow(
      /ONBOARDING_EMAIL_HASH_PEPPER is required in production/,
    );
  });

  it('boot guard: production with pepper set does NOT throw', () => {
    setEnv('NODE_ENV', 'production');
    setEnv('ONBOARDING_EMAIL_HASH_PEPPER', 'prod-pepper-value');
    expect(() => hashEmail('alice@x.com')).not.toThrow();
  });

  it('dev fallback: non-production with no pepper uses dev fallback (no throw)', () => {
    setEnv('NODE_ENV', 'development');
    setEnv('ONBOARDING_EMAIL_HASH_PEPPER', undefined);
    expect(() => hashEmail('alice@x.com')).not.toThrow();
  });
});

describe('emailDomain', () => {
  it('returns the lowercased domain after the last @', () => {
    expect(emailDomain('alice@Example.COM')).toBe('example.com');
  });

  it('handles emails with multiple @ by splitting on the LAST @', () => {
    // RFC 5321 quoted local-parts can technically contain `@`. We treat the
    // last `@` as the separator (matches `parseaddr`-style behavior).
    expect(emailDomain('"a@b"@x.com')).toBe('x.com');
  });

  it('returns "unknown" when the email has no @', () => {
    expect(emailDomain('not-an-email')).toBe('unknown');
  });
});
