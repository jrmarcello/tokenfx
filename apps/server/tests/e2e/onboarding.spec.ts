/**
 * Invite-onboarding Playwright E2E suite — TASK-SMOKE for
 * `.specs/central-server-onboarding.md`.
 *
 * Covers TC-E2E-01..07:
 *   01 — Manager creates an invite and lands on the show-once page.
 *   02 — The new invite appears in the list with status=active and the full
 *        token is NOT in the DOM (only the 8-char prefix).
 *   03 — Revoke flow: native <dialog> → confirm → status flips to "revoked".
 *   04 — Public `/onboard#token=<64hex>` displays the token + copy button.
 *   05 — Public `/onboard` with no fragment shows the empty state.
 *   06 — Full chain: create invite via UI, capture URL → spawn
 *        `pnpm reporter:setup` non-interactively → verify config file mode/shape
 *        → push a batch via `lib/reporter/client.ts` → verify ingestion_log +
 *        sessions_agg rows landed.
 *   07 — Member-role hits `/manager/invites` → 403.
 *
 * Auth bypass strategy mirrors the spec-3 `manager.spec.ts` file: we mint a
 * NextAuth-compatible session JWT and inject it as a cookie via
 * `context.addCookies`. No OAuth round-trip required.
 *
 * For TC-E2E-06 we never write to the project's real
 * `data/reporter-config.json`. The setup CLI is spawned with `cwd` pointing at
 * a per-test temp dir, so the resulting config lands at
 * `<tmp>/data/reporter-config.json`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { test, expect, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { e2eOrgId } from '../../lib/e2e/seed-ids';

const BASE_URL = 'http://localhost:3232';

/** Match `manager.spec.ts` — the dev server must boot with the same secret. */
const E2E_SECRET = process.env.NEXTAUTH_SECRET ?? 'tokenfx-e2e-secret';

/** NextAuth v5 cookie name for the session JWT in non-HTTPS dev. */
const SESSION_COOKIE = 'authjs.session-token';

/**
 * Repo root — needed so we can resolve the setup script + the local `tsx`
 * binary without depending on the test runner's cwd.
 *
 * `__dirname` here is `<repo>/apps/server/tests/e2e`; four `..` levels up
 * reaches `<repo>`. Centralized so both the reporter-setup spawn (TC-E2E-06)
 * and any future helpers stay anchored to the same path.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const REPORTER_SETUP_SCRIPT = path.join(
  REPO_ROOT,
  'scripts',
  'reporter-setup.ts',
);

type Role = 'admin' | 'manager' | 'member';

type SeedUser = {
  readonly email: string;
  readonly ssoSubject: string;
  readonly role: Role;
  readonly orgId: string;
};

const ALPHA_ORG_ID = e2eOrgId('org-alpha');

const SEED_USERS = {
  // Alpha admin — full manager access.
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
  // Alpha member — used for the 403 path (TC-E2E-07).
  bobMember: {
    email: 'bob@alpha.test',
    ssoSubject: 'e2e:bob@alpha.test',
    role: 'member',
    orgId: ALPHA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

/**
 * Build a NextAuth-compatible session JWT and inject it on `context`. Same
 * helper shape as `manager.spec.ts` — kept colocated rather than shared in a
 * helper file so each suite stays self-contained (the only cost is ~25 lines
 * of duplication; refactoring to a shared module is a follow-up).
 */
