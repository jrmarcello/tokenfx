/**
 * Postgres helpers for asserting `auth_event_log` rows in E2E tests.
 *
 * Origin: extracted from `apps/server/tests/e2e/sso-replay-audit-row.spec.ts`
 * by `.specs/sso-nonce-replay.md` TASK-5 so the new spec can share the
 * same probes without 44 LoC of inline duplication. The original spec
 * (`sso-replay-audit-row`) anticipated this extraction in its Design
 * §"Future refactor to a shared `helpers/audit-log-probe.ts`".
 *
 * The probes filter by `email_hash = REPLAY_EMAIL_HASH_SENTINEL` because
 * the replay-audit writer always uses sentinel values for the
 * NOT-NULL identity columns (see `lib/auth/replay-detector.ts`). Tests
 * pin `sinceMs` to the test's own start time so unrelated rows from
 * prior tests are filtered out.
 */
import { Client } from 'pg';

import { REPLAY_EMAIL_HASH_SENTINEL } from '../../../lib/auth/replay-detector';

export type ReplayRow = {
  outcome: string;
  email_hash: string;
  iss: string;
  sso_provider: string;
  ip: string | null;
  city: string | null;
  user_agent: string | null;
  occurred_at: Date;
};

/**
 * One-shot query: returns all `rejected-replay` rows with the sentinel
 * email hash whose `occurred_at` is strictly newer than `sinceMs`.
 *
 * Opens + closes the connection per call — slow but cheap relative to
 * Playwright round-trips, and avoids long-lived connections that would
 * outlive a test fixture.
 */
export const queryReplayRowsSince = async (
  sinceMs: number,
): Promise<ReplayRow[]> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const sinceIso = new Date(sinceMs).toISOString();
    const res = await client.query<ReplayRow>(
      `SELECT outcome, email_hash, iss, sso_provider, ip, city, user_agent, occurred_at
         FROM auth_event_log
        WHERE outcome = 'rejected-replay'
          AND email_hash = $1
          AND occurred_at > $2
        ORDER BY occurred_at DESC`,
      [REPLAY_EMAIL_HASH_SENTINEL, sinceIso],
    );
    return res.rows;
  } finally {
    await client.end();
  }
};

/**
 * Delete every `rejected-replay` row tagged with the replay sentinels.
 *
 * fix-sso-e2e-remaining-5 TASK-4: used in `beforeEach` of SSO E2E specs
 * that assert row-count invariants (`.toBe(0)` for healthy flows or
 * `.toBe(1)` for exactly-one-replay flows). Without this, leftover
 * rows from earlier tests in the same Playwright run leak into the
 * `occurred_at > testStartMs - 1_000` poll window and flip the count.
 *
 * The DELETE is scoped to the sentinel `email_hash` so we cannot
 * accidentally wipe a real audit row.
 */
export const truncateReplayRows = async (): Promise<void> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM auth_event_log
        WHERE outcome = 'rejected-replay'
          AND email_hash = $1`,
      [REPLAY_EMAIL_HASH_SENTINEL],
    );
  } finally {
    await client.end();
  }
};

/**
 * Poll until at least one row matches OR `timeoutMs` elapses.
 *
 * The replay-write happens in a fire-and-forget microtask after the
 * NextAuth redirect response is sent (see `auth.ts` `logger.error`
 * hook from commit `1961b61`), so a fixed sleep is flake-prone. The
 * poll converges as fast as the DB write commits and times out cleanly
 * if it never does.
 */
export const waitForReplayRow = async (
  sinceMs: number,
  timeoutMs = 3_000,
): Promise<ReplayRow[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await queryReplayRowsSince(sinceMs);
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return queryReplayRowsSince(sinceMs);
};
