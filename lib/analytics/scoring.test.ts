import { describe, it, expect } from 'vitest';
import {
  correctionPenalties,
  effectivenessScore,
  bucketCostPerTurn,
  type TurnLike,
} from '@/lib/analytics/scoring';

function makeTurn(
  id: string,
  sequence: number,
  userPrompt: string | null,
): TurnLike {
  return { id, sequence, userPrompt };
}

describe('correctionPenalties — core semantics', () => {
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

describe('correctionPenalties — expanded vocabulary', () => {
  const strongCases = [
    // pt
    'refaz isso',
    'refazer do zero',
    'apaga esse trecho',
    'apague tudo',
    'remove isso daí',
    'quebrou agora',
    'quebrado, nada funciona',
    'não funcionou',
    'não rodou',
    'não compila mais',
    'não era isso que eu queria',
    'não era assim',
    'não era pra fazer',
    'volta atrás',
    'volta pra versão anterior',
    'tá errado, rever',
    'tá ruim esse código',
    'acho que não é por aí', // matches via "não"
    "i don't think that's right", // matches via "don't"
    // en
    "doesn't work",
    "didn't work",
    'not working at all',
    'broken now',
    'failed to build',
    'try again',
    "that's wrong",
    'this is wrong',
    'not what i wanted',
    'not what i asked',
    'not what i meant',
    'fix this',
    'remove that',
    'delete that line',
  ];

  it.each(strongCases)('"%s" triggers STRONG penalty', (prompt) => {
    const turns = [makeTurn('a', 0, 'x'), makeTurn('b', 1, prompt)];
    expect(correctionPenalties(turns).get('a')).toBe(1.0);
  });

  const mildCases = [
    // pt
    'repensa essa abordagem',
    'repense isso',
    'ajusta aí o formato',
    'ajuste só essa linha',
    'talvez seja melhor outra',
    'será que tem como?',
    'hmm, interessante',
    // en
    'rethink the approach',
    "i'm not sure about that",
    'reconsider this',
  ];

  it.each(mildCases)('"%s" triggers MILD penalty', (prompt) => {
    const turns = [makeTurn('a', 0, 'x'), makeTurn('b', 1, prompt)];
    expect(correctionPenalties(turns).get('a')).toBe(0.5);
  });

  const nonCorrectionCases = [
    // These should NOT trigger — legitimate first-turn content
    'crie uma função pra somar',
    'please write a test',
    'add a new column',
    'melhora o readme', // intentionally excluded from pool
    'improve the docs', // intentionally excluded from pool
    'existe um bug no código X, qual a solução?', // "bug" not in pool
    'thanks, looks good',
  ];

  it.each(nonCorrectionCases)('"%s" does NOT trigger penalty', (prompt) => {
    const turns = [makeTurn('a', 0, 'x'), makeTurn('b', 1, prompt)];
    expect(correctionPenalties(turns).size).toBe(0);
  });
});

describe('effectivenessScore', () => {
  it('all inputs present (happy) — weighted sum', () => {
    const score = effectivenessScore({
      outputInputRatio: 1.0, // clipped/2 = 0.5, w=0.10 => 0.05
      cacheHitRatio: 0.5, //             0.5, w=0.10 => 0.05
      avgRating: 1, //                   1.0, w=0.30 => 0.30
      correctionDensity: 0, //           1.0, w=0.20 => 0.20
      toolErrorRate: 0, //               1.0, w=0.15 => 0.15
      acceptRate: 1, //                  1.0, w=0.15 => 0.15
    });
    // Sum = 0.05 + 0.05 + 0.30 + 0.20 + 0.15 + 0.15 = 0.90 => 90.0
    expect(score).toBeCloseTo(90, 5);
  });

  it('all quality signals null => 0 (correctionDensity alone insufficient)', () => {
    const score = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: null,
      avgRating: null,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    expect(score).toBe(0);
  });

  it('redistributes weights when some signals are null', () => {
    // Only cacheHitRatio (0.10) + correctionDensity (0.20) => both =1.0
    // Total weight 0.30; normalized sum = 1.0 => 100.
    const score = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: 1.0,
      avgRating: null,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    expect(score).toBeCloseTo(100, 5);
  });

  it('correctionDensity of 1 drags score meaningfully', () => {
    const a = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
      toolErrorRate: 0,
      acceptRate: 1,
    });
    const b = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 1,
      toolErrorRate: 0,
      acceptRate: 1,
    });
    expect(b).toBeLessThan(a);
    // correctionDensity weight = 0.2 => 20 points max difference
    expect(a - b).toBeCloseTo(20, 5);
  });

  it('toolErrorRate of 1 drags score meaningfully', () => {
    const a = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
      toolErrorRate: 0,
      acceptRate: 1,
    });
    const b = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
      toolErrorRate: 1,
      acceptRate: 1,
    });
    expect(b).toBeLessThan(a);
    // toolErrorRate weight = 0.15 => 15 points max difference
    expect(a - b).toBeCloseTo(15, 5);
  });

  it('acceptRate of 0 drags score meaningfully', () => {
    const a = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
      toolErrorRate: 0,
      acceptRate: 1,
    });
    const b = effectivenessScore({
      outputInputRatio: 1.0,
      cacheHitRatio: 0.5,
      avgRating: 0,
      correctionDensity: 0,
      toolErrorRate: 0,
      acceptRate: 0,
    });
    expect(b).toBeLessThan(a);
    // acceptRate weight = 0.15 => 15 points max difference
    expect(a - b).toBeCloseTo(15, 5);
  });

  it('output/input ratio clipped at 2.0 (ratio of 10 scores same as ratio of 2)', () => {
    const a = effectivenessScore({
      outputInputRatio: 10.0,
      cacheHitRatio: null,
      avgRating: null,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    const b = effectivenessScore({
      outputInputRatio: 2.0,
      cacheHitRatio: null,
      avgRating: null,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    expect(a).toBeCloseTo(b, 5);
  });

  it('null toolErrorRate is ignored (session with no tool calls)', () => {
    const score = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: null,
      avgRating: 1,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    expect(score).toBeCloseTo(100, 5);
  });

  it('null acceptRate is ignored (OTEL off or no decisions)', () => {
    const withNull = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: null,
      avgRating: 1,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: null,
    });
    const withPerfect = effectivenessScore({
      outputInputRatio: null,
      cacheHitRatio: null,
      avgRating: 1,
      correctionDensity: 0,
      toolErrorRate: null,
      acceptRate: 1,
    });
    // Both should be 100 because remaining signals are perfect;
    // null just changes weight redistribution.
    expect(withNull).toBeCloseTo(100, 5);
    expect(withPerfect).toBeCloseTo(100, 5);
  });
});

describe('bucketCostPerTurn', () => {
  it('empty input => []', () => {
    expect(bucketCostPerTurn([], 5)).toEqual([]);
  });

  it('10 values into 5 buckets produces 5 entries summing to 10', () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const buckets = bucketCostPerTurn(values, 5);
    expect(buckets.length).toBe(5);
    const total = buckets.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(10);
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
