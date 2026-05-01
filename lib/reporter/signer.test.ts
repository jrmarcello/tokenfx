import { describe, it, expect } from 'vitest';

import { canonicalJSON, sign, verify } from './signer';

describe('canonicalJSON', () => {
  it('serializes primitives', () => {
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON(false)).toBe('false');
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON('hello')).toBe('"hello"');
  });

  it('sorts object keys lexicographically at every nesting level', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2, x: 3 } };
    expect(canonicalJSON(a)).toBe('{"a":2,"b":1,"c":{"x":3,"y":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no whitespace', () => {
    const out = canonicalJSON({ a: [1, { b: 2 }] });
    expect(out).not.toMatch(/\s/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow();
    expect(() => canonicalJSON(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('sign / verify', () => {
  const SECRET = 'test-secret-do-not-use-in-prod';

  // TC-U-23: sign(payload, secret) -> 64-hex-char signature
  it('produces a 64-hex-char HMAC-SHA256 signature', () => {
    const sig = sign({ hello: 'world' }, SECRET);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  // TC-U-24: signature stability under key reordering + whitespace differences
  it('produces byte-equal signatures for logically equal payloads with different key order', () => {
    const a = { foo: 1, bar: 2, nested: { x: 1, y: 2 } };
    const b = { nested: { y: 2, x: 1 }, bar: 2, foo: 1 };
    expect(sign(a, SECRET)).toBe(sign(b, SECRET));
  });

  it('produces byte-equal signatures regardless of source whitespace (whitespace cannot enter via JS object literal — re-verified via JSON parse)', () => {
    const compact = JSON.parse('{"a":1,"b":2}');
    const spaced = JSON.parse('{\n  "b": 2,\n  "a": 1\n}');
    expect(sign(compact, SECRET)).toBe(sign(spaced, SECRET));
  });

  // TC-U-25: verify with tampered payload returns false
  it('returns false when the payload has been tampered with', () => {
    const payload = { user: 'alice', amount: 100 };
    const sig = sign(payload, SECRET);
    const tampered = { user: 'alice', amount: 101 };
    expect(verify(tampered, sig, SECRET)).toBe(false);
  });

  // TC-U-26: verify with wrong secret returns false
  it('returns false when verifying with the wrong secret', () => {
    const payload = { user: 'alice', amount: 100 };
    const sig = sign(payload, SECRET);
    expect(verify(payload, sig, 'wrong-secret')).toBe(false);
  });

  // TC-U-27: empty payload roundtrip
  it('signs and verifies an empty object payload', () => {
    const sig = sign({}, SECRET);
    expect(verify({}, sig, SECRET)).toBe(true);
  });

  it('verify returns true for a correctly signed payload', () => {
    const payload = { type: 'event', items: [1, 2, 3] };
    const sig = sign(payload, SECRET);
    expect(verify(payload, sig, SECRET)).toBe(true);
  });

  it('verify returns false for a malformed (non-hex / wrong-length) signature', () => {
    expect(verify({ a: 1 }, 'not-a-real-signature', SECRET)).toBe(false);
    expect(verify({ a: 1 }, '', SECRET)).toBe(false);
  });
});
