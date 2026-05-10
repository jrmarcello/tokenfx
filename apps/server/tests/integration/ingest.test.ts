/**
 * Integration tests for POST /api/ingest (TASK-14).
 *
 * Maps directly to TC-I-21..31, TC-I-40, TC-I-48 in the spec. Drives the
 * route handler via direct invocation (no HTTP server) — Next's
 * `NextRequest`/`NextResponse` types are honored.
 *
 * Requires Postgres via Testcontainers (REQ-22). Skipped when
 * `SKIP_PG_TESTS=1` so devs without Docker can still run unit suites.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, and, sql } from 'drizzle-orm';
import {
  POST,
  __resetRateLimiter,
  __resetIngestAuthCache,
} from '@/app/api/ingest/route';
import { closeDb, getDb } from '@/lib/db/client';
import {
  ingestionLog,
  modelBreakdownAgg,
  orgs,
  sessionOutcomesAgg,
  sessionsAgg,
  toolCountAgg,
  userMachines,
  users,
} from '@/lib/db/schema';
import { BCRYPT_COST } from '@/lib/auth/bearer-auth';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// Hand-written test fixtures — no mocking framework (project rule).
type SessionPayload = {
  session_id: string;
  started_at: number;
  ended_at: number;
  project_slug: string;
  git_branch: string | null;
  cc_version: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_cost_usd_otel: number | null;
  turn_count: number;
  tool_call_count: number;
  model_breakdown: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;
  tool_counts: Record<string, number>;
  avg_rating: number | null;
  cache_hit_ratio: number | null;
  output_input_ratio: number | null;
  subagent_usage_ratio: number | null;
  // v3 outcome fields (manager-dashboard-v3-outcomes spec REQ-1).
  // All 7 are optional — old reporters omit the keys entirely (REQ-7
  // backward-compat verified by TC-I-01-v3 below).
  commit_count?: number | null;
  loc_added?: number | null;
  loc_removed?: number | null;
  files_changed?: number | null;
  reverts_within_7d?: number | null;
  merged_pr_count?: number | null;
  outcome_status?:
    | 'evaluated'
    | 'cwd-missing'
    | 'not-a-git-repo'
    | 'no-user-email'
    | null;
};

const makeSession = (overrides: Partial<SessionPayload> = {}): SessionPayload => ({
  session_id: overrides.session_id ?? `sess-${Math.random().toString(36).slice(2, 10)}`,
  started_at: 1700000000,
  ended_at: 1700001000,
  project_slug: 'slug:0123456789abcdef',
  git_branch: 'main',
  cc_version: '1.0.0',
  total_input_tokens: 1000,
  total_output_tokens: 500,
  total_cache_read_tokens: 100,
  total_cache_creation_tokens: 50,
  total_cost_usd: 0.5,
  total_cost_usd_otel: 0.1,
  turn_count: 10,
  tool_call_count: 20,
  model_breakdown: [
    {
      model: 'claude-sonnet-4-5',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      cost_usd: 0.5,
    },
  ],
  tool_counts: { Read: 15, Edit: 5 },
  avg_rating: null,
  cache_hit_ratio: 0.5,
  output_input_ratio: 0.5,
  subagent_usage_ratio: 0,
  ...overrides,
});

const SECRET = 'test-secret-do-not-use-in-prod';
const KEY_ID = 'key_test_001';
const MACHINE_ID = '00000000-0000-4000-8000-000000000001';

let testUserId = '';

type MakeRequestOpts = {
  keyId?: string;
  machineId?: string;
  raw?: string;
  /** Override the Authorization header value (full string after `:`). If
   *  omitted, defaults to `Bearer ${SECRET}`. Pass `null` to omit the header. */
  authorization?: string | null;
  /** Inject extra envelope fields (e.g. legacy `signature` to assert
   *  Zod strict rejection). */
  extraEnvelope?: Record<string, unknown>;
};

const makeRequest = (
  payload: unknown[],
  opts: MakeRequestOpts = {},
): Request => {
  const envelope = {
    version: 1 as const,
    key_id: opts.keyId ?? KEY_ID,
    machine_id: opts.machineId ?? MACHINE_ID,
    payload,
    ...(opts.extraEnvelope ?? {}),
  };
  const body = opts.raw ?? JSON.stringify(envelope);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.42',
  };
  if (opts.authorization === undefined) {
    headers.authorization = `Bearer ${SECRET}`;
  } else if (opts.authorization !== null) {
    headers.authorization = opts.authorization;
  }
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers,
    body,
  });
};

