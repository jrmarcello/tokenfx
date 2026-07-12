/**
 * Regression lock on the NextAuth Okta provider config.
 *
 * Spec: .specs/sso-nonce-replay.md REQ-1 + TC-U-10.
 *
 * Why this exists: enabling nonce validation on the Okta provider is a
 * one-line change in `auth.config.ts`. A future Auth.js upgrade that
 * renames the `checks` option, changes the provider factory signature,
 * or silently drops the override would degrade SSO security with no
 * production-visible signal. This unit test asserts the resolved
 * provider config carries the nonce check so any such regression
 * fails at typecheck or unit-test time, not at the E2E layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';

import { buildRootMiddleware } from './localhost-guard';
import { authConfig, buildAuthConfig } from './auth.config';

describe('authConfig — Okta provider checks (sso-nonce-replay TC-U-10)', () => {
  it('REQ-1: Okta provider declares checks: ["pkce", "state", "nonce"]', () => {
    // Auth.js providers expose their options via either `.options` or
    // (in older typings) directly on the provider object. Resolve both
    // shapes defensively.
    const okta = authConfig.providers.find((p) => {
      const id = (p as { id?: unknown }).id;
      const optsId = (p as { options?: { id?: unknown } }).options?.id;
      return id === 'okta' || optsId === 'okta';
    });
    expect(okta, 'Okta provider must be configured').toBeDefined();
    const checks =
      (okta as { options?: { checks?: unknown } }).options?.checks ??
      (okta as { checks?: unknown }).checks;
    expect(checks).toBeDefined();
    // Defense: Vitest's `.toContain` on a string does substring match,
    // so a future Auth.js shape change (e.g. `checks: 'pkce state nonce'`
    // as a space-delimited string) would produce a silent false-positive.
    // Pin the array contract explicitly.
    expect(Array.isArray(checks), 'checks must be an array').toBe(true);
    const arr = checks as readonly string[];
    expect(arr).toContain('nonce');
    expect(arr).toContain('state');
    expect(arr).toContain('pkce');
  });
});

/**
 * Cookie hardening — review-report-2026-05-14-fixes REQ-24 (TASK-L1).
 *
 * NextAuth ships sane defaults for `sessionToken`, `state`, `pkceCodeVerifier`,
 * `nonce` (httpOnly + sameSite=lax + path=/ + secure-when-prod), but the
 * defaults are not part of the public contract: a future Auth.js upgrade
 * could change them without a major-version bump. Pinning them explicitly
 * in `auth.config.ts` and asserting field-by-field here locks the security
 * contract at unit-test time. Snapshot assertions are deliberately avoided
 * (security-critical: a wrong-but-stable value would round-trip silently).
 *
 * `csrfToken` is intentionally OUT OF SCOPE — managed by NextAuth internals.
 */
type CookieOptions = {
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
  path?: string;
};
type CookieEntry = { options?: CookieOptions };

type PinnedCookieKey = 'sessionToken' | 'state' | 'pkceCodeVerifier' | 'nonce';

const getCookieOptions = (
  cfg: ReturnType<typeof buildAuthConfig>,
  key: PinnedCookieKey,
): CookieOptions => {
  const cookies = cfg.cookies as Record<string, CookieEntry | undefined> | undefined;
  expect(cookies, 'authConfig.cookies must be defined').toBeDefined();
  const entry = cookies?.[key];
  expect(entry, `authConfig.cookies.${key} must be defined`).toBeDefined();
  const options = entry?.options;
  expect(options, `authConfig.cookies.${key}.options must be defined`).toBeDefined();
  // Non-null assertion justified: the two expect() calls above fail-fast if
  // either is missing, so by this point both have been narrowed to defined.
  return options as CookieOptions;
};

