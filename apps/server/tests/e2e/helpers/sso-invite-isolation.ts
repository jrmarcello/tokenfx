/**
 * Reset `onboarding_invites` so SSO E2E tests start with EXACTLY the
 * `*@e2e-sso.test` wildcard invite — nothing else.
 *
 * Why: other tests in the Playwright run (onboarding.spec.ts TC-E2E-01,
 * manager-ui.spec.ts invite-create tests) create invites with
 * `email_pattern = NULL` — which the matcher treats as "matches any
 * email" (see `lib/auth/match-email-pattern.ts:matchEmailPattern`).
 * Without this scrubber, SSO auto-provision sees ≥ 2 candidate invites
 * for the test emails and returns `rejected-multiple-matches`,
 * surfacing as `?error=AccessDenied` on the callback.
 *
 * Scope: invite rows only. Does NOT touch `users`, `auth_event_log`,
 * etc — those have their own cleanup in `audit-log-probe.ts` and the
 * existing seed.
 *
 * Spec: `.specs/fix-sso-e2e-remaining-5.md` TASK-3 / TASK-SMOKE.
 */
import { createHash } from 'node:crypto';

import { Client } from 'pg';

export const SSO_TEST_DOMAIN = 'e2e-sso.test' as const;

/**
 * Wipe `onboarding_invites` and re-insert the canonical wildcard for
 * the SSO test domain (`*@e2e-sso.test`). Idempotent — safe to call in
 * any `beforeAll`/`beforeEach`.
 *
 * Maps the invite to Alpha org. Token derivation mirrors
 * `scripts/seed-server.ts` so the same row identity is preserved if
 * the seed runs both before AND after this helper (TASK-MERGE-style
 * safety, not strictly needed today).
 */
export const resetSsoInvitesIsolated = async (
  alphaOrgId: string,
): Promise<void> => {
  // Defense-in-depth: this helper lives under `tests/e2e/helpers/` and
  // is Vitest/Playwright-only by convention. If a misconfigured import
  // path ever loads it at runtime with a production DATABASE_URL, the
  // TRUNCATE would wipe live invites. Refuse to run in production unless
  // the operator explicitly opts in (mirrors the destructive-script
  // pattern in `scripts/seed-server.ts`).
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TOKENFX_E2E_ALLOW_DESTRUCTIVE !== '1'
  ) {
    throw new Error(
      'sso-invite-isolation: refusing to TRUNCATE onboarding_invites in production. Set TOKENFX_E2E_ALLOW_DESTRUCTIVE=1 if intentional.',
    );
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // No CASCADE: if a future migration adds a FK referencing
    // onboarding_invites, this TRUNCATE will fail loudly so the test
    // author updates the helper. CASCADE would silently delete
    // dependent rows from new tables.
    await client.query('TRUNCATE TABLE onboarding_invites');
    const token = createHash('sha256')
      .update('e2e:wildcard-invite:e2e-sso')
      .digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO onboarding_invites
         (token, org_id, team_id, email_pattern, max_uses, used_count,
          expires_at, allowed_sso_providers)
       VALUES ($1, $2, NULL, $3, 100, 0, $4, ARRAY['okta']::text[])`,
      [token, alphaOrgId, `*@${SSO_TEST_DOMAIN}`, expiresAt.toISOString()],
    );
  } finally {
    await client.end();
  }
};
