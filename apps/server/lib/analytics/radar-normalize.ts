/**
 * Radar comparison axis normalization for the manager-dashboard-v2 spec
 * (REQ-6 + Q13). Min-max normalizes each of the 5 effectiveness axes
 * across the manager's team set so that the radar polygon shows
 * **relative** performance (min → 0, max → 1, intermediate → linearly
 * interpolated), not absolute values.
 *
 * Q13 lock: when only one team is in scope there is nothing to compare,
 * so the radar is hidden in the UI and this helper returns `null`.
 *
 * Divide-by-zero safety: when every team has the same value on an axis,
 * the formula `(v - min) / (max - min)` is `0/0`. Returning NaN would
 * propagate through the chart layer; we return 0.5 (the midpoint of the
 * normalized range) so every team plots on the axis center for that axis.
 *
 * The helper is pure and does NOT enforce the 6-team multi-select cap
 * (REQ-6). Truncation is the caller's responsibility — keeping the
 * helper agnostic lets the SQL layer or UI control the cap independently.
 */

export type RadarTeam = {
  teamId: string;
  cacheHit: number;
  goodSessionPct: number;
  subagentAdoptionPct: number;
  editToolShare: number;
  readToolShare: number;
};

export type NormalizedRadarTeam = {
  teamId: string;
  /** Normalized 0..1 (relative position vs the input team set on this axis). */
  cacheHit: number;
  goodSessionPct: number;
  subagentAdoptionPct: number;
  editToolShare: number;
  readToolShare: number;
};

type Axis = keyof Omit<RadarTeam, 'teamId'>;

/** Min-max normalize one axis across the team set. min == max → all 0.5. */
const normalizeAxis = (values: readonly number[]): number[] => {
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span === 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / span);
};

/**
 * Min-max normalize the 5 radar axes across `teams`.
 *
 * - `teams.length < 2` → returns `null` (radar hidden by REQ-6 + Q13).
 * - For each axis, the lowest team value maps to 0, the highest to 1,
 *   intermediate values linearly. When every team has the same value on
 *   an axis (`min == max`), all teams map to 0.5 on that axis (no NaN).
 * - Team order in the output matches the input order; the 6-team cap is
 *   the caller's responsibility (the helper itself returns whatever it's
 *   given).
 */
export const normalizeRadarMetrics = (input: {
  teams: RadarTeam[];
}): NormalizedRadarTeam[] | null => {
  const { teams } = input;
  if (teams.length < 2) return null;

  // Normalize each axis once, then zip results back into per-team rows.
  const normalizedAxes: Record<Axis, number[]> = {
    cacheHit: normalizeAxis(teams.map((t) => t.cacheHit)),
    goodSessionPct: normalizeAxis(teams.map((t) => t.goodSessionPct)),
    subagentAdoptionPct: normalizeAxis(
      teams.map((t) => t.subagentAdoptionPct),
    ),
    editToolShare: normalizeAxis(teams.map((t) => t.editToolShare)),
    readToolShare: normalizeAxis(teams.map((t) => t.readToolShare)),
  };

  return teams.map((team, i) => ({
    teamId: team.teamId,
    cacheHit: normalizedAxes.cacheHit[i],
    goodSessionPct: normalizedAxes.goodSessionPct[i],
    subagentAdoptionPct: normalizedAxes.subagentAdoptionPct[i],
    editToolShare: normalizedAxes.editToolShare[i],
    readToolShare: normalizedAxes.readToolShare[i],
  }));
};
