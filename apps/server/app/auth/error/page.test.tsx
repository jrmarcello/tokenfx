/**
 * Unit tests for the pure `lookupErrorMessage` helper.
 *
 * Spec: .specs/sso-replay-audit-row.md TC-I-04..06.
 *
 * The page is a thin Server Component shell over `lookupErrorMessage`;
 * testing the helper covers the privacy-sensitive surface (no raw code
 * echo) without spinning up a Next.js renderer.
 */
import { describe, expect, it } from 'vitest';

import { lookupErrorMessage } from './page';

describe('lookupErrorMessage', () => {
  it('TC-I-04: returns the localized message for a known code (OAuthCallbackError); never echoes the raw code', () => {
    const message = lookupErrorMessage('OAuthCallbackError');
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('OAuthCallbackError');
  });

  it('TC-I-05: returns the fallback string for undefined and never echoes "undefined"', () => {
    const message = lookupErrorMessage(undefined);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('undefined');
  });

  it('TC-I-06: returns the same fallback for an unknown code (e.g. SomeFutureCode) and never echoes it', () => {
    const message = lookupErrorMessage('SomeFutureCode');
    expect(message).toBe(lookupErrorMessage(undefined));
    expect(message).not.toContain('SomeFutureCode');
  });

  it('returns localized messages for each known code with no code-value leak', () => {
    const knownCodes = [
      'OAuthCallbackError',
      'Configuration',
      'Verification',
      'AccessDenied',
      'Default',
    ];
    for (const code of knownCodes) {
      const message = lookupErrorMessage(code);
      expect(message).not.toContain(code);
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
