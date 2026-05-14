import { describe, expect, test } from 'vitest';
import { authConfig } from './auth.config';

/**
 * Canary test for TASK-H2 (review-report-2026-05-14-fixes).
 *
 * Locks down the set of OIDC provider IDs allowed in the Edge-safe
 * `authConfig.providers` array. Any drift — e.g. a misconfigured factory,
 * a typo, or a malicious provider injection — is caught at unit-test time
 * before the merged Node-runtime config (`./auth.ts`) augments providers
 * with the dev-only `e2eBypassProvider`.
 *
 * Note: `e2eBypassProvider` (id: `credentials`) is appended at runtime in
 * `auth.ts` via `assertNotProductionWithBypass`, NOT in this config file.
 * So the providers visible here should be the OIDC set only (google, okta).
 * `credentials` stays in the allowlist because the merged config legitimately
 * carries it in non-production environments.
 */
const ALLOWED_PROVIDER_IDS = new Set(['google', 'okta', 'credentials']);

describe('authConfig.providers canary (TASK-H2)', () => {
  test('TC-U-15: all configured providers are in the OIDC allowlist', () => {
    for (const provider of authConfig.providers) {
      const id = (provider as { id: string }).id;
      expect(ALLOWED_PROVIDER_IDS.has(id)).toBe(true);
    }
  });

  test('TC-U-16: canary detects an unknown provider id', () => {
    const tampered = [
      ...authConfig.providers,
      { id: 'evil-provider' },
    ];
    const allValid = tampered.every(
      (p) => ALLOWED_PROVIDER_IDS.has((p as { id: string }).id),
    );
    expect(allValid).toBe(false);
  });

  test('TC-U-17: Edge-safe authConfig contains exactly [google, okta] (credentials is added by auth.ts at runtime, not here)', () => {
    // The Edge-safe `authConfig.providers` is what the middleware sees. The
    // e2eBypassProvider (id: `credentials`) is appended at runtime in
    // `auth.ts` via `assertNotProductionWithBypass`, NOT here. Lock the
    // exact OIDC set so a future drift (e.g. accidentally exporting the
    // bypass through the Edge-safe path, which would land it in middleware
    // and break the prod boot-guard contract) fails this canary.
    const ids = authConfig.providers.map((p) => (p as { id: string }).id);
    expect(ids).toEqual(['google', 'okta']);
    expect(ids).not.toContain('credentials');
  });
});
