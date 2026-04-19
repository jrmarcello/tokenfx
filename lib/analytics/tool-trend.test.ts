import { describe, it, expect } from 'vitest';
import {
  MIN_CALLS_PER_BUCKET,
  PALETTE,
  colorForTool,
  buildTrend,
  type RawTrendRow,
  type ToolTrendResult,
} from './tool-trend';

function raw(
  week: string,
  toolName: string,
  calls: number,
  errors: number,
): RawTrendRow {
  return { week, toolName, calls, errors };
}

describe('MIN_CALLS_PER_BUCKET', () => {
  it('is 5 (documented threshold)', () => {
    expect(MIN_CALLS_PER_BUCKET).toBe(5);
  });
});

describe('PALETTE', () => {
  it('has 10 entries, each a valid hex color', () => {
    expect(PALETTE).toHaveLength(10);
    for (const c of PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('colorForTool', () => {
  // TC-U-10
  it('TC-U-10: returns a PALETTE element, deterministically on repeat calls', () => {
    const first = colorForTool('Bash');
    expect(PALETTE).toContain(first);
    for (let i = 0; i < 100; i++) {
      expect(colorForTool('Bash')).toBe(first);
    }
  });

  // TC-U-11
  it.each(['Bash', 'Read', 'Edit', 'Grep', 'Write'])(
    'TC-U-11: tool "%s" maps to a PALETTE element',
    (tool) => {
      expect(PALETTE).toContain(colorForTool(tool));
    },
  );

  // TC-U-12
  it('TC-U-12: empty string returns a PALETTE element without throwing', () => {
    expect(() => colorForTool('')).not.toThrow();
    expect(PALETTE).toContain(colorForTool(''));
  });
});

describe('buildTrend', () => {
  // TC-U-01
  it('TC-U-01: single tool, sufficient calls → rate computed', () => {
    const out = buildTrend([raw('2026-W10', 'Bash', 20, 2)], 5);
    expect(out.tools).toEqual(['Bash']);
    expect(out.points).toHaveLength(1);
    expect(out.points[0]).toEqual({
      week: '2026-W10',
      rates: { Bash: 0.1 },
      counts: { Bash: { calls: 20, errors: 2 } },
    });
  });

  // TC-U-02 — single sub-threshold row: week dropped (consistent with
  // TC-U-09). Counts-preservation for sub-threshold buckets is tested
  // separately in "week emitted when at least one tool has a non-null
  // rate" below, which exercises the mixed case the UI actually hits.
  it('TC-U-02: isolated sub-threshold (calls < 5) week is dropped', () => {
    const out = buildTrend([raw('2026-W10', 'Bash', 4, 1)], 5);
    expect(out.tools).toEqual(['Bash']);
    expect(out.points).toEqual([]);
  });

  // TC-U-03
  it('TC-U-03: exactly at threshold (calls = 5) → rate computed (0/5 = 0)', () => {
    const out = buildTrend([raw('2026-W10', 'Bash', 5, 0)], 5);
    expect(out.points[0].rates.Bash).toBe(0);
  });

  // TC-U-04 — 1 call + 1 error is the volatile case the threshold exists
  // to suppress. Isolated → week dropped (same semantics as TC-U-02).
  it('TC-U-04: isolated 1/1 volatile bucket → week dropped', () => {
    const out = buildTrend([raw('2026-W10', 'Bash', 1, 1)], 5);
    expect(out.points).toEqual([]);
  });

  // TC-U-05
  it('TC-U-05: multiple weeks → ordered ASC by week string', () => {
    const rows: RawTrendRow[] = [
      raw('2026-W12', 'Bash', 10, 1),
      raw('2026-W10', 'Bash', 10, 0),
      raw('2026-W11', 'Bash', 10, 2),
    ];
    const out = buildTrend(rows, 5);
    expect(out.points.map((p) => p.week)).toEqual([
      '2026-W10',
      '2026-W11',
      '2026-W12',
    ]);
  });

  // TC-U-06
  it('TC-U-06: same week with all top-N tools → single point with all rates', () => {
    const rows: RawTrendRow[] = [
      raw('2026-W10', 'Bash', 20, 2),
      raw('2026-W10', 'Read', 10, 0),
      raw('2026-W10', 'Edit', 8, 1),
    ];
    const out = buildTrend(rows, 5);
    expect(out.points).toHaveLength(1);
    const p = out.points[0];
    expect(Object.keys(p.rates).sort()).toEqual(['Bash', 'Edit', 'Read']);
    expect(p.rates.Bash).toBeCloseTo(0.1, 10);
    expect(p.rates.Read).toBe(0);
    expect(p.rates.Edit).toBeCloseTo(0.125, 10);
  });

  // TC-U-07
  it('TC-U-07: tools outside top-N are omitted', () => {
    // 4 tools, topN=2 → only top-2 by total calls survive
    const rows: RawTrendRow[] = [
      raw('2026-W10', 'Bash', 100, 5),
      raw('2026-W10', 'Read', 80, 3),
      raw('2026-W10', 'Edit', 10, 1), // rank 3 — dropped
      raw('2026-W10', 'Grep', 5, 0), // rank 4 — dropped
    ];
    const out = buildTrend(rows, 2);
    expect(out.tools.sort()).toEqual(['Bash', 'Read']);
    expect(Object.keys(out.points[0].rates).sort()).toEqual(['Bash', 'Read']);
    expect(out.points[0].rates).not.toHaveProperty('Edit');
    expect(out.points[0].rates).not.toHaveProperty('Grep');
  });

  // TC-U-08
  it('TC-U-08: empty raw → empty result', () => {
    const out = buildTrend([], 5);
    expect(out).toEqual({ tools: [], points: [] });
  });

  // TC-U-09
  it('TC-U-09: all weeks sub-threshold for all tools → empty points', () => {
    const rows: RawTrendRow[] = [
      raw('2026-W10', 'Bash', 2, 0),
      raw('2026-W10', 'Read', 3, 1),
      raw('2026-W11', 'Bash', 1, 0),
    ];
    // Still picks top-N tools by call totals (Bash=3, Read=3 → alphabetic order)
    const out = buildTrend(rows, 5);
    expect(out.tools).toEqual(['Bash', 'Read']);
    expect(out.points).toEqual([]);
  });

  // TC-U-13
  it('TC-U-13: rows across 2 distinct weeks preserve ASC ordering', () => {
    const out = buildTrend(
      [raw('2026-W02', 'Bash', 10, 0), raw('2026-W01', 'Bash', 10, 1)],
      5,
    );
    expect(out.points[0].week < out.points[1].week).toBe(true);
  });

  // Additional: top-N tiebreak by alphabetic ASC
  it('top-N tiebreak by alphabetic ASC when call totals tie', () => {
    const rows: RawTrendRow[] = [
      raw('2026-W10', 'Zeta', 10, 0),
      raw('2026-W10', 'Alpha', 10, 0),
      raw('2026-W10', 'Beta', 10, 0),
    ];
    const out = buildTrend(rows, 2);
    expect(out.tools).toEqual(['Alpha', 'Beta']);
  });

  // Additional: errors > calls gets clamped to 1.0 (REQ sanity clamping)
  it('clamps rate to [0,1] when errors > calls (data corruption defense)', () => {
    const out = buildTrend([raw('2026-W10', 'Bash', 10, 15)], 5);
    expect(out.points[0].rates.Bash).toBe(1);
  });

  // Additional: sub-threshold week mixed with valid week — week emitted if
  // ANY tool has a non-null rate in it (kept when at least one tool valid)
  it('week emitted when at least one tool has a non-null rate', () => {
    const rows: RawTrendRow[] = [
      raw('2026-W10', 'Bash', 20, 2),
      raw('2026-W10', 'Read', 3, 0), // sub-threshold
      raw('2026-W11', 'Bash', 3, 0), // sub-threshold for only tool in week
    ];
    const out: ToolTrendResult = buildTrend(rows, 5);
    // W10 kept (Bash valid), W11 dropped (only tool sub-threshold)
    expect(out.points.map((p) => p.week)).toEqual(['2026-W10']);
    expect(out.points[0].rates.Bash).toBeCloseTo(0.1, 10);
    expect(out.points[0].rates.Read).toBeNull();
    // counts for Read still preserved on the week it appears
    expect(out.points[0].counts.Read).toEqual({ calls: 3, errors: 0 });
  });
});
