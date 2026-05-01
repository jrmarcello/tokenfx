import { describe, it, expect } from 'vitest';

import { canonicalJSON } from './canonical-json';

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

  it('produces byte-equal output for logically equal payloads with different key order', () => {
    const a = { foo: 1, bar: 2, nested: { x: 1, y: 2 } };
    const b = { nested: { y: 2, x: 1 }, bar: 2, foo: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('produces byte-equal output regardless of source whitespace', () => {
    const compact = JSON.parse('{"a":1,"b":2}');
    const spaced = JSON.parse('{\n  "b": 2,\n  "a": 1\n}');
    expect(canonicalJSON(compact)).toBe(canonicalJSON(spaced));
  });

  it('rejects unsupported types (undefined, functions, symbols)', () => {
    expect(() => canonicalJSON(undefined)).toThrow();
    expect(() => canonicalJSON(() => 1)).toThrow();
    expect(() => canonicalJSON(Symbol('x'))).toThrow();
  });

  it('serializes empty containers', () => {
    expect(canonicalJSON({})).toBe('{}');
    expect(canonicalJSON([])).toBe('[]');
  });
});
