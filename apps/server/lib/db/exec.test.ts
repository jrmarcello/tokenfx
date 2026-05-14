/**
 * Unit tests for `extractExecRows` — REQ-13 / TASK-C4 in
 * `.specs/review-report-2026-05-14-fixes.md`.
 *
 * Covers:
 *   TC-U-20 happy — array input is returned as-is
 *   TC-U-21 happy — `{ rows: [...] }` wrapper input is unwrapped
 *   TC-U-22 edge  — unexpected shapes throw `DriverShapeError` (post-self-
 *                   review fix, Security MEDIUM-2: throw instead of silently
 *                   returning `[]`, which would mask driver-swap regressions)
 *
 * The helper centralizes a copy-paste pattern previously repeated across
 * ~11 query sites (Drizzle's `db.execute(...)` returns different shapes
 * depending on the driver: postgres-js returns rows[], pg returns {rows}).
 */

import { describe, expect, it } from 'vitest';
import { extractExecRows, DriverShapeError } from './exec';

describe('extractExecRows', () => {
  it.each<{ name: string; input: unknown; expected: ReadonlyArray<unknown> }>([
    {
      name: 'returns array input as-is (postgres-js shape)',
      input: [{ a: 1 }],
      expected: [{ a: 1 }],
    },
    {
      name: 'returns empty array input as-is',
      input: [],
      expected: [],
    },
  ])('TC-U-20 $name', ({ input, expected }) => {
    expect(extractExecRows(input)).toEqual(expected);
  });

  it.each<{ name: string; input: unknown; expected: ReadonlyArray<unknown> }>([
    {
      name: 'unwraps `{ rows: [...] }` (pg driver shape)',
      input: { rows: [{ a: 1 }] },
      expected: [{ a: 1 }],
    },
    {
      name: 'unwraps `{ rows: [] }` with empty rows',
      input: { rows: [] },
      expected: [],
    },
  ])('TC-U-21 $name', ({ input, expected }) => {
    expect(extractExecRows(input)).toEqual(expected);
  });

  it.each<{ name: string; input: unknown; expectedType: string }>([
    { name: 'null input', input: null, expectedType: 'object' },
    { name: 'undefined input', input: undefined, expectedType: 'undefined' },
    { name: 'string input', input: 'oops', expectedType: 'string' },
    { name: 'number input', input: 42, expectedType: 'number' },
    { name: 'boolean input', input: true, expectedType: 'boolean' },
    {
      name: 'object without rows property',
      input: { foo: 'bar' },
      expectedType: 'object',
    },
    {
      name: 'object with non-array rows property',
      input: { rows: 'not-an-array' },
      expectedType: 'object',
    },
  ])('TC-U-22 throws DriverShapeError on $name', ({ input, expectedType }) => {
    let caught: unknown;
    try {
      extractExecRows(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DriverShapeError);
    expect((caught as DriverShapeError).receivedType).toBe(expectedType);
  });

  it('preserves generic Row type at compile time (type-only check)', () => {
    type Row = { id: string; n: number };
    const out: Row[] = extractExecRows<Row>([{ id: 'x', n: 1 }]);
    expect(out[0].id).toBe('x');
    expect(out[0].n).toBe(1);
  });
});
