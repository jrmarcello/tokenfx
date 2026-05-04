import { describe, it, expect } from 'vitest';
import {
  normalizeRadarMetrics,
  type RadarTeam,
  type NormalizedRadarTeam,
} from './radar-normalize';

/**
 * Unit tests for `normalizeRadarMetrics`.
 *
 * Anchors REQ-6 + Q13 from `.specs/manager-dashboard-v2.md`:
 *   - Per-axis min-max normalization across the team set ([0, 1]).
 *   - Divide-by-zero safe (min == max → all 0.5, not NaN).
 *   - When `teamIds.length < 2`, the radar is hidden — helper returns `null`.
 *   - The helper does NOT enforce the 6-team multi-select cap (caller's job);
 *     it just returns whatever it's given normalized (TC-U-18e).
 */

const baseTeam = (
  teamId: string,
  overrides: Partial<Omit<RadarTeam, 'teamId'>> = {},
): RadarTeam => ({
  teamId,
  cacheHit: 0.5,
  goodSessionPct: 0.5,
  subagentAdoptionPct: 0.5,
  editToolShare: 0.5,
  readToolShare: 0.5,
  ...overrides,
});

describe('normalizeRadarMetrics', () => {
  describe('TC-U-17: min-max normalization across the team set', () => {
    it('cacheHit [0.4, 0.6, 0.5] → [0, 1, 0.5]', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { cacheHit: 0.4 }),
          baseTeam('b', { cacheHit: 0.6 }),
          baseTeam('c', { cacheHit: 0.5 }),
        ],
      });
      expect(out).not.toBeNull();
      const result = out as NormalizedRadarTeam[];
      expect(result[0].cacheHit).toBe(0);
      expect(result[1].cacheHit).toBe(1);
      expect(result[2].cacheHit).toBe(0.5);
    });

    it('goodSessionPct [10, 90, 50] → [0, 1, 0.5]', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { goodSessionPct: 10 }),
          baseTeam('b', { goodSessionPct: 90 }),
          baseTeam('c', { goodSessionPct: 50 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result[0].goodSessionPct).toBe(0);
      expect(result[1].goodSessionPct).toBe(1);
      expect(result[2].goodSessionPct).toBe(0.5);
    });

    it('subagentAdoptionPct [0.2, 0.8, 0.5] → [0, 1, 0.5]', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { subagentAdoptionPct: 0.2 }),
          baseTeam('b', { subagentAdoptionPct: 0.8 }),
          baseTeam('c', { subagentAdoptionPct: 0.5 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result[0].subagentAdoptionPct).toBe(0);
      expect(result[1].subagentAdoptionPct).toBe(1);
      // Float-drift on linear interp; midpoint is conceptually 0.5.
      expect(result[2].subagentAdoptionPct).toBeCloseTo(0.5, 10);
    });

    it('editToolShare [0.1, 0.3, 0.2] → [0, 1, 0.5]', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { editToolShare: 0.1 }),
          baseTeam('b', { editToolShare: 0.3 }),
          baseTeam('c', { editToolShare: 0.2 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result[0].editToolShare).toBe(0);
      expect(result[1].editToolShare).toBe(1);
      expect(result[2].editToolShare).toBeCloseTo(0.5, 10);
    });

    it('readToolShare [0.05, 0.25, 0.15] → [0, 1, 0.5]', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { readToolShare: 0.05 }),
          baseTeam('b', { readToolShare: 0.25 }),
          baseTeam('c', { readToolShare: 0.15 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result[0].readToolShare).toBe(0);
      expect(result[1].readToolShare).toBe(1);
      expect(result[2].readToolShare).toBeCloseTo(0.5, 10);
    });

    it('preserves team order from input', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('team-c', { cacheHit: 0.4 }),
          baseTeam('team-a', { cacheHit: 0.6 }),
          baseTeam('team-b', { cacheHit: 0.5 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result.map((t) => t.teamId)).toEqual(['team-c', 'team-a', 'team-b']);
    });
  });

  describe('TC-U-18: divide-by-zero safety (all teams identical metric)', () => {
    it('all teams identical cacheHit → all 0.5 (not NaN, not div-by-zero)', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { cacheHit: 0.5 }),
          baseTeam('b', { cacheHit: 0.5 }),
          baseTeam('c', { cacheHit: 0.5 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      for (const t of result) {
        expect(t.cacheHit).toBe(0.5);
        expect(Number.isNaN(t.cacheHit)).toBe(false);
      }
    });

    it('all teams identical on every axis → every axis 0.5 for every team', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a'),
          baseTeam('b'),
          baseTeam('c'),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      for (const t of result) {
        expect(t.cacheHit).toBe(0.5);
        expect(t.goodSessionPct).toBe(0.5);
        expect(t.subagentAdoptionPct).toBe(0.5);
        expect(t.editToolShare).toBe(0.5);
        expect(t.readToolShare).toBe(0.5);
      }
    });

    it('mixed: identical cacheHit but varied goodSessionPct → cacheHit=0.5, goodSessionPct normalized', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', { cacheHit: 0.5, goodSessionPct: 10 }),
          baseTeam('b', { cacheHit: 0.5, goodSessionPct: 90 }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      expect(result[0].cacheHit).toBe(0.5);
      expect(result[1].cacheHit).toBe(0.5);
      expect(result[0].goodSessionPct).toBe(0);
      expect(result[1].goodSessionPct).toBe(1);
    });
  });

  describe('TC-U-18b: 1 team in input → null (radar hidden by REQ-6 + Q13)', () => {
    it('single team returns null', () => {
      const out = normalizeRadarMetrics({ teams: [baseTeam('only')] });
      expect(out).toBeNull();
    });
  });

  describe('TC-U-18c: 0 teams → null (defensive)', () => {
    it('empty team list returns null', () => {
      const out = normalizeRadarMetrics({ teams: [] });
      expect(out).toBeNull();
    });
  });

  describe('TC-U-18d: 6 teams (max allowed) → all 6 returned normalized', () => {
    it('returns exactly 6 normalized teams', () => {
      const teams: RadarTeam[] = Array.from({ length: 6 }, (_, i) =>
        baseTeam(`t${i}`, { cacheHit: i / 5 }),
      );
      const out = normalizeRadarMetrics({ teams });
      expect(out).not.toBeNull();
      const result = out as NormalizedRadarTeam[];
      expect(result).toHaveLength(6);
      expect(result[0].cacheHit).toBe(0);
      expect(result[5].cacheHit).toBe(1);
    });
  });

  describe('TC-U-18e: 7 teams → all 7 returned (caller handles truncation)', () => {
    it('returns 7 normalized teams; helper does not enforce 6-team cap', () => {
      const teams: RadarTeam[] = Array.from({ length: 7 }, (_, i) =>
        baseTeam(`t${i}`, { cacheHit: i / 6 }),
      );
      const out = normalizeRadarMetrics({ teams });
      expect(out).not.toBeNull();
      const result = out as NormalizedRadarTeam[];
      expect(result).toHaveLength(7);
      expect(result[0].cacheHit).toBe(0);
      expect(result[6].cacheHit).toBe(1);
    });
  });

  describe('output range invariants', () => {
    it('every axis of every team is in [0, 1] for an arbitrary team set', () => {
      const out = normalizeRadarMetrics({
        teams: [
          baseTeam('a', {
            cacheHit: 0.42,
            goodSessionPct: 13,
            subagentAdoptionPct: 0.71,
            editToolShare: 0.18,
            readToolShare: 0.06,
          }),
          baseTeam('b', {
            cacheHit: 0.91,
            goodSessionPct: 87,
            subagentAdoptionPct: 0.04,
            editToolShare: 0.55,
            readToolShare: 0.31,
          }),
          baseTeam('c', {
            cacheHit: 0.66,
            goodSessionPct: 51,
            subagentAdoptionPct: 0.4,
            editToolShare: 0.33,
            readToolShare: 0.18,
          }),
        ],
      });
      const result = out as NormalizedRadarTeam[];
      for (const t of result) {
        for (const axis of [
          t.cacheHit,
          t.goodSessionPct,
          t.subagentAdoptionPct,
          t.editToolShare,
          t.readToolShare,
        ]) {
          expect(axis).toBeGreaterThanOrEqual(0);
          expect(axis).toBeLessThanOrEqual(1);
          expect(Number.isFinite(axis)).toBe(true);
        }
      }
    });
  });
});
