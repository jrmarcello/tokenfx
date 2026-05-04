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
    await db.delete(toolCountAgg);
    await db.delete(modelBreakdownAgg);
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
});
