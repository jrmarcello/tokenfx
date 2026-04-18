import { describe, it, expect } from 'vitest';
import {
  correctionPenalties,
  effectivenessScore,
  bucketCostPerTurn,
  type TurnLike,
} from '@/lib/analytics/scoring';

function makeTurn(id: string, sequence: number, userPrompt: string | null): TurnLike {
  return { id, sequence, userPrompt };
}

describe('correctionPenalties (TC-U-SCORING-01..05)', () => {
  it('strong match in Portuguese ("não, isso tá errado") penalizes preceding turn with 1.0', () => {
    const turns = [
      makeTurn('a', 0, 'pode ajudar?'),
      makeTurn('b', 1, 'não, isso tá errado'),
    ];
    const penalties = correctionPenalties(turns);
    expect(penalties.get('a')).toBe(1.0);
    expect(penalties.size).toBe(1);
  });

  it('strong match in English ("don\'t do that") penalizes preceding turn with 1.0', () => {
    const turns = [
      makeTurn('a', 0, 'first prompt'),
      makeTurn('b', 1, "don't do that please"),
    ];
    const penalties = correctionPenalties(turns);
    expect(penalties.get('a')).toBe(1.0);
  });

  it('mild match ("actually wait") penalizes preceding turn with 0.5', () => {
    const turns = [
      makeTurn('a', 0, 'first'),
      makeTurn('b', 1, 'actually, wait a sec'),
    ];
    const penalties = correctionPenalties(turns);
    expect(penalties.get('a')).toBe(0.5);
  });

  it('no match produces no penalty', () => {
    const turns = [
      makeTurn('a', 0, 'first'),
      makeTurn('b', 1, 'great, proceed'),
    ];
    const penalties = correctionPenalties(turns);
    expect(penalties.size).toBe(0);
  });

  it('last turn (no successor) is never penalized', () => {
    const turns = [makeTurn('a', 0, 'não')];
    const penalties = correctionPenalties(turns);
    expect(penalties.size).toBe(0);
  });

  it('null userPrompt on successor is ignored', () => {
    const turns = [makeTurn('a', 0, 'x'), makeTurn('b', 1, null)];
    expect(correctionPenalties(turns).size).toBe(0);
  });
});

describe('effectivenessScore (TC-U-SCORING-06..09)', () => {
  it('all inputs present (happy path) produces a score in (0,100]', () => {
    const score = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 1,
      correctionDensity: 0,
    });
    // 0.4 * 0.5 + 0.2 * 0.5 + 0.3 * 1 + 0.1 * 1 = 0.2 + 0.1 + 0.3 + 0.1 = 0.7
    expect(score).toBeCloseTo(70, 5);
  });

  it('all null inputs => 0', () => {
    const score = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: null,
      avgRating: null,
      correctionDensity: 0,
    });
    expect(score).toBe(0);
  });

  it('redistributes weights among present inputs when some are null', () => {
    // Only cacheHitRatio (0.2 weight) + correctionDensity (0.1 weight) present.
    // cacheHitRatio = 1.0, correctionDensity = 0 => value = 1, 1.
    // Total weight 0.3, so sum = (0.2/0.3)*1 + (0.1/0.3)*1 = 1.0 => 100.
    const score = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: 1.0,
      avgRating: null,
      correctionDensity: 0,
    });
    expect(score).toBeCloseTo(100, 5);
  });

  it('correctionDensity of 1 drags score down meaningfully', () => {
    const a = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
    });
    const b = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 1,
    });
    expect(b).toBeLessThan(a);
  });

  it('output/input ratio clipped at 2.0 for full marks', () => {
    const score = effectivenessScore({
      outputInputRatio: 10.0, // absurdly high, should clip
      cacheHitRatio: null,
      avgRating: null,
      correctionDensity: 0,
    });
    // only ratio (0.4) + density (0.1), value 1 and 1 => 100
    expect(score).toBeCloseTo(100, 5);
  });
});

describe('bucketCostPerTurn (TC-U-SCORING-10..12)', () => {
  it('empty input => []', () => {
    expect(bucketCostPerTurn([], 5)).toEqual([]);
  });

  it('10 values into 5 buckets produces 5 entries summing to 10', () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const buckets = bucketCostPerTurn(values, 5);
    expect(buckets.length).toBe(5);
    const total = buckets.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(10);
    // Lower of first = 0.1, upper of last = 1.0
    expect(buckets[0].lower).toBeCloseTo(0.1, 5);
    expect(buckets[4].upper).toBeCloseTo(1.0, 5);
  });

  it('all-equal values produces a single bucket', () => {
    const buckets = bucketCostPerTurn([0.5, 0.5, 0.5], 5);
    expect(buckets.length).toBe(1);
    expect(buckets[0].count).toBe(3);
    expect(buckets[0].lower).toBe(0.5);
    expect(buckets[0].upper).toBe(0.5);
  });
});
