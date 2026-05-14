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

import { authConfig } from './auth.config';

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
