import { deriveModelFamily, type ModelFamily } from './model';

/**
 * Lower bound for accepted effective rates (inclusive). Rates below this are
 * treated as pathological (likely a single extreme outlier sample) and the
 * helper falls through the cascade as if the entry did not exist.
 */
export const MIN_RATE = 0.01;

/**
 * Upper bound for accepted effective rates (inclusive). Rates above `1.0`
 * would imply the user pays MORE than Anthropic list price — impossible under
 * any current plan. `2.0` is the safety margin before we disregard.
 */
export const MAX_RATE = 2.0;

export type CostSource = 'otel' | 'calibrated' | 'list';

export type CalibrationFamily = 'opus' | 'sonnet' | 'haiku' | 'global';

export type CalibrationEntry = {
  family: CalibrationFamily;
  rate: number;
  sampleSessionCount: number;
  sumOtelCost: number;
  sumLocalCost: number;
  lastUpdatedAt: number;
};

export type Calibration = Map<CalibrationFamily, CalibrationEntry>;

export type EffectiveCostResult = {
  value: number;
  source: CostSource;
  /** Populated when source === 'calibrated'. */
  calibration?: {
    family: CalibrationFamily;
    rate: number;
    sampleCount: number;
  };
};

const isRateInBounds = (rate: number): boolean =>
  Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;

/**
 * Narrow a `ModelFamily` to a `CalibrationFamily`. `other` has no dedicated
 * calibration entry — it falls through to the global ratio.
 */
const calibrationFamilyFromModel = (
  model: string,
): Exclude<ModelFamily, 'other'> | null => {
  const family = deriveModelFamily(model);
  if (family === 'other') return null;
  return family;
};

/**
 * Resolve the effective cost for a session by walking the cascade:
 *
 *   1. OTEL (authoritative) — when `otelCost` is a positive number.
 *   2. Calibrated family rate — when the model maps to a known family with a
 *      valid rate in `[MIN_RATE, MAX_RATE]`.
 *   3. Calibrated global rate — fallback for unknown families or when the
 *      family-specific rate is out-of-bounds.
 *   4. List price — no calibration available or all rates rogue.
 *
 * Pure function: no I/O, no DB, no side effects. Defense-in-depth: even if a
 * rogue out-of-bounds rate slipped past the DB write-side validation, it is
 * ignored here and the cascade continues.
 *
 * `localCost === 0` short-circuits to `{ value: 0, source: 'list' }` — there
 * is nothing to multiply, and attributing the zero to a calibrated source
 * would be misleading in UI breakdowns.
 */
export const effectiveCostForSession = (args: {
  localCost: number;
  otelCost: number | null;
  model: string;
  calibration: Calibration;
}): EffectiveCostResult => {
  const { localCost, otelCost, model, calibration } = args;

  // 1. OTEL wins when present and strictly positive.
  if (otelCost !== null && otelCost > 0) {
    return { value: otelCost, source: 'otel' };
  }

  // Edge: zero local cost — nothing to calibrate, short-circuit to list.
  if (localCost === 0) {
    return { value: 0, source: 'list' };
  }

  // 2. Calibrated — try family-specific rate first.
  const family = calibrationFamilyFromModel(model);
  if (family !== null) {
    const entry = calibration.get(family);
    if (entry && isRateInBounds(entry.rate)) {
      return {
        value: localCost * entry.rate,
        source: 'calibrated',
        calibration: {
          family,
          rate: entry.rate,
          sampleCount: entry.sampleSessionCount,
        },
      };
    }
  }

  // 3. Calibrated — global fallback.
  const globalEntry = calibration.get('global');
  if (globalEntry && isRateInBounds(globalEntry.rate)) {
    return {
      value: localCost * globalEntry.rate,
      source: 'calibrated',
      calibration: {
        family: 'global',
        rate: globalEntry.rate,
        sampleCount: globalEntry.sampleSessionCount,
      },
    };
  }

  // 4. List price — cascade exhausted.
  return { value: localCost, source: 'list' };
};
