/**
 * Integration tests for `requestContext` wiring into the NextAuth route handler
 * (central-server-onboarding-v2-sso, TASK-11).
 *
 * Exercises:
 *   - `extractRequestContext` (exported from `route.ts`) as a pure helper.
 *   - The composed `csrfWrap` behavior: after CSRF passes, the inner handler
 *     runs inside `runInRequestContext(extractRequestContext(req), ...)` so a
 *     downstream callback (here, a stub) can read the current ctx via
 *     `getRequestContext()`.
 *   - ALS isolation across two concurrent requests (no bleed).
 *   - REQ-13a: a request whose `headers.get` throws does NOT 500; handler still
 *     runs with `{ip:'', userAgent:''}`; a warn fires once per process.
 *
 * --- Why a local re-implementation of `csrfWrap` ---
 *
 * Importing `route.ts` pulls `@/lib/auth/auth` (NextAuth v5), whose transitive
 * `import 'next/server'` (no `.js`) hits Node's strict ESM resolver before
 * vitest's bundler intercepts. The pattern below mirrors the production
 * wrapper while importing the SAME `extractRequestContext` source-of-truth
 * from `route.ts` (so the pure-function contract is tested end-to-end). See
 * `tests/integration/sso-auto-provision-csrf.test.ts` (top-of-file block)
 * for the well-documented constraint and `tests/integration/drilldown-notification.test.ts`
 * TC-I-17 `it.skip` for the upgrade path.
 *
 * TC mapping:
 *   - TC-I-32  — happy path; wrapped handler reads non-empty ctx from headers.
 *   - TC-I-32b — security; two concurrent requests with distinct IPs each see
 *                only their own ctx (ALS isolation invariant).
 *   - TC-I-33  — edge; `getRequestContext()` outside any scope returns defaults.
 *   - TC-I-41  — infra; no `x-forwarded-for` AND no `x-real-ip` → `ip:''`.
 *   - TC-I-41b — infra; `headers.get` throws → handler still runs with defaults,
 *                returns 200; warn fires once.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import {
  getRequestContext,
  runInRequestContext,
  type RequestContext,
} from '@/lib/auth/request-context';
import {
  __resetWarnedForExtractionFailure,
  extractRequestContext,
} from '@/app/api/auth/[...nextauth]/request-context-extract';
import { log as logger } from '@root/logger';

// ---------------------------------------------------------------------------
// XFF trust gate (review M1): `getTrustedClientIp` only honors `x-forwarded-for`
// when `TOKENFX_TRUSTED_PROXY=1`. The contract under test here — XFF first-hop
// → ctx.ip — describes the trusted-proxy branch, so we opt in for the file.
// Untrusted-default behavior is covered by the dedicated `ip-trust.test.ts`.
// ---------------------------------------------------------------------------
const mutableEnv = process.env as Record<string, string | undefined>;
let trustedProxySnapshot: string | undefined;

beforeAll(() => {
  trustedProxySnapshot = process.env.TOKENFX_TRUSTED_PROXY;
  mutableEnv.TOKENFX_TRUSTED_PROXY = '1';
});

afterAll(() => {
  if (trustedProxySnapshot === undefined) {
    delete mutableEnv.TOKENFX_TRUSTED_PROXY;
  } else {
    mutableEnv.TOKENFX_TRUSTED_PROXY = trustedProxySnapshot;
  }
});

// ---------------------------------------------------------------------------
// Local re-implementation of route.ts::csrfWrap, structurally identical to
// the production wrapper. Importing `route.ts` directly pulls NextAuth which
// fails ESM resolution under vitest. The `extractRequestContext` helper IS
// imported from route.ts (the source of truth under test).
// ---------------------------------------------------------------------------
type Handler = (request: NextRequest) => Promise<Response> | Response;

const csrfWrap = (handler: Handler): Handler => {
  return async (request: NextRequest) => {
    // The CSRF Origin check is exercised separately in
    // `sso-auto-provision-csrf.test.ts`. This test focuses on the ALS wiring
    // that happens AFTER the CSRF gate, so we skip the origin guard and only
    // mirror the `runInRequestContext` wrapping introduced by TASK-11.
    return runInRequestContext(extractRequestContext(request), () =>
      handler(request),
    );
  };
};

const BASE_URL = 'http://localhost/api/auth/signin/google';

const makeRequest = (headers: Record<string, string>): NextRequest =>
  new Request(BASE_URL, {
    method: 'POST',
    headers,
    body: 'csrfToken=stub',
  }) as unknown as NextRequest;

describe('extractRequestContext (pure helper)', () => {
  beforeEach(() => {
    __resetWarnedForExtractionFailure();
  });

  it('populates context from x-forwarded-for and user-agent', () => {
    const req = makeRequest({
      'x-forwarded-for': '192.0.2.1',
      'user-agent': 'Mozilla',
    });
    expect(extractRequestContext(req)).toEqual({
      ip: '192.0.2.1',
      userAgent: 'Mozilla',
    });
  });

  it('takes the first hop of a multi-hop x-forwarded-for', () => {
    const req = makeRequest({
      'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1, 10.0.0.2',
      'user-agent': 'Hopper',
    });
    expect(extractRequestContext(req)).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Hopper',
    });
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = makeRequest({
      'x-real-ip': '198.51.100.9',
      'user-agent': 'RealIP',
    });
    expect(extractRequestContext(req)).toEqual({
      ip: '198.51.100.9',
      userAgent: 'RealIP',
    });
  });

  it('returns empty string ip when neither header is set (not undefined)', () => {
    const req = makeRequest({ 'user-agent': 'NoIp' });
    const ctx = extractRequestContext(req);
    expect(ctx.ip).toBe('');
    expect(ctx.userAgent).toBe('NoIp');
  });

  it('returns empty string userAgent when header is absent', () => {
    const req = makeRequest({ 'x-forwarded-for': '192.0.2.42' });
    const ctx = extractRequestContext(req);
    expect(ctx.ip).toBe('192.0.2.42');
    expect(ctx.userAgent).toBe('');
  });

  it('falls back to empty defaults when headers throw', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const throwingReq = {
      headers: {
        get: (): string | null => {
          throw new Error('boom');
        },
      },
    } as unknown as NextRequest;

    const ctx = extractRequestContext(throwingReq);
    expect(ctx).toEqual({ ip: '', userAgent: '' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Second invocation must NOT warn again (warn-once budget).
    const ctx2 = extractRequestContext(throwingReq);
    expect(ctx2).toEqual({ ip: '', userAgent: '' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe('csrfWrap → runInRequestContext wiring', () => {
  beforeEach(() => {
    __resetWarnedForExtractionFailure();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // TC-I-32 — happy path
  // -------------------------------------------------------------------------
  it('TC-I-32: wrapped handler reads ctx populated from request headers', async () => {
    const downstream: Handler = () => {
      const ctx = getRequestContext();
      return NextResponse.json(ctx);
    };
    const wrapped = csrfWrap(downstream);

    const res = await wrapped(
      makeRequest({
        'x-forwarded-for': '192.0.2.1',
        'user-agent': 'Mozilla',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RequestContext;
    expect(body).toEqual({ ip: '192.0.2.1', userAgent: 'Mozilla' });
  });

  // -------------------------------------------------------------------------
  // TC-I-32b — security / ALS isolation across concurrent requests
  // -------------------------------------------------------------------------
  it('TC-I-32b: isolates context across concurrent requests', async () => {
    const observed: Array<RequestContext> = [];
    // Force interleaving with awaited microtasks so a leaky implementation
    // (e.g. module-level mutable ctx) would visibly cross-contaminate.
    const downstream: Handler = async () => {
      await Promise.resolve();
      const ctx = getRequestContext();
      observed.push(ctx);
      await Promise.resolve();
      return NextResponse.json(ctx);
    };
    const wrapped = csrfWrap(downstream);

    const [resA, resB] = await Promise.all([
      wrapped(
        makeRequest({ 'x-forwarded-for': '10.0.0.1', 'user-agent': 'UA-A' }),
      ),
      wrapped(
        makeRequest({ 'x-forwarded-for': '10.0.0.2', 'user-agent': 'UA-B' }),
      ),
    ]);

    const bodyA = (await resA.json()) as RequestContext;
    const bodyB = (await resB.json()) as RequestContext;
    expect(bodyA).toEqual({ ip: '10.0.0.1', userAgent: 'UA-A' });
    expect(bodyB).toEqual({ ip: '10.0.0.2', userAgent: 'UA-B' });

    // Each handler observed only its own ctx. The order of `observed` may
    // vary by interleaving — set comparison covers both schedulings.
    expect(observed).toEqual(
      expect.arrayContaining([
        { ip: '10.0.0.1', userAgent: 'UA-A' },
        { ip: '10.0.0.2', userAgent: 'UA-B' },
      ]),
    );
    expect(observed).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // TC-I-33 — getRequestContext outside any scope returns defaults
  // -------------------------------------------------------------------------
  it('TC-I-33: getRequestContext() outside any csrfWrap invocation returns empty defaults', () => {
    // Simulates a Server Component / lib/queries path that runs without an
    // ALS scope established. Must not throw, must not leak from any earlier
    // request, must return the empty-sentinel.
    const ctx = getRequestContext();
    expect(ctx).toEqual({ ip: '', userAgent: '' });
  });

  // -------------------------------------------------------------------------
  // TC-I-41 — infra: ip is empty string (NOT undefined) when both headers absent
  // -------------------------------------------------------------------------
  it('TC-I-41: request with neither x-forwarded-for nor x-real-ip yields ip:"" in ctx', async () => {
    const downstream: Handler = () => NextResponse.json(getRequestContext());
    const wrapped = csrfWrap(downstream);

    const res = await wrapped(makeRequest({ 'user-agent': 'Headless' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RequestContext;
    expect(body.ip).toBe('');
    expect(body.ip).not.toBeUndefined();
    expect(body.userAgent).toBe('Headless');
  });

  // -------------------------------------------------------------------------
  // TC-I-41b — infra: headers.get throws → handler still runs, returns 200,
  //            warn fires once
  // -------------------------------------------------------------------------
  it('TC-I-41b: header iteration throw still runs handler with defaults; never 500s; warn once', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const downstream: Handler = () => {
      const ctx = getRequestContext();
      return NextResponse.json(ctx, { status: 200 });
    };
    const wrapped = csrfWrap(downstream);

    const throwingReq = {
      headers: {
        get: (): string | null => {
          throw new Error('boom-iteration');
        },
      },
      method: 'POST',
      url: BASE_URL,
    } as unknown as NextRequest;

    const res = await wrapped(throwingReq);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RequestContext;
    expect(body).toEqual({ ip: '', userAgent: '' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A second throwing request must not warn again (dedup by module flag).
    const res2 = await wrapped(throwingReq);
    expect(res2.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
