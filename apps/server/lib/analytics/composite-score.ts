/**
 * Composite effectiveness score for the **org-scope** manager dashboard
 * (`/manager/effectiveness`). Returns an integer in `[0, 100]`, or `null` when
 * the session has no usable signal across any of the four input components.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this lives in `apps/server/` and DIVERGES from the local
 * `lib/analytics/scoring.ts`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The local `lib/analytics/scoring.ts#effectivenessScore` runs at the
 * single-user, per-session level for the personal dashboard. It uses six
 * components (manualRating 30%, correctionDensity 20%, acceptRate 15%,
 * toolErrorRate 15%, cacheHitRatio 10%, outputInputRatio 10%) and reads
 * turn-level signals (corrections, tool errors, OTEL accept/reject decisions)
 * that the local SQLite ingester captures from the JSONL transcript.
 *
 * This file runs at the **org / team** scope, against the central reporter's
 * Postgres database. The aggregate inputs available there are different —
 * `sessions_agg` only carries per-session rollups produced by the dev's
 * sanitizer (REQ-21). Specifically:
 *
 *  1. **`correction_density` does NOT exist in `sessions_agg`.**
 *     That signal lives in turn-level events stripped by the reporter
 *     sanitizer (privacy guard — turn prompts/responses never leave the
 *     dev's machine). Surfacing it would require a carve-out spec to extend
 *     the reporter payload + sanitizer allowlist. So in v2 the
 *     `correction_density` component (0.20 in the v1 DRAFT) is **dropped
 *     entirely** and its weight is redistributed to cache_hit (+0.10 → 0.40)
 *     and output_input (+0.10 → 0.40) — the two strongest aggregate-level
 *     signals.
 *
 *  2. **`acceptRate` and `toolErrorRate` are also NOT exposed at org scope**
 *     (same reason — turn-level / OTEL-only). They stay personal-scope.
 *
 *  3. **`subagentUsage` IS available** as a session-level rollup (% of tool
 *     calls that delegated to a subagent), and is included with a 0.10
 *     weight as a discipline signal.
 *
 * Net result: org-scope is its own formula with four components, NOT the
 * personal-scope formula re-aggregated. They are deliberate peers — DO NOT
 * "fix" the divergence by merging this back into `scoring.ts`. The Test Plan
 * (manager-dashboard-v2.md → Architecture Decisions) covers each separately.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Formula (v2 — locked 2026-05-01)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   cacheHit         × 0.40   // [0, 1] cache_read_tokens / total
 *   clamp(out/in, 0..1, raw/5) × 0.40   // [0, 5] clamped, then divided by 5
 *   min(subagent×2, 1) × 0.10   // [0, 0.5] cap, mapped to [0, 1]
 *   ((rating + 1) / 2) × 0.10   // [-1, 1] mapped to [0, 1]
 *
 * Sum of weights = 1.0.
 *
 * **NULL redistribution**: when a component is null, its weight is dropped
 * and the remaining weights are renormalized so they still sum to 1.0
 * (proportional redistribution). When ALL inputs are null we return `null`
 * — the session has no signal at all, distinct from "scored zero".
 *
 * The output is **rounded to the nearest integer** and clamped to `[0, 100]`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "Good session" classifier
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `isGoodSession` mirrors REQ-2: a session is "good" if `composite >=
 * threshold` OR `manualRating >= 0`. The threshold is tunable via
 * `MANAGER_GOOD_SESSION_THRESHOLD` (integer in `[0, 100]`, default 60).
 * Out-of-range or non-integer env values throw `ConfigError` (TC-U-34/35).
 *
 * The OR-with-rating fallback is intentional: a positive manual rating from
 * the dev should always count as "good" even if the heuristic disagrees,
 * because the goal is **adoption** (REQ-2), not "find bad work".
 */

/**
 * Inputs to the composite score. All values are normalized at the SQL layer
 * before reaching this function (the queries in `manager-v2.ts` pull the
 * already-aggregated columns from `sessions_agg` and pass them through). The
 * function is **pure** and only does arithmetic: it does not touch the DB.
 *
 * NOTE: `correctionDensity` is intentionally absent. Adding it would be a
 * TypeScript error — see the v2 rationale above.
 */
export type CompositeInput = {
  /** Cache-hit ratio, `[0, 1]`. Source: `sessions_agg.cache_hit_ratio`. */
  cacheHit: number | null;
  /**
   * Raw output/input token ratio, typically `[0, 5]` but clamped before use.
   * Source: `sessions_agg.output_input_ratio`. NULL when the session is
   * OTEL-only or the reporter's parser couldn't extract a ratio.
   */
  outputInput: number | null;
  /**
   * Fraction of tool calls that delegated to a subagent. Source:
   * `sessions_agg.subagent_usage_ratio`. The "discipline cap" is 0.5 — past
   * that we treat it as saturated (delegation is a binary signal of
   * orchestration-style usage; over-delegation has diminishing returns).
   */
  subagentUsage: number | null;
  /**
   * Mean manual rating in `[-1, 1]`. Source: `sessions_agg.avg_rating`. NULL
   * when the session has no rating yet (the common case at first ingest).
   */
  manualRating: number | null;
};

