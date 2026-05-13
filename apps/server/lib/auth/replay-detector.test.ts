/**
 * Unit tests for the replay-detection helpers.
 *
 * Spec: .specs/sso-replay-audit-row.md TC-U-01..U-18.
 */
import { describe, expect, it } from 'vitest';

import {
  REPLAY_EMAIL_HASH_SENTINEL,
  REPLAY_ISS_SENTINEL,
  deriveSsoProviderFromCallbackPath,
  isStateReplayAuthError,
} from './replay-detector';

describe('isStateReplayAuthError', () => {
  it('returns true for an AuthError-shaped object whose `type` is "InvalidCheck"', () => {
    expect(isStateReplayAuthError({ type: 'InvalidCheck', name: 'Error', message: 'x' })).toBe(true);
  });

  it('returns false for `type` Configuration (genuine config error)', () => {
    expect(isStateReplayAuthError({ type: 'Configuration', name: 'Error', message: 'x' })).toBe(false);
  });

  it('returns false for `type` Verification', () => {
    expect(isStateReplayAuthError({ type: 'Verification', name: 'Error', message: 'x' })).toBe(false);
  });

  it('returns false for `type` OAuthCallbackError (token-exchange failure)', () => {
    expect(isStateReplayAuthError({ type: 'OAuthCallbackError', name: 'Error', message: 'x' })).toBe(false);
  });

  it('returns false when `type` is undefined', () => {
    expect(isStateReplayAuthError({ name: 'Error', message: 'x' } as unknown as { type?: string })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isStateReplayAuthError(null)).toBe(false);
  });

  it('returns false for a plain Error (no `type` field)', () => {
    expect(isStateReplayAuthError(new Error('boom'))).toBe(false);
  });

  it('returns false for a non-object value', () => {
    expect(isStateReplayAuthError('InvalidCheck' as unknown)).toBe(false);
  });
});

describe('deriveSsoProviderFromCallbackPath', () => {
  it('extracts okta from /api/auth/callback/okta', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/okta')).toBe('okta');
  });

  it('extracts google from /api/auth/callback/google', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/google')).toBe('google');
  });

  it('returns "unknown" for a non-callback path', () => {
    expect(deriveSsoProviderFromCallbackPath('/manager')).toBe('unknown');
  });

  it('returns "unknown" for null', () => {
    expect(deriveSsoProviderFromCallbackPath(null)).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(deriveSsoProviderFromCallbackPath('')).toBe('unknown');
  });

  it('returns "unknown" for path-traversal-looking inputs (regex enforces [a-z-])', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/../../../etc/passwd')).toBe('unknown');
  });

  it('returns "unknown" for uppercase provider name (regex is lowercase-only)', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/Okta')).toBe('unknown');
  });

  it('returns "unknown" for trailing slash', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/okta/')).toBe('unknown');
  });

  it('returns "unknown" for a provider name containing digits', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/oauth2')).toBe('unknown');
  });

  it('accepts hyphens within the provider name', () => {
    expect(deriveSsoProviderFromCallbackPath('/api/auth/callback/my-okta')).toBe('my-okta');
  });

  it('returns "unknown" for about:blank-style scheme URIs (some browsers send these as Referer)', () => {
    // The helper takes a path, not a full URL — callers always extract
    // `new URL(...).pathname` upstream. `about:blank`'s pathname is
    // `'blank'` which the regex correctly rejects.
    expect(deriveSsoProviderFromCallbackPath('blank')).toBe('unknown');
  });
});

describe('sentinel constants', () => {
  it('REPLAY_EMAIL_HASH_SENTINEL starts with the literal "replay:" prefix', () => {
    expect(REPLAY_EMAIL_HASH_SENTINEL.startsWith('replay:')).toBe(true);
  });

  it('REPLAY_EMAIL_HASH_SENTINEL is NOT a 64-char lowercase hex string (cannot collide with real peppered SHA-256 hash)', () => {
    expect(REPLAY_EMAIL_HASH_SENTINEL).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('REPLAY_ISS_SENTINEL starts with the literal "replay:" prefix', () => {
    expect(REPLAY_ISS_SENTINEL.startsWith('replay:')).toBe(true);
  });
});
