import { describe, it, expect } from 'vitest';
import {
  fmtCompact,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  fmtPct,
  fmtRating,
  fmtRatio,
  fmtScore,
  fmtTime,
  fmtUsd,
  fmtUsdFine,
} from './fmt';

describe('fmt', () => {
  it('fmtUsd: 2-decimal currency', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(1.5)).toBe('$1.50');
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
  });

  it('fmtUsdFine: 4-decimal currency for small costs', () => {
    expect(fmtUsdFine(0.0012)).toBe('$0.0012');
    expect(fmtUsdFine(0.01)).toBe('$0.0100');
  });

  it('fmtCompact: compact notation', () => {
    expect(fmtCompact(0)).toBe('0');
    expect(fmtCompact(999)).toBe('999');
    expect(fmtCompact(1_500)).toBe('1.5K');
    expect(fmtCompact(2_000_000)).toBe('2M');
  });

  it('fmtNum: thousands-separated', () => {
    expect(fmtNum(1500)).toBe('1,500');
    expect(fmtNum(0)).toBe('0');
  });

  it('fmtPct: 1-decimal percent with null sentinel', () => {
    expect(fmtPct(0)).toBe('0.0%');
    expect(fmtPct(0.5)).toBe('50.0%');
    expect(fmtPct(0.123)).toBe('12.3%');
    expect(fmtPct(null)).toBe('—');
  });

  it('fmtRating: 2-decimal with null sentinel', () => {
    expect(fmtRating(0.75)).toBe('0.75');
    expect(fmtRating(-1)).toBe('-1.00');
    expect(fmtRating(0)).toBe('0.00');
    expect(fmtRating(null)).toBe('Sem avaliação');
  });

  it('fmtRatio: 2-decimal with null sentinel', () => {
    expect(fmtRatio(1.234)).toBe('1.23');
    expect(fmtRatio(null)).toBe('—');
  });

  it('fmtScore: 1-decimal with null sentinel', () => {
    expect(fmtScore(85.456)).toBe('85.5');
    expect(fmtScore(null)).toBe('—');
  });

  it('fmtDate / fmtDateTime / fmtTime use numeric pt-BR + 24h (DD/MM/YYYY HH:MM)', () => {
    const ms = Date.UTC(2026, 0, 2, 15, 30, 0);
    // fmtDate → DD/MM/YYYY
    expect(fmtDate(ms)).toMatch(/^\d{2}\/\d{2}\/2026$/);
    // fmtDateTime → DD/MM/YYYY HH:MM (24h, no AM/PM, no seconds)
    expect(fmtDateTime(ms)).toMatch(/^\d{2}\/\d{2}\/2026,? \d{2}:\d{2}$/);
    expect(fmtDateTime(ms)).not.toMatch(/AM|PM/i);
    // fmtTime → HH:MM (24h)
    expect(fmtTime(ms)).toMatch(/^\d{2}:\d{2}$/);
    expect(fmtTime(ms)).not.toMatch(/AM|PM/i);
  });
});

describe('fmtDuration', () => {
  it.each([
    // TC-U-08..16
    { tc: 'TC-U-08', input: 43 * 60_000, expected: '43m' },
    { tc: 'TC-U-09', input: 2 * 3_600_000 + 15 * 60_000, expected: '2h15m' },
    { tc: 'TC-U-10', input: 2 * 3_600_000, expected: '2h' },
    { tc: 'TC-U-11', input: 3 * 86_400_000, expected: '3d' },
    { tc: 'TC-U-12', input: 5 * 86_400_000 + 12 * 3_600_000, expected: '5d12h' },
    { tc: 'TC-U-13', input: 30_000, expected: 'agora' },
    { tc: 'TC-U-14', input: 0, expected: 'agora' },
    { tc: 'TC-U-15', input: -100_000, expected: 'agora' },
    { tc: 'TC-U-16', input: 8 * 86_400_000, expected: '7d+' },
    // Boundary cases
    { tc: 'boundary: just under 60s', input: 59_999, expected: 'agora' },
    { tc: 'boundary: exactly 60s', input: 60_000, expected: '1m' },
    { tc: 'boundary: just under 60min', input: 3_599_999, expected: '59m' },
    { tc: 'boundary: exactly 60min', input: 3_600_000, expected: '1h' },
    { tc: 'boundary: exactly 24h', input: 86_400_000, expected: '1d' },
    { tc: 'boundary: exactly 7d', input: 604_800_000, expected: '7d+' },
  ])('$tc: fmtDuration($input) → $expected', ({ input, expected }) => {
    expect(fmtDuration(input)).toBe(expected);
  });
});
