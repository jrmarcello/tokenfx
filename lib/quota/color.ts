/**
 * Quota color-band helpers — pure, side-effect-free.
 *
 * Used by the `QuotaNavWidget` and `/quota` page to map a usage ratio
 * (used / threshold) to a traffic-light color and a clamped bar fill.
 */

export type QuotaBand = 'green' | 'amber' | 'red';

/**
 * Maps a ratio (used / threshold) to a color band.
 *
 * Bounds are inclusive-on-the-left:
 *   pct < 0.70            -> green
 *   0.70 <= pct < 0.90    -> amber
 *   pct >= 0.90           -> red
 *
 * Overflow (pct > 1.0) stays red — no cap.
 */
export const quotaBand = (pct: number): QuotaBand => {
  if (pct < 0.7) return 'green';
  if (pct < 0.9) return 'amber';
  return 'red';
};

/**
 * Clamps a ratio to [0, 1] for visual rendering. Overflow (pct > 1)
 * caps the bar fill at 100% so the bar doesn't spill visually; the
 * caller is responsible for showing the real percentage as text.
 */
export const computeFillPct = (pct: number): number => {
  return Math.min(1, Math.max(0, pct));
};
