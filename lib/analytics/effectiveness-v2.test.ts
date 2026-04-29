import { describe, it, expect } from 'vitest';
import {
  LOW_TOOL_ERROR_RATE_THRESHOLD,
  MIN_FUNNEL_SESSIONS,
  EFFECTIVENESS_PALETTE,
  effectivenessLevelFor,
  computeMedian,
  formatInsightLine,
} from '@/lib/analytics/effectiveness-v2';

describe('LOW_TOOL_ERROR_RATE_THRESHOLD (TC-U-11)', () => {
  it('is exported and equals 0.1', () => {
    expect(LOW_TOOL_ERROR_RATE_THRESHOLD).toBe(0.1);
  });
});

describe('MIN_FUNNEL_SESSIONS (TC-U-12)', () => {
  it('is exported and equals 5', () => {
    expect(MIN_FUNNEL_SESSIONS).toBe(5);
  });
});

describe('EFFECTIVENESS_PALETTE (TC-U-13)', () => {
  it('has exactly 5 entries', () => {
    expect(EFFECTIVENESS_PALETTE).toHaveLength(5);
  });

  it('every entry is a valid 6-digit hex color', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const color of EFFECTIVENESS_PALETTE) {
      expect(color).toMatch(hex);
    }
  });

  it('order is L0 neutral → L1 rose → L2 amber → L3 lime → L4 emerald (locked spec values)', () => {
    expect(EFFECTIVENESS_PALETTE[0]).toBe('#525252'); // L0 neutral-600
    expect(EFFECTIVENESS_PALETTE[1]).toBe('#fb7185'); // L1 rose-400
    expect(EFFECTIVENESS_PALETTE[2]).toBe('#fbbf24'); // L2 amber-400
    expect(EFFECTIVENESS_PALETTE[3]).toBe('#a3e635'); // L3 lime-400
    expect(EFFECTIVENESS_PALETTE[4]).toBe('#34d399'); // L4 emerald-400
  });
});

describe('effectivenessLevelFor (TC-U-14)', () => {
  it.each([
    { input: null, expected: 0 },
    { input: 0, expected: 1 },
    { input: 24.999, expected: 1 },
    { input: 25, expected: 2 },
    { input: 49.999, expected: 2 },
    { input: 50, expected: 3 },
    { input: 74.999, expected: 3 },
    { input: 75, expected: 4 },
    { input: 100, expected: 4 },
  ] as const)('score=$input → level $expected', ({ input, expected }) => {
    expect(effectivenessLevelFor(input)).toBe(expected);
  });
});

describe('computeMedian', () => {
  it('returns null for empty array', () => {
    expect(computeMedian([])).toBeNull();
  });

  it('odd count → middle value', () => {
    expect(computeMedian([3, 1, 2])).toBe(2);
    expect(computeMedian([5, 5, 5])).toBe(5);
    expect(computeMedian([1, 2, 3, 4, 5])).toBe(3);
  });

  it('even count → mean of two middle values', () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
    expect(computeMedian([10, 20])).toBe(15);
  });

  it('filters NaN and Infinity defensively', () => {
    expect(computeMedian([NaN, 1, 2, 3])).toBe(2);
    expect(computeMedian([Infinity, 1, 2, 3])).toBe(2);
    expect(computeMedian([-Infinity, 1, 2, 3])).toBe(2);
  });

  it('all non-finite → null', () => {
    expect(computeMedian([NaN, Infinity, -Infinity])).toBeNull();
  });

  it('handles negative and decimal values', () => {
    expect(computeMedian([-2, -1, 0, 1, 2])).toBe(0);
    expect(computeMedian([0.5, 1.5, 2.5])).toBe(1.5);
  });
});

describe('formatInsightLine', () => {
  it('readsToEditsRatio happy path (TC-U-07)', () => {
    // canonical template per Design §12: "leem **{top}** arquivos por Edit"
    expect(formatInsightLine('readsToEditsRatio', 3, 12)).toBe(
      'Suas melhores sessões leem **3** arquivos por Edit; suas piores leem **12**',
    );
  });

  it('toolErrorRate with percentages (TC-U-08)', () => {
    const out = formatInsightLine('toolErrorRate', 0.02, 0.18);
    expect(out).toContain('erram');
    expect(out).toContain('**2%**');
    expect(out).toContain('**18%**');
    expect(out).toBe(
      'Suas melhores sessões erram **2%** das tool calls; suas piores erram **18%**',
    );
  });

  it('tokensUntilFirstEdit happy path', () => {
    expect(formatInsightLine('tokensUntilFirstEdit', 1234, 5678)).toBe(
      'Suas melhores sessões exploram **1234** tokens antes do 1º Edit; suas piores exploram **5678**',
    );
  });

  it('cacheHitRatio happy path', () => {
    expect(formatInsightLine('cacheHitRatio', 0.85, 0.42)).toBe(
      'Suas melhores sessões reaproveitam **85%** do contexto; suas piores reaproveitam **42%**',
    );
  });

  it('top === bottom → "Padrão consistente em **{value}**" (TC-U-09)', () => {
    expect(formatInsightLine('readsToEditsRatio', 5, 5)).toBe(
      'Padrão consistente em **5**',
    );
    expect(formatInsightLine('toolErrorRate', 0.1, 0.1)).toBe(
      'Padrão consistente em **10%**',
    );
    expect(formatInsightLine('cacheHitRatio', 0.5, 0.5)).toBe(
      'Padrão consistente em **50%**',
    );
    expect(formatInsightLine('tokensUntilFirstEdit', 200, 200)).toBe(
      'Padrão consistente em **200**',
    );
  });

  it('top null → omits the null side (TC-U-10)', () => {
    expect(formatInsightLine('readsToEditsRatio', null, 12)).toBe(
      'Suas piores sessões leem **12** arquivos por Edit; sem dado das melhores ainda',
    );
  });

  it('bottom null → omits the null side (TC-U-10)', () => {
    expect(formatInsightLine('readsToEditsRatio', 3, null)).toBe(
      'Suas melhores sessões leem **3** arquivos por Edit; sem dado das piores ainda',
    );
  });

  it('both null → fully neutral message', () => {
    expect(formatInsightLine('readsToEditsRatio', null, null)).toBe(
      'Sem dado suficiente ainda',
    );
  });

  it('toolErrorRate with null sides formats percentages on the present side', () => {
    expect(formatInsightLine('toolErrorRate', 0.05, null)).toBe(
      'Suas melhores sessões erram **5%** das tool calls; sem dado das piores ainda',
    );
    expect(formatInsightLine('toolErrorRate', null, 0.2)).toBe(
      'Suas piores sessões erram **20%** das tool calls; sem dado das melhores ainda',
    );
  });

  it('rounds tokens to nearest integer', () => {
    expect(formatInsightLine('tokensUntilFirstEdit', 1234.7, 5678.2)).toBe(
      'Suas melhores sessões exploram **1235** tokens antes do 1º Edit; suas piores exploram **5678**',
    );
  });
});