/** `null` when every input is null; otherwise an integer in `[0, 100]`. */
export type CompositeResult = number | null;

/**
 * Configuration error raised when an environment variable that drives a
 * runtime decision (e.g. `MANAGER_GOOD_SESSION_THRESHOLD`) is malformed.
 * Distinct subclass so callers / tests can match on it directly without
 * pattern-matching on the message.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * Component descriptor used to build the weighted average. Each non-null
 * input becomes one entry; null inputs are skipped and the remaining weights
 * are renormalized to sum to 1.0 (proportional redistribution).
 */
type Component = { weight: number; value: number };

/**
 * Compute the org-scope composite effectiveness score for a single session.
 *
 * @param input - Per-session aggregate metrics, possibly with null fields.
 * @returns Integer in `[0, 100]`, or `null` when every input is null.
 */
export const computeCompositeScore = (input: CompositeInput): CompositeResult => {
  const parts: Component[] = [];

  if (input.cacheHit !== null) {
    parts.push({ weight: 0.4, value: clamp(input.cacheHit, 0, 1) });
  }
  if (input.outputInput !== null) {
    // Raw ratio domain is unbounded above; clamp the raw ratio to [0, 5]
    // before mapping into [0, 1] by dividing by 5. (Using clamp(raw/5, 0, 1)
    // would behave identically — written this way to mirror the JSDoc.)
    const clampedRaw = clamp(input.outputInput, 0, 5);
    parts.push({ weight: 0.4, value: clampedRaw / 5 });
  }
  if (input.subagentUsage !== null) {
    // Discipline cap at 0.5 → maps to 1.0 after ×2; values above 0.5 saturate.
    const capped = clamp(input.subagentUsage, 0, 0.5);
    parts.push({ weight: 0.1, value: capped * 2 });
  }
  if (input.manualRating !== null) {
    const clamped = clamp(input.manualRating, -1, 1);
    parts.push({ weight: 0.1, value: (clamped + 1) / 2 });
  }

  if (parts.length === 0) return null;

  const totalWeight = parts.reduce((acc, p) => acc + p.weight, 0);
  // totalWeight is bounded by [0.1, 1.0] when at least one part exists, so
  // the divisor is never zero. The early-return above guards `parts.length === 0`.
  let weightedSum = 0;
  for (const p of parts) {
    weightedSum += (p.weight / totalWeight) * p.value;
  }

  // weightedSum is in [0, 1] by construction (each value is in [0, 1] and the
  // renormalized weights sum to 1). Round + clamp defensively.
  const scaled = weightedSum * 100;
  return clamp(Math.round(scaled), 0, 100);
};

/**
 * Reads the "good session" threshold from `MANAGER_GOOD_SESSION_THRESHOLD`
 * at call time (lazy resolution — same posture as `email-hash.ts#getPepper`
 * so test fixtures that flip env vars per case work without module reload).
 *
 * Validates: must be an integer in `[0, 100]`. Empty / unset → default 60.
 * Anything else → `ConfigError`.
 */
const resolveGoodSessionThreshold = (): number => {
  const raw = process.env.MANAGER_GOOD_SESSION_THRESHOLD;
  if (raw === undefined || raw === '') return 60;

  // `Number()` accepts leading/trailing whitespace and scientific notation,
  // both of which we want to reject. Use a strict regex first.
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(
      `MANAGER_GOOD_SESSION_THRESHOLD must be an integer in [0, 100]; got ${JSON.stringify(raw)}.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new ConfigError(
      `MANAGER_GOOD_SESSION_THRESHOLD must be an integer in [0, 100]; got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
};

/**
 * Classifies a session as "good" per REQ-2:
 *   `composite >= threshold` OR `manualRating >= 0`.
 *
 * The OR is generous-on-purpose: a non-negative manual rating from the dev
 * counts as good even when the heuristic disagrees, because the goal of
 * REQ-2 is to surface adoption signal, not to flag bad work.
 *
 * @param composite - The composite score (or null when every signal is null).
 * @param manualRating - The mean manual rating in `[-1, 1]` (or null).
 * @returns `true` iff the session passes either branch of the OR.
 * @throws `ConfigError` when `MANAGER_GOOD_SESSION_THRESHOLD` is malformed.
 */
export const isGoodSession = (
  composite: number | null,
  manualRating: number | null,
): boolean => {
  const threshold = resolveGoodSessionThreshold();
  if (composite !== null && composite >= threshold) return true;
  if (manualRating !== null && manualRating >= 0) return true;
  return false;
};
