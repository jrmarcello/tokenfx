/**
 * Unit tests for `GET /manager/audit-log/export` (TASK-19, REQ-6).
 *
 * Strategy: drive the route handler with an injected `authFn` stub + a
 * stub `loadAuditLogPageFn` so the auth/role gate, header shaping, and
 * CSV body framing can be exercised WITHOUT spinning up Postgres or
 * NextAuth. Postgres-backed end-to-end coverage (cap honored, X-TokenFx-
 * Truncated header against 10,001 real rows, formula-injection guard
 * applied to seeded data) lives in `tests/integration/audit-log-csv.test.ts`.
 *
 * Conventions: hand-written stubs only (no mocking framework), natural-
 * English `it()` names, TC-IDs annotated in comments for spec traceability.
 *
 * TC mapping (subset — full coverage spans both this file and the
 * integration test sibling):
 *   - TC-I-17   (happy): Content-Type/Content-Disposition headers correct
 *   - TC-I-18   (happy): CSV body has header row + N data rows w/ CRLF
 *   - TC-I-19   (security): cell starting with `=` → prefixed with `'`
 *   - Auth:     member-role → 403; unauthenticated → 401
 */
import { describe, expect, it, vi } from 'vitest';
import { log as logger } from '@tokenfx/shared/logger';
import type { Session } from 'next-auth';

import { exportAuditLogImpl, type AuthFn, type LoadAuditLogPageFn } from './route';
import type { AuditLogPage, AuditLogRow } from '@/lib/queries/audit-log';

const stubAuth = (session: Session | null): AuthFn => async () => session;

const stubLoader = (page: AuditLogPage): LoadAuditLogPageFn => async () => page;

const makeSession = (
  role: 'manager' | 'admin' | 'member',
  userId: string,
  orgId: string,
): Session => ({
  user: { id: userId, email: `${role}@x`, role, orgId },
  expires: '2099-01-01',
});

/**
 * Default-injects `sec-fetch-site: 'same-origin'` so the CSRF-on-GET guard
 * (added by `.specs/fix-sso-csv-export-csrf.md`) is satisfied for every
 * existing TC without rewriting them. CSRF-specific tests pass explicit
 * `headerOverrides` to exercise the reject paths.
 */
const makeRequest = (
  url = 'http://localhost/manager/audit-log/export',
  headerOverrides: Record<string, string> = {},
): Request =>
  new Request(url, {
    method: 'GET',
    headers: new Headers({ 'sec-fetch-site': 'same-origin', ...headerOverrides }),
  });

/**
 * Builds a Request with NO Sec-Fetch-Site header (and only the headers the
 * caller specifies). Used by CSRF tests that exercise the Origin/Referer
 * fallback path or the missing-origin path.
 */
const makeRequestNoFetchSite = (
  headers: Record<string, string> = {},
): Request =>
  new Request('http://localhost/manager/audit-log/export', {
    method: 'GET',
    headers: new Headers(headers),
  });

const makeRow = (overrides: Partial<AuditLogRow> = {}): AuditLogRow => ({
  occurredAt: new Date('2025-04-01T12:34:56Z'),
  outcome: 'accepted-sso-auto',
  emailHashPrefix: 'abcd1234',
  iss: 'https://accounts.google.com',
  city: 'São Paulo',
  browser: 'Mozilla/5.0',
  decisionReason: null,
  ...overrides,
});

