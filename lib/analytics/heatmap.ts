/**
 * Pure helpers for the session-timeline heatmap (GitHub-contributions style).
 *
 * All functions here are pure: no I/O, no React, no `Date.now()` side effects.
 * The UI layer consumes these shapes to render a 52x7 Sunday-first grid.
 */

export type HeatmapCell = {
  date: string; // YYYY-MM-DD
  spend: number;
  sessionCount: number;
  level: 0 | 1 | 2 | 3 | 4;
} | null;

/** length 7, Sunday..Saturday; `null` = padding outside window. */
export type Week = HeatmapCell[];

export type ParsedDate =
  | { valid: true; date: string; start: number; end: number }
  | { valid: false };

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Map raw spend values to discrete levels 0..4.
 *
 * Formula: `level = value === 0 ? 0 : Math.min(4, Math.ceil(4 * value / max))`
 * where `max = Math.max(...values)`. Deterministic, well-defined for any N,
 * preserves outliers (any non-zero → ≥ L1; the max → L4).
 *
 * Edge cases:
 *   - `[]` → `[]`
 *   - all-zero → all zero
 */
export const computeLevels = (values: number[]): number[] => {
  if (values.length === 0) return [];
  let max = 0;
  for (const v of values) {
    if (v > max) max = v;
  }
  if (max === 0) return values.map(() => 0);
  return values.map((v) => {
    if (v === 0) return 0;
    return Math.min(4, Math.ceil((4 * v) / max));
  });
};

type DailyPoint = { date: string; spend: number; sessionCount: number };

const parseIsoDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
};

const formatIsoDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Group daily points into Sunday-first weeks, ending at `endDate` (inclusive).
 * The window spans `points.length` consecutive days ending at `endDate`.
 *
 * - Weeks are ordered ascending (oldest first).
 * - The first week may be partial: cells before the window's start date are `null`.
 * - The last week may be partial: cells after `endDate` are `null`.
 * - Missing points (dates in window not present in input) are treated as zero.
 * - Each non-null cell's `level` is computed via `computeLevels` over all
 *   non-null spends in the resulting grid.
 */
export const arrangeWeeks = (
  points: ReadonlyArray<DailyPoint>,
  endDate: string,
): Week[] => {
  if (points.length === 0) return [];

  // Build a date -> point lookup so we can tolerate gaps in the input.
  const lookup = new Map<string, DailyPoint>();
  for (const p of points) lookup.set(p.date, p);

  const end = parseIsoDate(endDate);
  const endMs = end.getTime();
  const startMs = endMs - (points.length - 1) * DAY_MS;
  const start = new Date(startMs);

  // Compute the Sunday that begins the first column (<= start).
  const startDow = start.getDay(); // 0 = Sunday
  const firstSundayMs = startMs - startDow * DAY_MS;

  // Compute the Saturday that ends the last column (>= end).
  const endDow = end.getDay();
  const lastSaturdayMs = endMs + (6 - endDow) * DAY_MS;

  const totalDays = (lastSaturdayMs - firstSundayMs) / DAY_MS + 1;
  const weekCount = totalDays / 7;

  // First pass: build the grid with plain cells (level temporarily 0).
  type RawCell =
    | { date: string; spend: number; sessionCount: number }
    | null;
  const grid: RawCell[][] = [];
  const spends: number[] = [];
  const spendCoords: Array<{ week: number; row: number }> = [];

  for (let w = 0; w < weekCount; w++) {
    const week: RawCell[] = [];
    for (let row = 0; row < 7; row++) {
      const ms = firstSundayMs + (w * 7 + row) * DAY_MS;
      if (ms < startMs || ms > endMs) {
        week.push(null);
        continue;
      }
      const iso = formatIsoDate(new Date(ms));
      const p = lookup.get(iso);
      const spend = p?.spend ?? 0;
      const sessionCount = p?.sessionCount ?? 0;
      week.push({ date: iso, spend, sessionCount });
      spends.push(spend);
      spendCoords.push({ week: w, row });
    }
    grid.push(week);
  }

  // Compute levels over all non-null spends in one pass.
  const levels = computeLevels(spends);

  // Second pass: attach levels to cells.
  const result: Week[] = grid.map((week) =>
    week.map((cell) => (cell === null ? null : { ...cell, level: 0 as const })),
  );
  for (let i = 0; i < spendCoords.length; i++) {
    const { week, row } = spendCoords[i];
    const cell = result[week][row];
    if (cell !== null) {
      cell.level = levels[i] as 0 | 1 | 2 | 3 | 4;
    }
  }

  return result;
};

const MONTH_FORMATTER = new Intl.DateTimeFormat('pt-BR', { month: 'short' });

/**
 * For each week, return the short pt-BR month name if that week is the first
 * in the series to contain day 1 of a month; else return `''`.
 *
 * Null-padding cells are skipped. A week of entirely null cells yields `''`.
 */
export const monthLabels = (weeks: Week[]): string[] => {
  const seen = new Set<string>(); // 'YYYY-MM' already labeled
  return weeks.map((week) => {
    for (const cell of week) {
      if (cell === null) continue;
      const d = cell.date.slice(8, 10);
      const ym = cell.date.slice(0, 7);
      if (d === '01' && !seen.has(ym)) {
        seen.add(ym);
        const parsed = parseIsoDate(cell.date);
        const label = MONTH_FORMATTER.format(parsed);
        // Intl.pt-BR appends a trailing dot; strip for a cleaner label.
        return label.replace(/\.$/, '');
      }
    }
    return '';
  });
};

const isRealDate = (y: number, m: number, d: number): boolean => {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === m - 1 &&
    dt.getDate() === d
  );
};

/**
 * Validate a `YYYY-MM-DD` query param.
 *
 * Invalid when: undefined, null, empty, wrong format, or impossible calendar
 * date (e.g., `2026-02-30`). When valid, returns epoch-ms cutoffs computed via
 * `new Date(Y, M-1, D, 0, 0, 0, 0)` — i.e., the consumer's local time zone.
 * `end` is the local midnight of the next day (not `start + 86_400_000`)
 * so the [start, end) window stays correct across DST transitions.
 */
export const parseDateParam = (
  raw: string | undefined | null,
): ParsedDate => {
  if (raw === undefined || raw === null || raw === '') return { valid: false };
  if (!DATE_RE.test(raw)) return { valid: false };
  const [y, m, d] = raw.split('-').map(Number);
  if (!isRealDate(y, m, d)) return { valid: false };
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { valid: true, date: raw, start, end };
};
