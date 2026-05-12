/**
 * SSO replay-detection tests (central-server-onboarding-v2-sso, TASK-13).
 *
 * DEFERRED — TC-I-34 (state reuse) and TC-I-45 (nonce reuse) cannot be
 * exercised at the integration layer without simulating a full OAuth round-
 * trip: NextAuth v5 manages state/nonce cookies internally during the
 * `/api/auth/signin/*` initiation and validates them on the matching
 * `/api/auth/callback/*` response. Replaying a callback requires:
 *
 *   1. A live NextAuth-built state cookie (HMAC-signed, time-bounded).
 *   2. A second, identical callback request issued after the first.
 *
 * The internal cookie format is private to NextAuth and not part of its
 * public API, so synthesizing it inside a unit/integration test would
 * couple us to NextAuth's implementation details. Threat-model §Decisão #23
 * explicitly mandates these as end-to-end TCs; they are tracked by TASK-15
 * (Playwright + OAuth IdP stub).
 *
 * This placeholder file:
 *   - Surfaces the deferral via a loud `console.warn` so CI logs record it
 *     every run (no silent skips — see project conventions).
 *   - Carries `it.skip` stubs so the TC-IDs remain greppable.
 *   - Lives next to the CSRF test so future folks find it together.
 *
 * Tracking:
 *   - `apps/server/SECURITY.md` §6 "Known limitations" — documents the gap.
 *   - `.specs/central-server-onboarding-v2-sso.threat-model.md` §Decisão #23.
 *   - Spec task TASK-15 — Playwright e2e once OAuth IdP stub infra lands.
 */
import { describe, it } from 'vitest';

console.warn(
  '[sso-auto-provision-replay.test] DEFERRED — TC-I-34 and TC-I-45 require ' +
    'end-to-end OAuth replay simulation (real NextAuth state/nonce cookie + ' +
    'second-callback invocation). Spec §Decisão #23 mandates the test; ' +
    'implementation deferred to TASK-15 e2e (Playwright + OAuth IdP stub).',
);

describe('SSO replay-detection (DEFERRED — requires e2e infra)', () => {
  it.skip('TC-I-34: state token reuse rejected end-to-end (requires e2e infra)', () => {});
  it.skip('TC-I-45: nonce token reuse rejected end-to-end (requires e2e infra)', () => {});
});
