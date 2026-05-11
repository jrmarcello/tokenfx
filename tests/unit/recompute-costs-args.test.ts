import { describe, it, expect } from 'vitest';
import { parseArgs } from '@/scripts/recompute-costs';

describe('parseArgs — error states', () => {
  it('returns no-filter error when called with no flags', () => {
    expect(parseArgs([])).toEqual({ mode: 'error', reason: 'no-filter' });
  });

  it.each([
    ['invalid month/day (2026-13-99)', '2026-13-99'],
    ['arbitrary text', 'not-a-date'],
    ['empty string', ''],
    ['single-digit month (2026-2-1) fails strict regex', '2026-2-1'],
  ])('rejects --since with %s', (_label, value) => {
    expect(parseArgs(['--since', value])).toEqual({
      mode: 'error',
      reason: 'invalid-date',
    });
  });

  it('rejects --since 2025-02-29 (non-leap year — V8 silently rolls; round-trip catches)', () => {
    expect(parseArgs(['--since', '2025-02-29'])).toEqual({
      mode: 'error',
      reason: 'invalid-date',
    });
  });

  it('accepts --since 2024-02-29 (leap year)', () => {
    const result = parseArgs(['--since', '2024-02-29']);
    expect(result.mode).toBe('default');
    if (result.mode !== 'default') throw new Error('narrowing');
    expect(result.scope).toEqual({
      kind: 'since',
      sinceMs: Date.UTC(2024, 1, 29),
    });
  });

  it.each([
    [['--all', '--since', '2026-04-01']],
    [['--all', '--session', 'X']],
    [['--since', '2026-04-01', '--session', 'X']],
  ])('returns mutually-exclusive error for %s', (argv) => {
    expect(parseArgs(argv)).toEqual({
      mode: 'error',
      reason: 'mutually-exclusive',
    });
  });

  it.each([
    [['--session', 'X', '--prefer-otel']],
    [['--since', '2026-04-01', '--prefer-otel']],
    [['--session', 'X', '--recalibrate']],
    [['--since', '2026-04-01', '--recalibrate']],
  ])('returns incompatible-mode error for %s', (argv) => {
    expect(parseArgs(argv)).toEqual({
      mode: 'error',
      reason: 'incompatible-mode',
    });
  });

  it.each([
    ['empty session id', ''],
    ['whitespace-only session id', '   '],
  ])('rejects --session with %s', (_label, value) => {
    expect(parseArgs(['--session', value])).toEqual({
      mode: 'error',
      reason: 'invalid-session',
    });
  });
});

describe('parseArgs — happy paths', () => {
  it('parses --all into default mode with scope kind=all', () => {
    expect(parseArgs(['--all'])).toEqual({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: false,
    });
  });

  it('parses --since YYYY-MM-DD into default mode with sinceMs at UTC midnight', () => {
    const result = parseArgs(['--since', '2026-04-01']);
    expect(result).toEqual({
      mode: 'default',
      scope: { kind: 'since', sinceMs: Date.UTC(2026, 3, 1) },
      dryRun: false,
    });
  });

  it('parses --session ID into default mode with scope kind=session', () => {
    expect(parseArgs(['--session', 'abc123'])).toEqual({
      mode: 'default',
      scope: { kind: 'session', id: 'abc123' },
      dryRun: false,
    });
  });

  it.each([
    [['--all', '--dry-run']],
    [['--dry-run', '--all']],
  ])('parses --dry-run with --all (any order: %s)', (argv) => {
    expect(parseArgs(argv)).toEqual({
      mode: 'default',
      scope: { kind: 'all' },
      dryRun: true,
    });
  });

  it('parses --prefer-otel --dry-run into prefer-otel mode with dryRun', () => {
    expect(parseArgs(['--prefer-otel', '--dry-run'])).toEqual({
      mode: 'prefer-otel',
      dryRun: true,
    });
  });

  it('parses --recalibrate --dry-run into recalibrate mode with dryRun', () => {
    expect(parseArgs(['--recalibrate', '--dry-run'])).toEqual({
      mode: 'recalibrate',
      dryRun: true,
    });
  });
});
