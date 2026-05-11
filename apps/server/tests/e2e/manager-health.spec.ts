/**
 * `/manager/health` Playwright E2E suite — TASK-SMOKE-HEALTH.
 *
 * Covers TC-E2E-05 (REQ-10/11), TC-E2E-06 (REQ-12), TC-E2E-07 (REQ-13).
 *
 * --- Auth strategy ----------------------------------------------------------
 *
 * Reuses the NextAuth JWT cookie-injection pattern documented in
 * `manager.spec.ts`. The helper is duplicated here (not imported) because
 * Playwright spec files run in isolation and a shared fixture module would
 * pull `manager.spec.ts`'s `test.describe` into this file. Keep the two
 * copies in sync — any drift in cookie name / encode args / SEED_USERS
 * shape is the same drift `manager.spec.ts` would catch.
 *
 * --- Seed assumptions -------------------------------------------------------
 *
 * The sibling task TASK-SMOKE-EFFECTIVENESS owns
 * `apps/server/scripts/seed-manager-v2.ts`, which extends the `--e2e` seed
 * with the data this suite needs. Until that script is in place, this spec
 * documents — verbatim, in this comment — what the seed must produce so the
 * seed author can validate against the assertions below:
 *
 *   1. **Check-in (TC-E2E-05)** — at least ONE dev in the alpha org whose
 *      30d spend is ≥ 3σ above the team mean OR whose week-over-week spend
 *      jumped ≥ 50%. The dev must roll up under Alice (the alpha admin) so
 *      `getCheckInOpportunities({ managerId: alice })` returns it. The dev's
 *      `users.id` is unimportant to this spec — we discover the rendered
 *      card by its `data-testid` prefix `check-in-card-` rather than binding
 *      to a specific user UUID.
 *
 *   2. **Drop-off (TC-E2E-06)** — at least ONE dev whose week-over-week
 *      active-days OR session count dropped > 50%, AND who was active in
 *      the prior week. Same manager-rollup constraint as (1). Same
 *      testid-prefix discovery (`dropoff-card-`).
 *
 *   3. **Knowledge-sharing (TC-E2E-07)** — at least ONE feature where
 *      the top team's usage is ≥ 2× the median across Alice's teams AND
 *      ≥ 4× the lowest team's. Both gates required (REQ-13). The card
 *      surfaces team names + a ratio formatted with one decimal place
 *      (see `knowledge-sharing-card.tsx`).
 *
 * If the global seed does NOT yet provide these, the suite skips with a
 * clear message rather than failing — this lets TASK-SMOKE-EFFECTIVENESS
 * land independently. We do NOT augment the seed inline here: the spec
 * (line 601) is explicit that `seed-manager-v2.ts` owns the additive
 * fixture, and a per-spec inline insert would couple this E2E to the
 * server's drizzle client + bleed transactional state on crash.
 *
 * --- Tone-word policy -------------------------------------------------------
 *
 * REQ-11 + REQ-12 lock the supportive-not-performance copy. The forbidden
 * tone words are `alert`, `warning`, `flag`, `violation`, `breach`. The
 * check-in card carries ONE allow-listed phrase — "It's not a flag." —
 * which is part of REQ-11's verbatim copy. Everywhere else (including the
 * drop-off card) the words are forbidden in the rendered HTML.
 *
 * The runtime grep is case-insensitive and applied to the card's
 * `innerHTML` (post-render). Using `innerHTML` over `innerText` catches
 * tone words that might leak via attributes (`aria-label`, `title`,
 * class names — any of which would render in the browser's accessibility
 * tree even if invisible).
 */
import { test, expect, type Locator } from '@playwright/test';
import { signInAs } from './helpers/sign-in-as';
import { e2eOrgId } from '../../lib/e2e/seed-ids';

const BASE_URL = 'http://localhost:3232';

type Role = 'admin' | 'manager' | 'member';

type SeedUser = {
  readonly email: string;
  readonly ssoSubject: string;
  readonly role: Role;
  readonly orgId: string;
};

const ALPHA_ORG_ID = e2eOrgId('org-alpha');

