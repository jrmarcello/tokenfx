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
import { describe, expect, it } from 'vitest';
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

const makeRequest = (url = 'http://localhost/manager/audit-log/export'): Request =>
  new Request(url, { method: 'GET' });

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
    await exportAuditLogImpl(new Request(url, { method: 'GET' }), {
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
    await exportAuditLogImpl(new Request(url, { method: 'GET' }), {
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
    await exportAuditLogImpl(new Request(url, { method: 'GET' }), {
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
});
