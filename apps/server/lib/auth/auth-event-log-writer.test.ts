/**
 * Integration tests for `writeAuthEvent` (TASK-5).
 *
 * Spec: .specs/central-server-onboarding-v2-sso.backend.md
 *   - REQ-4 (truncate user_agent at write boundary)
 *   - REQ-10 (10-outcome CHECK constraint on auth_event_log)
 *   - REQ-12 / Decisão #16 ('rate-limited' is NOT a valid auth_event_log
 *     outcome — confirms rate-limit logging stays in onboarding_redemption_log)
 *
 * TC coverage: TC-I-14, TC-I-16, TC-I-17 (partial — full privacy sweep in
 * TASK-10), TC-I-35.
 *
 * Runs against the shared Testcontainers Postgres started by
 * `tests/integration/setup-pg.ts` (gated on SKIP_PG_TESTS=1).
 *
 * Conventions: hand-written stubs (no mocking framework), natural-English
 * test names, table-driven via `it.each` where uniform.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '@/lib/db/client';

import {
  type AuthEventInput,
  type AuthEventOutcome,
  writeAuthEvent,
  writeReplayAuditRow,
} from './auth-event-log-writer';
import {
  REPLAY_EMAIL_HASH_SENTINEL,
  REPLAY_ISS_SENTINEL,
} from './replay-detector';

const SKIP_PG = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP_PG ? describe.skip : describe;

// The 10 valid outcomes from the auth_event_log CHECK constraint
// (kept in sync with schema.ts → authEventLog.outcomeCheck).
const ALL_OUTCOMES: readonly AuthEventOutcome[] = [
  'accepted-sso-auto',
  'rejected-public-domain',
  'rejected-multiple-matches',
  'rejected-no-match',
  'rejected-race',
  'rejected-csrf',
  'rejected-replay',
  'rejected-cross-idp',
  'rejected-pre-existing-binding',
  'email-not-verified',
] as const;

/** Build an AuthEventInput with sensible defaults; override via the patch. */
const makeInput = (patch: Partial<AuthEventInput> = {}): AuthEventInput => ({
  ssoProvider: 'google',
  iss: 'https://accounts.google.com',
  emailHash: 'peppered-hash-email-default',
  ssoSubjectHash: 'peppered-hash-subject-default',
  ip: '203.0.113.7',
  city: 'São Paulo',
  userAgent: 'Mozilla/5.0 (test-ua)',
  outcome: 'accepted-sso-auto',
  ...patch,
});

/** Fetch the most-recent auth_event_log row written by these tests. */
type AuthEventRow = {
  id: string;
  sso_provider: string;
  iss: string;
  email_hash: string;
  sso_subject_hash: string | null;
  ip: string | null;
  city: string | null;
  user_agent: string | null;
  outcome: string;
  occurred_at: Date;
};

const fetchLatestByEmailHash = async (
  emailHash: string,
): Promise<AuthEventRow | undefined> => {
  const db = getDb();
  const result = await db.execute<AuthEventRow>(sql`
    SELECT id, sso_provider, iss, email_hash, sso_subject_hash, ip, city,
           user_agent, outcome, occurred_at
    FROM auth_event_log
    WHERE email_hash = ${emailHash}
    ORDER BY id DESC
    LIMIT 1
  `);
  return result.rows[0];
};