skipDescribe('POST /api/ingest (Postgres integration)', () => {
  beforeAll(async () => {
    const db = getDb();
    // Reset shared Postgres state — Testcontainers persists across the suite,
    // sibling test files seed orgs/users/machines too. Without this, this
    // file's seed collides on email/key_id uniques and cascades to 401s
    // (auth mismatch) when the route reads a stale `user_machines.secretHash`.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    // Seed an org + user + machine (TASK-15 carved-out: manual seed).
    const [org] = await db.insert(orgs).values({ name: 'TestOrg' }).returning({ id: orgs.id });
    const [user] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: 'tester@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-1',
        role: 'member',
      })
      .returning({ id: users.id });
    testUserId = user.id;
    const secretHash = await bcrypt.hash(SECRET, BCRYPT_COST);
    await db.insert(userMachines).values({
      userId: testUserId,
      machineId: MACHINE_ID,
      keyId: KEY_ID,
      // Bcrypt-hashed bearer secret (central-server-onboarding REQ-9).
      secretHash,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    __resetRateLimiter();
    __resetIngestAuthCache();
  });

  afterEach(async () => {
    const db = getDb();
    // Wipe per-session aggregates between tests (keep org/user/machine).
    // Order matters — outcome rows have a CASCADE FK on sessions_agg, but
    // wiping the FK target last works either way; explicit order is for
    // clarity, mirroring how Drizzle's delete order matches the schema
    // dependency graph.
    await db.delete(toolCountAgg);
    await db.delete(modelBreakdownAgg);
    await db.delete(sessionOutcomesAgg);
    await db.delete(sessionsAgg);
    await db.delete(ingestionLog);
  });

  it('TC-I-21: valid Bearer-authenticated batch of 5 sessions → 200 accepted=5', async () => {
    const payload = Array.from({ length: 5 }, (_, i) =>
      makeSession({ session_id: `sess-tc21-${i}` }),
    );
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number; skipped: number; rejected: number };
    expect(json.accepted).toBe(5);
    expect(json.skipped).toBe(0);
    expect(json.rejected).toBe(0);

    const db = getDb();
    const rows = await db.select().from(sessionsAgg).where(eq(sessionsAgg.userId, testUserId));
    expect(rows).toHaveLength(5);
  });

  it('TC-I-22 (legacy → Bearer): wrong bearer secret → 401', async () => {
    const payload = [makeSession()];
    const res = await POST(
      makeRequest(payload, {
        authorization: `Bearer ${SECRET.slice(0, -1)}x`,
      }) as never,
    );
    expect(res.status).toBe(401);
    const db = getDb();
    const rows = await db.select().from(sessionsAgg);
    expect(rows).toHaveLength(0);
  });

  it('TC-I-23: unknown key_id → 401', async () => {
    const payload = [makeSession()];
    const res = await POST(makeRequest(payload, { keyId: 'key_nonexistent' }) as never);
    expect(res.status).toBe(401);
  });

  it('TC-I-24: extra field at envelope root (Zod strict) → 400', async () => {
    const payload = [makeSession()];
    // The legacy `signature` field is itself an "extra field" after the
    // Bearer-auth refactor, so we reuse it as the unknown root key.
    const envelope = {
      version: 1,
      key_id: KEY_ID,
      machine_id: MACHINE_ID,
      payload,
      extra_field: 'should not be here',
    };
    const req = new Request('http://localhost/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(envelope),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('TC-I-25 / TC-I-48: payload item with prohibited field → per-session reject (200)', async () => {
    const goodSession = makeSession({ session_id: 'sess-good' });
    const badItem = { ...makeSession({ session_id: 'sess-bad' }), user_prompt: 'leaked secret' };
    const payload = [goodSession, badItem];
    const res = await POST(makeRequest(payload) as never);
    // Level-2 validation rejects per-item; valid siblings still accepted.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: number;
      rejected: number;
      errors: Array<{ session_id: string; reason: string }>;
    };
    expect(json.accepted).toBe(1);
    expect(json.rejected).toBe(1);
    expect(json.errors[0].session_id).toBe('sess-bad');

    // The bad row must NOT have been written (the reason matters for REQ-25).
    const db = getDb();
    const rows = await db
      .select()
      .from(sessionsAgg)
      .where(and(eq(sessionsAgg.userId, testUserId), eq(sessionsAgg.sessionId, 'sess-bad')));
    expect(rows).toHaveLength(0);
  });

  it('TC-I-26: same batch twice → second call all skipped, ingestion_log has 2 rows', async () => {
    const payload = Array.from({ length: 3 }, (_, i) =>
      makeSession({ session_id: `sess-tc26-${i}` }),
    );
    const res1 = await POST(makeRequest(payload) as never);
    expect(res1.status).toBe(200);
    const j1 = (await res1.json()) as { accepted: number; skipped: number };
    expect(j1.accepted).toBe(3);
    expect(j1.skipped).toBe(0);

    const res2 = await POST(makeRequest(payload) as never);
    const j2 = (await res2.json()) as { accepted: number; skipped: number };
    expect(j2.accepted).toBe(0);
    expect(j2.skipped).toBe(3);

    const db = getDb();
    const logs = await db.select().from(ingestionLog).where(eq(ingestionLog.userId, testUserId));
    expect(logs).toHaveLength(2);
  });

  it('TC-I-27: payload change (avg_rating added) → row updated', async () => {
    const original = makeSession({ session_id: 'sess-tc27', avg_rating: null });
    const updated = { ...original, avg_rating: 0.5 };

    const r1 = await POST(makeRequest([original]) as never);
    expect((await r1.json()).accepted).toBe(1);

    const r2 = await POST(makeRequest([updated]) as never);
    const j2 = (await r2.json()) as { accepted: number; skipped: number };
    expect(j2.accepted).toBe(1);
    expect(j2.skipped).toBe(0);

    const db = getDb();
    const [row] = await db
      .select()
      .from(sessionsAgg)
      .where(and(eq(sessionsAgg.userId, testUserId), eq(sessionsAgg.sessionId, 'sess-tc27')));
    expect(row.avgRating).not.toBeNull();
  });

  it('TC-I-28: DB error during write → 500, no partial write (transaction rollback)', async () => {
    // Force a constraint violation to trigger 500: insert a session twice
    // with two different machines pointing at the same user but with a
    // payload that overflows numeric(14,6) precision. Easiest way: pass a
    // total_cost_usd value that violates numeric(14,6) (max 99_999_999.999_999).
    // Zod's schema accepts any finite non-negative — Postgres rejects it.
    const payload = [
      makeSession({
        session_id: 'sess-tc28',
        total_cost_usd: 1e15,
      }),
    ];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(500);

    // Verify rollback — no row inserted.
    const db = getDb();
    const rows = await db
      .select()
      .from(sessionsAgg)
      .where(and(eq(sessionsAgg.userId, testUserId), eq(sessionsAgg.sessionId, 'sess-tc28')));
    expect(rows).toHaveLength(0);
  });

  it('TC-I-29: empty batch → 200 accepted=0, ingestion_log row written', async () => {
    const res = await POST(makeRequest([]) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(0);

    const db = getDb();
    const logs = await db.select().from(ingestionLog).where(eq(ingestionLog.userId, testUserId));
    expect(logs).toHaveLength(1);
  });

  it('TC-I-30: batch of 1 with invalid session_id format → per-session reject', async () => {
    // session_id must be min(1).max(128) — empty string fails.
    const goodSession = makeSession({ session_id: 'sess-good-tc30' });
    const badItem = { ...makeSession({ session_id: 'x' }), session_id: '' };
    const payload = [goodSession, badItem];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number; rejected: number };
    expect(json.accepted).toBe(1);
    expect(json.rejected).toBe(1);
  });

  it('TC-I-31: 101 requests in 60s → 429 with Retry-After', async () => {
    // Hammer the rate limiter directly. Use empty payload to keep DB fast.
    let lastRes: Response | undefined;
    for (let i = 0; i < 101; i += 1) {
      lastRes = await POST(makeRequest([]) as never);
      if (lastRes.status === 429) break;
    }
    expect(lastRes?.status).toBe(429);
    expect(lastRes?.headers.get('Retry-After')).toBe('60');
  });

  it('TC-I-40: successful ingest writes ingestion_log row with truncated IP', async () => {
    const payload = [makeSession({ session_id: 'sess-tc40' })];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const db = getDb();
    const [row] = await db
      .select({
        machineId: ingestionLog.machineId,
        requestIp: ingestionLog.requestIp,
        acceptedCount: ingestionLog.acceptedCount,
      })
      .from(ingestionLog)
      .where(eq(ingestionLog.userId, testUserId))
      .limit(1);
    expect(row.machineId).toBe(MACHINE_ID);
    expect(row.requestIp).toBe('203.0.113.0/24');
    expect(row.acceptedCount).toBe(1);
  });

  it('TC-I-19a: per-user calibration row written when OTEL cost present', async () => {
    // Hits REQ-19 — calibration recompute fires only when an item with
    // positive total_cost_usd_otel is in the batch.
    const payload = [
      makeSession({
        session_id: 'sess-cal-1',
        total_cost_usd: 1.0,
        total_cost_usd_otel: 0.2,
        model_breakdown: [
          {
            model: 'claude-sonnet-4-5',
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: 1.0,
          },
        ],
      }),
    ];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const db = getDb();
    const result = await db.execute(sql`
      SELECT family, effective_rate::float8 AS rate, sample_session_count
      FROM cost_calibration_per_user
      WHERE user_id = ${testUserId} AND family = 'sonnet'
    `);
    const rows = (Array.isArray(result)
      ? result
      : (result as unknown as { rows: Array<{ family: string; rate: number }> }).rows
    ) as Array<{ family: string; rate: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].rate).toBeGreaterThan(0);
  });

  // ---- v3 outcome fields (manager-dashboard-v3-outcomes spec) -----------

  // Helper: read the single outcome row for a session, with values cast to
  // their natural shape. NULLs from PG come through as JS null.
  const readOutcomeRow = async (
    sessionId: string,
  ): Promise<
    | {
        commit_count: number | null;
        loc_added: number | null;
        loc_removed: number | null;
        files_changed: number | null;
        reverts_within_7d: number | null;
        merged_pr_count: number | null;
        outcome_status: string | null;
      }
    | undefined
  > => {
    const db = getDb();
    const rows = await db
      .select({
        commit_count: sessionOutcomesAgg.commitCount,
        loc_added: sessionOutcomesAgg.locAdded,
        loc_removed: sessionOutcomesAgg.locRemoved,
        files_changed: sessionOutcomesAgg.filesChanged,
        reverts_within_7d: sessionOutcomesAgg.revertsWithin7d,
        merged_pr_count: sessionOutcomesAgg.mergedPrCount,
        outcome_status: sessionOutcomesAgg.outcomeStatus,
      })
      .from(sessionOutcomesAgg)
      .where(
        and(
          eq(sessionOutcomesAgg.userId, testUserId),
          eq(sessionOutcomesAgg.sessionId, sessionId),
        ),
      );
    return rows[0];
  };

  // TC-I-00a (REQ-8): CASCADE — DELETE parent sessions_agg removes child.
  it('TC-I-00a-v3 (REQ-8): CASCADE from sessions_agg to session_outcomes_agg', async () => {
    const payload = [makeSession({ session_id: 'sess-cascade', commit_count: 5 })];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    expect(await readOutcomeRow('sess-cascade')).toBeDefined();

    const db = getDb();
    await db
      .delete(sessionsAgg)
      .where(
        and(
          eq(sessionsAgg.userId, testUserId),
          eq(sessionsAgg.sessionId, 'sess-cascade'),
        ),
      );

    expect(await readOutcomeRow('sess-cascade')).toBeUndefined();
  });

  // TC-I-01-v3 (REQ-7, REQ-9): backward-compat — old reporter omits outcome
  // keys entirely. Server v3 must still UPSERT a row with all 7 columns
  // as SQL NULL (not 0, not empty string). .optional() Zod modifier path.
  it('TC-I-01-v3 (REQ-7): old payload (no outcome keys) → row with all 7 columns NULL', async () => {
    // makeSession() base shape has NO outcome keys (they're optional).
    const payload = [makeSession({ session_id: 'sess-old-shape' })];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const row = await readOutcomeRow('sess-old-shape');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.commit_count).toBeNull();
    expect(row.loc_added).toBeNull();
    expect(row.loc_removed).toBeNull();
    expect(row.files_changed).toBeNull();
    expect(row.reverts_within_7d).toBeNull();
    expect(row.merged_pr_count).toBeNull();
    expect(row.outcome_status).toBeNull();
  });

  // TC-I-02-v3 (REQ-9): all 7 fields populated → reflected exactly.
  it('TC-I-02-v3 (REQ-9): payload with all 7 outcome fields → row reflects each value', async () => {
    const payload = [
      makeSession({
        session_id: 'sess-all-outcome',
        commit_count: 5,
        loc_added: 120,
        loc_removed: 30,
        files_changed: 8,
        reverts_within_7d: 1,
        merged_pr_count: 2,
        outcome_status: 'evaluated',
      }),
    ];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const row = await readOutcomeRow('sess-all-outcome');
    expect(row).toEqual({
      commit_count: 5,
      loc_added: 120,
      loc_removed: 30,
      files_changed: 8,
      reverts_within_7d: 1,
      merged_pr_count: 2,
      outcome_status: 'evaluated',
    });
  });

  // TC-I-02b-v3 (REQ-4, REQ-9): merged_pr_count = null preserved as SQL NULL.
  it('TC-I-02b-v3 (REQ-4): merged_pr_count = null persisted as SQL NULL (not 0)', async () => {
    const payload = [
      makeSession({
        session_id: 'sess-pr-null',
        commit_count: 3,
        loc_added: 50,
        loc_removed: 10,
        files_changed: 4,
        reverts_within_7d: 0,
        merged_pr_count: null,
        outcome_status: 'evaluated',
      }),
    ];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const row = await readOutcomeRow('sess-pr-null');
    expect(row?.merged_pr_count).toBeNull();
    // The other metrics are populated — verifies null is field-scoped.
    expect(row?.commit_count).toBe(3);
  });

  // TC-I-02c-v3 (REQ-4, REQ-9): merged_pr_count = 0 distinct from null.
  it('TC-I-02c-v3 (REQ-4): merged_pr_count = 0 persisted as 0 (distinct from null)', async () => {
    const payload = [
      makeSession({
        session_id: 'sess-pr-zero',
        commit_count: 3,
        loc_added: 50,
        loc_removed: 10,
        files_changed: 4,
        reverts_within_7d: 0,
        merged_pr_count: 0,
        outcome_status: 'evaluated',
      }),
    ];
    const res = await POST(makeRequest(payload) as never);
    expect(res.status).toBe(200);

    const row = await readOutcomeRow('sess-pr-zero');
    expect(row?.merged_pr_count).toBe(0);
  });

  // TC-I-03-v3 (REQ-9, idempotency): re-push same envelope → second is a
  // no-op (existing payloadHash skip). The outcome row remains.
  it('TC-I-03-v3 (REQ-9): same envelope twice — outcome row stable, no duplicate', async () => {
    const session = makeSession({
      session_id: 'sess-idempotent',
      commit_count: 7,
      loc_added: 200,
      loc_removed: 50,
      files_changed: 12,
      reverts_within_7d: 0,
      merged_pr_count: 1,
      outcome_status: 'evaluated',
    });
    const res1 = await POST(makeRequest([session]) as never);
    expect(res1.status).toBe(200);
    __resetRateLimiter();
    const res2 = await POST(makeRequest([session]) as never);
    expect(res2.status).toBe(200);

    const db = getDb();
    const rows = await db
      .select()
      .from(sessionOutcomesAgg)
      .where(
        and(
          eq(sessionOutcomesAgg.userId, testUserId),
          eq(sessionOutcomesAgg.sessionId, 'sess-idempotent'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].commitCount).toBe(7);
  });

  // TC-I-03b-v3 (REQ-9b): outcome change between pushes → re-push proceeds
  // (different payloadHash since outcome fields are part of canonical JSON).
  it('TC-I-03b-v3 (REQ-9b): outcome update between pushes → row reflects last write', async () => {
    const first = makeSession({
      session_id: 'sess-outcome-update',
      commit_count: 1,
      loc_added: 10,
      loc_removed: 0,
      files_changed: 1,
      reverts_within_7d: 0,
      merged_pr_count: null,
      outcome_status: 'evaluated',
    });
    const res1 = await POST(makeRequest([first]) as never);
    expect(res1.status).toBe(200);
    expect((await readOutcomeRow('sess-outcome-update'))?.merged_pr_count).toBeNull();

    __resetRateLimiter();
    // Same session, but PR lookup eventually populated merged_pr_count.
    const updated = { ...first, merged_pr_count: 3 };
    const res2 = await POST(makeRequest([updated]) as never);
    expect(res2.status).toBe(200);
    expect((await readOutcomeRow('sess-outcome-update'))?.merged_pr_count).toBe(3);
  });

  // TC-I-Status-v3 (REQ-3): non-evaluated status preserved literally.
  it.each([
    ['cwd-missing' as const],
    ['not-a-git-repo' as const],
    ['no-user-email' as const],
  ])(
    'persists outcome_status=%j with metric columns NULL (cron WHERE clause skips these)',
    async (status) => {
      const payload = [
        makeSession({
          session_id: `sess-status-${status}`,
          // Non-evaluated sessions: payload has the status but metrics
          // are null (the local schema sets them to 0 by default but the
          // sanitizer/runner pipe the columns as null in this scenario;
          // here we mirror that contract directly).
          commit_count: null,
          loc_added: null,
          loc_removed: null,
          files_changed: null,
          reverts_within_7d: null,
          merged_pr_count: null,
          outcome_status: status,
        }),
      ];
      const res = await POST(makeRequest(payload) as never);
      expect(res.status).toBe(200);

      const row = await readOutcomeRow(`sess-status-${status}`);
      expect(row?.outcome_status).toBe(status);
      expect(row?.commit_count).toBeNull();
    },
  );
});
