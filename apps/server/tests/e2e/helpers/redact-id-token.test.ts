/**
 * Unit tests for `redactIdTokenLine` (TASK-0 / TC-U-03 + TC-U-04 of
 * `.specs/fix-sso-e2e-remaining-5.md`).
 *
 * The redactor drops any JWT-shaped substring from a log line so captured
 * dev-server stderr never persists raw id_tokens to disk. Two-arm contract:
 *   - JWT-shaped substring → replaced with `[REDACTED]`.
 *   - No JWT-shaped content → output identical to input.
 */
import { describe, it, expect } from 'vitest';

import { redactIdTokenLine } from './redact-id-token';

describe('redactIdTokenLine', () => {
  it.each([
    {
      name: 'replaces id_token=eyJ... substring',
      input:
        '[info] login id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature for alice',
      expectNotMatching: /eyJ[A-Za-z0-9_-]{10,}/,
    },
    {
      name: 'replaces a bare JWT substring',
      input: 'token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload.sig',
      expectNotMatching: /eyJ[A-Za-z0-9_-]{10,}/,
    },
    {
      name: 'replaces multiple JWT-shaped substrings on one line',
      input:
        'first=eyJhbGciOiJSUzI1NiJ9.aaaa.bbbb second=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.cccc.dddd',
      expectNotMatching: /eyJ[A-Za-z0-9_-]{10,}/,
    },
    {
      name: 'replaces FULL three-segment JWT (header + payload + sig)',
      // Post-self-review fix: prior regex matched only the header,
      // leaving the payload (often a second eyJ...) and signature on
      // disk. The expectation is that NO base64-shape JWT remnant
      // remains.
      input:
        'id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature-bytes-here',
      expectNotMatching: /eyJ[A-Za-z0-9_-]{5,}/,
    },
  ])('TC-U-03 $name', ({ input, expectNotMatching }) => {
    const output = redactIdTokenLine(input);
    expect(output).not.toMatch(expectNotMatching);
    expect(output).toContain('[REDACTED]');
  });

  it.each([
    {
      name: 'leaves a plain log line unchanged',
      input: '[info] login attempt for alice@alpha.test',
    },
    {
      name: 'leaves base64-ish but non-JWT content unchanged',
      input: 'session_id=abc123.def456.ghi789 (not a JWT)',
    },
    {
      name: 'leaves short eyJ substrings unchanged (under threshold)',
      input: 'note: eyJ is the JWT magic prefix',
    },
  ])('TC-U-04 $name', ({ input }) => {
    expect(redactIdTokenLine(input)).toBe(input);
  });
});
