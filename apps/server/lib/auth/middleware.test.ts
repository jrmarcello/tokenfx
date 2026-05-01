import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { requireRole, type AuthFn } from './middleware';
import type { Role } from './auth';

/**
 * Hand-written stub for the `auth()` function — no mocking framework. Each
 * test injects its own session shape via the `requireRole(req, allowed, auth)`
 * dependency-injection seam.
 */
const stubAuth = (session: Session | null): AuthFn => async () => session;

const fakeReq = (path: string): NextRequest => {
  const url = `http://localhost${path}`;
  // Cast: NextRequest's type surface is large but `requireRole` only reads
  // `req.url` to construct the redirect URL.
  return { url, nextUrl: new URL(url) } as unknown as NextRequest;
};

describe('requireRole', () => {
  it.each<{
    name: string;
    session: Session | null;
    allowed: ReadonlyArray<Role>;
    expectedStatus: number | null;
    expectsRedirect: boolean;
  }>([
    {
      name: 'redirects to /api/auth/signin when no session',
      session: null,
      allowed: ['manager', 'admin'],
      expectedStatus: 307,
      expectsRedirect: true,
    },
    {
      name: 'redirects to /api/auth/signin when session has no user',
      session: { expires: '2099-01-01' } as Session,
      allowed: ['manager', 'admin'],
      expectedStatus: 307,
      expectsRedirect: true,
    },
    {
      name: 'returns 403 when role is member and only manager allowed',
      session: {
        user: { email: 'm@x', role: 'member', orgId: 'o1' },
        expires: '2099-01-01',
      } as Session,
      allowed: ['manager', 'admin'],
      expectedStatus: 403,
      expectsRedirect: false,
    },
    {
      name: 'returns 403 when role is manager but admin required',
      session: {
        user: { email: 'm@x', role: 'manager', orgId: 'o1' },
        expires: '2099-01-01',
      } as Session,
      allowed: ['admin'],
      expectedStatus: 403,
      expectsRedirect: false,
    },
    {
      name: 'returns 403 when role is undefined (DB enrichment failed)',
      session: {
        user: { email: 'm@x', orgId: 'o1' },
        expires: '2099-01-01',
      } as Session,
      allowed: ['manager', 'admin'],
      expectedStatus: 403,
      expectsRedirect: false,
    },
    {
      name: 'passes through (returns null) when role matches manager',
      session: {
        user: { email: 'm@x', role: 'manager', orgId: 'o1' },
        expires: '2099-01-01',
      } as Session,
      allowed: ['manager', 'admin'],
      expectedStatus: null,
      expectsRedirect: false,
    },
    {
      name: 'passes through (returns null) when role matches admin',
      session: {
        user: { email: 'a@x', role: 'admin', orgId: 'o1' },
        expires: '2099-01-01',
      } as Session,
      allowed: ['admin'],
      expectedStatus: null,
      expectsRedirect: false,
    },
  ])('$name', async ({ session, allowed, expectedStatus, expectsRedirect }) => {
    const res = await requireRole(fakeReq('/manager'), allowed, stubAuth(session));
    if (expectedStatus === null) {
      expect(res).toBeNull();
      return;
    }
    expect(res).not.toBeNull();
    expect(res?.status).toBe(expectedStatus);
    if (expectsRedirect) {
      expect(res?.headers.get('location')).toContain('/api/auth/signin');
    }
  });
});
