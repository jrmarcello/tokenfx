/**
 * Unit tests for `revalidateInvite` — pure predicate that re-validates an
 * invite row read under `SELECT ... FOR UPDATE` inside the SSO
 * auto-provision transaction (REQ-15, central-server-onboarding-v2-sso).
 *
 * The predicate replaces an inline check + the `onAfterSelectForUpdate`
 * test seam previously used by `sso-auto-provision.ts`. Being a pure
 * function it is trivially testable without DB/mocking.
 *
 * Precedence (documented + tested): revoked > expired > exhausted.
 * Inclusive boundary: `expiresAt === currentTimeMs` is treated as expired.
 * Over-redemption: `usedCount > maxUses` is reported as `exhausted`
 * (predicate uses `>=`).
 */
import { describe, it, expect } from 'vitest';
import { revalidateInvite, type InviteRow, type RevalidateResult } from './revalidate-invite';

const NOW_MS = 1_700_000_000_000;
const PAST = new Date(NOW_MS - 60_000);
const FUTURE = new Date(NOW_MS + 60_000);
const BOUNDARY = new Date(NOW_MS);

const baseInvite = (overrides: Partial<InviteRow> = {}): InviteRow => ({
  token: 'a'.repeat(64),
  revokedAt: null,
  expiresAt: FUTURE,
  usedCount: 0,
  maxUses: 1,
  ...overrides,
});

describe('revalidateInvite', () => {
  it.each<{
    name: string;
    invite: InviteRow;
    currentTimeMs: number;
    expected: RevalidateResult;
  }>([
    {
      name: 'returns valid for fresh invite (not revoked, not expired, not exhausted)',
      invite: baseInvite(),
      currentTimeMs: NOW_MS,
      expected: { valid: true },
    },
    {
      name: 'returns revoked when revokedAt is in the past',
      invite: baseInvite({ revokedAt: PAST }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'revoked' },
    },
    {
      name: 'returns expired when expiresAt is in the past',
      invite: baseInvite({ expiresAt: PAST }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'expired' },
    },
    {
      name: 'returns exhausted when usedCount equals maxUses',
      invite: baseInvite({ usedCount: 1, maxUses: 1 }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'exhausted' },
    },
    {
      name: 'returns exhausted on over-redemption (usedCount > maxUses)',
      invite: baseInvite({ usedCount: 2, maxUses: 1 }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'exhausted' },
    },
    {
      name: 'returns expired at inclusive boundary (expiresAt === currentTimeMs)',
      invite: baseInvite({ expiresAt: BOUNDARY }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'expired' },
    },
    {
      name: 'precedence: revoked wins over expired and exhausted',
      invite: baseInvite({
        revokedAt: PAST,
        expiresAt: PAST,
        usedCount: 5,
        maxUses: 1,
      }),
      currentTimeMs: NOW_MS,
      expected: { valid: false, reason: 'revoked' },
    },
  ])('$name', ({ invite, currentTimeMs, expected }) => {
    expect(revalidateInvite(invite, currentTimeMs)).toEqual(expected);
  });

  it('precedence: expired wins over exhausted when not revoked', () => {
    const invite = baseInvite({
      revokedAt: null,
      expiresAt: PAST,
      usedCount: 5,
      maxUses: 1,
    });
    expect(revalidateInvite(invite, NOW_MS)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('treats future revokedAt as not-yet-revoked (only past/now revocations count)', () => {
    // A revokedAt strictly in the future means the row is scheduled for
    // future revocation; at the current moment it is still active.
    const invite = baseInvite({ revokedAt: FUTURE });
    expect(revalidateInvite(invite, NOW_MS)).toEqual({ valid: true });
  });

  it('treats revokedAt === currentTimeMs as revoked (inclusive)', () => {
    const invite = baseInvite({ revokedAt: BOUNDARY });
    expect(revalidateInvite(invite, NOW_MS)).toEqual({
      valid: false,
      reason: 'revoked',
    });
  });
});
