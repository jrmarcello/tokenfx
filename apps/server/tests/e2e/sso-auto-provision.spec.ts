/**
 * SSO auto-provision E2E spec (TASK-15 — DEFERRED).
 *
 * Status: DEFERRED. Both TCs in this file are gated behind missing infra
 * that the current SDD batch does not provision. Skipping is INTENTIONAL
 * and surfaced via `console.warn` at module load so the deferral does not
 * silently rot in CI output.
 *
 * REQ coverage owed (per `.specs/central-server-onboarding-v2-sso.backend.md`):
 *
 *  - TC-E2E-01 / REQ-13 — full Google SSO sign-in flow creates a `users`
 *    row and lands the user on a gated page.
 *    Blocker: requires a stubbed Google OAuth IdP. The real Google endpoint
 *    cannot run in a headless Playwright container, and NextAuth v5's
 *    OAuth machinery does not (yet) have an inline fake-IdP harness here.
 *    Substitute path: `e2e-bypass-provider` already covers session-cookie
 *    minting in `auth-bypass.spec.ts`, but it bypasses the signIn callback
 *    entirely, so it exercises NEITHER the auto-provision orchestrator
 *    (TASK-10) NOR the `auth.ts` integration (TASK-11). Promoting that
 *    helper to drive the signIn callback would require a separate spike.
 *
 *  - TC-E2E-02 / REQ-16 — cross-origin POST to `/api/auth/signin` returns
 *    HTTP 403 + writes a `rejected-csrf` row to `onboarding_redemption_log`.
 *    Blocker: REQ-16 is implemented by TASK-9 (`csrf-origin-guard.ts`) +
 *    TASK-11 (extending `apps/server/middleware.ts` matcher to include
 *    `/api/auth/signin`). Neither has merged yet in this batch — running
 *    the test now would assert against an unimplemented surface and pass
 *    for the wrong reason (NextAuth's own CSRF handling, not our guard).
 *    Tractable to enable as soon as TASK-9 + TASK-11 land: the existing
 *    `global-setup.ts` already spawns a dev server bound to `127.0.0.1`
 *    with all required env vars, so a `request.post()` with a forged
 *    `Origin` header is sufficient — no OAuth IdP needed.
 *
 * Documentation: see `apps/server/SECURITY.md` §6 "Deferred E2E coverage"
 * for the gap explanation and re-enablement criteria.
 */
import { test } from '@playwright/test';

// Loud deferral notice — fires at module load so the runner output shows
// the gap even when `test.describe.skip` produces no per-test lines.
console.warn(
  '[e2e:sso-auto-provision] DEFERRED — TC-E2E-01 needs a stubbed Google IdP; ' +
    'TC-E2E-02 needs REQ-16 (TASK-9 + TASK-11) merged. See ' +
    'apps/server/SECURITY.md §6 for re-enablement criteria.',
);

test.describe.skip('SSO auto-provision e2e (DEFERRED — requires OAuth IdP stub + REQ-16)', () => {
  test('completes the full Google sign-in flow and provisions a users row', async ({ page }) => {
    // TC-E2E-01 / REQ-13.
    //
    // TODO once a fake Google OAuth IdP harness lands:
    //   1. Navigate to `/api/auth/signin/google` (NextAuth default route).
    //   2. Intercept the redirect to `accounts.google.com/o/oauth2/...` and
    //      reply with a deterministic authorization code.
    //   3. Intercept the token exchange + userinfo response so the signIn
    //      callback in `auth.ts` runs through TASK-10's auto-provision
    //      orchestrator with a fixture profile (e.g. `e2e-new@alpha.test`).
    //   4. Assert the post-signin page renders the gated header AND the
    //      `users` table now has the new row (via a server-side probe).
    //
    // The `e2e-bypass-provider` is NOT a valid substitute here — it bypasses
    // the signIn callback by design, so it exercises neither the orchestrator
    // nor the audit-log writers.
    void page;
    throw new Error('TC-E2E-01 is deferred until OAuth IdP stub is wired');
  });

  test('rejects cross-origin signin initiation with HTTP 403', async ({ request }) => {
    // TC-E2E-02 / REQ-16.
    //
    // TODO once TASK-9 (`csrf-origin-guard.ts`) + TASK-11 (middleware matcher
    // extension) land:
    //   const res = await request.post('http://localhost:3232/api/auth/signin', {
    //     headers: { Origin: 'https://evil.example.com' },
    //     failOnStatusCode: false,
    //   });
    //   expect(res.status()).toBe(403);
    //
    // The dev server is already running via `global-setup.ts` (bound to
    // 127.0.0.1 with `HOSTNAME=127.0.0.1`); no IdP stubbing is required for
    // this case because the guard rejects BEFORE NextAuth's signin handler.
    void request;
    throw new Error('TC-E2E-02 is deferred until REQ-16 (TASK-9 + TASK-11) lands');
  });
});
