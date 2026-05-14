/**
 * Unit tests for the auth.ts hardening fixes (TASK-AUTH-HARDENING in
 * `.specs/review-report-2026-05-14-fixes.md`):
 *
 *   - H3 (REQ-7/REQ-8): `extractIssuer` cap at 512 chars + edge cases
 *     (missing iss, array iss, malformed JWT) — TC-U-13, TC-U-13b/c/d,
 *     TC-U-14, TC-U-14b/c/d.
 *   - C-1 (REQ-10):  `logger.error` hook routes `AuthError` of type
 *     `InvalidCheck` to the replay-audit writer via
 *     `isStateReplayAuthError` (not via an unchecked cast). Other
 *     AuthError types pass through without writing — TC-U-18, TC-U-18b.
 *   - C-3 (REQ-12): the `switch (decision.kind)` block has an
 *     exhaustiveness `default:` case that returns `false` (silent
 *     reject) instead of throwing — TC-U-19.
 *
 * Test target: `./auth-helpers.ts` — the same module `auth.ts` imports
 * from. The helpers live in a separate file specifically so unit tests
 * can exercise them without pulling NextAuth (and its transitive
 * `next/server` import graph) into the Vitest module graph.
 *
 * Conventions: hand-written stubs (no mocking framework), descriptive
 * natural-English test names, table-driven via `it.each` where the
 * branching is uniform.
 */
import { describe, expect, it } from 'vitest';

import {
  createInvalidCheckHandler,
  extractIssuer,
  signInDefaultVerdict,
} from './auth-helpers';
import type { WriteReplayAuditRowInput } from './auth-event-log-writer';
import type { SignInDecision } from './load-user';

// ---------------------------------------------------------------------------
// extractIssuer — REQ-7 (cap @ 512) + REQ-8 (happy + edges)
// ---------------------------------------------------------------------------

