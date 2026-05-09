import { describe, it, expect } from 'vitest';

import {
  avgMergedPrsPerSessionWithOutcome,
  aggregateOrgRollup,
  costPerMergedLoc,
  revertRate,
  tokensPerMergedLoc,
  type TeamOutcomesRollup,
} from './team-outcomes';

// ---- Pure ratio helpers (REQ-12) -----------------------------------------

describe('tokensPerMergedLoc', () => {
  // TC-U-11 (REQ-12): div-by-zero guard
  it('returns null when totalLocAdded === 0 (div-by-zero guard)', () => {
    expect(
      tokensPerMergedLoc({
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalLocAdded: 0,
      }),
    ).toBeNull();
  });

  // TC-U-12 (REQ-12): happy path
  it('returns (input + output) / locAdded when locAdded > 0', () => {
    expect(
      tokensPerMergedLoc({
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalLocAdded: 30,
      }),
    ).toBe(5);
  });
});

describe('costPerMergedLoc', () => {
  // TC-U-13 (REQ-12): happy path
  it('returns cost / locAdded when locAdded > 0', () => {
    expect(
      costPerMergedLoc({ totalCostUsd: 12.5, totalLocAdded: 100 }),
    ).toBe(0.125);
  });

  // TC-U-13b (REQ-12): div-by-zero guard
  it('returns null when totalLocAdded === 0', () => {
    expect(
      costPerMergedLoc({ totalCostUsd: 5.0, totalLocAdded: 0 }),
    ).toBeNull();
  });
});

describe('revertRate', () => {
  // TC-U-14 (REQ-12): div-by-zero (no commits at all)
  it('returns null when totalCommits === 0', () => {
    expect(revertRate({ totalReverts: 0, totalCommits: 0 })).toBeNull();
  });

  // TC-U-14b (REQ-12): clean team — 0 reverts but commits > 0 → 0.0 NOT null
  it('returns 0.0 when totalReverts === 0 AND totalCommits > 0 (clean team)', () => {
    expect(revertRate({ totalReverts: 0, totalCommits: 5 })).toBe(0);
  });

  it('returns reverts / commits when both > 0', () => {
    expect(revertRate({ totalReverts: 2, totalCommits: 8 })).toBe(0.25);
  });
});

describe('avgMergedPrsPerSessionWithOutcome', () => {
  it('returns null when sessionsWithOutcome === 0', () => {
    expect(
      avgMergedPrsPerSessionWithOutcome({
        totalMergedPrCount: 5,
        sessionsWithOutcome: 0,
      }),
    ).toBeNull();
  });

  it('returns null when totalMergedPrCount is null (PR lookup off / all rate-limited)', () => {
    expect(
      avgMergedPrsPerSessionWithOutcome({
        totalMergedPrCount: null,
        sessionsWithOutcome: 10,
      }),
    ).toBeNull();
  });

  it('returns total / count when both are populated', () => {
    expect(
      avgMergedPrsPerSessionWithOutcome({
        totalMergedPrCount: 8,
        sessionsWithOutcome: 4,
      }),
    ).toBe(2);
  });
});

// ---- Pure aggregation helper ---------------------------------------------

describe('aggregateOrgRollup', () => {
  const baseRow = (overrides: Partial<TeamOutcomesRollup>): TeamOutcomesRollup => ({
    orgId: 'org-A',
    teamId: 'team-1',
    day: '2026-05-01',
    totalCommits: 0,
    totalLocAdded: 0,
    totalLocRemoved: 0,
    totalFilesChanged: 0,
    totalRevertsWithin7d: 0,
    totalMergedPrCount: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    sessionsWithOutcome: 0,
    ...overrides,
  });

  it('sums all numeric fields across rows', () => {
    const result = aggregateOrgRollup([
      baseRow({
        totalCommits: 5,
        totalLocAdded: 100,
        totalCostUsd: 1.5,
        sessionsWithOutcome: 3,
      }),
      baseRow({
        totalCommits: 3,
        totalLocAdded: 50,
        totalCostUsd: 0.75,
        sessionsWithOutcome: 2,
      }),
    ]);
    expect(result.totalCommits).toBe(8);
    expect(result.totalLocAdded).toBe(150);
    expect(result.totalCostUsd).toBe(2.25);
    expect(result.sessionsWithOutcome).toBe(5);
  });

  it('returns NULL totalMergedPrCount when ALL rows have it as NULL', () => {
    const result = aggregateOrgRollup([
      baseRow({ totalMergedPrCount: null }),
      baseRow({ totalMergedPrCount: null }),
    ]);
    expect(result.totalMergedPrCount).toBeNull();
  });

  it('sums non-null totalMergedPrCount values, ignoring null rows', () => {
    const result = aggregateOrgRollup([
      baseRow({ totalMergedPrCount: 3 }),
      baseRow({ totalMergedPrCount: null }), // skipped
      baseRow({ totalMergedPrCount: 5 }),
    ]);
    expect(result.totalMergedPrCount).toBe(8);
  });

  it('handles empty input — returns zero values, NULL merged_pr_count', () => {
    const result = aggregateOrgRollup([]);
    expect(result.totalCommits).toBe(0);
    expect(result.totalMergedPrCount).toBeNull();
    expect(result.sessionsWithOutcome).toBe(0);
  });
});
