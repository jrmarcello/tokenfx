/**
 * Unit tests for `manager-alerts.ts` helpers (central-server-onboarding-v2-sso
 * manager-ui spec, TASK-5).
 *
 * These cover the pure helper `formatBannerCount` that produces the user-facing
 * banner string. Integration tests for `loadFirstAutoProvisionAlert` and
 * `acknowledgeAlert` (DB-touching) live in
 * `tests/integration/manager-alerts-banner.test.ts`.
 *
 * Test plan coverage:
 *   TC-U-17 — formatBannerCount(0) returns null (no banner rendered).
 *   TC-U-18 — formatBannerCount(1) returns the singular phrase.
 *   TC-U-19 — formatBannerCount(7) returns the plural phrase.
 *
 * No mocking framework — these are pure-function assertions.
 */
import { describe, expect, it } from 'vitest';

import { formatBannerCount } from './manager-alerts';

describe('formatBannerCount', () => {
  it('returns null when the count is zero so the banner does not render', () => {
    expect(formatBannerCount(0)).toBeNull();
  });

  it('returns the singular phrase for exactly one event', () => {
    expect(formatBannerCount(1)).toBe(
      '1 developer was auto-onboarded via SSO in the last 7 days',
    );
  });

  it('returns the plural phrase for more than one event', () => {
    expect(formatBannerCount(7)).toBe(
      '7 developers were auto-onboarded via SSO in the last 7 days',
    );
  });
});
