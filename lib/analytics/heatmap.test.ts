import { describe, it, expect } from 'vitest';
import {
  computeLevels,
  arrangeWeeks,
  monthLabels,
  parseDateParam,
  type HeatmapCell,
  type Week,
  type ParsedDate,
} from '@/lib/analytics/heatmap';

describe('computeLevels', () => {
  it('TC-U-01: empty input → []', () => {
    expect(computeLevels([])).toEqual<number[]>([]);
  });

  it('TC-U-02: all-zero input → all 0', () => {
    expect(computeLevels([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it('TC-U-03: [0, 2, 4, 6, 8] (max=8) → [0, 1, 2, 3, 4]', () => {
    expect(computeLevels([0, 2, 4, 6, 8])).toEqual([0, 1, 2, 3, 4]);
  });

  it('TC-U-04: single non-zero [0, 0, 5] → [0, 0, 4] (outlier saturates)', () => {
    expect(computeLevels([0, 0, 5])).toEqual([0, 0, 4]);
  });

  it('TC-U-05: all equal non-zero [5, 5, 5] → [4, 4, 4]', () => {
    expect(computeLevels([5, 5, 5])).toEqual([4, 4, 4]);
  });

  it('TC-U-06: tiny non-zero values clamp to ≥ L1 via ceil', () => {
    // max=1, 0.01 → ceil(4*0.01/1) = ceil(0.04) = 1; 1 → 4.
    expect(computeLevels([0.01, 1])).toEqual([1, 4]);
  });
});

describe('arrangeWeeks', () => {
  const endDate = '2026-04-18'; // Saturday

  const buildPoints = (
    endDateStr: string,
    count: number,
  ): Array<{ date: string; spend: number; sessionCount: number }> => {
    const [y, m, d] = endDateStr.split('-').map(Number);
    const endMs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const points: Array<{ date: string; spend: number; sessionCount: number }> =
      [];
    for (let i = count - 1; i >= 0; i--) {
      const ms = endMs - i * 86_400_000;
      const dt = new Date(ms);
      const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      points.push({ date: iso, spend: i % 5, sessionCount: i % 3 });
    }
    return points;
  };

  it('TC-U-07: happy path — 365 points → 52 or 53 cols × 7 rows, Sunday-first', () => {
    const points = buildPoints(endDate, 365);
    const weeks = arrangeWeeks(points, endDate);
    expect(weeks.length === 52 || weeks.length === 53).toBe(true);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
    // Verify Sunday-first: for each non-null cell in a week, its dow must
    // equal the row index (0 = Sunday, ..., 6 = Saturday).
    for (const week of weeks) {
      for (let row = 0; row < 7; row++) {
        const cell = week[row];
        if (cell === null) continue;
        const [y, m, d] = cell.date.split('-').map(Number);
        const dow = new Date(y, m - 1, d).getDay();
        expect(dow).toBe(row);
      }
    }
  });

  it('TC-U-08: first column is partial when start_date is not a Sunday', () => {
    const points = buildPoints(endDate, 365);
    const weeks = arrangeWeeks(points, endDate);
    const firstWeek = weeks[0];
    const firstNonNull = firstWeek.findIndex((c) => c !== null);
    expect(firstNonNull).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < firstNonNull; i++) {
      expect(firstWeek[i]).toBeNull();
    }
    const cell = firstWeek[firstNonNull];
    expect(cell).not.toBeNull();
    if (cell !== null) {
      const [y, m, d] = cell.date.split('-').map(Number);
      expect(new Date(y, m - 1, d).getDay()).toBe(firstNonNull);
    }
  });

  it('computes levels per-cell over non-null spends', () => {
    const points = [
      { date: '2026-04-12', spend: 0, sessionCount: 0 }, // Sun
      { date: '2026-04-13', spend: 2, sessionCount: 1 }, // Mon
      { date: '2026-04-14', spend: 4, sessionCount: 2 }, // Tue
      { date: '2026-04-15', spend: 6, sessionCount: 3 }, // Wed
      { date: '2026-04-16', spend: 8, sessionCount: 4 }, // Thu
      { date: '2026-04-17', spend: 0, sessionCount: 0 }, // Fri
      { date: '2026-04-18', spend: 0, sessionCount: 0 }, // Sat
    ];
    const weeks = arrangeWeeks(points, '2026-04-18');
    expect(weeks).toHaveLength(1);
    const week = weeks[0];
    const levels = week.map((c) => (c === null ? -1 : c.level));
    expect(levels).toEqual([0, 1, 2, 3, 4, 0, 0]);
  });
});

describe('monthLabels', () => {
  it('TC-U-15: emits short pt-BR month label on the first week containing day 1', () => {
    // 2026-03-01 is Sunday. 2026-03-29 is Sunday and contains April 1 (Wed).
    const cell = (date: string): HeatmapCell => ({
      date,
      spend: 0,
      sessionCount: 0,
      level: 0,
    });
    const makeWeek = (startSunday: string): Week => {
      const [y, m, d] = startSunday.split('-').map(Number);
      const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
      const week: HeatmapCell[] = [];
      for (let i = 0; i < 7; i++) {
        const dt = new Date(start + i * 86_400_000);
        const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        week.push(cell(iso));
      }
      return week;
    };
    const weeks: Week[] = [
      makeWeek('2026-03-01'), // contains March 1
      makeWeek('2026-03-08'), // no day-1
      makeWeek('2026-03-29'), // contains April 1
    ];
    const labels = monthLabels(weeks);
    expect(labels).toHaveLength(3);
    expect(labels[0].length).toBeGreaterThan(0);
    expect(labels[1]).toBe('');
    expect(labels[2].length).toBeGreaterThan(0);
    expect(labels[0].toLowerCase()).toContain('mar');
    expect(labels[2].toLowerCase()).toContain('abr');
  });

  it('returns empty string for a week entirely made of null padding', () => {
    const nullWeek: Week = [null, null, null, null, null, null, null];
    const labels = monthLabels([nullWeek]);
    expect(labels).toEqual(['']);
  });
});

describe('parseDateParam', () => {
  it('TC-U-09: valid "2026-04-18" → start/end are local midnight of day and next day', () => {
    const out = parseDateParam('2026-04-18');
    expect(out.valid).toBe(true);
    if (out.valid) {
      expect(out.date).toBe('2026-04-18');
      const expectedStart = new Date(2026, 3, 18, 0, 0, 0, 0).getTime();
      const expectedEnd = new Date(2026, 3, 19, 0, 0, 0, 0).getTime();
      expect(out.start).toBe(expectedStart);
      expect(out.end).toBe(expectedEnd);
    }
  });

  it('TC-U-10: "2026-2-1" (missing zero-pad) → invalid', () => {
    expect(parseDateParam('2026-2-1')).toEqual<ParsedDate>({ valid: false });
  });

  it('TC-U-11: "2026-02-30" (impossible day) → invalid', () => {
    expect(parseDateParam('2026-02-30')).toEqual<ParsedDate>({ valid: false });
  });

  it('TC-U-12: empty string → invalid', () => {
    expect(parseDateParam('')).toEqual<ParsedDate>({ valid: false });
  });

  it('TC-U-13: undefined → invalid', () => {
    expect(parseDateParam(undefined)).toEqual<ParsedDate>({ valid: false });
  });

  it('TC-U-14: "abc-de-fg" → invalid', () => {
    expect(parseDateParam('abc-de-fg')).toEqual<ParsedDate>({ valid: false });
  });

  it('null → invalid', () => {
    expect(parseDateParam(null)).toEqual<ParsedDate>({ valid: false });
  });

  it.each([
    ['2026-13-01'], // invalid month (>12)
    ['2026-00-10'], // invalid month (zero)
    ['2026-01-00'], // invalid day (zero)
    ['2026-01-32'], // out-of-range day
  ])('rejects impossible calendar dates: %s', (raw) => {
    expect(parseDateParam(raw)).toEqual<ParsedDate>({ valid: false });
  });
});
