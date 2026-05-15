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

  // TC-U-08: suffix-injection attack via Referer — `https://app.tokenfx.io.evil.com`
  // is a DIFFERENT origin from `https://app.tokenfx.io`, but `startsWith` would
  // pass it. Origin-equality (via `new URL(...).origin`) correctly rejects it.
  it('rejects Referer https://app.tokenfx.io.evil.com/foo as cross-origin (suffix injection)', () => {
    const req = stubRequest({ referer: 'https://app.tokenfx.io.evil.com/foo' });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  // TC-U-09: same suffix-injection attack via Origin header.
  it('rejects Origin https://app.tokenfx.io.evil.com as cross-origin (suffix injection)', () => {
    const req = stubRequest({ origin: 'https://app.tokenfx.io.evil.com' });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  // TC-U-09b: a non-parseable Referer (URL constructor throws) is treated as
  // cross-origin — safer default than letting it bubble.
  it('rejects Referer that fails URL parsing as cross-origin', () => {
    const req = stubRequest({ referer: 'not-a-url' });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  // TC-U-09c: explicit nulls in both headers → missing-origin (preserves the
  // existing null-pair behavior under the new origin-equality logic).
  it('returns missing-origin when both Origin and Referer are explicitly null', () => {
    const req = stubRequest({ origin: null, referer: null });
    expect(checkSigninOrigin(req, BASE)).toEqual({
      ok: false,
      reason: 'missing-origin',
    });
  });

  // TC-U-10: exact origin equality, no path, no port → ok.
  it('accepts Origin exact https://app.tokenfx.io', () => {
    const req = stubRequest({ origin: 'https://app.tokenfx.io' });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });

  // TC-U-11: Referer carrying a path → ok (origin-equality strips the path).
  it('accepts Referer https://app.tokenfx.io/some/path', () => {
    const req = stubRequest({ referer: 'https://app.tokenfx.io/some/path' });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });

  // TC-U-12: default-port normalization — `https://app.tokenfx.io:443` and
  // `https://app.tokenfx.io` share the same `.origin` value per WHATWG URL.
  it('accepts Origin https://app.tokenfx.io:443 when baseUrl omits the default port', () => {
    const req = stubRequest({ origin: 'https://app.tokenfx.io:443' });
    expect(checkSigninOrigin(req, BASE)).toEqual({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────────────
  // auth-optional-mode-and-sso-bugfixes (bug #3): regression guards
  // ─────────────────────────────────────────────────────────────────────

  it('TC-U-24: accepts same-origin localhost (smoke profile baseline)', () => {
    const req = stubRequest({ origin: 'http://localhost:3232' });
    expect(checkSigninOrigin(req, 'http://localhost:3232')).toEqual({
      ok: true,
    });
  });

  it('TC-U-25: rejects cross-origin (guard still catches real attacks)', () => {
    const req = stubRequest({ origin: 'http://evil.example.com' });
    expect(checkSigninOrigin(req, 'http://localhost:3232')).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });

  it('TC-U-26: regression — baseUrl built from raw Host header matches Origin', () => {
    // Bug #3 manifests when baseUrl is built from `new URL(request.url).host`
    // and `request.url` carries the bind address (e.g. `http://0.0.0.0:3232/...`).
    // With the post-fix baseUrl sourced from `request.headers.get('host')`,
    // the canonical form matches the Origin header exactly.
    const req = stubRequest({ origin: 'http://localhost:3232' });
    const baseUrlFromHostHeader = 'http://localhost:3232'; // what the fix produces
    expect(checkSigninOrigin(req, baseUrlFromHostHeader)).toEqual({ ok: true });
  });

  it('TC-U-26b: captures the bug — baseUrl from `url.host` of 0.0.0.0 mismatches Origin', () => {
    // Documents the shape of the bug: a baseUrl built from the bind
    // address (what the pre-fix code did) rejects a legitimate
    // same-origin request as cross-origin.
    const req = stubRequest({ origin: 'http://localhost:3232' });
    const baseUrlFromUrlHost = 'http://0.0.0.0:3232'; // what the pre-fix bug produced
    expect(checkSigninOrigin(req, baseUrlFromUrlHost)).toEqual({
      ok: false,
      reason: 'cross-origin',
    });
  });
});
