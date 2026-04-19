/**
 * Format a list of fractions (summing to ≈ 1.0) as percentage strings
 * that round to the specified decimal precision AND sum exactly to
 * 100.00…% at that precision.
 *
 * Uses the Largest Remainder (Hamilton) Method: each quota is floored
 * to the precision, then the leftover slots are distributed to the
 * entries with the biggest fractional remainder. Prevents the two
 * independent-rounding artifacts you get with naive `.toFixed`:
 *
 * 1) Tiny shares vanish to `0.00%` when the raw fraction sits below
 *    half the precision step (e.g. 0.046% → "0.0%" at 1 decimal).
 * 2) Row percentages don't add up to 100 (e.g. 98.7 + 1.2 = 99.9).
 *
 * Empty input returns empty output. Non-finite/negative fractions are
 * coerced to 0 (only positive quotas participate in distribution). If
 * every quota is 0 the output is `"0.00%"` for each row (no normalization
 * possible).
 */
export function distributePercents(
  fractions: number[],
  decimals: number,
): string[] {
  if (fractions.length === 0) return [];

  const clamped = fractions.map((f) =>
    Number.isFinite(f) && f > 0 ? f : 0,
  );
  const sum = clamped.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    const zero = (0).toFixed(decimals);
    return clamped.map(() => `${zero}%`);
  }

  // Scale so that the target integer total = `100 * 10^decimals`. At
  // `decimals=2` this is 10000 → each integer unit represents 0.01%.
  const tenPow = 10 ** decimals;
  const target = 100 * tenPow;
  const scaled = clamped.map((f) => (f / sum) * target);
  const floors = scaled.map((s) => Math.floor(s));
  const fractional = scaled.map((s, i) => s - floors[i]);
  const floorSum = floors.reduce((a, b) => a + b, 0);

  // Residue should be in [0, N) — each fractional part is in [0, 1).
  // `Math.round` absorbs float drift in the target - floorSum subtraction.
  let residue = Math.round(target - floorSum);

  // Distribute one unit at a time to the largest remainders. Stable
  // tiebreak: lower index wins, matching how the component renders rows.
  const order = fractional
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r !== a.r ? b.r - a.r : a.i - b.i))
    .map((x) => x.i);

  const units = [...floors];
  let cursor = 0;
  while (residue > 0 && cursor < order.length) {
    units[order[cursor]] += 1;
    residue -= 1;
    cursor += 1;
  }

  return units.map((u) => `${(u / tenPow).toFixed(decimals)}%`);
}
