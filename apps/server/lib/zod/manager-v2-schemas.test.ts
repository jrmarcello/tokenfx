/**
 * Unit tests for the manager-dashboard-v2 Zod schemas.
 *
 * Covers REQ-14 (drilldown reason+reasonText validation) and REQ-17
 * (/me/visibility pagination) plus the dismiss-anomaly POST body shape
 * (REQ-22 dismiss).
 *
 * TC-IDs map to entries in `.specs/manager-dashboard-v2.md`:
 *   TC-U-22..TC-U-28 — reason tag enum + reasonText length boundaries
 *   TC-U-36          — drilldown lock: reasonText silently accepted/ignored
 *                      when reason !== 'other'
 *   TC-U-36b..TC-U-36d — drilldown error paths (missing/short reasonText
 *                      when reason='other'; invalid devId UUID)
 *   TC-I-71/TC-I-72  — pagination rejects page <= 0 (Zod-level here; the
 *                      route layer maps the parse error to HTTP 400)
 *   TC-I-75          — dismiss POST rejects missing target_user_id
 *
 * NOTE: The Zod boundary is the single source of truth for these shapes.
 *       Route handlers / Server Components should call these schemas'
 *       `.safeParse(...)` and translate failures to HTTP responses.
 */
import { describe, expect, it } from 'vitest';
import {
  REASON_ENUM,
  dismissAnomalySchema,
  drilldownParamsSchema,
  paginationSchema,
  reasonTagSchema,
  reasonTextSchema,
} from './manager-v2-schemas';

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';

describe('REASON_ENUM', () => {
  it('exposes the four locked reason tags in canonical order', () => {
    expect(REASON_ENUM).toEqual([
      'training-check',
      'quota-investigation',
      'cost-investigation',
      'other',
    ]);
  });
});

describe('reasonTagSchema', () => {
  it.each([
    ['training-check', true, 'TC-U-22 — canonical training-check is valid'],
    ['quota-investigation', true, 'quota-investigation is valid'],
    ['cost-investigation', true, 'cost-investigation is valid'],
    ['other', true, 'other is valid'],
    ['Training-Check', false, 'TC-U-23 — case-sensitive, capitalized rejected'],
    ['hacking', false, 'TC-U-24 — value outside enum rejected'],
    ['', false, 'empty string rejected'],
  ])('parses %s -> ok=%s (%s)', (input, expectedOk) => {
    const res = reasonTagSchema.safeParse(input);
    expect(res.success).toBe(expectedOk);
  });

  it('rejects non-string inputs', () => {
    expect(reasonTagSchema.safeParse(42).success).toBe(false);
    expect(reasonTagSchema.safeParse(null).success).toBe(false);
    expect(reasonTagSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('reasonTextSchema', () => {
  it.each([
    ['a'.repeat(10), true, 'TC-U-25 — 10-char min boundary is valid'],
    ['a'.repeat(9), false, 'TC-U-26 — 9-char (min-1) is invalid'],
    ['a'.repeat(500), true, 'TC-U-27 — 500-char max boundary is valid'],
    ['a'.repeat(501), false, 'TC-U-28 — 501-char (max+1) is invalid'],
    ['a'.repeat(250), true, 'mid-range value is valid'],
  ])('parses len=%s.length -> ok=%s (%s)', (input, expectedOk) => {
    const res = reasonTextSchema.safeParse(input);
    expect(res.success).toBe(expectedOk);
  });
});

describe('drilldownParamsSchema', () => {
  it('TC-U-36 — accepts reasonText silently when reason is not "other"', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'training-check',
      reasonText: 'extra',
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(true);
  });

  it('accepts a non-other reason without reasonText', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'cost-investigation',
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(true);
  });

  it('TC-U-36b — rejects reason=other without reasonText', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'other',
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) =>
        i.path.includes('reasonText'),
      );
      expect(issue).toBeDefined();
    }
  });

  it('TC-U-36c — rejects reason=other with reasonText shorter than 10 chars', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'other',
      reasonText: 'a'.repeat(9),
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(false);
  });

  it('accepts reason=other with a 10-char reasonText (min boundary)', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'other',
      reasonText: 'a'.repeat(10),
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(true);
  });

  it('rejects reason=other with reasonText longer than 500 chars', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'other',
      reasonText: 'a'.repeat(501),
      devId: VALID_UUID_A,
    });
    expect(res.success).toBe(false);
  });

  it('TC-U-36d — rejects a devId that is not a valid UUID', () => {
    const res = drilldownParamsSchema.safeParse({
      reason: 'training-check',
      devId: 'not-a-uuid',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.includes('devId'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects when reason is missing entirely', () => {
    const res = drilldownParamsSchema.safeParse({ devId: VALID_UUID_A });
    expect(res.success).toBe(false);
  });

  it('rejects when devId is missing entirely', () => {
    const res = drilldownParamsSchema.safeParse({ reason: 'training-check' });
    expect(res.success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('TC-I-71 — rejects page=0', () => {
    const res = paginationSchema.safeParse({ page: 0 });
    expect(res.success).toBe(false);
  });

  it('TC-I-72 — rejects page=-1', () => {
    const res = paginationSchema.safeParse({ page: -1 });
    expect(res.success).toBe(false);
  });

  it('defaults page to 1 when missing', () => {
    const res = paginationSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.page).toBe(1);
    }
  });

  it('accepts page=2', () => {
    const res = paginationSchema.safeParse({ page: 2 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.page).toBe(2);
    }
  });

  it('coerces a numeric string ("3") to a number', () => {
    const res = paginationSchema.safeParse({ page: '3' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.page).toBe(3);
    }
  });

  it('rejects non-integer numeric values (e.g. 1.5)', () => {
    const res = paginationSchema.safeParse({ page: 1.5 });
    expect(res.success).toBe(false);
  });

  it('rejects a non-numeric page string', () => {
    const res = paginationSchema.safeParse({ page: 'abc' });
    expect(res.success).toBe(false);
  });
});

describe('dismissAnomalySchema', () => {
  it('TC-I-77 — accepts a valid body with target_user_id + kind', () => {
    const res = dismissAnomalySchema.safeParse({
      target_user_id: VALID_UUID_A,
      kind: 'spend-spike-30d',
    });
    expect(res.success).toBe(true);
  });

  it('TC-I-75 — rejects body missing target_user_id', () => {
    const res = dismissAnomalySchema.safeParse({ kind: 'spend-spike-30d' });
    expect(res.success).toBe(false);
  });

  it('rejects body missing kind', () => {
    const res = dismissAnomalySchema.safeParse({
      target_user_id: VALID_UUID_A,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty kind string', () => {
    const res = dismissAnomalySchema.safeParse({
      target_user_id: VALID_UUID_A,
      kind: '',
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-UUID target_user_id', () => {
    const res = dismissAnomalySchema.safeParse({
      target_user_id: 'not-a-uuid',
      kind: 'spend-spike-30d',
    });
    expect(res.success).toBe(false);
  });

  it('rejects extra/unknown fields (.strict())', () => {
    const res = dismissAnomalySchema.safeParse({
      target_user_id: VALID_UUID_A,
      kind: 'spend-spike-30d',
      attacker_field: 'oops',
    });
    expect(res.success).toBe(false);
  });
});
