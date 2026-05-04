import { describe, it, expect } from 'vitest';
import { displayLabelFor, type UserForDisplay } from './user-display';

/**
 * Tests for TASK-USER-DISPLAY of `.specs/manager-dashboard-v2.md`.
 *
 * `displayLabelFor` is a pure presentation helper — no I/O, no mocks needed.
 * It centralizes the user-label fallback chain used in:
 *   - `/manager/health` check-in cards (REQ-11)
 *   - `/manager/health` drop-off cards (REQ-12)
 *   - `/me/visibility` audit log
 *   - the manager nav
 *
 * The same fallback is encoded at the SQL layer in REQ-18's
 * `ORDER BY COALESCE(users.display_name, split_part(users.email, '@', 1)) ASC`.
 *
 * Naming-convention rationale: this lives under `lib/util/` (presentation
 * helper), NOT `lib/auth/` (auth pipeline: hashing, token validation, role
 * narrowing). `displayLabelFor` is presentation, NOT auth.
 *
 * TC-IDs map to rows in the spec's Test Plan (TC-U-37, TC-U-38, plus
 * sub-cases TC-U-38b..TC-U-38f for boundary coverage).
 */
describe('displayLabelFor', () => {
  it.each<{
    name: string;
    user: UserForDisplay;
    expected: string;
  }>([
    // TC-U-37 (happy): display_name present → returned verbatim.
    {
      name: 'TC-U-37 — returns display_name when present',
      user: { display_name: 'Alice', email: 'a@x.com' },
      expected: 'Alice',
    },
    // TC-U-38 (edge): display_name null → fallback to email local-part.
    {
      name: 'TC-U-38 — falls back to email local-part when display_name is null',
      user: { display_name: null, email: 'alice@x.com' },
      expected: 'alice',
    },
    // TC-U-38b: display_name undefined behaves identically to null.
    {
      name: 'TC-U-38b — falls back to email local-part when display_name is undefined',
      user: { display_name: undefined, email: 'bob@x.com' },
      expected: 'bob',
    },
    // TC-U-38c: empty-string display_name treated as missing (DB NOT NULL
    // constraint allows '', but UX-wise it is meaningless).
    {
      name: 'TC-U-38c — falls back to email local-part when display_name is empty string',
      user: { display_name: '', email: 'carol@x.com' },
      expected: 'carol',
    },
    // TC-U-38d: whitespace-only display_name falls back via trim guard
    // (avoids rendering a card heading that is all spaces).
    {
      name: 'TC-U-38d — falls back to email local-part when display_name is whitespace-only',
      user: { display_name: '   ', email: 'dave@x.com' },
      expected: 'dave',
    },
    // TC-U-38e: spaces inside a real name MUST be preserved (no trim of
    // interior whitespace, no surname stripping).
    {
      name: 'TC-U-38e — preserves spaces inside a real display_name',
      user: { display_name: 'Frank Surname', email: 'frank@x.com' },
      expected: 'Frank Surname',
    },
    // TC-U-38f (defensive): email without an `@` (should not happen in
    // practice — Zod validates emails on insert — but guarantees the helper
    // is total: always returns a non-empty string).
    {
      name: 'TC-U-38f — returns email as-is when there is no @ sign',
      user: { display_name: null, email: 'noatsign' },
      expected: 'noatsign',
    },
  ])('$name', ({ user, expected }) => {
    expect(displayLabelFor(user)).toBe(expected);
  });
});
