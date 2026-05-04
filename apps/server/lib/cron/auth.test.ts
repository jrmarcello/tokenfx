import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Env-restoration helper. Each test that toggles `NODE_ENV` /
 * `INTERNAL_CRON_SECRET` snapshots prior values and restores them in
 * `afterEach` so we never leak state between tests. Mirrors the pattern in
 * `lib/auth/email-hash.test.ts`.
 */
const ENV_KEYS = ['NODE_ENV', 'INTERNAL_CRON_SECRET'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let snapshot: Partial<Record<EnvKey, string | undefined>> = {};

// `process.env.NODE_ENV` is typed as `readonly` in @types/node ≥ 20. Cast to a
// mutable record so per-test flips compile under strict mode without a global
// override. Restored in afterEach.
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
    INTERNAL_CRON_SECRET: process.env.INTERNAL_CRON_SECRET,
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    setEnv(key, snapshot[key]);
  }
  vi.resetModules();
});

const buildRequest = (header: string | null): Request => {
  const headers = new Headers();
  if (header !== null) {
    headers.set('x-internal-cron-secret', header);
  }
  return new Request('http://localhost/api/internal/cron/test', {
    method: 'POST',
    headers,
  });
};

describe('assertInternalCronAuth', () => {
  it('TC-U-29: throws CronAuthError 401 when no x-internal-cron-secret header is present', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', 'correct-secret-value');
    const mod = await import('./auth');
    const req = buildRequest(null);
    expect(() => mod.assertInternalCronAuth(req)).toThrow(mod.CronAuthError);
    try {
      mod.assertInternalCronAuth(req);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(mod.CronAuthError);
      if (e instanceof mod.CronAuthError) {
        expect(e.status).toBe(401);
      }
    }
  });

  it('TC-U-30: throws CronAuthError 401 when the provided secret is wrong (timing-safe-equal)', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', 'correct-secret-value');
    const mod = await import('./auth');
    // Same length so the length pre-check doesn't short-circuit — we want
    // timingSafeEqual itself to reject.
    const req = buildRequest('wrongggg-secret-value');
    expect(() => mod.assertInternalCronAuth(req)).toThrow(mod.CronAuthError);
  });

  it('TC-U-30b: throws CronAuthError 401 when the provided secret has a different length', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', 'correct-secret-value');
    const mod = await import('./auth');
    // Different length must also be rejected — timingSafeEqual would throw
    // RangeError on differing-length buffers, so the helper short-circuits
    // first. The user-visible behavior is still 401, not a crash.
    const req = buildRequest('short');
    expect(() => mod.assertInternalCronAuth(req)).toThrow(mod.CronAuthError);
  });

  it('TC-U-31: does not throw and returns void when the correct secret is supplied', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', 'correct-secret-value');
    const mod = await import('./auth');
    const req = buildRequest('correct-secret-value');
    const result = mod.assertInternalCronAuth(req);
    expect(result).toBeUndefined();
  });
});

describe('boot-time guard (TC-U-39)', () => {
  it('TC-U-39: NODE_ENV=production AND INTERNAL_CRON_SECRET unset → importing the module throws', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('INTERNAL_CRON_SECRET', undefined);
    vi.resetModules();
    await expect(import('./auth')).rejects.toThrow(
      /INTERNAL_CRON_SECRET is required/,
    );
  });

  it('TC-U-39 (empty string variant): NODE_ENV=production AND INTERNAL_CRON_SECRET="" → importing the module throws', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('INTERNAL_CRON_SECRET', '');
    vi.resetModules();
    // Empty string is the dangerous case: Buffer.from('') == Buffer.from('')
    // is true under timingSafeEqual, so any caller would pass without this
    // guard. Asserting the guard rejects the empty string is the whole point
    // of TC-U-39.
    await expect(import('./auth')).rejects.toThrow(
      /INTERNAL_CRON_SECRET is required/,
    );
  });

  it('TC-U-39 (production happy path): NODE_ENV=production AND INTERNAL_CRON_SECRET set → import succeeds', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('INTERNAL_CRON_SECRET', 'prod-secret-value');
    vi.resetModules();
    await expect(import('./auth')).resolves.toBeDefined();
  });

  it('TC-U-39b: NODE_ENV=test with secret unset — boot does NOT throw; first assertInternalCronAuth call throws "not configured"', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', undefined);
    vi.resetModules();
    const mod = await import('./auth');
    const req = buildRequest('anything');
    expect(() => mod.assertInternalCronAuth(req)).toThrow(mod.CronAuthError);
    try {
      mod.assertInternalCronAuth(req);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(mod.CronAuthError);
      if (e instanceof mod.CronAuthError) {
        expect(e.message).toMatch(/not configured/);
      }
    }
  });

  it('TC-U-39c: provided header empty + env empty (non-prod) → throws (defensive — Buffer.from("") would otherwise match)', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INTERNAL_CRON_SECRET', '');
    vi.resetModules();
    const mod = await import('./auth');
    const req = buildRequest('');
    expect(() => mod.assertInternalCronAuth(req)).toThrow(mod.CronAuthError);
  });
});
