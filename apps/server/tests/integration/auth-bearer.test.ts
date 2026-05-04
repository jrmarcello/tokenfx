/**
 * Integration tests for the Bearer-token + bcrypt auth refactor
 * (central-server-onboarding REQ-6, REQ-7, REQ-8, REQ-9, REQ-37).
 *
 * Maps to TC-I-04..09, TC-I-33d..f, TC-I-69..71e in the spec.
 *
 * Hand-written stubs only (project rule). Driven by direct route invocation
 * (no HTTP server). Requires Postgres via Testcontainers (REQ-22).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { sql } from 'drizzle-orm';
import {
  POST,
  __resetRateLimiter,
  __resetIngestAuthCache,
} from '@/app/api/ingest/route';
import {
  GET as healthGET,
  __resetHealthRateLimit,
} from '@/app/api/health/route';
import { closeDb, getDb } from '@/lib/db/client';
import { orgs, userMachines, users } from '@/lib/db/schema';
import {
  BCRYPT_COST,
  __hasCachedVerification,
} from '@/lib/auth/bearer-auth';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const SECRET = 'a'.repeat(64); // realistic 64-hex-char shape, value irrelevant
const KEY_ID = 'k_auth_bearer_test';
const MACHINE_ID = '11111111-2222-4333-8444-555555555555';

// Minimal valid SanitizedSessionPayload — the auth tests don't care about
// per-item validation, but the route still requires a structurally-valid
// payload[] entry to reach DB writes; for 401-path tests we send `[]` to
// keep things fast.
const validPayload = (): Record<string, unknown> => ({
  session_id: `auth-bearer-${Math.random().toString(36).slice(2, 10)}`,
  started_at: 1700000000,
  ended_at: 1700000500,
  project_slug: 'slug:0123456789abcdef',
  git_branch: 'main',
  cc_version: '1.0.0',
  total_input_tokens: 10,
  total_output_tokens: 20,
  total_cache_read_tokens: 5,
  total_cache_creation_tokens: 2,
  total_cost_usd: 0.01,
  total_cost_usd_otel: null,
  turn_count: 1,
  tool_call_count: 0,
  model_breakdown: [],
  tool_counts: {},
  avg_rating: null,
  cache_hit_ratio: null,
  output_input_ratio: null,
  subagent_usage_ratio: null,
});

const ingestRequest = (
  payload: unknown[],
  authorization: string | null | undefined,
): Request => {
  const envelope = {
    version: 1 as const,
    key_id: KEY_ID,
    machine_id: MACHINE_ID,
    payload,
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': '203.0.113.42',
  };
  if (authorization !== undefined && authorization !== null) {
    headers.authorization = authorization;
  }
  return new Request('http://localhost/api/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(envelope),
  });
};

const healthRequest = (
  opts: {
    keyId?: string;
    authorization?: string;
    /** Truncated /24 we control, so the limiter buckets predictably. */
    forwardedFor?: string;
  } = {},
): Request => {
  const params = new URLSearchParams();
  if (opts.keyId !== undefined) params.set('key_id', opts.keyId);
  const url = `http://localhost/api/health${params.toString() ? `?${params.toString()}` : ''}`;
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) {
    headers.authorization = opts.authorization;
  }
  if (opts.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = opts.forwardedFor;
  }
  return new Request(url, { method: 'GET', headers });
};