skipDescribe('writeAuthEvent — auth_event_log writer (TASK-5)', () => {
  beforeAll(async () => {
    // Force pool initialisation against the shared Testcontainers DB.
    getDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    // Per-test isolation: truncate auth_event_log only. Other tests in
    // the suite share orgs/users/etc., so we leave those untouched.
    await db.execute(sql`TRUNCATE TABLE auth_event_log RESTART IDENTITY`);
  });

  // ==========================================================================
  // TC-I-14 — happy path: all 10 fields populated correctly.
  // ==========================================================================
  it('writes a row with all 10 fields populated correctly', async () => {
    const input = makeInput({
      ssoProvider: 'okta',
      iss: 'https://acme.okta.com',
      emailHash: 'hash-happy-path-email',
      ssoSubjectHash: 'hash-happy-path-subject',
      ip: '198.51.100.42',
      city: 'Berlin',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      outcome: 'accepted-sso-auto',
    });
    await writeAuthEvent(input);

    const row = await fetchLatestByEmailHash('hash-happy-path-email');
    expect(row).toBeDefined();
    expect(row!.sso_provider).toBe('okta');
    expect(row!.iss).toBe('https://acme.okta.com');
    expect(row!.email_hash).toBe('hash-happy-path-email');
    expect(row!.sso_subject_hash).toBe('hash-happy-path-subject');
    expect(row!.ip).toBe('198.51.100.42');
    expect(row!.city).toBe('Berlin');
    expect(row!.user_agent).toBe('Mozilla/5.0 (Macintosh)');
    expect(row!.outcome).toBe('accepted-sso-auto');
    // occurred_at populated by the DB default — must be near now().
    const occurredMs = new Date(row!.occurred_at).getTime();
    expect(Math.abs(Date.now() - occurredMs)).toBeLessThan(5000);
  });

  // ==========================================================================
  // TC-I-16 — user_agent truncation at the write boundary (REQ-4).
  // ==========================================================================
  it('truncates user_agent strings longer than 512 chars at write boundary', async () => {
    const longUa = 'a'.repeat(1000);
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-truncate-long', userAgent: longUa }),
    );

    const row = await fetchLatestByEmailHash('hash-truncate-long');
    expect(row).toBeDefined();
    expect(row!.user_agent).not.toBeNull();
    expect(row!.user_agent!.length).toBe(512);
    expect(row!.user_agent).toBe('a'.repeat(512));
  });

  it('preserves user_agent strings 512 chars or shorter unchanged', async () => {
    const exact512 = 'b'.repeat(512);
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-truncate-512', userAgent: exact512 }),
    );

    const row = await fetchLatestByEmailHash('hash-truncate-512');
    expect(row).toBeDefined();
    expect(row!.user_agent).toBe(exact512);
    expect(row!.user_agent!.length).toBe(512);

    const short = 'Mozilla/5.0 short-ua';
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-truncate-short', userAgent: short }),
    );
    const row2 = await fetchLatestByEmailHash('hash-truncate-short');
    expect(row2!.user_agent).toBe(short);
  });

  // ==========================================================================
  // Nullable column edge cases.
  // ==========================================================================
  it('accepts null user_agent and writes NULL column', async () => {
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-null-ua', userAgent: null }),
    );
    const row = await fetchLatestByEmailHash('hash-null-ua');
    expect(row).toBeDefined();
    expect(row!.user_agent).toBeNull();
  });

  it('accepts null ssoSubjectHash and writes NULL column', async () => {
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-null-subject', ssoSubjectHash: null }),
    );
    const row = await fetchLatestByEmailHash('hash-null-subject');
    expect(row).toBeDefined();
    expect(row!.sso_subject_hash).toBeNull();
  });

  it('accepts null ip and city columns', async () => {
    await writeAuthEvent(
      makeInput({ emailHash: 'hash-null-ip-city', ip: null, city: null }),
    );
    const row = await fetchLatestByEmailHash('hash-null-ip-city');
    expect(row).toBeDefined();
    expect(row!.ip).toBeNull();
    expect(row!.city).toBeNull();
  });

  // ==========================================================================
  // DB default — occurred_at.
  // ==========================================================================
  it('occurredAt defaults to now() when not provided', async () => {
    const before = Date.now();
    await writeAuthEvent(makeInput({ emailHash: 'hash-default-occurred' }));
    const after = Date.now();

    const row = await fetchLatestByEmailHash('hash-default-occurred');
    expect(row).toBeDefined();
    const occurredMs = new Date(row!.occurred_at).getTime();
    // Allow modest clock skew between test process and Postgres container.
    expect(occurredMs).toBeGreaterThanOrEqual(before - 5000);
    expect(occurredMs).toBeLessThanOrEqual(after + 5000);
  });

  // ==========================================================================
  // CHECK-constraint enforcement (spec a REQ-10).
  // ==========================================================================
  it('CHECK constraint rejects unknown outcome value', async () => {
    // The writer's TS type prevents this at compile time. To exercise the
    // DB-level CHECK we must bypass TS narrowing — done explicitly with a
    // typed cast (NOT `any`) so the test surfaces the runtime DB error.
    const badInput = makeInput({
      emailHash: 'hash-bad-outcome',
      // Cast through `string` to dodge the AuthEventOutcome union narrowing;
      // explicit comment documents that this is the test's whole point.
      outcome: 'garbage' as unknown as AuthEventOutcome,
    });
    await expect(writeAuthEvent(badInput)).rejects.toThrow(
      /check constraint|outcome_check/i,
    );
  });

  // TC-I-35 — every valid outcome inserts cleanly. Uses it.each per spec.
  it.each(ALL_OUTCOMES)(
    'each of the 10 SSO-decision outcomes can be inserted successfully (%s)',
    async (outcome) => {
      const emailHash = `hash-outcome-${outcome}`;
      await writeAuthEvent(makeInput({ emailHash, outcome }));
      const row = await fetchLatestByEmailHash(emailHash);
      expect(row).toBeDefined();
      expect(row!.outcome).toBe(outcome);
    },
  );

  // Decisão #16 — 'rate-limited' must NOT pass the CHECK on auth_event_log.
  it('inserting outcome=rate-limited is rejected by CHECK constraint', async () => {
    const badInput = makeInput({
      emailHash: 'hash-rate-limited-forbidden',
      // 'rate-limited' is a valid value for onboarding_redemption_log.outcome
      // (different enum). It MUST be rejected here.
      outcome: 'rate-limited' as unknown as AuthEventOutcome,
    });
    await expect(writeAuthEvent(badInput)).rejects.toThrow(
      /check constraint|outcome_check/i,
    );
  });

  // ==========================================================================
  // TC-I-17 (partial) — privacy: writer does not log raw email or raw subject.
  //
  // The writer doesn't log anything itself (no logger import). We still
  // assert this by spying on the console methods the lib/logger.ts wrapper
  // delegates to, ensuring no future regression silently introduces a
  // logger.info(rawEmail) line. Full sweep is in TASK-10.
  // ==========================================================================
  it('writer does not log raw email or raw sso_subject anywhere', async () => {
    const captured: string[] = [];
    const consoleMethods = ['debug', 'info', 'warn', 'error'] as const;
    const originals: Partial<Record<(typeof consoleMethods)[number], typeof console.log>> = {};

    for (const m of consoleMethods) {
      originals[m] = console[m];
      console[m] = (...args: unknown[]): void => {
        captured.push(args.map((a) => String(a)).join(' '));
      };
    }

    try {
      // Use sentinel strings the test can grep for. The writer should
      // never put RAW values into stdout — only their already-hashed
      // forms (passed in by the caller).
      await writeAuthEvent(
        makeInput({
          // Note: these "hash" values are the caller-provided hashes
          // (not raw). We choose distinctive strings so we can assert
          // they are NOT echoed, even though raw values would never
          // reach this function in the first place.
          emailHash: 'opaquehash-privacy-test-email',
          ssoSubjectHash: 'opaquehash-privacy-test-subject',
        }),
      );
    } finally {
      for (const m of consoleMethods) {
        const original = originals[m];
        if (original) console[m] = original;
      }
    }

    const joined = captured.join('\n');
    // Forbidden patterns: a literal email (anything containing '@') and
    // any raw subject string. The writer should produce zero log lines.
    expect(joined).not.toMatch(/@/);
    expect(joined).not.toMatch(/raw-subject/i);
    // Strictly: the writer logs nothing.
    expect(captured.length).toBe(0);
  });
});

