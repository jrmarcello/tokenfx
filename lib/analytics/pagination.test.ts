import { describe, it, expect } from 'vitest';
import { computePagination } from './pagination';

describe('computePagination', () => {
  // TC-U-01: default state, no offset, plenty of rows
  it('TC-U-01: undefined offset with total > pageSize', () => {
    const p = computePagination({ rawOffset: undefined, total: 100 });
    expect(p).toMatchObject({
      offset: 0,
      pageSize: 25,
      rangeStart: 1,
      rangeEnd: 25,
      hasPrev: false,
      hasNext: true,
      overflow: false,
    });
  });

  // TC-U-02: middle page
  it('TC-U-02: offset=25 with total=100', () => {
    const p = computePagination({ rawOffset: '25', total: 100 });
    expect(p.offset).toBe(25);
    expect(p.rangeStart).toBe(26);
    expect(p.rangeEnd).toBe(50);
    expect(p.hasPrev).toBe(true);
    expect(p.hasNext).toBe(true);
  });

  // TC-U-03: last page exact
  it('TC-U-03: last full page (offset=75, total=100)', () => {
    const p = computePagination({ rawOffset: '75', total: 100 });
    expect(p.offset).toBe(75);
    expect(p.rangeEnd).toBe(100);
    expect(p.hasNext).toBe(false);
  });

  // TC-U-04: last page partial
  it('TC-U-04: last partial page (offset=80, total=100)', () => {
    const p = computePagination({ rawOffset: '80', total: 100 });
    expect(p.offset).toBe(80);
    expect(p.rangeEnd).toBe(100);
    expect(p.hasNext).toBe(false);
  });

  // TC-U-05: negative offset → clamp to 0
  it('TC-U-05: negative offset clamps to 0', () => {
    const p = computePagination({ rawOffset: '-5', total: 100 });
    expect(p.offset).toBe(0);
    expect(p.overflow).toBe(false);
  });

  // TC-U-06: non-numeric → clamp to 0
  it('TC-U-06: non-numeric offset clamps to 0', () => {
    const p = computePagination({ rawOffset: 'abc', total: 100 });
    expect(p.offset).toBe(0);
    expect(p.overflow).toBe(false);
  });

  // TC-U-07: overflow — offset >= total
  it('TC-U-07: offset > total yields overflow with zero range', () => {
    const p = computePagination({ rawOffset: '999', total: 100 });
    expect(p.offset).toBe(999);
    expect(p.overflow).toBe(true);
    expect(p.hasPrev).toBe(true);
    expect(p.hasNext).toBe(false);
    expect(p.rangeStart).toBe(0);
    expect(p.rangeEnd).toBe(0);
  });

  // TC-U-08: fractional offset — Zod coerce floors (via .int())
  it('TC-U-08: non-integer offset clamps to 0 via Zod rejection', () => {
    const p = computePagination({ rawOffset: '1.5', total: 100 });
    expect(p.offset).toBe(0);
  });

  // TC-U-09: total below pageSize → no pagination
  it('TC-U-09: total below pageSize (no controls)', () => {
    const p = computePagination({ rawOffset: undefined, total: 3 });
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });

  // TC-U-10: empty total
  it('TC-U-10: empty total', () => {
    const p = computePagination({ rawOffset: undefined, total: 0 });
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
    expect(p.rangeStart).toBe(0);
    expect(p.rangeEnd).toBe(0);
  });

  // TC-U-11: offset === total → overflow
  it('TC-U-11: offset equals total triggers overflow', () => {
    const p = computePagination({ rawOffset: '25', total: 25 });
    expect(p.offset).toBe(25);
    expect(p.overflow).toBe(true);
  });

  // TC-U-12: first page exactly pageSize
  it('TC-U-12: first page covers entire set (total === pageSize)', () => {
    const p = computePagination({ rawOffset: '0', total: 25 });
    expect(p.hasNext).toBe(false);
    expect(p.rangeEnd).toBe(25);
  });

  // TC-U-13: above Zod max
  it('TC-U-13: offset above Zod max clamps to 0', () => {
    const p = computePagination({ rawOffset: '10001', total: 100 });
    expect(p.offset).toBe(0);
  });

  // TC-U-14: offset > 0 with empty DB — no overflow flag (total=0 short-circuit)
  it('TC-U-14: offset on empty DB does not trigger overflow', () => {
    const p = computePagination({ rawOffset: '5', total: 0 });
    expect(p.offset).toBe(5);
    expect(p.overflow).toBe(false);
    expect(p.rangeStart).toBe(0);
    expect(p.rangeEnd).toBe(0);
  });

  // Extra: custom pageSize
  it('respects custom pageSize', () => {
    const p = computePagination({ rawOffset: '10', total: 30, pageSize: 10 });
    expect(p.pageSize).toBe(10);
    expect(p.rangeStart).toBe(11);
    expect(p.rangeEnd).toBe(20);
  });
});
