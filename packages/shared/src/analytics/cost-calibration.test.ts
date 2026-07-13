import { describe, it, expect } from 'vitest';
import {
  effectiveCostForSession,
  MIN_RATE,
  MAX_RATE,
  type Calibration,
  type CalibrationEntry,
} from './cost-calibration';

const makeEntry = (
  family: CalibrationEntry['family'],
  rate: number,
  sampleSessionCount = 1,
): CalibrationEntry => ({
  family,
  rate,
  sampleSessionCount,
  sumOtelCost: 10,
  sumLocalCost: 10 / Math.max(rate, 0.000001),
  lastUpdatedAt: 1_700_000_000_000,
});

const emptyCalibration = (): Calibration => new Map();

describe('effectiveCostForSession', () => {
  it('TC-U-01: OTEL present wins over calibration and list', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.2)],
      ['global', makeEntry('global', 0.2)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: 23,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result).toEqual({ value: 23, source: 'otel' });
  });

  it('TC-U-02: calibrated family rate applies when OTEL null', () => {
    const opusEntry = makeEntry('opus', 0.2, 3);
    const calibration: Calibration = new Map([
      ['opus', opusEntry],
      ['global', makeEntry('global', 0.25, 5)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result.value).toBeCloseTo(20);
    expect(result.source).toBe('calibrated');
    expect(result.calibration).toEqual({
      family: 'opus',
      rate: 0.2,
      sampleCount: 3,
    });
  });

  it('TC-U-03: falls back to global when family missing', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.2, 2)],
      ['global', makeEntry('global', 0.3, 4)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-sonnet-4-6',
      calibration,
    });
    expect(result.value).toBeCloseTo(30);
    expect(result.source).toBe('calibrated');
    expect(result.calibration).toEqual({
      family: 'global',
      rate: 0.3,
      sampleCount: 4,
    });
  });

  it('TC-U-04: empty calibration falls back to list', () => {
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration: emptyCalibration(),
    });
    expect(result).toEqual({ value: 100, source: 'list' });
  });

  it('TC-U-05: non-claude model uses global rate', () => {
    const calibration: Calibration = new Map([
      ['global', makeEntry('global', 0.5, 2)],
    ]);
    const result = effectiveCostForSession({
      localCost: 40,
      otelCost: null,
      model: 'gpt-4',
      calibration,
    });
    expect(result.value).toBeCloseTo(20);
    expect(result.source).toBe('calibrated');
    expect(result.calibration?.family).toBe('global');
  });

  it('TC-U-06: out-of-bounds family rate is ignored and cascades (falls through to global, then list)', () => {
    // Force a rogue rate below MIN_RATE into the map for opus — helper rejects it.
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.0001, 1)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    // No global defined, so cascade ends at list.
    expect(result).toEqual({ value: 100, source: 'list' });
  });

  it('TC-U-06b: out-of-bounds family rate falls through to valid global', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.0001, 1)],
      ['global', makeEntry('global', 0.25, 5)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result.value).toBeCloseTo(25);
    expect(result.source).toBe('calibrated');
    expect(result.calibration?.family).toBe('global');
  });

  it('TC-U-06c: out-of-bounds global rate also rejected, ends at list', () => {
    const calibration: Calibration = new Map([
      ['global', makeEntry('global', 5.0, 1)], // above MAX_RATE
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-sonnet-4-6',
      calibration,
    });
    expect(result).toEqual({ value: 100, source: 'list' });
  });

  it('TC-U-07: localCost=0 short-circuits to list with value 0', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.2, 3)],
      ['global', makeEntry('global', 0.2, 5)],
    ]);
    const result = effectiveCostForSession({
      localCost: 0,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result).toEqual({ value: 0, source: 'list' });
  });

  it('otelCost=0 is treated as "no OTEL" and falls through to calibration', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', 0.2, 2)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: 0,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result.value).toBeCloseTo(20);
    expect(result.source).toBe('calibrated');
  });

  it('boundary: rate exactly MIN_RATE (0.01) is accepted', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', MIN_RATE, 1)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result.value).toBeCloseTo(1);
    expect(result.source).toBe('calibrated');
    expect(result.calibration?.rate).toBe(MIN_RATE);
  });

  it('boundary: rate exactly MAX_RATE (2.0) is accepted', () => {
    const calibration: Calibration = new Map([
      ['opus', makeEntry('opus', MAX_RATE, 1)],
    ]);
    const result = effectiveCostForSession({
      localCost: 100,
      otelCost: null,
      model: 'claude-opus-4-7',
      calibration,
    });
    expect(result.value).toBeCloseTo(200);
    expect(result.source).toBe('calibrated');
    expect(result.calibration?.rate).toBe(MAX_RATE);
  });
});
