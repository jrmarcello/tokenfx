import { describe, expect, it } from 'vitest';

import {
  detectDropOff,
  detectKnowledgeSharingOpportunity,
  detectSpike,
  detectWowSpike,
} from './anomaly-detection';

describe('detectSpike — 3σ thirty-day spend rule', () => {
  // Boundary semantics: spec REQ-10 / TC-U-30 say "exact 3σ → flagged".
  // Implementation MUST use `>=` not `>`.
  it.each([
    {
      name: 'TC-U-09 — 5σ above mean → flagged',
      input: { thirtyDaySpend: 100 + 5 * 10, teamMean: 100, teamStdDev: 10 },
      expected: true,
    },
    {
      name: 'TC-U-10 — 2.5σ above mean → not flagged',
      input: { thirtyDaySpend: 100 + 2.5 * 10, teamMean: 100, teamStdDev: 10 },
      expected: false,
    },
    {
      name: 'TC-U-30 — exactly 3.0σ → flagged (boundary inclusive)',
      input: { thirtyDaySpend: 100 + 3.0 * 10, teamMean: 100, teamStdDev: 10 },
      expected: true,
    },
    {
      name: 'TC-U-31 — 2.99σ → not flagged',
      input: { thirtyDaySpend: 100 + 2.99 * 10, teamMean: 100, teamStdDev: 10 },
      expected: false,
    },
    {
      name: 'edge — spend exactly equals mean (0σ) → not flagged',
      input: { thirtyDaySpend: 100, teamMean: 100, teamStdDev: 10 },
      expected: false,
    },
    {
      name: 'edge — spend below mean → not flagged',
      input: { thirtyDaySpend: 50, teamMean: 100, teamStdDev: 10 },
      expected: false,
    },
    {
      name: 'edge — zero std dev with spend > mean → not flagged (cannot compute σ-distance)',
      input: { thirtyDaySpend: 200, teamMean: 100, teamStdDev: 0 },
      expected: false,
    },
    {
      name: 'edge — zero std dev with spend == mean → not flagged',
      input: { thirtyDaySpend: 100, teamMean: 100, teamStdDev: 0 },
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(detectSpike(input)).toBe(expected);
  });
});

describe('detectWowSpike — week-over-week strict > +50%', () => {
  // REQ-10 wording: "spike > +50%". Strict >, not >=. TC-U-11/12 confirm.
  it.each([
    {
      name: 'TC-U-11 — exactly +50% (100 -> 150) → not flagged (strict >)',
      input: { thisWeek: 150, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'TC-U-12 — +49.99% → not flagged',
      input: { thisWeek: 149.99, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'TC-U-11b — +50.01% → flagged (just above strict threshold)',
      input: { thisWeek: 150.01, lastWeek: 100 },
      expected: true,
    },
    {
      name: '+200% jump → flagged',
      input: { thisWeek: 300, lastWeek: 100 },
      expected: true,
    },
    {
      name: 'flat (no change) → not flagged',
      input: { thisWeek: 100, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'decrease → not flagged',
      input: { thisWeek: 50, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'lastWeek=0 → not flagged (cannot compute ratio; first-week onboarding)',
      input: { thisWeek: 100, lastWeek: 0 },
      expected: false,
    },
    {
      name: 'both zero → not flagged',
      input: { thisWeek: 0, lastWeek: 0 },
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(detectWowSpike(input)).toBe(expected);
  });
});

describe('detectDropOff — strict > 50% week-over-week decline', () => {
  // REQ-12 / TC-U-15: exactly -50% → not flagged (strict >).
  it.each([
    {
      name: 'TC-U-13 — -80% drop (100 -> 20) → flagged',
      input: { thisWeek: 20, lastWeek: 100 },
      expected: true,
    },
    {
      name: 'TC-U-14 — thisWeek=0, lastWeek=0 → not flagged (no prior activity)',
      input: { thisWeek: 0, lastWeek: 0 },
      expected: false,
    },
    {
      name: 'TC-U-15 — exactly -50% (100 -> 50) → not flagged (boundary, strict >)',
      input: { thisWeek: 50, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'TC-U-16 — -66.6% (100 -> 33.4) → flagged',
      input: { thisWeek: 33.4, lastWeek: 100 },
      expected: true,
    },
    {
      name: 'lastWeek=0, thisWeek>0 → not flagged (first week onboarding, not a drop-off)',
      input: { thisWeek: 50, lastWeek: 0 },
      expected: false,
    },
    {
      name: '-50.01% → flagged (just past the boundary)',
      input: { thisWeek: 49.99, lastWeek: 100 },
      expected: true,
    },
    {
      name: 'flat → not flagged',
      input: { thisWeek: 100, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'increase → not flagged',
      input: { thisWeek: 200, lastWeek: 100 },
      expected: false,
    },
    {
      name: 'thisWeek=0 with strong prior week → flagged (-100%)',
      input: { thisWeek: 0, lastWeek: 100 },
      expected: true,
    },
  ])('$name', ({ input, expected }) => {
    expect(detectDropOff(input)).toBe(expected);
  });
});

describe('detectKnowledgeSharingOpportunity — top vs median + lowest-non-zero gates', () => {
  // REQ-13: BOTH gates fire — top >= 2.0 × median AND top >= 4.0 × bottom.
  // TC-U-40 covers boundary cases: 2.0×/4.0× → flagged; either gate fails → not flagged.

  it('TC-U-20 — top 5× lowest, 2× median → flagged', () => {
    // teams: [10, 10, 10, 10, 50] → median=10, top=50, bottom=10 → 50/10=5, 50/10=5, ratio=5
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 10 }, { usage: 10 }, { usage: 10 }, { usage: 10 }, { usage: 50 }],
    });
    expect(result.flagged).toBe(true);
    expect(result.topIdx).toBe(4);
    expect(result.bottomIdx).toBe(0);
    expect(result.ratio).toBe(5);
  });

  it('TC-U-21 — all teams zero → not flagged', () => {
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 0 }, { usage: 0 }, { usage: 0 }],
    });
    expect(result.flagged).toBe(false);
  });

  it('TC-U-40a — exactly top=2.0×median AND top=4.0×lowest → flagged (both boundaries inclusive)', () => {
    // bottom=10, median=20, top=40 → top/median=2.0, top/bottom=4.0
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 10 }, { usage: 20 }, { usage: 40 }],
    });
    expect(result.flagged).toBe(true);
    expect(result.medianRatio).toBe(2);
    expect(result.ratio).toBe(4);
  });

  it('TC-U-40b — 1.99× median + 4.0× lowest → not flagged (gate 1 fails)', () => {
    // We need top/bottom = 4.0 but top/median = 1.99.
    // top=39.8, median=20, bottom=9.95 → 39.8/20=1.99, 39.8/9.95=4.0
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 9.95 }, { usage: 20 }, { usage: 39.8 }],
    });
    expect(result.flagged).toBe(false);
  });

  it('TC-U-40c — 2.0× median + 3.99× lowest → not flagged (gate 2 fails)', () => {
    // top=40, median=20, bottom=40/3.99 ≈ 10.0250...
    // top/median = 2.0, top/bottom = 3.99
    const bottom = 40 / 3.99;
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: bottom }, { usage: 20 }, { usage: 40 }],
    });
    expect(result.flagged).toBe(false);
  });

  it('empty teams → not flagged', () => {
    const result = detectKnowledgeSharingOpportunity({ teams: [] });
    expect(result.flagged).toBe(false);
  });

  it('single team → not flagged (no comparison possible)', () => {
    const result = detectKnowledgeSharingOpportunity({ teams: [{ usage: 100 }] });
    expect(result.flagged).toBe(false);
  });

  it('top is zero → not flagged (no usage anywhere)', () => {
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 0 }, { usage: 0 }, { usage: 0 }, { usage: 0 }],
    });
    expect(result.flagged).toBe(false);
  });

  it('bottom team has zero usage but others do not → bottom is lowest non-zero', () => {
    // teams: [0, 5, 20, 50]. zeros excluded from "bottom non-zero".
    // bottom (non-zero) = 5, median of all teams = (5+20)/2 = 12.5, top = 50.
    // top/median = 50/12.5 = 4.0 ≥ 2.0 ✓, top/bottom = 50/5 = 10 ≥ 4.0 ✓ → flagged.
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 0 }, { usage: 5 }, { usage: 20 }, { usage: 50 }],
    });
    expect(result.flagged).toBe(true);
    expect(result.topIdx).toBe(3);
    expect(result.bottomIdx).toBe(1);
  });

  it('all teams equal non-zero → not flagged (top/median = 1.0, top/bottom = 1.0)', () => {
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 10 }, { usage: 10 }, { usage: 10 }],
    });
    expect(result.flagged).toBe(false);
  });

  it('only one non-zero team → not flagged (no bottom non-zero comparison)', () => {
    const result = detectKnowledgeSharingOpportunity({
      teams: [{ usage: 0 }, { usage: 0 }, { usage: 100 }],
    });
    expect(result.flagged).toBe(false);
  });
});