describe('GET /manager/audit-log/export', () => {
  // ---------------------------------------------------------------------------
  // Auth gating
  // ---------------------------------------------------------------------------
  it('returns 401 when there is no session', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(null),
      loadAuditLogPageFn: stubLoader({
        rows: [],
        totalCount: 0,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session role is member (only manager|admin allowed)', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('member', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [],
        totalCount: 0,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.status).toBe(403);
  });

  it('allows admin role through (manager OR admin)', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('admin', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow()],
        totalCount: 1,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // TC-I-17 — Content-Type + Content-Disposition headers
  // ---------------------------------------------------------------------------
  it('TC-I-17 happy: sets Content-Type text/csv and Content-Disposition attachment for authenticated manager', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow()],
        totalCount: 1,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const disp = res.headers.get('content-disposition');
    expect(disp).toMatch(/^attachment;/);
    expect(disp).toMatch(/audit-log-org-1-/);
    expect(disp).toMatch(/\.csv"$/);
  });

  // ---------------------------------------------------------------------------
  // TC-I-18 — CSV header row + data rows with CRLF
  // ---------------------------------------------------------------------------
  it('TC-I-18 happy: CSV body starts with the canonical header row terminated by CRLF', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow(), makeRow({ outcome: 'rejected-csrf' })],
        totalCount: 2,
        page: 0,
        pageSize: 10_000,
      }),
    });
    const body = await res.text();
    const lines = body.split('\r\n');
    expect(lines[0]).toBe(
      'timestamp,outcome,email_hash_prefix,iss,city,browser,decision_reason',
    );
    // 1 header + 2 data + trailing empty (toCsvRow appends \r\n to every row)
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    // Data rows contain the seeded values verbatim (no special chars here).
    expect(lines[1]).toContain('accepted-sso-auto');
    expect(lines[2]).toContain('rejected-csrf');
  });

  it('TC-I-18b happy: every row ends with CRLF (no LF-only line endings)', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow()],
        totalCount: 1,
        page: 0,
        pageSize: 10_000,
      }),
    });
    const body = await res.text();
    // No lone LFs (every \n must be preceded by \r)
    const loneLf = /(?<!\r)\n/.test(body);
    expect(loneLf).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // TC-I-19 — Formula-injection guard
  // ---------------------------------------------------------------------------
  it("TC-I-19 security: a cell value starting with '=' is prefixed with apostrophe via toCsvRow", async () => {
    const malicious = `=cmd|'/c calc'!A0`;
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow({ iss: malicious })],
        totalCount: 1,
        page: 0,
        pageSize: 10_000,
      }),
    });
    const body = await res.text();
    // The cell is prefixed with `'` (OWASP formula-injection guard).
    // `toCsvRow` only wraps cells in `"..."` when they contain `,`, `"`,
    // CR, or LF — `'` and `=` alone don't trigger quoting, so the cell is
    // emitted raw with the apostrophe prefix.
    expect(body).toContain(`'=cmd|'/c calc'!A0`);
    // Sanity: the raw `=cmd...` form (no leading apostrophe) MUST NOT
    // appear anywhere — that would be the un-guarded payload.
    expect(body).not.toMatch(/(^|,)=cmd\|'\/c calc'!A0/);
  });

  it("TC-I-19b security: cells starting with '+', '-', '@', tab, CR are also guarded", async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [
          makeRow({ iss: '+1234' }),
          makeRow({ iss: '-2345' }),
          makeRow({ iss: '@SUM(A1)' }),
        ],
        totalCount: 3,
        page: 0,
        pageSize: 10_000,
      }),
    });
    const body = await res.text();
    expect(body).toContain(`'+1234`);
    expect(body).toContain(`'-2345`);
    expect(body).toContain(`'@SUM(A1)`);
  });

  // ---------------------------------------------------------------------------
  // X-TokenFx-Truncated header
  // ---------------------------------------------------------------------------
  it('omits X-TokenFx-Truncated header when totalCount equals the cap (not exceeded)', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow()],
        totalCount: 10_000,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.status).toBe(200);
    // Header MUST NOT be present when totalCount <= cap.
    expect(res.headers.get('x-tokenfx-truncated')).toBeNull();
  });

  it('sets X-TokenFx-Truncated: true when totalCount exceeds the 10,000 cap', async () => {
    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: stubLoader({
        rows: [makeRow()],
        totalCount: 10_001,
        page: 0,
        pageSize: 10_000,
      }),
    });
    expect(res.headers.get('x-tokenfx-truncated')).toBe('true');
  });

  // ---------------------------------------------------------------------------
  // Zod parsing of searchParams
  // ---------------------------------------------------------------------------
  it('passes Zod-parsed filters from searchParams into the loader (outcome + iss + city + browser)', async () => {
    let capturedFilters: unknown = null;
    const loader: LoadAuditLogPageFn = async (...args) => {
      capturedFilters = args[2];
      return { rows: [], totalCount: 0, page: 0, pageSize: 10_000 };
    };
    const url =
      'http://localhost/manager/audit-log/export' +
      '?outcome=accepted-sso-auto' +
      '&iss=https%3A%2F%2Faccounts.google.com' +
      '&city=Sao%20Paulo' +
      '&browser=Mozilla';
    await exportAuditLogImpl(makeRequest(url), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: loader,
    });
    expect(capturedFilters).toEqual({
      outcome: 'accepted-sso-auto',
      iss: 'https://accounts.google.com',
      city: 'Sao Paulo',
      browser: 'Mozilla',
      from: undefined,
      to: undefined,
    });
  });

  it('parses from/to ISO-8601 strings into Date objects for the loader', async () => {
    const capture: { value: { from?: Date; to?: Date } | null } = { value: null };
    const loader: LoadAuditLogPageFn = async (...args) => {
      capture.value = args[2] as { from?: Date; to?: Date };
      return { rows: [], totalCount: 0, page: 0, pageSize: 10_000 };
    };
    const url =
      'http://localhost/manager/audit-log/export' +
      '?from=2025-01-01T00%3A00%3A00.000Z' +
      '&to=2025-02-01T00%3A00%3A00.000Z';
    await exportAuditLogImpl(makeRequest(url), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: loader,
    });
    expect(capture.value?.from).toBeInstanceOf(Date);
    expect(capture.value?.to).toBeInstanceOf(Date);
    expect(capture.value?.from?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(capture.value?.to?.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  it('falls back to safe defaults when searchParams contain invalid values', async () => {
    let capturedFilters: unknown = null;
    const loader: LoadAuditLogPageFn = async (...args) => {
      capturedFilters = args[2];
      return { rows: [], totalCount: 0, page: 0, pageSize: 10_000 };
    };
    const url =
      'http://localhost/manager/audit-log/export' +
      '?outcome=not-a-real-outcome' +
      '&from=not-a-date';
    await exportAuditLogImpl(makeRequest(url), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: loader,
    });
    expect(capturedFilters).toEqual({
      outcome: undefined,
      iss: undefined,
      city: undefined,
      browser: undefined,
      from: undefined,
      to: undefined,
    });
  });

  // ---------------------------------------------------------------------------
  // Loader is invoked with pageSize=10_000 (the cap), page=0
  // ---------------------------------------------------------------------------
  it('invokes loadAuditLogPage with page=0 and pageSize=10000 (the cap)', async () => {
    let capturedPage: number | null = null;
    let capturedPageSize: number | null = null;
    const loader: LoadAuditLogPageFn = async (
      _db,
      _orgId,
      _filters,
      page,
      pageSize,
    ) => {
      capturedPage = page;
      capturedPageSize = pageSize ?? null;
      return { rows: [], totalCount: 0, page, pageSize: pageSize ?? 10_000 };
    };
    await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
      loadAuditLogPageFn: loader,
    });
    expect(capturedPage).toBe(0);
    expect(capturedPageSize).toBe(10_000);
  });

  // ---------------------------------------------------------------------------
  // CSRF-on-GET guard (fix-sso-csv-export-csrf — TC-I-01..04, TC-I-07a, TC-I-08, TC-I-10, TC-I-11)
  //
  // The guard fires BEFORE authFn. To prove auth was never invoked, the tests
  // pass an authFn stub that throws — if the guard regresses and auth runs,
  // the test fails loudly.
  // ---------------------------------------------------------------------------
  describe('CSRF-on-GET guard', () => {
    const failingAuth: AuthFn = async () => {
      throw new Error('auth() must not be called when guard rejects');
    };

    it('returns 200 for same-origin requests with valid session (TC-I-01)', async () => {
      // The default makeRequest() injects sec-fetch-site: same-origin.
      const res = await exportAuditLogImpl(makeRequest(), {
        authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
        loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    });

    it('rejects sec-fetch-site=cross-site with 403 before invoking auth (TC-I-02, REQ-6)', async () => {
      const res = await exportAuditLogImpl(
        makeRequest(undefined, { 'sec-fetch-site': 'cross-site' }),
        {
          authFn: failingAuth,
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        },
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toBe('application/json');
      const body = (await res.json()) as { error: { message: string; code: string } };
      expect(body.error.code).toBe('cross-site');
      expect(body.error.message).toBe('cross-origin request blocked');
    });

    it('rejects sec-fetch-site=same-site with 403 and code same-site-rejected (TC-I-03)', async () => {
      const res = await exportAuditLogImpl(
        makeRequest(undefined, { 'sec-fetch-site': 'same-site' }),
        {
          authFn: failingAuth,
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('same-site-rejected');
    });

    it('rejects when no Sec-Fetch-Site, no Origin, no Referer (TC-I-04)', async () => {
      // Also verifies the log payload uses the `<missing>` sentinel — not
      // `null` — when the Sec-Fetch-Site header is absent.
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* swallow */
      });
      try {
        const res = await exportAuditLogImpl(makeRequestNoFetchSite({}), {
          authFn: failingAuth,
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('missing-origin');
        // Sentinel assertion: `sec_fetch_site` is the literal '<missing>',
        // never the JS `null` value.
        const [, payload] = spy.mock.calls[0];
        expect((payload as { sec_fetch_site: unknown }).sec_fetch_site).toBe('<missing>');
      } finally {
        spy.mockRestore();
      }
    });

    it('accepts sec-fetch-site=none (typed URL or bookmark) (TC-I-08)', async () => {
      const res = await exportAuditLogImpl(
        makeRequest(undefined, { 'sec-fetch-site': 'none' }),
        {
          authFn: stubAuth(makeSession('manager', 'u-1', 'org-1')),
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        },
      );
      expect(res.status).toBe(200);
    });

    it('rejects when Sec-Fetch-Site is absent and Origin is a different origin (TC-I-10)', async () => {
      const res = await exportAuditLogImpl(
        makeRequestNoFetchSite({ origin: 'https://evil.example.com' }),
        {
          authFn: failingAuth,
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('cross-origin');
    });

    it('rejects when Sec-Fetch-Site is absent and Origin is the literal string "null" (TC-I-11)', async () => {
      const res = await exportAuditLogImpl(
        makeRequestNoFetchSite({ origin: 'null' }),
        {
          authFn: failingAuth,
          loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('null-origin');
    });

    it('never leaks Origin or Referer header values in the warn log (TC-I-07a privacy)', async () => {
      // Privacy invariant: the structured payload contains ONLY
      // {route, reason, sec_fetch_site}. `vi.spyOn` on the logger module
      // patches the live binding — restored in `finally` to avoid cross-test
      // contamination.
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* swallow */
      });
      try {
        const sensitiveOrigin = 'https://leak.example.com';
        const sensitiveReferer = 'https://leak.example.com/secret-path';
        await exportAuditLogImpl(
          makeRequestNoFetchSite({ origin: sensitiveOrigin, referer: sensitiveReferer }),
          {
            authFn: failingAuth,
            loadAuditLogPageFn: stubLoader({ rows: [], totalCount: 0, page: 0, pageSize: 10_000 }),
          },
        );
        expect(spy).toHaveBeenCalledOnce();
        const [, payload] = spy.mock.calls[0];
        // Structural shape: only the 3 documented keys.
        expect(payload).toEqual({
          route: '/manager/audit-log/export',
          reason: 'cross-origin',
          sec_fetch_site: '<missing>',
        });
        // Belt-and-suspenders: the serialized call args do not contain the
        // sensitive values anywhere (catches accidental spread/spillage).
        const serialized = JSON.stringify(spy.mock.calls);
        expect(serialized).not.toContain(sensitiveOrigin);
        expect(serialized).not.toContain(sensitiveReferer);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