const buildIdToken = (claims: Record<string, unknown>): string => {
  const header = Buffer.from('{"alg":"none"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
};

describe('extractIssuer — REQ-7 boundary (cap at 512 chars)', () => {
  it.each([
    { name: 'TC-U-13  iss length 1000 → truncated to 512',     length: 1000, expected: 512 },
    { name: 'TC-U-13b iss length 511  → returned intact (511)', length: 511,  expected: 511 },
    { name: 'TC-U-13c iss length 512  → returned intact (512)', length: 512,  expected: 512 },
    { name: 'TC-U-13d iss length 513  → truncated to 512',      length: 513,  expected: 512 },
  ])('$name', ({ length, expected }) => {
    const iss = 'x'.repeat(length);
    const account = { iss } as unknown as Record<string, unknown>;
    expect(extractIssuer(account).length).toBe(expected);
  });

  it('TC-U-13e caps a long `iss` read from id_token payload (JWT-decoded path)', () => {
    const long = 'y'.repeat(1000);
    const account = { id_token: buildIdToken({ iss: long }) };
    expect(extractIssuer(account).length).toBe(512);
  });
});

describe('extractIssuer — REQ-8 happy + edges', () => {
  it('TC-U-14 returns a known issuer unchanged (≤512 chars)', () => {
    const account = { iss: 'https://accounts.google.com' };
    expect(extractIssuer(account)).toBe('https://accounts.google.com');
  });

  it('TC-U-14b returns `\'\'` when id_token carries no `iss` claim', () => {
    const account = { id_token: buildIdToken({ sub: 'no-iss-here' }) };
    expect(extractIssuer(account)).toBe('');
  });

  it('TC-U-14c returns `\'\'` when `iss` is an array (non-string)', () => {
    // Direct: array on the Account itself.
    expect(
      extractIssuer({ iss: ['evil.com'] } as unknown as Record<string, unknown>),
    ).toBe('');
    // Via id_token payload: same expectation.
    const account = { id_token: buildIdToken({ iss: ['evil.com'] }) };
    expect(extractIssuer(account)).toBe('');
  });

  it('TC-U-14d returns `\'\'` for a malformed id_token (non-base64 payload) without throwing', () => {
    const account = { id_token: 'aaaa.@@@not-base64@@@.sig' };
    // Must NOT throw — try/catch in extractIssuer falls through.
    expect(() => extractIssuer(account)).not.toThrow();
    expect(extractIssuer(account)).toBe('');
  });

  it('returns `\'\'` for a null account (no claim available)', () => {
    expect(extractIssuer(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// logger.error hook — REQ-10 (use isStateReplayAuthError, not unchecked cast)
// ---------------------------------------------------------------------------

/**
 * Hand-written stub matching `writeReplayAuditRow` (no mocking framework
 * per project conventions). Records every call in `calls` so the test
 * asserts the input shape; ignores opts.
 */
const makeWriterStub = (): {
  calls: WriteReplayAuditRowInput[];
  fn: (input: WriteReplayAuditRowInput) => Promise<void>;
} => {
  const calls: WriteReplayAuditRowInput[] = [];
  return {
    calls,
    fn: async (input) => {
      calls.push(input);
    },
  };
};

// Hand-written stub for ipToCity — returns 'TestCity' for any non-null IP.
const ipToCityStub = async (ip: string): Promise<string | null> =>
  ip ? 'TestCity' : null;

const noContextProvider = (): { ip: string; userAgent: string } => ({
  ip: '203.0.113.7',
  userAgent: 'test-ua/1.0',
});

describe('writeReplayAuditRowOnInvalidCheck hook — REQ-10', () => {
  it('TC-U-18 writes a replay-audit row when error.type === "InvalidCheck"', async () => {
    const writer = makeWriterStub();
    const handler = createInvalidCheckHandler({
      writer: writer.fn,
      ipToCity: ipToCityStub,
      getRequestContext: noContextProvider,
    });

    // AuthError-shaped fixture — mirrors @auth/core's InvalidCheck instance
    // (static `type` field). We avoid pulling `@auth/core/errors` to keep
    // the test free of provider-internal coupling.
    const invalidCheckError = Object.assign(new Error('state cookie mismatch'), {
      type: 'InvalidCheck' as const,
    });

    await handler(invalidCheckError);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toEqual({
      ssoProvider: 'unknown',
      ip: '203.0.113.7',
      city: 'TestCity',
      userAgent: 'test-ua/1.0',
    });
  });

  it('TC-U-18b does NOT write when error.type is some other AuthError (`AccessDenied`)', async () => {
    const writer = makeWriterStub();
    const handler = createInvalidCheckHandler({
      writer: writer.fn,
      ipToCity: ipToCityStub,
      getRequestContext: noContextProvider,
    });

    const accessDenied = Object.assign(new Error('access denied'), {
      type: 'AccessDenied' as const,
    });
    await handler(accessDenied);

    expect(writer.calls).toHaveLength(0);
  });

  it('does NOT throw if the writer itself rejects (catch logs at warn)', async () => {
    const throwingWriter = async (): Promise<void> => {
      throw new Error('boom');
    };
    const handler = createInvalidCheckHandler({
      writer: throwingWriter,
      ipToCity: ipToCityStub,
      getRequestContext: noContextProvider,
    });
    const invalidCheckError = Object.assign(new Error('x'), { type: 'InvalidCheck' as const });
    await expect(handler(invalidCheckError)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// signIn switch exhaustiveness — REQ-12
// ---------------------------------------------------------------------------

describe('signInDefaultVerdict — REQ-12 exhaustiveness default', () => {
  it('TC-U-19 returns false (no throw) for an unknown decision variant', () => {
    // Force-cast an unsafe variant to simulate a future `SignInDecision.kind`
    // that the switch was never updated for. The default case must not throw.
    const unknownDecision = {
      kind: 'unknown-future-variant',
    } as unknown as SignInDecision;
    expect(() => signInDefaultVerdict(unknownDecision)).not.toThrow();
    expect(signInDefaultVerdict(unknownDecision)).toBe(false);
  });

  it('returns true for each `true`-verdict known variant (allow/fill-sso/bootstrap)', () => {
    expect(signInDefaultVerdict({ kind: 'allow' })).toBe(true);
    expect(
      signInDefaultVerdict({ kind: 'fill-sso', provider: 'p', subject: 's' }),
    ).toBe(true);
    expect(signInDefaultVerdict({ kind: 'bootstrap' })).toBe(true);
  });

  it('returns false for each `false`-verdict known variant (reject-mismatch / ambiguous-multi-org)', () => {
    expect(signInDefaultVerdict({ kind: 'reject-mismatch' })).toBe(false);
    expect(signInDefaultVerdict({ kind: 'ambiguous-multi-org' })).toBe(false);
  });
});
