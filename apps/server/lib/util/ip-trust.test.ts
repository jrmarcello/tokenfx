import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTrustedClientIp } from './ip-trust';

/**
 * Env-restoration helper. Tests toggle `TOKENFX_TRUSTED_PROXY` per case;
 * we snapshot and restore in afterEach so state never leaks across tests.
 */
const mutableEnv = process.env as Record<string, string | undefined>;
let snapshot: string | undefined;

beforeEach(() => {
  snapshot = process.env.TOKENFX_TRUSTED_PROXY;
  // Default each test to "unset"; cases that need it can opt in.
  delete mutableEnv.TOKENFX_TRUSTED_PROXY;
});

afterEach(() => {
  if (snapshot === undefined) {
    delete mutableEnv.TOKENFX_TRUSTED_PROXY;
  } else {
    mutableEnv.TOKENFX_TRUSTED_PROXY = snapshot;
  }
  vi.restoreAllMocks();
});

/**
 * Hand-written stub of the minimal Request-like shape that `getTrustedClientIp`
 * consumes. No mocking framework — just a Map-backed header bag matching the
 * `Headers.get` lookup case-insensitively (Fetch spec). The helper itself
 * uses lowercase names so the Map is keyed lowercase for simplicity.
 */
const makeReq = (headers: Record<string, string | null>): { headers: { get(name: string): string | null } } => {
  const lower: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: {
      get(name: string): string | null {
        const v = lower[name.toLowerCase()];
        return v === undefined ? null : v;
      },
    },
  };
};

describe('getTrustedClientIp — TOKENFX_TRUSTED_PROXY unset (XFF must be ignored)', () => {
  it('TC-U-29a: returns null when only x-forwarded-for is present (XFF ignored, no fallback)', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4' });
    expect(getTrustedClientIp(req)).toBeNull();
  });

  it('TC-U-29b: returns null even with x-real-ip set (both IP headers ignored in untrusted mode)', () => {
    // Hardening pass post-self-review (security M1 MEDIUM-1): x-real-ip is
    // also client-spoofable end-to-end without a proxy in front, so the
    // untrusted-mode path collapses ALL IP headers, not just XFF.
    const req = makeReq({ 'x-real-ip': '10.0.0.1' });
    expect(getTrustedClientIp(req)).toBeNull();
  });

  it('TC-U-29b (variant): both headers spoofed → null (untrusted mode refuses to pick)', () => {
    const req = makeReq({ 'x-forwarded-for': 'attacker.ip', 'x-real-ip': '10.0.0.1' });
    expect(getTrustedClientIp(req)).toBeNull();
  });

  it('returns null when both XFF and x-real-ip are absent', () => {
    const req = makeReq({});
    expect(getTrustedClientIp(req)).toBeNull();
  });
});

describe('getTrustedClientIp — TOKENFX_TRUSTED_PROXY=1 (XFF trusted)', () => {
  beforeEach(() => {
    mutableEnv.TOKENFX_TRUSTED_PROXY = '1';
  });

  it('TC-U-30: returns first hop of multi-value XFF list', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(getTrustedClientIp(req)).toBe('1.2.3.4');
  });

  it('TC-U-30 (single value): returns sole XFF entry', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4' });
    expect(getTrustedClientIp(req)).toBe('1.2.3.4');
  });

  it('TC-U-30b: returns spoofed XFF verbatim — operator owns the trust model upstream', () => {
    // Documents the trust model: with TOKENFX_TRUSTED_PROXY=1 the operator
    // promises that a real reverse proxy controls the first XFF hop. If they
    // misconfigure (set the flag without a real proxy), the client can spoof.
    // The helper's contract is: trust-flag-on means trust XFF as-is.
    const req = makeReq({ 'x-forwarded-for': 'attacker.ip' });
    expect(getTrustedClientIp(req)).toBe('attacker.ip');
  });

  it('TC-U-31: empty XFF string falls through to "absent" branch (length === 0); no x-real-ip → null + warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = makeReq({ 'x-forwarded-for': '' });
    // Per the design snippet, `xff && xff.length > 0` is false for "", so the
    // helper treats the header as effectively absent and warns accordingly.
    // With no x-real-ip fallback either, the final return is null.
    expect(getTrustedClientIp(req)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'getTrustedClientIp: TOKENFX_TRUSTED_PROXY set but XFF header absent',
    );
  });

  it('TC-U-31 (whitespace-only first hop): present but trims to empty → null + first-hop-empty warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = makeReq({ 'x-forwarded-for': '   , 5.6.7.8' });
    expect(getTrustedClientIp(req)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'getTrustedClientIp: XFF present but first hop empty',
    );
  });

  it('TC-U-31b: falls back to x-real-ip when XFF header is absent (with warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = makeReq({ 'x-real-ip': '10.0.0.1' });
    expect(getTrustedClientIp(req)).toBe('10.0.0.1');
    expect(warnSpy).toHaveBeenCalledWith(
      'getTrustedClientIp: TOKENFX_TRUSTED_PROXY set but XFF header absent',
    );
  });

  it('TC-U-31b (no fallback either): returns null when both XFF and x-real-ip absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const req = makeReq({});
    expect(getTrustedClientIp(req)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('getTrustedClientIp — flag values other than "1" do NOT enable trust', () => {
  it.each([
    ['0', '0'],
    ['true', 'truthy-but-not-1'],
    ['yes', 'yes'],
    ['', 'empty string'],
  ])('treats TOKENFX_TRUSTED_PROXY="%s" (%s) as untrusted', (raw) => {
    mutableEnv.TOKENFX_TRUSTED_PROXY = raw;
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '10.0.0.1' });
    // Post-self-review hardening: untrusted mode refuses to pick any IP
    // header. Both XFF and x-real-ip are client-spoofable; the helper
    // collapses to null so callers fall back to the `unknown-ip` rate-limit
    // bucket. Trust requires explicit operator opt-in via the env flag = "1".
    expect(getTrustedClientIp(req)).toBeNull();
  });
});
