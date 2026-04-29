import { describe, it, expect } from 'vitest';
import { linearRegression, type LinearFit } from './regression';

describe('linearRegression', () => {
  it('TC-U-01: fits a perfectly linear set (y = x)', () => {
    const fit = linearRegression([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
    expect(fit).not.toBeNull();
    // Narrow null
    if (fit === null) return;
    expect(fit.slope).toBeCloseTo(1, 10);
    expect(fit.intercept).toBeCloseTo(0, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it('TC-U-02: rejects n=1 (degenerate, cannot fit)', () => {
    // Spec text mentions a sentinel; we choose `null` for both n<3 cases
    // (n=1 and n=2) for simplicity and consistency. Documented in JSDoc.
    expect(linearRegression([{ x: 5, y: 7 }])).toBeNull();
  });

  it('TC-U-03: rejects n=2 (degenerate, helper guards even if caller does)', () => {
    expect(
      linearRegression([
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    ).toBeNull();
  });

  it('TC-U-04: rejects vertical data (all x equal → division by zero)', () => {
    expect(
      linearRegression([
        { x: 5, y: 1 },
        { x: 5, y: 2 },
        { x: 5, y: 3 },
        { x: 5, y: 4 },
      ]),
    ).toBeNull();
  });

  it('TC-U-05: handles inverse correlation (slope < 0, r2 ∈ (0, 1])', () => {
    const fit = linearRegression([
      { x: 1, y: 10 },
      { x: 2, y: 8 },
      { x: 3, y: 6.5 },
      { x: 4, y: 4 },
      { x: 5, y: 2 },
    ]);
    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.slope).toBeLessThan(0);
    expect(fit.r2).toBeGreaterThan(0);
    expect(fit.r2).toBeLessThanOrEqual(1);
  });

  it('TC-U-06: filters NaN/Infinity points and regresses on the finite remainder', () => {
    const fit = linearRegression([
      { x: 1, y: 1 },
      { x: NaN, y: 5 },
      { x: 2, y: 2 },
      { x: 4, y: Infinity },
      { x: 3, y: 3 },
      { x: -Infinity, y: 0 },
    ]);
    // After filtering: {1,1},{2,2},{3,3} → perfect fit y=x
    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.slope).toBeCloseTo(1, 10);
    expect(fit.intercept).toBeCloseTo(0, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it('returns null when filtering leaves fewer than 3 points', () => {
    const fit = linearRegression([
      { x: 1, y: 1 },
      { x: NaN, y: 5 },
      { x: 2, y: Infinity },
    ]);
    expect(fit).toBeNull();
  });

  it('handles all-y-equal (horizontal line) deterministically: slope=0, r2=1', () => {
    // Σ(y - ȳ)² = 0 → r² denominator is 0. Numerator is also 0 (residuals
    // are zero on a perfectly horizontal line through ȳ). Documented as r²=1.
    const fit = linearRegression([
      { x: 1, y: 5 },
      { x: 2, y: 5 },
      { x: 3, y: 5 },
    ]);
    expect(fit).not.toBeNull();
    if (fit === null) return;
    expect(fit.slope).toBeCloseTo(0, 10);
    expect(fit.intercept).toBeCloseTo(5, 10);
    expect(fit.r2).toBe(1);
  });

  it('LinearFit type has the expected shape', () => {
    const fit: LinearFit = { slope: 1, intercept: 0, r2: 1 };
    expect(fit.slope).toBe(1);
    expect(fit.intercept).toBe(0);
    expect(fit.r2).toBe(1);
  });
});
