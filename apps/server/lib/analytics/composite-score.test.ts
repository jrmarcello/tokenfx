import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeCompositeScore,
  isGoodSession,
  ConfigError,
  type CompositeInput,
} from './composite-score';

/**
 * Env-restoration helper. The "good session" classifier reads
 * `MANAGER_GOOD_SESSION_THRESHOLD` at call time, so individual tests flip the
 * env var and we restore the prior value afterwards. Mirrors the pattern in
 * `apps/server/lib/auth/email-hash.test.ts`.
 */
const ENV_KEYS = ['MANAGER_GOOD_SESSION_THRESHOLD'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let snapshot: Partial<Record<EnvKey, string | undefined>> = {};

const mutableEnv = process.env as Record<string, string | undefined>;
const setEnv = (key: EnvKey, value: string | undefined): void => {
  if (value === undefined) {
    delete mutableEnv[key];
    return;
  }
  mutableEnv[key] = value;
};

beforeEach(() => {
  snapshot = {
    MANAGER_GOOD_SESSION_THRESHOLD: process.env.MANAGER_GOOD_SESSION_THRESHOLD,
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    setEnv(key, snapshot[key]);
  }
});

describe('computeCompositeScore — v2 (4 components)', () => {
  type Case = {
    name: string;
    input: CompositeInput;
    expected: number | null;
  };

  // TC-U-01: 4-component happy path.
  // 0.40×0.5 + 0.40×(2.0/5) + 0.10×min(0.3×2,1) + 0.10×((0.5+1)/2)
  // = 0.20 + 0.16 + 0.06 + 0.075 = 0.495 → 50
  const happy: Case = {
    name: 'TC-U-01: happy path with all 4 components present rounds to 50',
    input: {
      cacheHit: 0.5,
      outputInput: 2.0,
      subagentUsage: 0.3,
      manualRating: 0.5,
    },
    expected: 50,
  };

  // TC-U-02: all metrics at perfect maxes → 100.
  // cacheHit=1, outputInput=5 (clamped to 5/5=1), subagentUsage=0.5 (×2=1), rating=1 ((1+1)/2=1)
  const perfect: Case = {
    name: 'TC-U-02: all metrics at perfect maxes equals exactly 100',
    input: {
      cacheHit: 1,
      outputInput: 5,
      subagentUsage: 0.5,
      manualRating: 1,
    },
    expected: 100,
  };

  // TC-U-03: all metrics at zero / negative → 0 (clip).
  const zero: Case = {
    name: 'TC-U-03: all metrics at 0 or negative clip to exactly 0',
    input: {
      cacheHit: 0,
      outputInput: -1, // clamped up to 0
      subagentUsage: 0,
      manualRating: -1,
    },
    expected: 0,
  };

  // TC-U-04: manualRating null → 0.10 weight redistributed across remaining 3.
  // Remaining weights: cache 0.40, output 0.40, subagent 0.10 → total 0.90.
  // 0.40/0.90 × 0.5 + 0.40/0.90 × 0.4 + 0.10/0.90 × 0.6
  //   = (0.20 + 0.16 + 0.06) / 0.90
  //   = 0.42 / 0.90 ≈ 0.4667
  // → 47
  const ratingNull: Case = {
    name: 'TC-U-04: manualRating null redistributes its 0.10 weight',
    input: {
      cacheHit: 0.5,
      outputInput: 2.0,
      subagentUsage: 0.3,
      manualRating: null,
    },
    expected: 47,
  };

  // TC-U-04b: outputInput null → 0.40 weight redistributed across cache (0.40),
  // subagent (0.10), manualRating (0.10) → total 0.60.
  // 0.40/0.60 × 0.5 + 0.10/0.60 × 0.6 + 0.10/0.60 × 0.75
  //   = (0.20 + 0.06 + 0.075) / 0.60
  //   = 0.335 / 0.60 ≈ 0.5583
  // → 56
  const outputNull: Case = {
    name: 'TC-U-04b: outputInput null redistributes its 0.40 weight',
    input: {
      cacheHit: 0.5,
      outputInput: null,
      subagentUsage: 0.3,
      manualRating: 0.5,
    },
    expected: 56,
  };

  // TC-U-05: all metrics null → null (no signal).
  const allNull: Case = {
    name: 'TC-U-05: all metrics null returns null',
    input: {
      cacheHit: null,
      outputInput: null,
      subagentUsage: null,
      manualRating: null,
    },
    expected: null,
  };

  it.each<Case>([happy, perfect, zero, ratingNull, outputNull, allNull])(
    '$name',
    ({ input, expected }) => {
      expect(computeCompositeScore(input)).toBe(expected);
    },
  );

  it('clamps subagentUsage above 0.5 cap to 1.0 (mapped value)', () => {
    // Sanity: subagentUsage=0.8 → min(0.8×2, 1) = 1; treated identically to 0.5
    const a = computeCompositeScore({
      cacheHit: 0,
      outputInput: 0,
      subagentUsage: 0.8,
      manualRating: -1,
    });
    const b = computeCompositeScore({
      cacheHit: 0,
      outputInput: 0,
      subagentUsage: 0.5,
      manualRating: -1,
    });
    expect(a).toBe(b);
  });

  it('clamps outputInput above 5 to 1.0 (mapped value)', () => {
    // Sanity: outputInput=10 → clamp(10/5, 0, 1) = 1; identical to 5.
    const a = computeCompositeScore({
      cacheHit: 0,
      outputInput: 10,
      subagentUsage: 0,
      manualRating: -1,
    });
    const b = computeCompositeScore({
      cacheHit: 0,
      outputInput: 5,
      subagentUsage: 0,
      manualRating: -1,
    });
    expect(a).toBe(b);
  });

  it('returns an integer in [0, 100]', () => {
    const result = computeCompositeScore({
      cacheHit: 0.37,
      outputInput: 1.7,
      subagentUsage: 0.21,
      manualRating: 0.4,
    });
    expect(result).not.toBeNull();
    expect(Number.isInteger(result)).toBe(true);
    if (result !== null) {
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }
  });
});

describe('isGoodSession — boundary + env-var threshold', () => {
  // Default threshold = 60 (env unset).

  it('TC-U-06: composite exactly 60 is counted as good (boundary, default threshold)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(60, -1)).toBe(true);
  });

  it('TC-U-07: composite 59 with rating 0 is good (rating override)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(59, 0)).toBe(true);
  });

  it('TC-U-08: composite 59 with rating -1 is NOT good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(59, -1)).toBe(false);
  });

  it('null composite + rating -1 is NOT good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(null, -1)).toBe(false);
  });

  it('null composite + rating null is NOT good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(null, null)).toBe(false);
  });

  it('TC-U-32: MANAGER_GOOD_SESSION_THRESHOLD=0 → composite=0 is good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '0');
    expect(isGoodSession(0, -1)).toBe(true);
  });

  it('TC-U-33: MANAGER_GOOD_SESSION_THRESHOLD=100 → composite=100 is good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '100');
    expect(isGoodSession(100, -1)).toBe(true);
  });

  it('TC-U-33b: MANAGER_GOOD_SESSION_THRESHOLD=100, composite=99 → NOT good', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '100');
    expect(isGoodSession(99, -1)).toBe(false);
  });

  it('TC-U-34: MANAGER_GOOD_SESSION_THRESHOLD=101 throws ConfigError (out of range)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '101');
    expect(() => isGoodSession(50, -1)).toThrow(ConfigError);
  });

  it('TC-U-34b: MANAGER_GOOD_SESSION_THRESHOLD=-1 throws ConfigError (out of range)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '-1');
    expect(() => isGoodSession(50, -1)).toThrow(ConfigError);
  });

  it('TC-U-35: MANAGER_GOOD_SESSION_THRESHOLD="banana" throws ConfigError (non-integer)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', 'banana');
    expect(() => isGoodSession(50, -1)).toThrow(ConfigError);
  });

  it('TC-U-35b: MANAGER_GOOD_SESSION_THRESHOLD="60.5" throws ConfigError (non-integer)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', '60.5');
    expect(() => isGoodSession(50, -1)).toThrow(ConfigError);
  });

  it('rating=0 alone (no composite signal) is good — generous-on-purpose semantics', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    // Spec REQ-2: "composite >= 60 OR manual_rating >= 0".
    expect(isGoodSession(null, 0)).toBe(true);
  });

  it('rating=1 with low composite is good (rating override path)', () => {
    setEnv('MANAGER_GOOD_SESSION_THRESHOLD', undefined);
    expect(isGoodSession(10, 1)).toBe(true);
  });
});
