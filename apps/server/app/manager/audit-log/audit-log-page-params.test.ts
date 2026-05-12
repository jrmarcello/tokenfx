/**
 * Unit tests for `parseAuditLogSearchParams` (and the underlying schema).
 *
 * Source: .specs/sso-test-coverage-orphans.md REQ-2, TC-U-02a..h.
 *
 * The schema lives in a pure TS sibling of `page.tsx` precisely so these
 * TCs can exercise the Zod `.catch(...)` coercion behavior directly,
 * without needing a Next.js runtime. Every field has `.catch()` — the
 * helper NEVER throws.
 */
import { describe, expect, it } from 'vitest';
import { parseAuditLogSearchParams } from './audit-log-page-params';

describe('parseAuditLogSearchParams', () => {
  // TC-U-02a — happy: coerce numeric string.
  it('coerces a numeric string into a number', () => {
    expect(parseAuditLogSearchParams({ page: '5' }).page).toBe(5);
  });

  // TC-U-02b — validation: non-numeric falls back to 0 (no NaN).
  it("falls back to page=0 on non-numeric input (e.g. 'abc')", () => {
    expect(parseAuditLogSearchParams({ page: 'abc' }).page).toBe(0);
  });

  // TC-U-02c — validation: negative falls back to 0 via .min(0) + .catch.
  it("falls back to page=0 on a negative input (e.g. '-1')", () => {
    expect(parseAuditLogSearchParams({ page: '-1' }).page).toBe(0);
  });

  // TC-U-02d — edge: empty params → all undefined, page defaults to 0.
  it('returns defaults (page=0, all other fields undefined) on empty input', () => {
    const parsed = parseAuditLogSearchParams({});
    expect(parsed.page).toBe(0);
    expect(parsed.outcome).toBeUndefined();
    expect(parsed.iss).toBeUndefined();
    expect(parsed.city).toBeUndefined();
    expect(parsed.browser).toBeUndefined();
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });

  // TC-U-02e — edge: massive overflow > MAX_PAGE → .max() rejects → catch(0).
  it('clamps a page index that exceeds MAX_PAGE back to 0', () => {
    expect(parseAuditLogSearchParams({ page: '99999999999999' }).page).toBe(0);
  });

  // TC-U-02f — edge: explicit '0' passes .min(0); not clamped.
  it("accepts page='0' as the valid minimum (not clamped via catch)", () => {
    expect(parseAuditLogSearchParams({ page: '0' }).page).toBe(0);
  });

  // TC-U-02g — validation: fractional fails .int() → catch(0).
  it("falls back to page=0 on a fractional input (e.g. '5.5' fails .int())", () => {
    expect(parseAuditLogSearchParams({ page: '5.5' }).page).toBe(0);
  });

  // TC-U-02h — edge: explicit undefined key resolves to page=0 via catch.
  it('falls back to page=0 when the page key is undefined', () => {
    expect(parseAuditLogSearchParams({ page: undefined }).page).toBe(0);
  });
});
