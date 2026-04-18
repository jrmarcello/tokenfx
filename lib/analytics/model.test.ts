import { describe, it, expect } from 'vitest';
import {
  deriveModelFamily,
  groupByFamily,
  MODEL_FAMILY_COLORS,
  type ModelBreakdownItem,
  type ModelFamily,
} from '@/lib/analytics/model';

describe('deriveModelFamily', () => {
  it.each([
    ['claude-opus-4-7', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
  ])('TC-U-01..03: %s → %s', (model, expected) => {
    expect(deriveModelFamily(model)).toBe(expected);
  });

  it('TC-U-04: strips trailing date suffix -YYYYMMDD', () => {
    expect(deriveModelFamily('claude-opus-4-1-20250401')).toBe('opus');
  });

  it('TC-U-05: strips bracket suffix [1m]', () => {
    expect(deriveModelFamily('claude-opus-4-7[1m]')).toBe('opus');
  });

  it('TC-U-06: case-insensitive match', () => {
    expect(deriveModelFamily('CLAUDE-OPUS-4-7')).toBe('opus');
  });

  it('TC-U-07: unknown model falls back to other', () => {
    expect(deriveModelFamily('gpt-4')).toBe('other');
  });

  it('TC-U-08: empty string falls back to other', () => {
    expect(deriveModelFamily('')).toBe('other');
  });
});

describe('groupByFamily', () => {
  it('TC-U-09: combines same-family rows', () => {
    const out = groupByFamily([
      { model: 'claude-opus-4-7', cost: 6 },
      { model: 'claude-opus-4-1', cost: 4 },
      { model: 'claude-sonnet-4-6', cost: 10 },
    ]);
    expect(out).toHaveLength(2);
    const opus = out.find((x) => x.family === 'opus');
    const sonnet = out.find((x) => x.family === 'sonnet');
    expect(opus?.cost).toBe(10);
    expect(sonnet?.cost).toBe(10);
    expect(opus?.pct).toBeCloseTo(0.5, 10);
    expect(sonnet?.pct).toBeCloseTo(0.5, 10);
  });

  it('TC-U-10: ties break deterministically by family name (alpha)', () => {
    const out = groupByFamily([
      { model: 'claude-opus-4-7', cost: 10 },
      { model: 'claude-sonnet-4-6', cost: 10 },
    ]);
    expect(out.map((x) => x.family)).toEqual(['opus', 'sonnet']);
  });

  it('TC-U-10 (cont): larger cost first when unequal', () => {
    const out = groupByFamily([
      { model: 'claude-opus-4-7', cost: 5 },
      { model: 'claude-sonnet-4-6', cost: 20 },
      { model: 'claude-haiku-4-5', cost: 10 },
    ]);
    expect(out.map((x) => x.family)).toEqual(['sonnet', 'haiku', 'opus']);
  });

  it('TC-U-11: pct sums to ~1.0', () => {
    const out = groupByFamily([
      { model: 'claude-opus-4-7', cost: 3 },
      { model: 'claude-sonnet-4-6', cost: 7 },
      { model: 'claude-haiku-4-5', cost: 13 },
    ]);
    const total = out.reduce((a, x) => a + x.pct, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-6);
  });

  it('TC-U-12: empty input → empty output', () => {
    expect(groupByFamily([])).toEqual<ModelBreakdownItem[]>([]);
  });

  it('TC-U-13: all-zero costs → empty output', () => {
    expect(
      groupByFamily([
        { model: 'claude-opus-4-7', cost: 0 },
        { model: 'claude-sonnet-4-6', cost: 0 },
      ]),
    ).toEqual<ModelBreakdownItem[]>([]);
  });

  it('groups unknown models under "other"', () => {
    const out = groupByFamily([
      { model: 'gpt-4', cost: 5 },
      { model: 'random', cost: 5 },
      { model: 'claude-opus-4-7', cost: 10 },
    ]);
    const other = out.find((x) => x.family === 'other');
    expect(other?.cost).toBe(10);
    expect(out).toHaveLength(2);
  });
});

describe('MODEL_FAMILY_COLORS', () => {
  it('has stable color for every family', () => {
    const families: ModelFamily[] = ['opus', 'sonnet', 'haiku', 'other'];
    for (const f of families) {
      expect(typeof MODEL_FAMILY_COLORS[f]).toBe('string');
      expect(MODEL_FAMILY_COLORS[f].length).toBeGreaterThan(0);
    }
  });
});