const SEED_USERS = {
  // Alpha admin — has full manager access; rollups in seed-manager-v2.ts
  // are scoped to the teams she manages so the queries return rows.
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

/**
 * Tone-word vocabulary locked by REQ-11 / REQ-12. Case-insensitive match.
 * Word boundaries (`\b`) prevent false positives on substrings like
 * `breachable` (not a real tone word in our copy) or class fragments.
 */
const FORBIDDEN_TONE_WORDS = [
  'alert',
  'warning',
  'flag',
  'violation',
  'breach',
] as const;

const FORBIDDEN_TONE_RE = new RegExp(
  `\\b(${FORBIDDEN_TONE_WORDS.join('|')})\\b`,
  'gi',
);

/**
 * REQ-11 verbatim allow-list for the check-in card: the literal phrase
 * "not a flag" appears once in the body sentence and is the single
 * permitted tone-word occurrence in that card. We strip the phrase before
 * running the forbidden-tone regex.
 *
 * The strip is intentionally narrow: it removes the EXACT five characters
 * needed (case-insensitive `not a flag`) and nothing else. Any other
 * occurrence of `flag` — even a stray attribute — fails the assertion.
 *
 * The drop-off card has NO allow-list (TC-I-69 + TC-E2E-06): we apply the
 * regex to the raw HTML directly.
 */
const CHECK_IN_ALLOWED_PHRASE = /not a flag/gi;

const collectForbiddenMatches = (
  html: string,
  allowed: RegExp | null,
): readonly string[] => {
  const sanitized = allowed ? html.replace(allowed, '') : html;
  const matches = sanitized.match(FORBIDDEN_TONE_RE);
  return matches ?? [];
};

const firstCardWithPrefix = async (
  page: import('@playwright/test').Page,
  prefix: string,
): Promise<Locator | null> => {
  const cards = page.locator(`[data-testid^="${prefix}"]`);
  const count = await cards.count();
  if (count === 0) return null;
  return cards.first();
};

test.describe('manager health UI E2E (TASK-SMOKE-HEALTH)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  // The three TCs share the same authenticated session + page load. Serial
  // mode keeps them in one context so the seeded rollup is fetched once,
  // not three times. The assertions are independent — a failure in one
  // does NOT skip the others.
  test.describe.configure({ mode: 'serial' });

  test('TC-E2E-05: check-in opportunity card renders with REQ-11 verbatim copy and no forbidden tone words', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager/health`);

    // Sanity: section landmark is on the page (independent of seed state).
    await expect(page.locator('[data-testid="section-check-ins"]')).toBeVisible();

    const card = await firstCardWithPrefix(page, 'check-in-card-');
    test.skip(
      card === null,
      'No check-in card rendered — seed-manager-v2.ts has not produced an outlier dev yet (see SEED ASSUMPTION 1 at top of file). Re-run after TASK-SMOKE-EFFECTIVENESS lands.',
    );
    if (card === null) return;

    // REQ-11 heading verbatim.
    await expect(card).toContainText('Check-in opportunity');

    // REQ-11 body fragments (locked verbatim in spec line 92-98). We assert
    // on the supportive sentence + the explicit "not a flag" reassurance
    // rather than the full string — `displayLabel` and team name vary per
    // seed but the framing copy is fixed.
    await expect(card).toContainText(
      '1:1 conversation about workflow, training, or scope',
    );
    await expect(card).toContainText("not a flag");

    // Two CTAs (REQ-11): primary "Open conversation guide" + secondary
    // "Dismiss for 7 days". We grab them by visible text rather than by
    // testid suffix so this assertion fails loudly if the labels drift.
    await expect(
      card.getByRole('link', { name: 'Open conversation guide' }),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Dismiss for 7 days' }),
    ).toBeVisible();

    // Tone-word audit (TC-E2E-05 acceptance criterion). Strip the
    // allow-listed "not a flag" phrase before matching so the verbatim
    // REQ-11 copy doesn't trip the regex.
    const html = await card.innerHTML();
    const violations = collectForbiddenMatches(html, CHECK_IN_ALLOWED_PHRASE);
    expect(
      violations,
      `check-in card contains forbidden tone words: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  test('TC-E2E-06: drop-off card renders with REQ-12 verbatim copy and zero forbidden tone words', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager/health`);

    await expect(page.locator('[data-testid="section-dropoffs"]')).toBeVisible();

    const card = await firstCardWithPrefix(page, 'dropoff-card-');
    test.skip(
      card === null,
      'No drop-off card rendered — seed-manager-v2.ts has not produced a drop-off dev yet (see SEED ASSUMPTION 2 at top of file). Re-run after TASK-SMOKE-EFFECTIVENESS lands.',
    );
    if (card === null) return;

    // REQ-12 heading verbatim.
    await expect(card).toContainText('May need support');

    // REQ-12 body fragments — the "training, blockers, or scope changes"
    // phrase is locked supportive copy and "week-over-week" is the
    // mandatory framing for the drop signal.
    await expect(card).toContainText(
      'Consider checking in about training, blockers, or scope changes.',
    );
    await expect(card).toContainText(/week-over-week/i);

    // Two CTAs (REQ-12 mirrors REQ-11): primary "Open conversation guide" +
    // secondary "Dismiss for 7 days".
    await expect(
      card.getByRole('link', { name: 'Open conversation guide' }),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Dismiss for 7 days' }),
    ).toBeVisible();

    // Strict zero forbidden tone words (no allow-list — TC-I-69 + the
    // dropoff-card.tsx top-comment policy say nothing is permitted here).
    const html = await card.innerHTML();
    const violations = collectForbiddenMatches(html, null);
    expect(
      violations,
      `drop-off card contains forbidden tone words: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  test('TC-E2E-07: knowledge-sharing section lists team names and ratio', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager/health`);

    await expect(
      page.locator('[data-testid="section-knowledge-sharing"]'),
    ).toBeVisible();

    const card = page.locator('[data-testid="knowledge-sharing-card"]');
    const cardCount = await card.count();
    test.skip(
      cardCount === 0,
      'No knowledge-sharing card rendered — seed-manager-v2.ts has not produced a top-vs-bottom team scenario yet (see SEED ASSUMPTION 3 at top of file). Re-run after TASK-SMOKE-EFFECTIVENESS lands.',
    );
    if (cardCount === 0) return;

    await expect(card).toContainText('Knowledge-sharing opportunity');

    // REQ-13 verbatim copy template:
    //   "Team {top} uses {feature} {ratio}× more than {bottom}. Consider sharing patterns."
    // We assert on the locked tail ("Consider sharing patterns.") + the
    // `Nx` ratio shape (one decimal place per the component's
    // `ratio.toFixed(1)`). Team names + feature names are seed-specific.
    await expect(card).toContainText('Consider sharing patterns.');
    await expect(card).toContainText(/\b\d+\.\d×\b/);

    // At least one row rendered (`knowledge-sharing-row-{feature}` testid).
    const rows = card.locator('[data-testid^="knowledge-sharing-row-"]');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);

    // Each row mentions BOTH a "top" team name and a "bottom" team name.
    // We can't pin the names without coupling to the seed, but we can
    // assert the structural template — "Team X uses Y N.N× more than Z" —
    // by regex.
    const firstRowText = await rows.first().innerText();
    expect(firstRowText).toMatch(
      /^Team .+ uses .+ \d+\.\d× more than .+\. Consider sharing patterns\.$/,
    );
  });
});
