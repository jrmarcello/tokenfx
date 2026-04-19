import { describe, it, expect } from 'vitest';
import { distributePercents } from './percent';

function sumPct(strs: string[]): number {
  return strs.reduce((acc, s) => acc + parseFloat(s.replace('%', '')), 0);
}

describe('distributePercents', () => {
  it('returns [] for empty input', () => {
    expect(distributePercents([], 2)).toEqual([]);
  });

  it('single entry → 100.00%', () => {
    expect(distributePercents([1], 2)).toEqual(['100.00%']);
  });

  it('single entry regardless of input magnitude → 100.00% after normalization', () => {
    expect(distributePercents([0.5], 2)).toEqual(['100.00%']);
    expect(distributePercents([42], 2)).toEqual(['100.00%']);
  });

  it('equal thirds sum to 100.00% with stable tiebreak', () => {
    const out = distributePercents([1 / 3, 1 / 3, 1 / 3], 2);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    // Tiebreak by lower index → first row gets the extra 0.01%
    expect(out).toEqual(['33.34%', '33.33%', '33.33%']);
  });

  it('regression: 98.7% + 1.2% + three tiny rows sum to exactly 100.00% at 2 decimals', () => {
    // Screenshot-reproduced fractions from production data.
    const fractions = [
      688.2630 / 697.5016, // Main
      8.2765 / 697.5016, // general-purpose
      0.3207 / 697.5016, // code-reviewer
      0.3207 / 697.5016, // data-reviewer
      0.3207 / 697.5016, // security-reviewer
    ];
    const out = distributePercents(fractions, 2);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    // Main dominant, tiny rows are NON-ZERO (the fix)
    expect(out[0]).toMatch(/^\d{2}\.\d{2}%$/);
    for (let i = 2; i < out.length; i++) {
      expect(out[i]).not.toBe('0.00%');
    }
  });

  it('all zeros → every row is "0.00%" (no normalization possible)', () => {
    expect(distributePercents([0, 0, 0], 2)).toEqual([
      '0.00%',
      '0.00%',
      '0.00%',
    ]);
  });

  it('mix of zero and positive → zeros stay 0, positive share 100%', () => {
    const out = distributePercents([0, 0.5, 0.5], 2);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    expect(out[0]).toBe('0.00%');
    expect(out[1]).toBe('50.00%');
    expect(out[2]).toBe('50.00%');
  });

  it('non-finite values are coerced to 0', () => {
    const out = distributePercents([NaN, Infinity, 1], 2);
    expect(out[0]).toBe('0.00%');
    expect(out[1]).toBe('0.00%');
    expect(out[2]).toBe('100.00%');
  });

  it('negative values are coerced to 0', () => {
    const out = distributePercents([-1, 1], 2);
    expect(out).toEqual(['0.00%', '100.00%']);
  });

  it('decimals=0 → whole-number percentages summing to 100', () => {
    const out = distributePercents([1 / 3, 1 / 3, 1 / 3], 0);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    expect(out).toEqual(['34%', '33%', '33%']);
  });

  it('decimals=4 → handles very small fractions without flooring to zero', () => {
    const fractions = [0.9999, 0.0001];
    const out = distributePercents(fractions, 4);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    expect(out[1]).toBe('0.0100%');
  });

  it('respects precise value when already exact at target precision', () => {
    // 0.10 + 0.20 + 0.70 = 1.0 exactly at 2 decimals
    const out = distributePercents([0.1, 0.2, 0.7], 2);
    expect(out).toEqual(['10.00%', '20.00%', '70.00%']);
  });

  it('input fractions not summing to 1 are normalized first', () => {
    const out = distributePercents([2, 1, 1], 2); // 50 / 25 / 25
    expect(out).toEqual(['50.00%', '25.00%', '25.00%']);
  });

  it('many tiny equal entries — residue distributed evenly in index order', () => {
    // 7 equal entries, 2 decimals → each 14.285%...
    // at scale 10000 each is 1428.57... → floor 1428, fractional 0.57
    // sum floors = 9996, residue 4. Largest-remainder by tiebreak (lower
    // index) → first 4 entries get +0.01 extra.
    const out = distributePercents(Array(7).fill(1), 2);
    expect(sumPct(out)).toBeCloseTo(100, 10);
    expect(out.slice(0, 4)).toEqual([
      '14.29%',
      '14.29%',
      '14.29%',
      '14.29%',
    ]);
    expect(out.slice(4)).toEqual(['14.28%', '14.28%', '14.28%']);
  });
});
