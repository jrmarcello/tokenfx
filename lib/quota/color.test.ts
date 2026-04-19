import { describe, it, expect } from 'vitest';
import { quotaBand, computeFillPct, type QuotaBand } from './color';

describe('quotaBand', () => {
  it.each<[string, number, QuotaBand]>([
    ['TC-U-01: 0.0 -> green (happy)', 0.0, 'green'],
    ['TC-U-02: 0.69 -> green (edge below amber)', 0.69, 'green'],
    ['TC-U-03: 0.70 -> amber (inclusive-left amber boundary)', 0.7, 'amber'],
    ['TC-U-04: 0.80 -> amber (happy)', 0.8, 'amber'],
    ['TC-U-05: 0.89 -> amber (edge below red)', 0.89, 'amber'],
    ['TC-U-06: 0.90 -> red (inclusive-left red boundary)', 0.9, 'red'],
    ['TC-U-07: 1.00 -> red (happy)', 1.0, 'red'],
    ['TC-U-08: 1.50 -> red (overflow stays red)', 1.5, 'red'],
  ])('%s', (_label, pct, expected) => {
    expect(quotaBand(pct)).toBe(expected);
  });
});

describe('computeFillPct', () => {
  it('TC-U-09: computeFillPct(1.50) -> 1.0 (overflow capped visually)', () => {
    expect(computeFillPct(1.5)).toBe(1.0);
  });

  it('TC-U-10: computeFillPct(0.62) -> 0.62 (pass-through in range)', () => {
    expect(computeFillPct(0.62)).toBe(0.62);
  });

  it('TC-U-11: computeFillPct(0) -> 0 (underflow/zero)', () => {
    expect(computeFillPct(0)).toBe(0);
  });
});
