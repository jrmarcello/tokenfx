export type TurnLike = {
  id: string;
  userPrompt: string | null;
  sequence: number;
};

/**
 * Correction detection regexes. Two tiers:
 *
 * - STRONG: explicit error/undo/retry signals. Penalizes the preceding
 *   assistant turn with weight 1.0.
 * - MILD: hedge/hesitation/"could be better" signals. Weight 0.5.
 *
 * Bilingual (pt-BR + en). Kept conservative — words with high false-positive
 * rates ("bug", "melhora", "improve" on their own) are excluded because they
 * often appear in legitimate first-turn requests ("melhora a doc",
 * "improve the prompt") rather than as corrections.
 */
const STRONG_CORRECTION = new RegExp(
  '\\b(?:' +
    [
      // --- pt
      'n[aã]o', // no (bare)
      'n[aã]o era (?:isso|assim|pra|bem|esse|essa|desse)',
      'errou',
      'errado',
      'na verdade',
      'volta atr[aá]s',
      'volta pra',
      'refaz',
      'refazer',
      'apaga(?:r|\\b)',
      'apague',
      'remove isso',
      'quebrou',
      'quebrado',
      'n[aã]o funcionou',
      'n[aã]o rodou',
      'n[aã]o compila',
      't[aá] errado',
      't[aá] ruim',
      // --- en
      "don'?t",
      'stop',
      'wrong',
      "actually that'?s wrong",
      'revert',
      'undo',
      "doesn'?t work",
      "didn'?t work",
      'not working',
      'broken',
      'failed',
      'try again',
      'not what i (?:wanted|asked|meant|said)',
      'fix this',
      'remove that',
      'delete that',
      "that'?s (?:wrong|incorrect|not right)",
      'this is wrong',
    ].join('|') +
    ')\\b',
  'i',
);

const MILD_CORRECTION = new RegExp(
  '\\b(?:' +
    [
      // --- pt
      'na real',
      'reconsidera',
      'repensa',
      'repense',
      'ajusta',
      'ajuste',
      'ajustar',
      'talvez',
      'ser[aá] que',
      'acho que n[aã]o',
      'hmm+',
      // --- en
      'actually',
      'hmm+',
      'wait',
      'uhh+',
      'reconsider',
      'rethink',
      "i don'?t think",
      "i'?m not sure",
    ].join('|') +
    ')\\b',
  'i',
);

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

export type ScoreInput = {
  outputInputRatio: number | null;
  cacheHitRatio: number | null;
  avgRating: number | null;
  correctionDensity: number;
  /**
   * Fraction of tool calls in the session that returned is_error=1.
   * Null when the session had zero tool calls.
   */
  toolErrorRate: number | null;
  /**
   * OTEL-only signal: accepts / (accepts + rejects) on Edit/Write/
   * NotebookEdit tool decisions. Null when OTEL is disabled or the
   * session had zero decision events.
   */
  acceptRate: number | null;
};

/**
 * Composite score in [0, 100].
 *
 * Weights (sum = 1.0):
 *   avg manual rating (-1..1 mapped 0..1):   30%
 *   (1 - correction density):                20%
 *   accept rate (OTEL):                      15%
 *   (1 - tool error rate):                   15%
 *   cache hit ratio (linear):                10%
 *   output/input ratio (clipped at 2.0):     10%
 *
 * Null inputs are skipped and remaining weights are redistributed
 * proportionally. correctionDensity is never null (zero when no turns);
 * toolErrorRate is null when the session had no tool calls; acceptRate
 * is null when OTEL is off or the session had no Edit/Write decisions.
 *
 * Design notes:
 * - Manual rating (30%) is the strongest single signal — human judgment
 *   captures what no heuristic can.
 * - Three automatic signals combine for 50% of the score: correction
 *   density (20%), accept rate (15%), tool error rate (15%). Each
 *   penalizes a different failure mode — retries, rejected edits,
 *   failed tool calls.
 * - Cache hit (10%) and output/input ratio (10%) are the weakest
 *   signals; output/input ratio is especially noisy (high can mean
 *   useful explanation OR verbose rambling).
 */
export function effectivenessScore(input: ScoreInput): number {
  const hasQualitySignal =
    input.outputInputRatio !== null ||
    input.cacheHitRatio !== null ||
    input.avgRating !== null ||
    input.toolErrorRate !== null ||
    input.acceptRate !== null;
  if (!hasQualitySignal) {
    // correctionDensity alone isn't enough to score a session.
    return 0;
  }

  const parts: Array<{ weight: number; value: number }> = [];

  if (input.outputInputRatio !== null) {
    const clipped = Math.max(0, Math.min(input.outputInputRatio, 2.0));
    parts.push({ weight: 0.1, value: clipped / 2.0 });
  }
  if (input.cacheHitRatio !== null) {
    const clipped = Math.max(0, Math.min(input.cacheHitRatio, 1.0));
    parts.push({ weight: 0.1, value: clipped });
  }
  if (input.avgRating !== null) {
    const clipped = Math.max(-1, Math.min(input.avgRating, 1));
    parts.push({ weight: 0.3, value: (clipped + 1) / 2 });
  }
  const density = Math.max(0, Math.min(input.correctionDensity, 1));
  parts.push({ weight: 0.2, value: 1 - density });
  if (input.toolErrorRate !== null) {
    const rate = Math.max(0, Math.min(input.toolErrorRate, 1));
    parts.push({ weight: 0.15, value: 1 - rate });
  }
  if (input.acceptRate !== null) {
    const rate = Math.max(0, Math.min(input.acceptRate, 1));
    parts.push({ weight: 0.15, value: rate });
  }

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
