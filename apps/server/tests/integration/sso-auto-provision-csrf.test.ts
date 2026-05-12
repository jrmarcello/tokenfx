/**
 * CSRF Origin-guard integration tests for `/api/auth/signin`
 * (central-server-onboarding-v2-sso, TASK-13).
 *
 * Exercises the `csrfWrap` behavior defined in
 * `apps/server/app/api/auth/[...nextauth]/route.ts` end-to-end against a real
 * Postgres `onboarding_redemption_log` row:
 *
 *   1. POST `/api/auth/signin/*` with cross-origin `Origin`   → 403
 *   2. POST `/api/auth/signin/*` with missing Origin+Referer  → 403
 *   3. POST `/api/auth/signin/*` with `Origin: null`          → 403
 *   4. POST `/api/auth/signin/*` with same-origin `Origin`    → passes through
 *      (downstream handler is invoked; no CSRF rejection row written).
 *
 * Each rejection ALSO writes one row to `onboarding_redemption_log` with
 * `outcome='rejected-csrf'`, `method='sso-auto'`, sentinel token prefix
 * `00000000`, empty `email_hash` / `email_domain` (we don't know the
 * email pre-NextAuth — by design).
 *
 * --- Why a local re-implementation of `csrfWrap` instead of importing it ----
 *
 * The wrapper in `route.ts` is composed of two production modules:
 *
 *   - `lib/auth/csrf-origin-guard.ts::checkSigninOrigin` — pure decision.
 *   - `lib/queries/redemption-log.ts::writeRedemptionLog` — DB writer.
 *
 * Importing `route.ts` directly pulls in `lib/auth/auth.ts` (NextAuth v5),
 * whose transitive `import 'next/server'` (no `.js`) hits Node's strict
 * ESM resolver before vitest's bundler intercepts — even with
 * `server.deps.inline: [/^next-auth/, /^next($|\/)/]` in `vitest.config.ts`.
 * See `tests/integration/drilldown-notification.test.ts:432-455` (TC-I-17
 * `it.skip`) for the same well-documented limitation.
 *
 * This test therefore reproduces the wrapper composition LOCALLY using
 * the **same real modules** the route uses (`checkSigninOrigin` +
 * `writeRedemptionLog`). The downstream handler is stubbed by a sentinel
 * (`NEXTAUTH_PASSTHROUGH`) that lets us assert "guard passed through" on
 * the same-origin case without booting NextAuth. The contract under test
 * — guard decision → audit row + 403 — runs end-to-end against the same
 * production code paths the route handler invokes at runtime. Re-enable
 * a route-level integration once vitest can resolve next-auth (see
 * TC-I-17 deferral note for the upgrade path).
 *
 * TC mapping:
 *   - TC-I-28 — Origin: evil.example.com → 403 + audit row outcome=rejected-csrf
 *   - TC-I-29 — Missing Origin AND missing Referer → 403
 *   - TC-I-30 — Origin matching base URL proceeds to downstream handler
 *   - TC-I-44 — Origin: null → 403
 *
 * Postgres-backed via the shared Testcontainers setup. Skip-guarded on
 * `SKIP_PG_TESTS=1` so unit-only runs still pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { closeDb, getDb } from '@/lib/db/client';
import { onboardingRedemptionLog } from '@/lib/db/schema';
import { checkSigninOrigin } from '@/lib/auth/csrf-origin-guard';
import { writeRedemptionLog } from '@/lib/queries/redemption-log';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const SIGNIN_PATH_PREFIX = '/api/auth/signin';
const SENTINEL_TOKEN_PREFIX = '00000000';
const BASE_URL = 'http://localhost';
const SIGNIN_URL = `${BASE_URL}/api/auth/signin/google`;

// Sentinel response from the downstream-handler stub. The same-origin TC
// asserts on this body to prove the guard passed through.
const NEXTAUTH_PASSTHROUGH = '__nextauth_stub_passthrough__';

type Handler = (request: NextRequest) => Promise<Response> | Response;

// Local re-implementation of route.ts::csrfWrap. Kept structurally identical
// to the production wrapper — see comment block at file top for the why.
const extractRequestIp = (request: NextRequest): string => {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real !== null) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const writeCsrfAuditRow = async (request: NextRequest): Promise<void> => {
  await writeRedemptionLog(getDb(), {
    tokenPrefix: SENTINEL_TOKEN_PREFIX,
    machineId: null,
    emailDomain: '',
    emailHash: '',
    requestIp: extractRequestIp(request),
    outcome: 'rejected-csrf',
    method: 'sso-auto',
    ssoProvider: null,
    ssoSubjectHash: null,
    iss: null,
    userAgent: request.headers.get('user-agent'),
  });
};

const csrfWrap = (handler: Handler): Handler => {
  return async (request: NextRequest) => {
    if (request.method === 'POST') {
      const url = new URL(request.url);
      if (url.pathname.startsWith(SIGNIN_PATH_PREFIX)) {
        const baseUrl = `${url.protocol}//${url.host}`;
        const csrf = checkSigninOrigin(request, baseUrl);
        if (!csrf.ok) {
          await writeCsrfAuditRow(request);
          return NextResponse.json(
            { error: { message: 'forbidden', code: csrf.reason } },
            { status: 403 },
          );
        }
      }
    }
    return handler(request);
  };
};

// Stub the downstream NextAuth handler with a sentinel response so the
// same-origin TC can assert passthrough without booting NextAuth.
const stubDownstream: Handler = () =>
  new Response(NEXTAUTH_PASSTHROUGH, { status: 200 });

const POST = csrfWrap(stubDownstream);

type RequestHeaders = Record<string, string>;

const makeSigninRequest = (headers: RequestHeaders): NextRequest =>
  new Request(SIGNIN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.42',
      ...headers,
    },
    body: 'csrfToken=stub',
  }) as unknown as NextRequest;

skipDescribe('POST /api/auth/signin — CSRF Origin guard', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      onboarding_redemption_log RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(onboardingRedemptionLog);
  });

  // ---------------------------------------------------------------------------
  // TC-I-28 — cross-origin
  // ---------------------------------------------------------------------------
  it('TC-I-28: /api/auth/signin with Origin: evil.example.com returns 403 + audit row outcome=rejected-csrf', async () => {
    const res = await POST(
      makeSigninRequest({ origin: 'http://evil.example.com' }),
    );

    expect(res.status).toBe(403);

    const body = (await res.json()) as {
      error?: { message?: string; code?: string };
    };
    expect(body.error?.message).toBe('forbidden');
    expect(body.error?.code).toBe('cross-origin');

    const rows = await getDb().select().from(onboardingRedemptionLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('rejected-csrf');
    expect(rows[0].method).toBe('sso-auto');
    expect(rows[0].tokenPrefix).toBe(SENTINEL_TOKEN_PREFIX);
    // No email known at this point — both fields must be the empty-sentinel.
    expect(rows[0].emailHash).toBe('');
    expect(rows[0].emailDomain).toBe('');
  });

  // ---------------------------------------------------------------------------
  // TC-I-29 — missing Origin AND missing Referer
  // ---------------------------------------------------------------------------
  it('TC-I-29: /api/auth/signin with missing Origin AND missing Referer returns 403', async () => {
    // makeSigninRequest sets no origin / referer by default.
    const res = await POST(makeSigninRequest({}));

    expect(res.status).toBe(403);

    const body = (await res.json()) as {
      error?: { message?: string; code?: string };
    };
    expect(body.error?.message).toBe('forbidden');
    expect(body.error?.code).toBe('missing-origin');

    const rows = await getDb().select().from(onboardingRedemptionLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('rejected-csrf');
  });

  // ---------------------------------------------------------------------------
  // TC-I-30 — same-origin: guard passes through to downstream handler
  // ---------------------------------------------------------------------------
  it('TC-I-30: /api/auth/signin with Origin matching base URL proceeds to NextAuth handler', async () => {
    const res = await POST(makeSigninRequest({ origin: BASE_URL }));

    // Same-origin: guard must NOT short-circuit with 403.
    expect(res.status).not.toBe(403);
    // Downstream stub returned its sentinel — proves the guard called through.
    expect(await res.text()).toBe(NEXTAUTH_PASSTHROUGH);

    // No CSRF-rejection audit row was written by the guard.
    const rows = await getDb().select().from(onboardingRedemptionLog);
    const csrfRejected = rows.filter((r) => r.outcome === 'rejected-csrf');
    expect(csrfRejected).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // TC-I-44 — Origin: null (sandboxed iframe / data: URI)
  // ---------------------------------------------------------------------------
  it('TC-I-44: /api/auth/signin with Origin: null returns 403', async () => {
    const res = await POST(makeSigninRequest({ origin: 'null' }));

    expect(res.status).toBe(403);

    const body = (await res.json()) as {
      error?: { message?: string; code?: string };
    };
    expect(body.error?.message).toBe('forbidden');
    expect(body.error?.code).toBe('null-origin');

    const rows = await getDb().select().from(onboardingRedemptionLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('rejected-csrf');
  });
});
