/**
 * Determinism trip-wire for `stableUuid` (TC-U: regression-pin).
 *
 * The function is the load-bearing glue between `scripts/seed-server.ts --e2e`
 * (which writes deterministic UUIDs into the DB) and
 * `tests/e2e/manager.spec.ts` (which mints JWT cookies with the matching
 * `orgId`). If the formula drifts — namespace prefix changes, slice indices
 * shift, hash algorithm bumps — the seed and the test silently disagree
 * and Playwright reports an opaque 403 instead of a clear failure pointing
 * at the UUID mismatch. A frozen snapshot here trips the moment that drift
 * happens.
 */
import { describe, expect, it } from 'vitest';
import { e2eOrgId, stableUuid } from './seed-ids';

describe('stableUuid', () => {
  it('is deterministic for the same input', () => {
    expect(stableUuid('org:org-alpha')).toBe(stableUuid('org:org-alpha'));
    expect(stableUuid('user:org-alpha:alice')).toBe(
      stableUuid('user:org-alpha:alice'),
    );
  });

  it('produces distinct UUIDs for distinct inputs', () => {
    expect(stableUuid('org:org-alpha')).not.toBe(stableUuid('org:org-beta'));
    expect(stableUuid('user:alice')).not.toBe(stableUuid('user:bob'));
  });

  it('matches the RFC 4122-ish UUID v4 shape (variant bit forced to 8)', () => {
    expect(stableUuid('org:org-alpha')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  // Frozen snapshot — pins the namespace prefix (`tokenfx-e2e:`) AND the
  // SHA-1 slice indices. Any change to the formula in `seed-ids.ts` MUST
  // be reflected here intentionally; an accidental drift is what this
  // pin is here to catch.
  it('produces a stable snapshot for org-alpha (regression pin)', () => {
    expect(stableUuid('org:org-alpha')).toBe(
      'd402d0e9-28af-48f7-8a1a-f02efb9798f3',
    );
  });
  it('produces a stable snapshot for team:org-alpha:team-frontend (regression pin)', () => {
    expect(stableUuid('team:org-alpha:team-frontend')).toBe(
      '4f64a24a-4cba-4292-8aa0-335868ac4063',
    );
  });
});

describe('e2eOrgId', () => {
  it('is equivalent to stableUuid with the org-namespace prefix', () => {
    expect(e2eOrgId('org-alpha')).toBe(stableUuid('org:org-alpha'));
  });
});
