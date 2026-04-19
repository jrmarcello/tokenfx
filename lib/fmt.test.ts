import { describe, it, expect } from 'vitest';
import {
  fmtCompact,
  fmtDate,
  fmtDateTime,
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