const signInAs = async (
  context: BrowserContext,
  user: SeedUser,
): Promise<void> => {
  if (!BASE_URL.startsWith('http://localhost')) {
    throw new Error(
      `signInAs is localhost-only. BASE_URL=${BASE_URL} — refusing to mint a non-Secure session cookie for a remote host.`,
    );
  }
  const token = await encode({
    token: {
      email: user.email,
      sub: user.ssoSubject,
      ssoProvider: 'e2e-seed',
      role: user.role,
      orgId: user.orgId,
    },
    secret: E2E_SECRET,
    salt: SESSION_COOKIE,
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: BASE_URL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
};

/**
 * Pull the 8-char token prefix from the show-once page's
 * `data-testid="flash-onboard-url-value"` element. The element renders the
 * full URL; we slice the fragment to get the token, then take the first 8
 * chars to match the prefix shown in the list view.
 */
const extractTokenFromOnboardUrl = (fullUrl: string): string => {
  const idx = fullUrl.indexOf('#token=');
  if (idx === -1) {
    throw new Error(`onboard URL missing #token fragment: ${fullUrl}`);
  }
  return fullUrl.slice(idx + '#token='.length);
};

test.describe('central-server-onboarding E2E (TASK-SMOKE)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: manager creates invite, show-once page renders full URL + warning + copy button', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);
    await page.goto(`${BASE_URL}/manager/invites`);

    // Click "Criar convite" — navigates to /manager/invites/create.
    await page.locator('[data-testid="invite-create-link"]').click();
    await expect(page).toHaveURL(/\/manager\/invites\/create$/);

    // Submit the form with default values (max_uses=1, expires_in_hours=8,
    // no team / email pattern). The Client Component sets a UUID idempotency
    // key on mount; default values + submit lands on the show-once page.
    await page.locator('[data-testid="invite-create-form"]').waitFor();
    await page.locator('[data-testid="invite-create-submit"]').click();

    // Show-once page lives at /manager/invites/created; the URL value is in
    // a <code data-testid="flash-onboard-url-value">.
    await expect(page).toHaveURL(/\/manager\/invites\/created$/);
    const urlValueLocator = page.locator(
      '[data-testid="flash-onboard-url-value"]',
    );
    await expect(urlValueLocator).toBeVisible();

    // Verify the URL shape: contains `/onboard#token=<64hex>`.
    const fullUrl = await urlValueLocator.innerText();
    expect(fullUrl).toMatch(/\/onboard#token=[0-9a-f]{64}$/);

    // Warning copy ("mostrado apenas uma vez").
    const flashCard = page.locator('[data-testid="flash-onboard-url"]');
    await expect(flashCard).toContainText(/apenas uma vez/i);

    // Copy button is focusable + clickable in headless. Browser's clipboard
    // API may refuse to actually write in headless without a user-gesture
    // permission, but the click handler must not crash and the button must
    // be reachable. Locator click confirms the button is interactive.
    const copyBtn = flashCard.locator('button', { hasText: /copiar/i });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click(); // no-op clipboard write is fine; we only assert no crash
  });

  test('TC-E2E-02: created invite appears in list with status=active; full token NOT in DOM', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);

    // Create one — same flow as TC-E2E-01.
    await page.goto(`${BASE_URL}/manager/invites/create`);
    await page.locator('[data-testid="invite-create-form"]').waitFor();
    await page.locator('[data-testid="invite-create-submit"]').click();
    await expect(page).toHaveURL(/\/manager\/invites\/created$/);

    // Capture the full URL so we can confirm it's NOT in the list view.
    const fullUrl = await page
      .locator('[data-testid="flash-onboard-url-value"]')
      .innerText();
    const fullToken = extractTokenFromOnboardUrl(fullUrl);

    // Navigate back to the list.
    await page.goto(`${BASE_URL}/manager/invites`);
    const table = page.locator('[data-testid="invites-table"]');
    await expect(table).toBeVisible();

    // The new row's prefix == first 8 chars of the full token. The status
    // pill carries `data-status` for a robust selector independent of copy.
    const prefix = fullToken.slice(0, 8);
    const statusPill = page.locator(
      `[data-testid="invite-status-${prefix}"]`,
    );
    await expect(statusPill).toBeVisible();
    await expect(statusPill).toHaveAttribute('data-status', 'active');

    // Used-count column starts at "0/1" for default form values.
    const row = page.locator(`[data-testid="invite-row-${prefix}"]`);
    await expect(row).toContainText('0/1');

    // The full 64-char token must NOT appear anywhere in the list page DOM
    // (the design says only the 8-char prefix is ever surfaced).
    const fullPageHtml = await page.content();
    expect(fullPageHtml).not.toContain(fullToken);
  });

  test('TC-E2E-03: revoke active invite via dialog → status flips to revoked', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);

    // Create an invite to revoke.
    await page.goto(`${BASE_URL}/manager/invites/create`);
    await page.locator('[data-testid="invite-create-form"]').waitFor();
    await page.locator('[data-testid="invite-create-submit"]').click();
    await expect(page).toHaveURL(/\/manager\/invites\/created$/);
    const fullUrl = await page
      .locator('[data-testid="flash-onboard-url-value"]')
      .innerText();
    const prefix = extractTokenFromOnboardUrl(fullUrl).slice(0, 8);

    await page.goto(`${BASE_URL}/manager/invites`);
    const revokeBtn = page.locator(`[data-testid="invite-revoke-${prefix}"]`);
    await expect(revokeBtn).toBeVisible();
    await revokeBtn.click();

    // Native <dialog> opens — the confirm button carries a deterministic testid.
    const confirmBtn = page.locator(
      `[data-testid="invite-revoke-confirm-${prefix}"]`,
    );
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // After confirm, the row repaints with status=revoked. `router.refresh()`
    // in the client component re-fetches the Server Component output.
    const statusPill = page.locator(
      `[data-testid="invite-status-${prefix}"]`,
    );
    await expect(statusPill).toHaveAttribute('data-status', 'revoked');

    // Revoke button should no longer be present (only `active` rows render it).
    await expect(
      page.locator(`[data-testid="invite-revoke-${prefix}"]`),
    ).toHaveCount(0);
  });

  test('TC-E2E-04: /onboard#token=<64hex> displays token + copy button', async ({
    page,
  }) => {
    // No auth — public page. Use a 64-hex literal; the Client Component
    // validates with /^[0-9a-f]{64}$/ before rendering.
    const sample =
      'a'.repeat(64); // valid hex shape; doesn't have to match a real DB row
    await page.goto(`${BASE_URL}/onboard#token=${sample}`);

    const tokenBox = page.locator('[data-testid="onboard-token-value"]');
    await expect(tokenBox).toBeVisible();
    await expect(tokenBox).toHaveText(sample);

    // Copy button visible + clickable.
    const copyBtn = page.locator('[data-testid="onboard-copy-button"]');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
  });

  test('TC-E2E-05: /onboard with no fragment shows empty state, no crash', async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/onboard`);
    await expect(page.locator('[data-testid="onboard-empty"]')).toBeVisible();
    // Token box must NOT render.
    await expect(page.locator('[data-testid="onboard-token"]')).toHaveCount(0);
  });

  test('TC-E2E-06: full flow: create invite → reporter:setup → push batch → ingestion_log + sessions_agg', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);

    await signInAs(context, SEED_USERS.aliceAdmin);

    // 1) Create the invite via UI; capture the full onboard URL.
    await page.goto(`${BASE_URL}/manager/invites/create`);
    await page.locator('[data-testid="invite-create-form"]').waitFor();
    await page.locator('[data-testid="invite-create-submit"]').click();
    await expect(page).toHaveURL(/\/manager\/invites\/created$/);
    const fullUrl = await page
      .locator('[data-testid="flash-onboard-url-value"]')
      .innerText();
    const token = extractTokenFromOnboardUrl(fullUrl);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // 2) Per-test temp dir so the spawned setup CLI writes to
    //    <tmp>/data/reporter-config.json instead of the project's real config.
    const tmpHome = await mkdtemp(path.join(tmpdir(), 'tokenfx-e2e-'));
    const configPath = path.join(tmpHome, 'data', 'reporter-config.json');

    try {
      // 3) Spawn the reporter-setup script directly via the workspace `tsx`
      //    binary (NOT `pnpm reporter:setup`). pnpm runs scripts with cwd
      //    forced to the package.json directory, which means
      //    `DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'data/...')` would
      //    overwrite the project's real `data/reporter-config.json`. Spawning
      //    tsx ourselves with `cwd=tmpHome` keeps the config in the temp dir.
      //    `--allow-http` is required because the dev server is plain HTTP.
      const setupExit = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = spawn(
          TSX_BIN,
          [
            REPORTER_SETUP_SCRIPT,
            `--token=${token}`,
            `--email=${SEED_USERS.aliceAdmin.email}`,
            `--central-url=${BASE_URL}`,
            '--allow-http',
            '--non-interactive',
          ],
          { cwd: tmpHome, env: { ...process.env, HOME: tmpHome } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('close', (code) => {
          resolve({ code, stdout, stderr });
        });
      });

      if (setupExit.code !== 0) {
        // Surface the full output so failures are diagnosable.
        throw new Error(
          `reporter:setup exited ${setupExit.code}\n--- stdout ---\n${setupExit.stdout}\n--- stderr ---\n${setupExit.stderr}`,
        );
      }

      // 4) Verify config file: exists, mode 0600, JSON shape matches.
      const st = await stat(configPath);
      // Mask off the file-type bits, keep permissions.
      const mode = st.mode & 0o777;
      expect(mode).toBe(0o600);

      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof config.key_id).toBe('string');
      expect(typeof config.secret).toBe('string');
      expect(typeof config.machine_id).toBe('string');
      expect(typeof config.user_email).toBe('string');
      expect(typeof config.central_url).toBe('string');
      expect(typeof config.project_secret).toBe('string');
      expect(config.user_email).toBe(SEED_USERS.aliceAdmin.email);
      expect(config.central_url).toBe(BASE_URL);
      // key_id is `k_` + 16 hex per REQ-15.
      expect(config.key_id).toMatch(/^k_[0-9a-f]{16}$/);

      // 5) Push a batch via the production `pushBatch` client. The reporter
      //    client lives at the repo-root `lib/reporter/client.ts` (it's the
      //    reporter, not server code). We avoid a cross-package dynamic
      //    `import()` (Playwright's runtime picks up the relative path as a
      //    bare ESM module and the root package has no `type:module`) by
      //    going through a plain HTTP `fetch` to `/api/ingest` with the
      //    new Bearer auth — same wire format the production client emits,
      //    so we still validate the end-to-end refactor without coupling
      //    the E2E module graph to the reporter package.
      const sessionId = `e2e-onboarding-${Date.now()}`;
      const startedAtSec = Math.floor(Date.now() / 1000) - 60;
      const endedAtSec = startedAtSec + 30;
      const projectSlug =
        'slug:' +
        Array.from({ length: 16 }, () =>
          Math.floor(Math.random() * 16).toString(16),
        ).join('');

      const envelope = {
        version: 1,
        key_id: config.key_id as string,
        machine_id: config.machine_id as string,
        payload: [
          {
            session_id: sessionId,
            started_at: startedAtSec,
            ended_at: endedAtSec,
            project_slug: projectSlug,
            git_branch: 'main',
            cc_version: '1.0.0',
            total_input_tokens: 1000,
            total_output_tokens: 500,
            total_cache_read_tokens: 0,
            total_cache_creation_tokens: 0,
            total_cost_usd: 0.123456,
            total_cost_usd_otel: 0.117283,
            turn_count: 5,
            tool_call_count: 3,
            model_breakdown: [
              {
                model: 'claude-sonnet-4-5-20250929',
                input_tokens: 1000,
                output_tokens: 500,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cost_usd: 0.123456,
              },
            ],
            tool_counts: { Read: 2, Edit: 1 },
            avg_rating: 0.5,
            cache_hit_ratio: 0,
            output_input_ratio: 0.5,
            subagent_usage_ratio: 0,
          },
        ],
      };
      const pushRes = await fetch(`${BASE_URL}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.secret as string}`,
        },
        body: JSON.stringify(envelope),
      });
      expect(pushRes.status).toBe(200);
      const pushBody = (await pushRes.json()) as { accepted?: number };
      expect(pushBody.accepted ?? 0).toBeGreaterThanOrEqual(1);

      // 6) Verify ingestion_log + sessions_agg rows landed. `globalSetup.ts`
      //    set DATABASE_URL on process.env; Playwright workers inherit it.
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL not set on test runner — global-setup.ts did not propagate it',
        );
      }
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        const ingestionLogQuery = await pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM ingestion_log WHERE key_id = $1',
          [config.key_id],
        );
        expect(Number(ingestionLogQuery.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(
          1,
        );

        const sessionRow = await pool.query<{ session_id: string }>(
          'SELECT session_id FROM sessions_agg WHERE session_id = $1',
          [sessionId],
        );
        expect(sessionRow.rows.length).toBe(1);
      } finally {
        await pool.end();
      }
    } finally {
      // Clean up the temp dir + config so subsequent runs start fresh.
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('TC-E2E-07: member-role hits /manager/invites → 403', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.bobMember);
    const response = await page.goto(`${BASE_URL}/manager/invites`);

    // Middleware short-circuits with 403 for member-role; the layout's
    // defense-in-depth would otherwise render `data-testid="manager-403"`.
    if (response && response.status() === 403) {
      const body = await response.text();
      expect(body).toMatch(/Manager role required/i);
    } else {
      await expect(page.locator('[data-testid="manager-403"]')).toBeVisible();
    }

    // Negative assertions: invite UI must never reach the client.
    await expect(page.locator('[data-testid="invites-table"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="invite-create-link"]'),
    ).toHaveCount(0);
  });
});
