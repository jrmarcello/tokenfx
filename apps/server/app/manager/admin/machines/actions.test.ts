/**
 * Unit tests for the machine-revocation Server Action impl.
 * Spec: .specs/machine-revocation-ui.md (REQ-4, REQ-7, REQ-3).
 *
 * Strategy: target `revokeMachineImpl` directly, injecting `authFn` and `core`
 * stubs — no Next.js runtime or Postgres needed. Hand-written stubs, no
 * mocking framework.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import {
  revokeMachineImpl,
  type AuthFn,
  type RevokeMachineImplDeps,
} from './actions';
import type { RevokeMachineResult } from '@/lib/queries/machines';

const stubAuth = (session: Session | null): AuthFn => async () => session;

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

const ADMIN: Session = {
  user: { id: ACTOR_ID, email: 'adm@x', role: 'admin', orgId: ORG_ID },
  expires: '2099-01-01',
};
const MANAGER: Session = {
  user: { id: ACTOR_ID, email: 'mgr@x', role: 'manager', orgId: ORG_ID },
  expires: '2099-01-01',
};
const MEMBER: Session = {
  user: { id: ACTOR_ID, email: 'mbr@x', role: 'member', orgId: ORG_ID },
  expires: '2099-01-01',
};

// A core stub that records whether it was called and returns a fixed result.
const coreReturning = (
  result: RevokeMachineResult,
): { fn: RevokeMachineImplDeps['core']; calls: () => number } => {
  let calls = 0;
  const fn: RevokeMachineImplDeps['core'] = async () => {
    calls += 1;
    return result;
  };
  return { fn, calls: () => calls };
};

const VALID_PREFIX = 'k_a1b2c3';

describe('revokeMachineImpl — Zod prefix validation (REQ-4)', () => {
  it.each<{ tc: string; prefix: string }>([
    { tc: 'TC-U-01a', prefix: '' },
    { tc: 'TC-U-01b', prefix: 'k_zzzzzz' },
    { tc: 'TC-U-01c-short', prefix: 'k_a1b2c' }, // 7 chars
    { tc: 'TC-U-01c-long', prefix: 'k_a1b2c3d' }, // 9 chars
    { tc: 'TC-U-01c-nohex5', prefix: 'k_a1b2' }, // k_ + 4 hex
  ])('$tc: rejects malformed prefix "$prefix" as invalid_input', async ({ prefix }) => {
    const core = coreReturning({ kind: 'revoked', keyPrefix: prefix });
    const res = await revokeMachineImpl(prefix, {
      authFn: stubAuth(ADMIN),
      core: core.fn,
    });
    expect(res).toEqual({ ok: false, code: 'invalid_input' });
    expect(core.calls()).toBe(0); // never reaches the DB
  });

  it('TC-U-01d: accepts a valid prefix and calls core', async () => {
    const core = coreReturning({ kind: 'revoked', keyPrefix: VALID_PREFIX });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(ADMIN),
      core: core.fn,
    });
    expect(res).toEqual({ ok: true, kind: 'revoked' });
    expect(core.calls()).toBe(1);
  });
});

describe('revokeMachineImpl — authorization (REQ-7)', () => {
  it('TC-I-09a: member is rejected; core NOT called', async () => {
    const core = coreReturning({ kind: 'revoked', keyPrefix: VALID_PREFIX });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(MEMBER),
      core: core.fn,
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
    expect(core.calls()).toBe(0);
  });

  it('TC-I-09b: manager is rejected — admin-only (stricter than invites); core NOT called', async () => {
    const core = coreReturning({ kind: 'revoked', keyPrefix: VALID_PREFIX });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(MANAGER),
      core: core.fn,
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
    expect(core.calls()).toBe(0);
  });

  it('TC-I-10-no-org: admin without orgId is rejected', async () => {
    const session = { user: { id: ACTOR_ID, email: 'a@x', role: 'admin' }, expires: '2099-01-01' } as unknown as Session;
    const res = await revokeMachineImpl(VALID_PREFIX, { authFn: stubAuth(session) });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
  });

  it('TC-I-10-no-id: admin without user.id is rejected (defensive invariant)', async () => {
    const session = { user: { email: 'a@x', role: 'admin', orgId: ORG_ID }, expires: '2099-01-01' } as unknown as Session;
    const res = await revokeMachineImpl(VALID_PREFIX, { authFn: stubAuth(session) });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
  });

  it('null session is rejected', async () => {
    const res = await revokeMachineImpl(VALID_PREFIX, { authFn: stubAuth(null) });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
  });
});

describe('revokeMachineImpl — result mapping (REQ-3)', () => {
  it('TC-I-13: already-revoked (double-click race) maps to ok success', async () => {
    const core = coreReturning({ kind: 'already-revoked', keyPrefix: VALID_PREFIX });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(ADMIN),
      core: core.fn,
    });
    expect(res).toEqual({ ok: true, kind: 'already-revoked' });
  });

  it('collision maps to a collision error code', async () => {
    const core = coreReturning({ kind: 'collision', matchCount: 2 });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(ADMIN),
      core: core.fn,
    });
    expect(res).toEqual({ ok: false, code: 'collision' });
  });

  it('not-found maps to a not_found error code', async () => {
    const core = coreReturning({ kind: 'not-found' });
    const res = await revokeMachineImpl(VALID_PREFIX, {
      authFn: stubAuth(ADMIN),
      core: core.fn,
    });
    expect(res).toEqual({ ok: false, code: 'not_found' });
  });
});
