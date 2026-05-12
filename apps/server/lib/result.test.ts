import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from './result';

describe('Result', () => {
  it('ok() wraps a value in { ok: true, value }', () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('err() wraps an error in { ok: false, error }', () => {
    const error = new Error('boom');
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
  });

  it('discriminated union narrows: ok branch exposes value, err branch exposes error', () => {
    const successCase: Result<number, Error> = ok(7);
    const failureCase: Result<number, Error> = err(new Error('nope'));

    if (successCase.ok) {
      // TS narrowing: `value` is accessible only when `ok` is true.
      expect(successCase.value).toBe(7);
    } else {
      throw new Error('expected ok branch');
    }

    if (!failureCase.ok) {
      // TS narrowing: `error` is accessible only when `ok` is false.
      expect(failureCase.error.message).toBe('nope');
    } else {
      throw new Error('expected err branch');
    }
  });
});
