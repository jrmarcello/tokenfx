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
import { describe, expect, it } from 'vitest';

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