describe('authConfig — pinned cookie options (review-report-2026-05-14 TC-U-32 / TC-U-33)', () => {
  it('TC-U-32: sessionToken.options has httpOnly=true, sameSite="lax", path="/"', () => {
    const opts = getCookieOptions(authConfig, 'sessionToken');
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  it('TC-U-32b: sessionToken.options.secure === true when NODE_ENV=production', () => {
    const cfg = buildAuthConfig({ ...process.env, NODE_ENV: 'production' });
    const opts = getCookieOptions(cfg, 'sessionToken');
    expect(opts.secure).toBe(true);
  });

  it('TC-U-32c: sessionToken.options.secure === false when NODE_ENV=test', () => {
    const cfg = buildAuthConfig({ ...process.env, NODE_ENV: 'test' });
    const opts = getCookieOptions(cfg, 'sessionToken');
    expect(opts.secure).toBe(false);
  });

  // TC-U-33: same field-by-field assertions for state, pkceCodeVerifier, nonce.
  it.each([
    ['state'] as const,
    ['pkceCodeVerifier'] as const,
    ['nonce'] as const,
  ])('TC-U-33: %s.options has httpOnly=true, sameSite="lax", path="/"', (key) => {
    const opts = getCookieOptions(authConfig, key);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  it.each([
    ['state'] as const,
    ['pkceCodeVerifier'] as const,
    ['nonce'] as const,
  ])('TC-U-33: %s.options.secure tracks NODE_ENV (production → true, test → false)', (key) => {
    const prod = buildAuthConfig({ ...process.env, NODE_ENV: 'production' });
    expect(getCookieOptions(prod, key).secure).toBe(true);
    const test = buildAuthConfig({ ...process.env, NODE_ENV: 'test' });
    expect(getCookieOptions(test, key).secure).toBe(false);
  });
});

/**
 * `/api/manager/*` auth gate — security-hardening-lowsev REQ-3 (TASK-4).
 *
 * Extending only the middleware `matcher` to `/api/manager/:path*` is a
 * no-op: `authorized()` short-circuits with `return true` for any path
 * that does not start with `/manager` (and `/api/manager/*` starts with
 * `/api`). REQ-3 closes the gap in BOTH places — this block exercises the
 * `authorized()` half by calling it directly with a hand-built
 * `{ request, auth }` stub (Edge-safe: no Postgres, no NextAuth runtime).
 *
 * SSO mode is forced via `AUTH_REQUIRED='true'` so `isAuthRequired(env)`
 * is true and the callback runs its full gating logic (rather than the
 * localhost-mode `return true` at the top).
 */
type AuthorizedFn = NonNullable<
  NonNullable<ReturnType<typeof buildAuthConfig>['callbacks']>['authorized']
>;

const ssoAuthorized = (): AuthorizedFn => {
  const cfg = buildAuthConfig({
    NODE_ENV: 'test',
    AUTH_REQUIRED: 'true',
  } as NodeJS.ProcessEnv);
  const authorized = cfg.callbacks?.authorized;
  if (!authorized) {
    throw new Error('authConfig.callbacks.authorized must be defined');
  }
  return authorized;
};

const apiManagerReq = (): NextRequest =>
  new NextRequest('http://localhost/api/manager/dismiss-anomaly');

const sessionWithRole = (role: 'member' | 'manager' | 'admin'): Session =>
  ({
    user: { email: 'u@example.test', role, orgId: 'org-1' },
    expires: '2099-01-01',
  }) as Session;

/** Duck-typed Response check — avoids cross-realm `instanceof` pitfalls. */
const isResponseLike = (value: unknown): value is Response =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { status?: unknown }).status === 'number' &&
  typeof (value as { json?: unknown }).json === 'function';

const expectJsonError = async (
  result: Awaited<ReturnType<AuthorizedFn>>,
  status: number,
  body: unknown,
): Promise<void> => {
  expect(
    isResponseLike(result),
    'authorized() must return a Response (not a boolean short-circuit)',
  ).toBe(true);
  const response = result as Response;
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual(body);
};

describe('authConfig.authorized() — /api/manager gate (security-hardening-lowsev TC-I-07)', () => {
  it('TC-I-07 security: SSO mode + no session → 401 JSON {error:{message,code}}', async () => {
    const result = await ssoAuthorized()({ request: apiManagerReq(), auth: null });
    await expectJsonError(result, 401, {
      error: { message: 'unauthorized', code: 'unauthorized' },
    });
  });

  it('TC-I-07b security: SSO mode + role=member → 403 JSON {error:{message,code}}', async () => {
    const result = await ssoAuthorized()({
      request: apiManagerReq(),
      auth: sessionWithRole('member'),
    });
    await expectJsonError(result, 403, {
      error: { message: 'forbidden', code: 'forbidden' },
    });
  });

  it.each(['manager', 'admin'] as const)(
    'TC-I-07c happy: SSO mode + role=%s → passes to handler (returns true, no short-circuit)',
    async (role) => {
      const result = await ssoAuthorized()({
        request: apiManagerReq(),
        auth: sessionWithRole(role),
      });
      expect(result).toBe(true);
    },
  );
});

/**
 * Root middleware localhost-mode Host gate — security-hardening-lowsev
 * REQ-3 (TASK-4). `buildRootMiddleware` is the Edge-safe dispatcher
 * extracted from `middleware.ts`: the root middleware itself cannot be
 * imported here because its top-level `NextAuth(authConfig).auth` pulls
 * `next-auth`'s main entry (`lib/env.js` → extensionless `import
 * 'next/server'`), which Vitest's ESM loader cannot resolve — the same
 * reason `lib/auth/middleware.ts` lazy-imports `./auth`. The factory takes
 * the SSO handler as a DI seam (mirroring that file's `AuthFn`), so with
 * `AUTH_REQUIRED=false` the dispatch routes to the localhost host-gate
 * without ever touching NextAuth. The sentinel SSO handler throws to prove
 * localhost-mode never delegates to SSO. TC-I-08 asserts the 403 body
 * matches the `{error:{message,code}}` shape required by security.md
 * (previously `{error:'forbidden'}`, a bare string).
 */
const throwingSso = (): never => {
  throw new Error('SSO handler must not run in localhost mode');
};

const runMiddleware = (req: NextRequest): Response =>
  buildRootMiddleware(throwingSso)(req) as Response;

describe('root middleware — localhost-mode Host gate (security-hardening-lowsev TC-I-08/09)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('TC-I-08 security: localhost-mode + non-loopback Host → 403 JSON {error:{message,code}}', async () => {
    vi.stubEnv('AUTH_REQUIRED', 'false');
    const req = new NextRequest('http://localhost/api/manager/dismiss-anomaly', {
      headers: { host: 'evil.com' },
    });
    const res = runMiddleware(req);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: { message: 'forbidden', code: 'localhost-only' },
    });
  });

  it('TC-I-09 happy: localhost-mode + loopback Host → passes (NextResponse.next)', () => {
    vi.stubEnv('AUTH_REQUIRED', 'false');
    const req = new NextRequest('http://localhost/api/manager/dismiss-anomaly', {
      headers: { host: 'localhost' },
    });
    const res = runMiddleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('SSO mode delegates to the injected NextAuth handler (never the localhost gate)', () => {
    vi.stubEnv('AUTH_REQUIRED', 'true');
    const sentinel = Symbol('sso-ran');
    const spySso = (): symbol => sentinel;
    const req = new NextRequest('http://localhost/api/manager/dismiss-anomaly', {
      headers: { host: 'evil.com' },
    });
    // With AUTH_REQUIRED unset/true the dispatcher must call the SSO handler
    // and return its value verbatim — a regression that always routed through
    // the localhost gate would return a 403 Response instead of the sentinel.
    expect(buildRootMiddleware(spySso)(req)).toBe(sentinel);
  });
});
