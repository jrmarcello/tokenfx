/**
 * Anomaly detection heuristics for the manager dashboard.
 *
 * Pure functions, no I/O. Boundary semantics are spec-driven and tested
 * exhaustively in `anomaly-detection.test.ts`:
 *
 * - 3σ spend spike — boundary INCLUSIVE (`>=`). Exact 3σ flags.
 * - WoW spike — strict `>` +50%. Exact +50% does not flag.
 * - Drop-off — strict `>` 50% decline. Exact -50% does not flag.
 * - Knowledge-sharing — TWO gates, BOTH must fire (top vs median ≥ 2.0×
 *   AND top vs lowest-non-zero ≥ 4.0×). All-zero teams never flag.
 *
 * Edge cases:
 * - WoW ratios with `lastWeek = 0` are treated as "no prior activity" — not
 *   anomalies (covers onboarding-week noise).
 * - 3σ with `teamStdDev = 0` cannot compute σ-distance → never flags.
 * - Knowledge-sharing with < 2 non-zero teams → not flagged (no comparison).
 */

const SIGMA_THRESHOLD = 3;
const WOW_SPIKE_THRESHOLD = 0.5;
const WOW_DROP_THRESHOLD = 0.5;
const KS_MEDIAN_RATIO = 2.0;
const KS_BOTTOM_RATIO = 4.0;

/**
 * Flags a team whose 30-day spend is at least 3σ above the team mean.
 * Boundary INCLUSIVE — exact 3σ flags.
 */
export const detectSpike = (input: {
  thirtyDaySpend: number;
  teamMean: number;
  teamStdDev: number;
}): boolean => {
  const { thirtyDaySpend, teamMean, teamStdDev } = input;
  if (teamStdDev <= 0) return false;
  const sigmas = (thirtyDaySpend - teamMean) / teamStdDev;
  return sigmas >= SIGMA_THRESHOLD;
};

/**
 * Flags a strict > +50% week-over-week increase.
 * Exact +50% (e.g. 100 → 150) does NOT flag.
 * `lastWeek = 0` is treated as no comparable baseline → not flagged.
 */
export const detectWowSpike = (input: {
  thisWeek: number;
  lastWeek: number;
}): boolean => {
  const { thisWeek, lastWeek } = input;
  if (lastWeek <= 0) return false;
  const ratio = (thisWeek - lastWeek) / lastWeek;
  return ratio > WOW_SPIKE_THRESHOLD;
};

/**
 * Flags a strict > 50% drop in week-over-week usage.
 * Exact -50% (e.g. 100 → 50) does NOT flag (boundary).
 * `lastWeek = 0` is "no prior activity" — onboarding lag, not drop-off.
 *
 * `prevPrevWeek` is accepted for forward-compat with REQ-12 ("prior week
 * was active"), but the current implementation requires only `lastWeek > 0`
 * since `lastWeek` IS the "prior week was active" signal in the standard
 * interpretation. Kept in the signature for spec parity.
 */
export const detectDropOff = (input: {
  thisWeek: number;
  lastWeek: number;
  prevPrevWeek?: number;
}): boolean => {
  const { thisWeek, lastWeek } = input;
  if (lastWeek <= 0) return false;
  const drop = (lastWeek - thisWeek) / lastWeek;
  return drop > WOW_DROP_THRESHOLD;
};

export type KnowledgeSharingResult = {
  flagged: boolean;
  topIdx?: number;
  bottomIdx?: number;
  ratio?: number; // top / lowest-non-zero
  medianRatio?: number; // top / median
};

const median = (sorted: readonly number[]): number => {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Flags a knowledge-sharing opportunity when ONE team dominates two ways:
 *  Gate 1 — top usage ≥ 2.0 × team median (i.e. clearly above the pack).
 *  Gate 2 — top usage ≥ 4.0 × lowest non-zero team (i.e. lagging adopters
 *           still active enough to learn from the leader).
 *
 * Both boundaries are INCLUSIVE. Either gate failing → not flagged.
 *
 * "Lowest non-zero" excludes teams with zero usage (they're unrelated to a
 * sharing opportunity — they aren't using the product yet at all). If fewer
 * than 2 non-zero teams exist, the comparison is undefined → not flagged.
 */
export const detectKnowledgeSharingOpportunity = (input: {
  teams: { usage: number }[];
}): KnowledgeSharingResult => {
  const { teams } = input;
  if (teams.length < 2) return { flagged: false };

  let topIdx = -1;
  let topUsage = -Infinity;
  let bottomIdx = -1;
  let bottomUsage = Infinity;
  for (let i = 0; i < teams.length; i += 1) {
    const u = teams[i].usage;
    if (u > topUsage) {
      topUsage = u;
      topIdx = i;
    }
    if (u > 0 && u < bottomUsage) {
      bottomUsage = u;
      bottomIdx = i;
    }
  }

  if (topUsage <= 0 || bottomIdx === -1) return { flagged: false };
  if (topIdx === bottomIdx) return { flagged: false };

  const sorted = [...teams.map((t) => t.usage)].sort((a, b) => a - b);
  const med = median(sorted);
  if (med <= 0) return { flagged: false };

  const medianRatio = topUsage / med;
  const ratio = topUsage / bottomUsage;
  const flagged = medianRatio >= KS_MEDIAN_RATIO && ratio >= KS_BOTTOM_RATIO;

  return {
    flagged,
    topIdx,
    bottomIdx,
    ratio,
    medianRatio,
  };
};
