import { describe, it, expect, vi } from 'vitest';
import {
  assertNotProductionWithBypass,
  buildE2eBypassProvider,
  createAuthorize,
  isLocalhostHost,
  type LoadUserFn,
} from './e2e-bypass-provider';
import type { LoadedUser } from './load-user';

const ALICE: LoadedUser = {
  userId: 'user-alice-123',
  role: 'admin',
  orgId: 'org-alpha-123',
  ssoProvider: null,
};

const stubLoadUserOk =
  (user: LoadedUser): LoadUserFn =>
  async () =>
    user;

const stubLoadUserNull: LoadUserFn = async () => null;

const stubLoadUserThrow: LoadUserFn = async () => {
  throw new Error('db connection lost');
};

const makeRequest = (host: string | null, extraHeaders: Record<string, string> = {}): Request => {
  const headers = new Headers(extraHeaders);
  if (host !== null) headers.set('host', host);
  return new Request('http://localhost:3232/api/auth/callback/credentials', {
    method: 'POST',
    headers,
  });
};

const callAuthorize = async (
  loadUser: LoadUserFn,
  credentials: Record<string, unknown>,
  request: Request,
) => createAuthorize(loadUser)(credentials, request);

describe('buildE2eBypassProvider', () => {
  it('returns a Credentials provider when E2E_AUTH_BYPASS is exactly "1"', () => {
    const provider = buildE2eBypassProvider({ E2E_AUTH_BYPASS: '1', NODE_ENV: 'test' });
    expect(provider).not.toBeNull();
    expect(provider).toMatchObject({ id: 'credentials' });
  });

  it.each([
    ['"0" (explicit off)', { E2E_AUTH_BYPASS: '0' }],
    ['unset', {}],
    ['"true" (only literal "1" enables)', { E2E_AUTH_BYPASS: 'true' }],
    ['"yes"', { E2E_AUTH_BYPASS: 'yes' }],
    ['" 1" with leading space', { E2E_AUTH_BYPASS: ' 1' }],
  ])('returns null when E2E_AUTH_BYPASS is %s', (_label, env) => {
    expect(buildE2eBypassProvider(env as NodeJS.ProcessEnv)).toBeNull();
  });

  describe('host guard', () => {
    it('rejects evil.example host without calling loadUser', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('evil.example'),
      );
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('accepts localhost:3232 and calls loadUser', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('localhost:3232'),
      );
      expect(spy).toHaveBeenCalledWith('alice@alpha.test');
    });

    it('accepts any localhost port', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('localhost:9999'),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('accepts bare localhost without port', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('localhost'),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('rejects localhost.evil.com (substring match attack)', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('localhost.evil.com'),
      );
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects 127.0.0.1 (only literal localhost label accepted)', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('127.0.0.1:3232'),
      );
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects when host header is missing entirely', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest(null),
      );
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores x-forwarded-host (reads raw host header only)', async () => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      await callAuthorize(
        spy,
        { email: 'alice@alpha.test' },
        makeRequest('localhost:3232', { 'x-forwarded-host': 'evil.com' }),
      );
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('authorize body', () => {
    const validReq = makeRequest('localhost:3232');

    it('returns the user shape for a seeded admin email', async () => {
      const result = await callAuthorize(
        stubLoadUserOk(ALICE),
        { email: 'alice@alpha.test' },
        validReq,
      );
      expect(result).toEqual({
        id: 'user-alice-123',
        email: 'alice@alpha.test',
        role: 'admin',
        orgId: 'org-alpha-123',
      });
    });

    it('returns null when the seeded user lookup yields nothing', async () => {
      const result = await callAuthorize(
        stubLoadUserNull,
        { email: 'ghost@nowhere.test' },
        validReq,
      );
      expect(result).toBeNull();
    });

    it.each([
      ['missing email field', {}],
      ['empty-string email', { email: '' }],
      ['malformed email', { email: 'not-an-email' }],
    ])('returns null for %s', async (_label, credentials) => {
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(spy, credentials, validReq);
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('accepts a maximum-length valid email (254 chars, RFC 5321)', async () => {
      const localPart = 'a'.repeat(254 - '@example.com'.length);
      const email = `${localPart}@example.com`;
      expect(email).toHaveLength(254);
      const spy = vi.fn(stubLoadUserOk({ ...ALICE, userId: 'big' }));
      const result = await callAuthorize(spy, { email }, validReq);
      expect(result).toMatchObject({ email });
      expect(spy).toHaveBeenCalledWith(email);
    });

    it('rejects an email one char over the 254-char limit', async () => {
      const localPart = 'a'.repeat(255 - '@example.com'.length);
      const email = `${localPart}@example.com`;
      expect(email).toHaveLength(255);
      const spy = vi.fn(stubLoadUserOk(ALICE));
      const result = await callAuthorize(spy, { email }, validReq);
      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('propagates a loadUser DB error to the caller', async () => {
      await expect(
        callAuthorize(
          stubLoadUserThrow,
          { email: 'alice@alpha.test' },
          validReq,
        ),
      ).rejects.toThrow(/loadUser failed/);
    });

    it('preserves the original DB error as `cause` on the thrown wrapper', async () => {
      try {
        await callAuthorize(
          stubLoadUserThrow,
          { email: 'alice@alpha.test' },
          validReq,
        );
        throw new Error('expected createAuthorize to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        const cause = (e as Error).cause;
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).message).toBe('db connection lost');
      }
    });
  });
});

describe('isLocalhostHost (exported for re-use)', () => {
  it.each([
    ['localhost', true],
    ['localhost:3232', true],
    ['localhost:1', true],
    ['LOCALHOST', false],
    ['localhost.evil.com', false],
    ['127.0.0.1', false],
    ['127.0.0.1:3232', false],
    ['', false],
  ])('returns %s for %s', (host, expected) => {
    expect(isLocalhostHost(host)).toBe(expected);
  });

  it('returns false for null/undefined', () => {
    expect(isLocalhostHost(null)).toBe(false);
    expect(isLocalhostHost(undefined)).toBe(false);
  });
});

describe('assertNotProductionWithBypass (boot guard, called from auth.ts)', () => {
  it('throws when NODE_ENV=production AND E2E_AUTH_BYPASS=1', () => {
    expect(() =>
      assertNotProductionWithBypass({
        NODE_ENV: 'production',
        E2E_AUTH_BYPASS: '1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be unset outside development\/test/);
  });

  it.each([
    ['production with bypass unset', { NODE_ENV: 'production' }],
    ['production with bypass=0', { NODE_ENV: 'production', E2E_AUTH_BYPASS: '0' }],
    ['production with bypass="true" (not literal "1")', { NODE_ENV: 'production', E2E_AUTH_BYPASS: 'true' }],
    ['test with bypass=1 (allowed)', { NODE_ENV: 'test', E2E_AUTH_BYPASS: '1' }],
    ['development with bypass=1 (allowed)', { NODE_ENV: 'development', E2E_AUTH_BYPASS: '1' }],
  ])('does not throw for %s', (_label, env) => {
    expect(() =>
      assertNotProductionWithBypass(env as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  // Security review H1: production drift / misconfig — anything that isn't
  // `test` or `development` counts as production-like and must throw when
  // paired with the bypass flag.
  it.each([
    ['NODE_ENV=prod', { NODE_ENV: 'prod' }],
    ['NODE_ENV=production-staging', { NODE_ENV: 'production-staging' }],
    ['NODE_ENV="" (empty)', { NODE_ENV: '' }],
    ['NODE_ENV unset', {}],
    ['NODE_ENV=staging', { NODE_ENV: 'staging' }],
  ])('throws when E2E_AUTH_BYPASS=1 AND %s (non-dev/test variants)', (_label, base) => {
    expect(() =>
      assertNotProductionWithBypass({
        ...base,
        E2E_AUTH_BYPASS: '1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be unset outside development\/test/);
  });
});
