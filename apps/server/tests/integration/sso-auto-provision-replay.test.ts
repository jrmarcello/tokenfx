/**
 * SSO replay-detection deferral note.
 *
 * Status (post `.specs/oauth-idp-stub.md`):
 *
 *   - **TC-I-34** (state-cookie replay): MOVED to E2E layer. The IdP stub
 *     under `apps/idp-stub/` makes the full OAuth round-trip exercisable
 *     via Playwright. The assertion lives at TC-E2E-08 in
 *     `apps/server/tests/e2e/sso-flow.spec.ts`. This `it.skip` stub is
 *     preserved here so the TC-I-34 id remains grep-able from spec-b
 *     (`.specs/central-server-onboarding-v2-sso.backend.md`).
 *
 *     Caveat: TC-I-34 originally required BOTH the state-mismatch
 *     rejection AND a `'rejected-replay'` audit-log row. The E2E test
 *     verifies the first half only — the audit-row write needs a NextAuth
 *     error-handler hook that doesn't exist yet (`sso-auto-provision.ts`
 *     `'rejected-replay'` union exclusion). Tracked as REQ-FU-1 in
 *     `.specs/oauth-idp-stub.md`.
 *
 *   - **TC-I-45** (nonce-cookie replay): STILL DEFERRED. NextAuth's nonce
 *     check is harder to reach end-to-end than the state check — the IdP
 *     stub COULD mint duplicate-nonce id_tokens, but driving NextAuth's
 *     internal nonce validator to reject deterministically requires
 *     reverse-engineering NextAuth v5 internals that the IdP stub spec
 *     does not budget for. Tracked as REQ-FU-2 in
 *     `.specs/oauth-idp-stub.md`.
 *
 * Tracking refs:
 *   - `apps/server/SECURITY.md` §6 "Known limitations"
 *   - `.specs/central-server-onboarding-v2-sso.threat-model.md` §Decisão #23
 *   - `.specs/oauth-idp-stub.md` REQ-9 + Out-of-scope §REQ-FU-1, §REQ-FU-2
 */
import { describe, it } from 'vitest';

describe('SSO replay-detection (DEFERRED tracking stub)', () => {
  it.skip(
    'TC-I-34: state token reuse rejected — moved to TC-E2E-08 in sso-flow.spec.ts',
    () => {
      /* see tests/e2e/sso-flow.spec.ts */
    },
  );
  it.skip(
    'TC-I-45: nonce token reuse rejected — still deferred (REQ-FU-2)',
    () => {
      /* see .specs/oauth-idp-stub.md Out-of-scope §REQ-FU-2 */
    },
  );
});
