/**
 * Postgres helpers for asserting `onboarding_invites` rows in E2E tests.
 *
 * Used by TC-E2E-06 + TC-E2E-06b in `tests/e2e/manager-ui.spec.ts`:
 *
 * - `queryInviteByTokenPrefix` — TC-E2E-06 persistence assertion: the
 *   flash URL contains a 64-char hex token; the test extracts the first
 *   8 chars and looks up the row via the `idx_onboarding_invites_prefix`
 *   index on the physical `token_prefix` column (which stores
 *   `left(plaintext, 8)`), declared in `apps/server/lib/db/schema.ts`.
 * - `queryInvitesCreatedSince` — TC-E2E-06b time-window guard for the
 *   "form rejects empty provider selection, no row written" assertion.
 *
 * Both probes follow the connect/query/finally-close pattern from
 * `helpers/audit-log-probe.ts`. Time-window comparisons use the same
 * `new Date(sinceMs).toISOString()` → `> $1::timestamptz` shape as
 * `audit-log-probe.ts` for cross-helper consistency.
 *
 * Postgres-only via `pg.Client` — the E2E stack already requires a real
 * Postgres testcontainer, so SQLite portability is not a concern.
 */
import { Client } from 'pg';

export type InviteRow = Readonly<{
  token_prefix: string;
  allowed_sso_providers: readonly string[];
  created_at: Date;
}>;

/**
 * Open a `pg.Client` from `DATABASE_URL`, wrap connect errors with
 * helper-name context so failures surface as "invite-probe(<label>): ..."
 * rather than an unhandled-rejection stack pointing at pg internals.
 */
const withClient = async <T>(
  label: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`invite-probe(${label}): DB connect failed`, { cause: err });
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

/**
 * Look up an `onboarding_invites` row by the 8-char token prefix
 * derived from a captured invite URL. The schema's index
 * `idx_onboarding_invites_prefix` on the physical `token_prefix`
 * column makes this a single-row index scan.
 */
export const queryInviteByTokenPrefix = async (
  prefix: string,
): Promise<InviteRow | null> =>
  withClient('queryInviteByTokenPrefix', async (client) => {
    const res = await client.query<InviteRow>(
      `SELECT token_prefix,
              allowed_sso_providers,
              created_at
         FROM onboarding_invites
        WHERE token_prefix = $1
        LIMIT 1`,
      [prefix],
    );
    return res.rows[0] ?? null;
  });

/**
 * Return invites whose `created_at` is strictly after the given epoch-ms
 * marker. Used as a time-window guard for "no row should be written"
 * assertions in TC-E2E-06b. Callers should pass `Date.now() - 2000` (the
 * margin established by `tests/integration/team-roster-csv.test.ts`)
 * before the action that should NOT write, to absorb host vs db clock skew.
 */
export const queryInvitesCreatedSince = async (
  sinceMs: number,
): Promise<readonly InviteRow[]> =>
  withClient('queryInvitesCreatedSince', async (client) => {
    // ISO-string + `$1::timestamptz` mirrors `audit-log-probe.ts:45-51`
    // so both probes share one time-comparison idiom.
    const sinceIso = new Date(sinceMs).toISOString();
    const res = await client.query<InviteRow>(
      `SELECT token_prefix,
              allowed_sso_providers,
              created_at
         FROM onboarding_invites
        WHERE created_at > $1::timestamptz
        ORDER BY created_at ASC`,
      [sinceIso],
    );
    return res.rows;
  });
