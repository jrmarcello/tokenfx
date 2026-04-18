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
    expect(fmtRating(null)).toBe('—');
  });

  it('fmtRatio: 2-decimal with null sentinel', () => {
    expect(fmtRatio(1.234)).toBe('1.23');
    expect(fmtRatio(null)).toBe('—');
  });

  it('fmtScore: 1-decimal with null sentinel', () => {
    expect(fmtScore(85.456)).toBe('85.5');
    expect(fmtScore(null)).toBe('—');
  });

  it('fmtDate / fmtDateTime / fmtTime format epoch ms', () => {
    const ms = Date.UTC(2026, 0, 2, 12, 0, 0);
    // fmtDate uses pt-BR short: "2 de jan. de 2026"
    expect(fmtDate(ms)).toMatch(/jan/i);
    expect(fmtDate(ms)).toMatch(/2026/);
    expect(fmtDateTime(ms)).toMatch(/2026/);
    expect(typeof fmtTime(ms)).toBe('string');
    expect(fmtTime(ms).length).toBeGreaterThan(0);
  });
});
