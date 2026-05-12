/**
 * Integration tests for `GET /manager/audit-log/export` (TASK-19, REQ-6).
 *
 * Postgres-backed via the shared Testcontainers setup (`setup-pg.ts`). The
 * route handler is exercised through its dependency-injected `exportAuditLogImpl`
 * so we don't have to spin up NextAuth. The `loadAuditLogPageFn` is the real
 * `loadAuditLogPage` query (TASK-6) hitting the live container — only `authFn`
 * is stubbed.
 *
 * TC mapping:
 *   - TC-I-42  (infra): with 10,000 seeded rows the response body has 10,000
 *                      data rows; the X-TokenFx-Truncated header is NOT set
 *                      (totalCount == cap, not exceeded)
 *   - TC-I-42b (edge):  with 10,001 seeded rows the response body has 10,000
 *                      data rows + X-TokenFx-Truncated: true
 *   - TC-I-17/18/19  : light cross-check that real DB rows flow through the
 *                      CSV framing identically to the unit suite (covers the
 *                      JOIN + email_hash_prefix projection end-to-end).
 *
 * Conventions: hand-written stubs (no mocking framework), natural-English
 * `it()` names, suite-level seed via bulk insert (10k rows via individual
 * `seedAuthEvent` would take >30s — we chunk-insert directly).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';
import type { Session } from 'next-auth';

import { closeDb, getDb } from '@/lib/db/client';
import { authEventLog, orgs, users } from '@/lib/db/schema';
import { hashEmail } from '@/lib/auth/email-hash';
import { loadAuditLogPage } from '@/lib/queries/audit-log';
import {
  exportAuditLogImpl,
  type AuthFn,
} from '@/app/manager/audit-log/export/route';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const TEST_PEPPER = 'tokenfx-audit-log-csv-test-pepper';

const stubAuth = (session: Session | null): AuthFn => async () => session;

const makeSession = (orgId: string): Session => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'mgr@x',
    role: 'manager',
    orgId,
  },
  expires: '2099-01-01',
});

const truncateAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    auth_event_log, onboarding_redemption_log, onboarding_audit_log,
    onboarding_invites, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const seedOrg = async (name: string): Promise<string> => {
  const db = getDb();
  const [row] = await db
    .insert(orgs)
    .values({ name })
    .returning({ id: orgs.id });
  return row.id;
};

const seedUser = async (orgId: string, email: string): Promise<void> => {
  const db = getDb();
  await db.insert(users).values({
    orgId,
    email,
    role: 'member',
  });
};

const seedManyAuthEvents = async (
  email: string,
  count: number,
): Promise<void> => {
  const db = getDb();
  const emailHash = hashEmail(email);
  const base = Date.UTC(2025, 0, 1, 0, 0, 0);
  const CHUNK = 5_000;
  const rows: Array<{
    ssoProvider: string;
    iss: string;
    emailHash: string;
    ssoSubjectHash: string | null;
    ip: string | null;
    city: string | null;
    userAgent: string | null;
    outcome: 'accepted-sso-auto';
    occurredAt: Date;
  }> = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      ssoProvider: 'google',
      iss: 'https://accounts.google.com',
      emailHash,
      ssoSubjectHash: null,
      ip: '203.0.113.7',
      city: 'São Paulo',
      userAgent: 'Mozilla/5.0',
      outcome: 'accepted-sso-auto',
      occurredAt: new Date(base + i * 1000),
    });
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(authEventLog).values(rows.slice(i, i + CHUNK));
  }
};

const makeRequest = (): Request =>
  new Request('http://localhost/manager/audit-log/export', {
    method: 'GET',
    // CSRF-on-GET guard requires sec-fetch-site=same-origin (or `none`) for
    // a legitimate request. See `.specs/fix-sso-csv-export-csrf.md`.
    headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
  });

skipDescribe('GET /manager/audit-log/export (Postgres integration)', () => {
  beforeAll(async () => {
    process.env.ONBOARDING_EMAIL_HASH_PEPPER = TEST_PEPPER;
    getDb();
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    await truncateAll();
  });

  // ---------------------------------------------------------------------------
  // TC-I-42 — 10k rows: cap reached but NOT exceeded → no truncation header
  // ---------------------------------------------------------------------------
  it('TC-I-42: with exactly 10000 seeded rows the response body has 10000 data rows and no X-TokenFx-Truncated header', async () => {
    const orgId = await seedOrg('Org10k');
    await seedUser(orgId, 'dev@example.com');
    await seedManyAuthEvents('dev@example.com', 10_000);

    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession(orgId)),
      loadAuditLogPageFn: (db, oid, filters, page, pageSize) =>
        loadAuditLogPage(db, oid, filters, page, pageSize),
    });
    expect(res.status).toBe(200);
    // Header MUST NOT be present when totalCount === cap.
    expect(res.headers.get('x-tokenfx-truncated')).toBeNull();

    const body = await res.text();
    const lines = body.split('\r\n');
    // 1 header + 10000 data + 1 trailing empty (every row terminated by CRLF)
    expect(lines.length).toBe(10_002);
    expect(lines[0]).toBe(
      'timestamp,outcome,email_hash_prefix,iss,city,browser,decision_reason',
    );
    expect(lines[lines.length - 1]).toBe('');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // TC-I-42b — 10,001 rows: cap exceeded → truncation header + 10k data rows
  // ---------------------------------------------------------------------------
  it('TC-I-42b: with 10001 seeded rows the response body has exactly 10000 data rows and X-TokenFx-Truncated: true', async () => {
    const orgId = await seedOrg('Org10k1');
    await seedUser(orgId, 'dev@example.com');
    await seedManyAuthEvents('dev@example.com', 10_001);

    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession(orgId)),
      loadAuditLogPageFn: (db, oid, filters, page, pageSize) =>
        loadAuditLogPage(db, oid, filters, page, pageSize),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tokenfx-truncated')).toBe('true');

    const body = await res.text();
    const lines = body.split('\r\n');
    // 1 header + 10000 data + 1 trailing empty
    expect(lines.length).toBe(10_002);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // TC-I-17/18 cross-check — real DB rows flow through CSV framing
  // ---------------------------------------------------------------------------
  it('TC-I-17/18 cross-check: real DB rows produce header row + N data rows with the expected columns', async () => {
    const orgId = await seedOrg('OrgSmall');
    await seedUser(orgId, 'dev@example.com');
    await seedManyAuthEvents('dev@example.com', 3);

    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession(orgId)),
      loadAuditLogPageFn: (db, oid, filters, page, pageSize) =>
        loadAuditLogPage(db, oid, filters, page, pageSize),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);

    const body = await res.text();
    const lines = body.split('\r\n');
    // 1 header + 3 data + 1 trailing empty
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      'timestamp,outcome,email_hash_prefix,iss,city,browser,decision_reason',
    );

    // Each data row must carry the 8-char email_hash prefix, never the
    // plaintext. The hash for `dev@example.com` under the suite pepper is
    // deterministic.
    const expectedPrefix = hashEmail('dev@example.com').slice(0, 8);
    for (let i = 1; i <= 3; i += 1) {
      expect(lines[i]).toContain(expectedPrefix);
      // Privacy guard: plaintext email must NEVER appear in any row.
      expect(lines[i]).not.toContain('dev@example.com');
    }
  });

  // ---------------------------------------------------------------------------
  // TC-I-19 cross-check — formula-injection guard applied to real data
  // ---------------------------------------------------------------------------
  it("TC-I-19 cross-check: a stored iss starting with '=' is prefixed with apostrophe in the CSV", async () => {
    const db = getDb();
    const orgId = await seedOrg('OrgFormula');
    await seedUser(orgId, 'dev@example.com');
    const emailHash = hashEmail('dev@example.com');
    // Insert one event with a malicious `iss` value — simulates a forged
    // upstream OIDC issuer claim that landed in the log before any
    // application-layer sanitization.
    await db.insert(authEventLog).values({
      ssoProvider: 'google',
      iss: `=cmd|'/c calc'!A0`,
      emailHash,
      ssoSubjectHash: null,
      ip: '203.0.113.7',
      city: 'São Paulo',
      userAgent: 'Mozilla/5.0',
      outcome: 'accepted-sso-auto',
    });

    const res = await exportAuditLogImpl(makeRequest(), {
      authFn: stubAuth(makeSession(orgId)),
      loadAuditLogPageFn: (xdb, oid, filters, page, pageSize) =>
        loadAuditLogPage(xdb, oid, filters, page, pageSize),
    });
    const body = await res.text();
    // Per `toCsvRow` quoting rules (`,`, `"`, CR, LF only), the cell is
    // emitted raw with the OWASP `'` prefix applied — no surrounding `"`.
    expect(body).toContain(`'=cmd|'/c calc'!A0`);
    // Defense in depth: the un-guarded payload must never appear at a
    // cell boundary (start-of-row or after a `,`).
    expect(body).not.toMatch(/(^|,)=cmd\|'\/c calc'!A0/);
  });
});
