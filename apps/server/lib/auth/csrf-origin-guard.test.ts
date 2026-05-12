import { describe, it, expect } from 'vitest';

import { checkSigninOrigin } from './csrf-origin-guard';
import type { HasHeaderGetter } from './csrf-origin-guard';

/**
 * Hand-written `Request`-shaped stub. No mocking-framework: a frozen map of
 * lower-cased header names → value, returned by a closure that mirrors the
 * `Headers.get` contract (case-insensitive, returns `null` on miss).
 *
 * Covers TC-I-28..30 + TC-I-44 origin-validation surface (the route-level
 * integration test in `apps/server/tests/integration/sso-auto-provision-csrf.test.ts`
 * exercises the full middleware path; this file owns the pure-logic table).
 */
const stubRequest = (headers: Readonly<Record<string, string | null>>): HasHeaderGetter => {
  const lower = new Map<string, string | null>();
  for (const [k, v] of Object.entries(headers)) {
    lower.set(k.toLowerCase(), v);
  }
  return {
    headers: {
      get(name: string): string | null {
        return lower.get(name.toLowerCase()) ?? null;
      },
    },
  };
};

const BASE = 'https://app.tokenfx.io';

describe('checkSigninOrigin', () => {
  it('returns ok: true when Origin matches baseUrl exactly', () => {
    const req = stubRequest({ origin: BASE });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });

  it('returns ok: false / cross-origin when Origin is evil.example.com', () => {
    const req = stubRequest({ origin: 'https://evil.example.com' });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  it('returns ok: false / null-origin when Origin: null (sandboxed iframe)', () => {
    // Sandboxed iframes, data: URIs, and certain redirect chains emit the
    // literal string "null" as the Origin header — never a legitimate
    // same-origin POST, so we reject before falling back to Referer.
    const req = stubRequest({ origin: 'null', referer: BASE });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'null-origin',
    });
  });

  it('returns ok: false / missing-origin when both Origin and Referer absent', () => {
    const req = stubRequest({});
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'missing-origin',
    });
  });

  it('falls back to Referer when Origin is absent but Referer is same-origin', () => {
    // Browsers sometimes omit Origin on top-level navigations (e.g., classic
    // form POSTs from same-origin links). Same-origin Referer is sufficient.
    const req = stubRequest({ referer: `${BASE}/login` });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });

  it('rejects when Referer is from a different origin', () => {
    const req = stubRequest({ referer: 'https://evil.example.com/phish' });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  it('matches via prefix: Origin = baseUrl + path is acceptable', () => {
    // Origin should NOT carry a path per RFC 6454, but some user-agents do
    // append one (or proxies rewrite). Be defensive: prefix-match accepts
    // both forms without weakening the cross-origin check (a path on a
    // different origin still fails the prefix test).
    const req = stubRequest({ origin: `${BASE}/somewhere` });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });
});
