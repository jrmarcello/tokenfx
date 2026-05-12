/**
 * Unit tests for the team-roster CSV export route handler
 * (`GET /manager/teams/[id]/export`, REQ-10 / TASK-21).
 *
 * These tests exercise the auth + cross-org guard + filter coercion +
 * truncation cap surface using a hand-written stub for both `auth()`
 * (returns a `Session | null`) and `getTeamDetail()` (returns an
 * in-memory `TeamDetail` or `null`). Postgres-backed end-to-end
 * coverage lives in `tests/integration/team-roster-csv.test.ts`.
 *
 * The route is intentionally factored as a pure `exportTeamRosterImpl`
 * core that accepts `{ authFn, getTeamDetailFn }` deps, mirroring the
 * pattern used by `app/api/manager/dismiss-anomaly/route.ts`. This
 * keeps NextAuth + Drizzle out of vitest's module graph for the unit
 * suite.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import { NextRequest } from 'next/server';
import {
  exportTeamRosterImpl,
  type AuthFn,
  type GetTeamDetailFn,
} from './route';
import type { TeamDetail, TeamMember } from '@/lib/queries/teams';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const MANAGER_ID = '44444444-4444-4444-8444-444444444444';

const stubAuth =
  (session: Session | null): AuthFn =>
  async () => session;

const makeSession = (role: 'manager' | 'admin' | 'member'): Session => ({
  user: { id: MANAGER_ID, email: `${role}@x`, role, orgId: ORG_ID },
  expires: '2099-01-01',
});

const makeReq = (search = ''): NextRequest => {
  const url = `http://localhost/manager/teams/${TEAM_ID}/export${search}`;
  return new NextRequest(url);
};

const makeMember = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  userId: '55555555-5555-4555-8555-555555555555',
  email: 'alice@example.com',
  sessions30d: 0,
  spend30d: 0,
  provisionedVia: 'sso-auto',
  lastLoginAt: new Date('2026-04-01T12:00:00Z'),
  createdAt: new Date('2026-01-15T09:30:00Z'),
  ...overrides,
});

const detailWithMembers = (members: TeamMember[]): TeamDetail => ({
  teamId: TEAM_ID,
  teamName: 'Engineering',
  spendTrend30d: [],
  dau30d: [],
  members,
  topProjects: [],
});

const stubGetTeamDetail =
  (result: TeamDetail | null, capture?: { calls: unknown[] }): GetTeamDetailFn =>
  async (_db, teamId, orgId, options) => {
    if (capture) {
      capture.calls.push({ teamId, orgId, options });
    }
    return result;
  };

const callRoute = async (
  request: NextRequest,
  deps: { authFn: AuthFn; getTeamDetailFn: GetTeamDetailFn },
): Promise<Response> => {
  return exportTeamRosterImpl(request, { params: { id: TEAM_ID } }, deps);
};

describe('GET /manager/teams/[id]/export — route handler', () => {
  it('returns 403 for a member-role session', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('member')),
      getTeamDetailFn: stubGetTeamDetail(detailWithMembers([makeMember()])),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a null session', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(null),
      getTeamDetailFn: stubGetTeamDetail(detailWithMembers([makeMember()])),
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 when getTeamDetail returns null (cross-org or unknown team)', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(null),
    });
    expect(res.status).toBe(404);
  });

  it('exports roster as CSV for authenticated manager', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([
          makeMember({
            email: 'alice@example.com',
            provisionedVia: 'sso-auto',
            createdAt: new Date('2026-01-15T09:30:00Z'),
            lastLoginAt: new Date('2026-04-01T12:00:00Z'),
          }),
        ]),
      ),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`^attachment; filename="team-${TEAM_ID}-roster-\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
    );
    const body = await res.text();
    const lines = body.split('\r\n');
    expect(lines[0]).toBe('email_hash_prefix,provisioned_via,created_at,last_login_at');
    // Header row + one data row + trailing empty line from final CRLF.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
  });

  it('also allows admin role', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('admin')),
      getTeamDetailFn: stubGetTeamDetail(detailWithMembers([makeMember()])),
    });
    expect(res.status).toBe(200);
  });

  it('omits last_login_at when user has never logged in (NULL → empty cell)', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([
          makeMember({
            email: 'never@example.com',
            lastLoginAt: null,
            provisionedVia: 'manual-token',
            createdAt: new Date('2026-02-01T00:00:00Z'),
          }),
        ]),
      ),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const dataRow = body.split('\r\n')[1];
    const cells = dataRow.split(',');
    expect(cells).toHaveLength(4);
    // last_login_at is the 4th column; serialized as empty string, NOT 'null'.
    expect(cells[3]).toBe('');
    expect(body).not.toContain('null');
  });

  it('never contains plaintext email addresses', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([
          makeMember({ email: 'alice@example.com' }),
          makeMember({ email: 'bob@example.com', userId: 'u-2' }),
        ]),
      ),
    });
    const body = await res.text();
    expect(body).not.toContain('alice@example.com');
    expect(body).not.toContain('bob@example.com');
    expect(body).not.toContain('@example.com');
    expect(body).not.toContain('@');
  });

  it('emits one data row per team member with hash prefix in column 1', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([
          makeMember({ email: 'alice@example.com', userId: 'u-1' }),
          makeMember({ email: 'bob@example.com', userId: 'u-2' }),
          makeMember({ email: 'charlie@example.com', userId: 'u-3' }),
        ]),
      ),
    });
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // Header + 3 data rows.
    expect(lines).toHaveLength(4);
    for (let i = 1; i < lines.length; i += 1) {
      const cells = lines[i].split(',');
      expect(cells).toHaveLength(4);
      // hash prefix: exactly 8 lowercase hex chars.
      expect(cells[0]).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('coerces ?provisioned_via=sso-auto and passes it through to the query', async () => {
    const capture = { calls: [] as Array<{ options?: { provisionedVia?: string } }> };
    const res = await callRoute(makeReq('?provisioned_via=sso-auto'), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([makeMember()]),
        capture as { calls: unknown[] },
      ),
    });
    expect(res.status).toBe(200);
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].options?.provisionedVia).toBe('sso-auto');
  });

  it('coerces ?provisioned_via=token to the typed enum', async () => {
    const capture = { calls: [] as Array<{ options?: { provisionedVia?: string } }> };
    await callRoute(makeReq('?provisioned_via=token'), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([]),
        capture as { calls: unknown[] },
      ),
    });
    expect(capture.calls[0].options?.provisionedVia).toBe('token');
  });

  it('defaults to all when ?provisioned_via is missing', async () => {
    const capture = { calls: [] as Array<{ options?: { provisionedVia?: string } }> };
    await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([]),
        capture as { calls: unknown[] },
      ),
    });
    expect(capture.calls[0].options?.provisionedVia).toBe('all');
  });

  it('defaults to all when ?provisioned_via is an unknown value (Zod safe default)', async () => {
    const capture = { calls: [] as Array<{ options?: { provisionedVia?: string } }> };
    await callRoute(makeReq('?provisioned_via=xss'), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([]),
        capture as { calls: unknown[] },
      ),
    });
    expect(capture.calls[0].options?.provisionedVia).toBe('all');
  });

  it('sets X-TokenFx-Truncated: false when row count is under the 10,000 cap', async () => {
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(detailWithMembers([makeMember()])),
    });
    expect(res.headers.get('X-TokenFx-Truncated')).toBe('false');
  });

  it('sets X-TokenFx-Truncated: true and emits exactly 10,000 data rows when over cap', async () => {
    // Build 10,001 distinct members to exercise the cap.
    const many: TeamMember[] = Array.from({ length: 10_001 }, (_, i) =>
      makeMember({
        userId: `u-${i}`,
        email: `user${i}@example.com`,
      }),
    );
    const res = await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(detailWithMembers(many)),
    });
    expect(res.headers.get('X-TokenFx-Truncated')).toBe('true');
    const body = await res.text();
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    // header + 10,000 data rows = 10,001 non-empty lines.
    expect(lines).toHaveLength(10_001);
  });

  it('passes the team orgId from the session to getTeamDetail (tenant scoping)', async () => {
    const capture = { calls: [] as Array<{ orgId?: string }> };
    await callRoute(makeReq(), {
      authFn: stubAuth(makeSession('manager')),
      getTeamDetailFn: stubGetTeamDetail(
        detailWithMembers([]),
        capture as { calls: unknown[] },
      ),
    });
    expect(capture.calls[0].orgId).toBe(ORG_ID);
    expect(capture.calls[0].orgId).not.toBe(OTHER_ORG_ID);
  });
});