describe('writeReplayAuditRow (unit — DI seam)', () => {
  // Pure unit test — uses the `opts.writeAuthEvent` DI seam to assert the
  // shape passed downstream without touching Postgres. Integration coverage
  // (real DB) lives in `replay-detector.integration.test.ts`.
  it('calls the injected writeAuthEvent exactly once with sentinel emailHash + iss + outcome="rejected-replay"', async () => {
    const captured: Array<Parameters<typeof writeAuthEvent>[0]> = [];
    const stub = async (
      input: Parameters<typeof writeAuthEvent>[0],
    ): Promise<void> => {
      captured.push(input);
    };

    await writeReplayAuditRow(
      {
        ssoProvider: 'okta',
        ip: '1.2.3.4',
        city: 'Lisbon',
        userAgent: 'Mozilla/100.0',
      },
      { writeAuthEvent: stub },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      ssoProvider: 'okta',
      iss: REPLAY_ISS_SENTINEL,
      emailHash: REPLAY_EMAIL_HASH_SENTINEL,
      ssoSubjectHash: null,
      ip: '1.2.3.4',
      city: 'Lisbon',
      userAgent: 'Mozilla/100.0',
      outcome: 'rejected-replay',
    });
  });

  it('passes null ip / city / userAgent through unchanged', async () => {
    const captured: Array<Parameters<typeof writeAuthEvent>[0]> = [];
    const stub = async (
      input: Parameters<typeof writeAuthEvent>[0],
    ): Promise<void> => {
      captured.push(input);
    };

    await writeReplayAuditRow(
      {
        ssoProvider: 'unknown',
        ip: null,
        city: null,
        userAgent: null,
      },
      { writeAuthEvent: stub },
    );

    expect(captured[0].ip).toBe(null);
    expect(captured[0].city).toBe(null);
    expect(captured[0].userAgent).toBe(null);
    expect(captured[0].ssoProvider).toBe('unknown');
  });

  it('TC-I-03 (infra): when injected writeAuthEvent rejects (DB connection failure), writeReplayAuditRow rejects — the caller in auth.ts is responsible for the catch', async () => {
    const stub = async (): Promise<void> => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      writeReplayAuditRow(
        { ssoProvider: 'okta', ip: '1.2.3.4', city: null, userAgent: null },
        { writeAuthEvent: stub },
      ),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

skipDescribe('writeReplayAuditRow (integration — real Postgres)', () => {
  // Spec: .specs/sso-replay-audit-row.md TC-I-01..TC-I-03.
  // Runs against the shared testcontainer; gated on SKIP_PG_TESTS=1.
  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM auth_event_log WHERE email_hash = ${REPLAY_EMAIL_HASH_SENTINEL}`);
  });
  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM auth_event_log WHERE email_hash = ${REPLAY_EMAIL_HASH_SENTINEL}`);
  });
  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-01: writes one row with sentinel emailHash + sentinel iss + ssoSubjectHash null + outcome=rejected-replay', async () => {
    await writeReplayAuditRow({
      ssoProvider: 'okta',
      ip: '1.2.3.4',
      city: 'Lisbon',
      userAgent: 'Mozilla/100.0',
    });

    const db = getDb();
    const result = await db.execute(
      sql`SELECT sso_provider, iss, email_hash, sso_subject_hash, ip, city, user_agent, outcome
          FROM auth_event_log
          WHERE email_hash = ${REPLAY_EMAIL_HASH_SENTINEL}`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as {
      sso_provider: string;
      iss: string;
      email_hash: string;
      sso_subject_hash: string | null;
      ip: string | null;
      city: string | null;
      user_agent: string | null;
      outcome: string;
    };
    expect(row).toEqual({
      sso_provider: 'okta',
      iss: REPLAY_ISS_SENTINEL,
      email_hash: REPLAY_EMAIL_HASH_SENTINEL,
      sso_subject_hash: null,
      ip: '1.2.3.4',
      city: 'Lisbon',
      user_agent: 'Mozilla/100.0',
      outcome: 'rejected-replay',
    });
  });

  it('TC-I-02: truncates user_agent to <=512 chars at the write boundary', async () => {
    const longUa = 'A'.repeat(600);
    await writeReplayAuditRow({
      ssoProvider: 'okta',
      ip: null,
      city: null,
      userAgent: longUa,
    });
    const db = getDb();
    const result = await db.execute(
      sql`SELECT user_agent FROM auth_event_log
          WHERE email_hash = ${REPLAY_EMAIL_HASH_SENTINEL}`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as { user_agent: string };
    expect(row.user_agent.length).toBeLessThanOrEqual(512);
  });

  it('TC-I-03: accepts null ip/city/userAgent and writes them as NULL', async () => {
    await writeReplayAuditRow({
      ssoProvider: 'unknown',
      ip: null,
      city: null,
      userAgent: null,
    });
    const db = getDb();
    const result = await db.execute(
      sql`SELECT ip, city, user_agent
          FROM auth_event_log
          WHERE email_hash = ${REPLAY_EMAIL_HASH_SENTINEL}`,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as { ip: string | null; city: string | null; user_agent: string | null };
    expect(row.ip).toBe(null);
    expect(row.city).toBe(null);
    expect(row.user_agent).toBe(null);
  });
});
