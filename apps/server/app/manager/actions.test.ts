/**
 * Unit tests for `app/manager/actions.ts` — TASK-17, REQ-1.
 *
 * Targets `acknowledgeFirstAutoProvisionImpl` (the pure-ish core), so no
 * NextAuth / next/cache / pg connection is required. Hand-written stubs
 * follow the project convention (no mocking framework).
 *
 * TC mappings (from spec §"Test Plan" and TASK-17 brief):
 *   - happy path: manager auth + valid event_id → ack persisted + revalidatePath
 *   - unauthorized: member-role caller → `{ok:false, code:'unauthorized'}`,
 *     ack NOT invoked, revalidatePath NOT called.
 *   - invalid_input: bad event_id (non-numeric / negative / zero / missing)
 *     → `{ok:false, code:'invalid_input'}`, ack NOT invoked.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import {
  acknowledgeFirstAutoProvisionImpl,
  type AuthFn,
} from './actions';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const MANAGER_SESSION: Session = {
  user: { id: ACTOR_ID, email: 'mgr@x', role: 'manager', orgId: ORG_ID },
  expires: '2099-01-01',
};
const ADMIN_SESSION: Session = {
  user: { id: ACTOR_ID, email: 'adm@x', role: 'admin', orgId: ORG_ID },
  expires: '2099-01-01',
};
const MEMBER_SESSION: Session = {
  user: { id: ACTOR_ID, email: 'mbr@x', role: 'member', orgId: ORG_ID },
  expires: '2099-01-01',
};

const stubAuth = (session: Session | null): AuthFn => async () => session;

type AckCall = {
  managerId: string;
  kind: 'first-auto-provision';
  eventId: number;
};

const makeAckSpy = () => {
  const calls: AckCall[] = [];
  const fn = async (
    _db: unknown,
    managerId: string,
    kind: 'first-auto-provision',
    eventId: number,
  ): Promise<void> => {
    calls.push({ managerId, kind, eventId });
  };
  return { calls, fn };
};

const makeRevalidateSpy = () => {
  const calls: string[] = [];
  return { calls, fn: (p: string) => calls.push(p) };
};

const buildFormData = (entries: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

describe('acknowledgeFirstAutoProvisionImpl', () => {
  it('persists the ack and revalidates /manager when a manager submits a valid event_id', async () => {
    const ack = makeAckSpy();
    const revalidate = makeRevalidateSpy();

    const result = await acknowledgeFirstAutoProvisionImpl(
      buildFormData({ event_id: '42' }),
      {
        authFn: stubAuth(MANAGER_SESSION),
        revalidatePathFn: revalidate.fn,
        acknowledgeFn: ack.fn,
        db: {} as never,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(ack.calls).toHaveLength(1);
    expect(ack.calls[0]).toEqual({
      managerId: ACTOR_ID,
      kind: 'first-auto-provision',
      eventId: 42,
    });
    expect(revalidate.calls).toEqual(['/manager']);
  });

  it('accepts admin role just like manager (defense-in-depth role gate)', async () => {
    const ack = makeAckSpy();
    const revalidate = makeRevalidateSpy();

    const result = await acknowledgeFirstAutoProvisionImpl(
      buildFormData({ event_id: '7' }),
      {
        authFn: stubAuth(ADMIN_SESSION),
        revalidatePathFn: revalidate.fn,
        acknowledgeFn: ack.fn,
        db: {} as never,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(ack.calls).toHaveLength(1);
  });

  it('returns unauthorized for member-role callers and never invokes the ack', async () => {
    const ack = makeAckSpy();
    const revalidate = makeRevalidateSpy();

    const result = await acknowledgeFirstAutoProvisionImpl(
      buildFormData({ event_id: '42' }),
      {
        authFn: stubAuth(MEMBER_SESSION),
        revalidatePathFn: revalidate.fn,
        acknowledgeFn: ack.fn,
        db: {} as never,
      },
    );

    expect(result).toEqual({ ok: false, code: 'unauthorized' });
    expect(ack.calls).toEqual([]);
    expect(revalidate.calls).toEqual([]);
  });

  it('returns unauthorized for an unauthenticated caller (no session)', async () => {
    const ack = makeAckSpy();
    const revalidate = makeRevalidateSpy();

    const result = await acknowledgeFirstAutoProvisionImpl(
      buildFormData({ event_id: '42' }),
      {
        authFn: stubAuth(null),
        revalidatePathFn: revalidate.fn,
        acknowledgeFn: ack.fn,
        db: {} as never,
      },
    );

    expect(result).toEqual({ ok: false, code: 'unauthorized' });
    expect(ack.calls).toEqual([]);
    expect(revalidate.calls).toEqual([]);
  });

  it.each([
    { label: 'non-numeric', value: 'abc' },
    { label: 'negative', value: '-1' },
    { label: 'zero', value: '0' },
    { label: 'fractional', value: '1.5' },
    { label: 'empty string', value: '' },
  ])(
    'returns invalid_input when event_id is $label',
    async ({ value }) => {
      const ack = makeAckSpy();
      const revalidate = makeRevalidateSpy();

      const result = await acknowledgeFirstAutoProvisionImpl(
        buildFormData({ event_id: value }),
        {
          authFn: stubAuth(MANAGER_SESSION),
          revalidatePathFn: revalidate.fn,
          acknowledgeFn: ack.fn,
          db: {} as never,
        },
      );

      expect(result).toEqual({ ok: false, code: 'invalid_input' });
      expect(ack.calls).toEqual([]);
      expect(revalidate.calls).toEqual([]);
    },
  );

  it('returns invalid_input when event_id is missing from the form', async () => {
    const ack = makeAckSpy();
    const revalidate = makeRevalidateSpy();

    const result = await acknowledgeFirstAutoProvisionImpl(new FormData(), {
      authFn: stubAuth(MANAGER_SESSION),
      revalidatePathFn: revalidate.fn,
      acknowledgeFn: ack.fn,
      db: {} as never,
    });

    expect(result).toEqual({ ok: false, code: 'invalid_input' });
    expect(ack.calls).toEqual([]);
    expect(revalidate.calls).toEqual([]);
  });
});