skipDescribe('Bearer-auth integration (REQ-6, REQ-7, REQ-9, REQ-37)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    const [org] = await db
      .insert(orgs)
      .values({ name: 'AuthBearerTestOrg' })
      .returning({ id: orgs.id });
    const [user] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: 'bearer@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-bearer-1',
        role: 'member',
      })
      .returning({ id: users.id });
    const secretHash = await bcrypt.hash(SECRET, BCRYPT_COST);
    await db.insert(userMachines).values({
      userId: user.id,
      machineId: MACHINE_ID,
      keyId: KEY_ID,
      secretHash,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    __resetRateLimiter();
    __resetIngestAuthCache();
    __resetHealthRateLimit();
  });

  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM ingestion_log`);
    await db.execute(sql`DELETE FROM sessions_agg`);
  });

  // -------------------------------------------------------------------------
  // /api/ingest auth tests (TC-I-04..07, TC-I-33d..f)
  // -------------------------------------------------------------------------

  it('TC-I-04: Authorization: Bearer <secret> → 200', async () => {
    const res = await POST(
      ingestRequest([validPayload()], `Bearer ${SECRET}`) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: number };
    expect(json.accepted).toBe(1);
  });

  it('TC-I-05: Bearer with wrong secret → 401', async () => {
    const res = await POST(
      ingestRequest([validPayload()], `Bearer ${'b'.repeat(64)}`) as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-06: missing Authorization header → 401', async () => {
    const res = await POST(ingestRequest([validPayload()], null) as never);
    expect(res.status).toBe(401);
  });

  it('TC-I-07: malformed Authorization (no Bearer prefix) → 401', async () => {
    const res = await POST(
      ingestRequest([validPayload()], `${SECRET}`) as never,
    );
    expect(res.status).toBe(401);
  });

  it.each([
    ['lowercase scheme', `bearer ${SECRET}`],
    ['UPPERCASE scheme', `BEARER ${SECRET}`],
    ['MixedCase scheme', `BeArEr ${SECRET}`],
  ])(
    'TC-I-33d: case-insensitive Bearer scheme accepted (%s)',
    async (_label, headerValue) => {
      const res = await POST(
        ingestRequest([validPayload()], headerValue) as never,
      );
      expect(res.status).toBe(200);
    },
  );

  it('TC-I-33e: empty Bearer token (trailing whitespace only) → 401', async () => {
    // `Bearer ` → trailing whitespace makes the parser reject because
    // `parseBearerAuthorization` first rejects header values with leading
    // or trailing whitespace.
    const res = await POST(
      ingestRequest([validPayload()], 'Bearer ') as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-33e (b): empty Bearer token after trim of internal spaces → 401', async () => {
    // `Bearer    ` (multiple internal spaces, no token) — the trimmed value
    // is `Bearer`, which has no token portion → 401.
    const res = await POST(
      ingestRequest([validPayload()], 'Bearer') as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-33f: wrong scheme (Basic abc) → 401', async () => {
    const res = await POST(
      ingestRequest([validPayload()], 'Basic abc123') as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-33f (b): wrong scheme (Token xxx) → 401', async () => {
    const res = await POST(
      ingestRequest([validPayload()], `Token ${SECRET}`) as never,
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Cache behavior (TC-I-71e is health-mode; covered below)
  // -------------------------------------------------------------------------

  it('cache: 2nd ingest call within 60s skips bcrypt (cache populated)', async () => {
    const res1 = await POST(
      ingestRequest([validPayload()], `Bearer ${SECRET}`) as never,
    );
    expect(res1.status).toBe(200);
    expect(__hasCachedVerification(KEY_ID)).toBe(true);

    const res2 = await POST(
      ingestRequest([validPayload()], `Bearer ${SECRET}`) as never,
    );
    expect(res2.status).toBe(200);
    // Still cached after second call.
    expect(__hasCachedVerification(KEY_ID)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // /api/health (TC-I-69..71e)
  // -------------------------------------------------------------------------

  it('TC-I-69: GET /api/health (no auth, no query) → 200 liveness', async () => {
    const res = await healthGET(healthRequest() as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; server_time: string };
    expect(json.ok).toBe(true);
    expect(json.server_time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO8601 prefix
    );
  });

  it('TC-I-70: GET /api/health?key_id=valid + valid Bearer → 200', async () => {
    const res = await healthGET(
      healthRequest({
        keyId: KEY_ID,
        authorization: `Bearer ${SECRET}`,
      }) as never,
    );
    expect(res.status).toBe(200);
  });

  it('TC-I-71: GET /api/health?key_id=valid + invalid Bearer → 401', async () => {
    const res = await healthGET(
      healthRequest({
        keyId: KEY_ID,
        authorization: `Bearer ${'z'.repeat(64)}`,
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-71b: GET /api/health with Authorization but NO key_id → 400', async () => {
    const res = await healthGET(
      healthRequest({ authorization: `Bearer ${SECRET}` }) as never,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(json.error.code).toBe('bad-request');
  });

  it('TC-I-71c: GET /api/health?key_id=... with Basic scheme → 401', async () => {
    const res = await healthGET(
      healthRequest({
        keyId: KEY_ID,
        authorization: 'Basic abc123',
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it('TC-I-71d: 11 credential-validation calls in 60s from same IP → 11th 429', async () => {
    const fwd = '198.51.100.7'; // unique /24 vs other tests
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await healthGET(
        healthRequest({
          keyId: KEY_ID,
          authorization: `Bearer ${SECRET}`,
          forwardedFor: fwd,
        }) as never,
      );
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('TC-I-71e: cache hit on 2nd /api/health call within 60s avoids bcrypt', async () => {
    // First call — cold; bcrypt runs and populates the cache.
    const t0 = Date.now();
    const res1 = await healthGET(
      healthRequest({
        keyId: KEY_ID,
        authorization: `Bearer ${SECRET}`,
        forwardedFor: '198.51.100.99',
      }) as never,
    );
    const t1 = Date.now();
    expect(res1.status).toBe(200);
    expect(__hasCachedVerification(KEY_ID)).toBe(true);
    const coldDurationMs = t1 - t0;

    // Second call — warm; constant-time string compare, no bcrypt.
    // Reset rate limit so we don't hit the 10/min cap.
    __resetHealthRateLimit();
    const t2 = Date.now();
    const res2 = await healthGET(
      healthRequest({
        keyId: KEY_ID,
        authorization: `Bearer ${SECRET}`,
        forwardedFor: '198.51.100.99',
      }) as never,
    );
    const t3 = Date.now();
    expect(res2.status).toBe(200);
    const warmDurationMs = t3 - t2;
    // Cold should include ~25ms bcrypt; warm should be ≪ that. Use a
    // generous margin to avoid flake on slow CI: warm < cold AND warm < 15ms.
    expect(warmDurationMs).toBeLessThan(coldDurationMs);
    expect(warmDurationMs).toBeLessThan(15);
  });

  it('REQ-37: GET /api/health?key_id=k_xxx without Authorization → 401', async () => {
    // Edge: caller provided key_id but no Authorization. Not bad-request
    // (because there's no auth header to "explain"), but also not liveness
    // (because the URL clearly asks for credential validation). We return 401.
    const res = await healthGET(healthRequest({ keyId: KEY_ID }) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-37: GET /api/health with Bearer + unknown key_id → 401', async () => {
    const res = await healthGET(
      healthRequest({
        keyId: 'k_does_not_exist',
        authorization: `Bearer ${SECRET}`,
      }) as never,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TC-I-08, TC-I-09: seed-server.ts --e2e behavior
// These cover the script's contract (bcrypt prefix in DB, no plaintext on
// stdout). Run as integration so we exercise the real seed.
// ---------------------------------------------------------------------------

skipDescribe('seed-server.ts --e2e behavior (TC-I-08, TC-I-09)', () => {
  let stdoutCapture: string;

  beforeAll(async () => {
    // The seed runs against the same Testcontainers Postgres because
    // setup-pg.ts has set DATABASE_URL on `process.env`. Run the script and
    // capture stdout.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(repoRoot, 'scripts/seed-server.ts');
    // Wipe seed targets so onConflictDoNothing rows aren't pre-populated.
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    // Close the pool — the seed opens its own. Reopen lazily after.
    await closeDb();
    try {
      stdoutCapture = execFileSync('tsx', [scriptPath, '--e2e'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
    } catch (err) {
      // Surface the error so a CI failure shows the actual cause.
      throw new Error(`seed-server --e2e failed: ${(err as Error).message}`);
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-08: every user_machines.secret_hash starts with bcrypt prefix', async () => {
    const db = getDb();
    const rows = await db
      .select({ secretHash: userMachines.secretHash })
      .from(userMachines);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // bcrypt v2a/v2b hashes start with `$2a$10$` or `$2b$10$`.
      expect(r.secretHash).toMatch(/^\$2[ab]\$10\$/);
    }
  });

  it('TC-I-09: --e2e stdout does NOT print plaintext secret', async () => {
    // The deterministic plaintext for alice@alpha is sha256 of
    // `e2e-secret:org-alpha:alice` — recompute and assert it's NOT in stdout.
    const { createHash } = await import('node:crypto');
    const alicePlaintext = createHash('sha256')
      .update('e2e-secret:org-alpha:alice')
      .digest('hex');
    expect(stdoutCapture).not.toContain(alicePlaintext);
    // Defense-in-depth: no 64-hex-char plaintext substring at all.
    expect(stdoutCapture).not.toMatch(/[0-9a-f]{64}/);
  });

  it('TC-I-09b: --e2e stdout DOES print key_id and machine_id', async () => {
    expect(stdoutCapture).toContain('key_id=k_e2e_alpha_alice');
    expect(stdoutCapture).toMatch(/machine_id=[0-9a-f-]{36}/);
  });
});
