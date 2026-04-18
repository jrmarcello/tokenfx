export type TurnLike = {
  id: string;
  userPrompt: string | null;
  sequence: number;
};

const STRONG_CORRECTION =
  /\b(n[aã]o|don'?t|stop|wrong|errou|errado|na verdade|actually that'?s wrong|revert|undo)\b/i;
const MILD_CORRECTION =
  /\b(actually|hmm|wait|uhh|na real|reconsidera|reconsider)\b/i;

/**
 * For each turn i, look at turn i+1's userPrompt. If it matches the "strong"
 * correction regex, penalize turn i with 1.0. If "mild", 0.5. Returns only
 * penalized entries. Mirrors detectCorrectionPenalty in the transcript parser
 * but works on any TurnLike shape.
 */
export function correctionPenalties(
  turns: TurnLike[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < turns.length - 1; i++) {
    const next = turns[i + 1];
    const prompt = next.userPrompt;
    if (!prompt) continue;
    if (STRONG_CORRECTION.test(prompt)) {
      out.set(turns[i].id, 1.0);
    } else if (MILD_CORRECTION.test(prompt)) {
      out.set(turns[i].id, 0.5);
    }
  }
  return out;
}

type ScoreInput = {
  outputInputRatio: number | null;
  cacheHitRatio: number | null;
  avgRating: number | null;
  correctionDensity: number;
};

/**
 * Composite score in [0, 100].
 * Weights:
 *   output/input ratio (clipped at 2.0): 40%
 *   cache hit ratio (linear):            20%
 *   avg rating (-1..1 mapped 0..1):      30%
 *   (1 - correctionDensity):             10%
 * Null inputs are skipped and weights redistributed proportionally.
 */
export function effectivenessScore(input: ScoreInput): number {
  // If every signal is null, return 0 — correctionDensity alone is not
  // enough information to score a session.
  if (
    input.outputInputRatio === null &&
    input.cacheHitRatio === null &&
    input.avgRating === null
  ) {
    return 0;
  }

  const parts: Array<{ weight: number; value: number }> = [];

  if (input.outputInputRatio !== null) {
    const clipped = Math.max(0, Math.min(input.outputInputRatio, 2.0));
    parts.push({ weight: 0.4, value: clipped / 2.0 });
  }
  if (input.cacheHitRatio !== null) {
    const clipped = Math.max(0, Math.min(input.cacheHitRatio, 1.0));
    parts.push({ weight: 0.2, value: clipped });
  }
  if (input.avgRating !== null) {
    const clipped = Math.max(-1, Math.min(input.avgRating, 1));
    parts.push({ weight: 0.3, value: (clipped + 1) / 2 });
  }
  const density = Math.max(0, Math.min(input.correctionDensity, 1));
  parts.push({ weight: 0.1, value: 1 - density });

  const totalWeight = parts.reduce((acc, p) => acc + p.weight, 0);
  if (totalWeight === 0) return 0;

  let sum = 0;
  for (const p of parts) {
    sum += (p.weight / totalWeight) * p.value;
  }
  return Math.max(0, Math.min(100, sum * 100));
}

export function bucketCostPerTurn(
  values: number[],
  bucketCount: number,
): Array<{ bucket: string; count: number; lower: number; upper: number }> {
  if (values.length === 0 || bucketCount <= 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return [
      {
        bucket: formatRange(min, max),
        count: values.length,
        lower: min,
        upper: max,
      },
    ];
  }
  const range = max - min;
  const width = range / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const lower = min + i * width;
    const upper = i === bucketCount - 1 ? max : min + (i + 1) * width;
    return { bucket: formatRange(lower, upper), count: 0, lower, upper };
  });
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count += 1;
  }
  return buckets;
}

function formatRange(lower: number, upper: number): string {
  return `$${lower.toFixed(2)}-$${upper.toFixed(2)}`;
}
