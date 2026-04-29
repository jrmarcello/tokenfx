/**
 * Pure least-squares linear regression helper.
 *
 * Fits y = slope·x + intercept to a set of `{x, y}` points and reports
 * the coefficient of determination (r²). Returns `null` for any input
 * that cannot yield a meaningful fit:
 *
 *  - Fewer than 3 finite points after filtering. The spec mentions a
 *    "sentinel" return for n=1; for ergonomic call sites we collapse
 *    n=1 and n=2 to the same `null` outcome — callers `=== null`-check
 *    once and bail out, rather than discriminating two degenerate
 *    shapes.
 *  - All x values equal (vertical data) — Σ(x - x̄)² is 0, so slope
 *    would divide by zero.
 *
 * Special-case for r²: when Σ(y - ȳ)² is 0 (all y equal, perfectly
 * horizontal data), the standard r² formula divides by zero. Residuals
 * are also 0 in that case, so we return r² = 1 (the fit explains 100%
 * of the zero variance — a deliberate, deterministic choice).
 *
 * Pure: no side effects, no imports beyond local types.
 */

export type LinearFit = {
  slope: number;
  intercept: number;
  /** Coefficient of determination, ∈ [0, 1]. */
  r2: number;
};

type Point = { x: number; y: number };

const isFinitePoint = (p: Point): boolean =>
  Number.isFinite(p.x) && Number.isFinite(p.y);

export const linearRegression = (points: ReadonlyArray<Point>): LinearFit | null => {
  const finite = points.filter(isFinitePoint);
  const n = finite.length;
  if (n < 3) return null;

  let sumX = 0;
  let sumY = 0;
  for (const p of finite) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0; // Σ(x - x̄)²
  let sxy = 0; // Σ((x - x̄)(y - ȳ))
  let syy = 0; // Σ(y - ȳ)²
  for (const p of finite) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx === 0) return null; // vertical data — slope undefined

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // r² = 1 - SS_res / SS_tot, where SS_tot = syy and
  // SS_res = Σ(y - (slope·x + intercept))².
  let ssRes = 0;
  for (const p of finite) {
    const predicted = slope * p.x + intercept;
    const residual = p.y - predicted;
    ssRes += residual * residual;
  }

  const r2 = syy === 0 ? 1 : 1 - ssRes / syy;

  return { slope, intercept, r2 };
};
