/**
 * Unit tests for the invite Server Actions (TASK-7, REQ-18, REQ-22).
 *
 * Strategy: tests target `createInviteImpl` / `revokeInviteImpl` — the
 * pure-ish cores that take `authFn` + `cookieStore` + an injected `core`
 * function as deps, so no Next.js runtime is needed. The thin
 * `*Action` wrappers add `revalidatePath` + lazy-imports of `auth()` /
 * `next/headers`; those are exercised in TASK-SMOKE's E2E.
 *
 * TC mappings:
 *   - TC-I-10  — create flow (manager auth → core called → cookie set with full URL).
 *   - TC-I-11  — member-role caller → unauthorized; core NOT invoked.
 *   - TC-I-12..15 — Zod boundaries on expires_in_hours (0/1/168/169).
 *   - TC-I-16..19 — Zod boundaries on max_uses (0/1/100/101).
 *   - TC-I-20  — `.strict()` rejects unknown fields.
 *   - TC-I-21  — cache-hit path: still sets cookie, returns same prefix.
 *   - TC-I-23  — revoke happy path returns 'revoked'.
 *   - TC-I-25  — revoke not_found is surfaced.
 *   - revoke prefix shape — Zod regex catches non-hex.
 *
 * Hand-written stubs (no mocking framework). The injected `core` records
 * its calls so we assert the actor/org/idempotency tuple flows through
 * exactly as Zod parsed it.
 */
import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import {
  createInviteImpl,
  revokeInviteImpl,
  type AuthFn,
} from './actions';
import { allowedSsoProvidersSchema } from './actions.schemas';
import type {
  CreateInviteCoreDeps,
  CreateInviteCoreParams,
  CreateInviteCoreResult,
  RevokeInviteCoreDeps,
  RevokeInviteCoreParams,
  RevokeInviteCoreResult,
} from '@/lib/queries/invites';
import type { FlashCookieStore } from '@/lib/auth/flash-cookie';

const stubAuth = (session: Session | null): AuthFn => async () => session;

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const IDEMP_KEY = '44444444-4444-4444-8444-444444444444';

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

/**
 * Build a FormData from the given scalar entries. ALL invite-create tests
 * must provide at least one `allowed_sso_providers` value (REQ-7/8 write
 * path). To keep pre-TASK-15 tests passing without rewriting them, this
 * helper appends a default `['google']` selection — opt out by passing
 * `{ withDefaultProviders: false }` in the optional second arg (used by the
 * "field omitted" rejection test).
 */
const buildFormData = (
  entries: Record<string, string>,
  options?: { withDefaultProviders?: boolean },
): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  const withDefaults = options?.withDefaultProviders ?? true;
  if (withDefaults) fd.append('allowed_sso_providers', 'google');
  return fd;
};

type CreateCoreCall = { params: CreateInviteCoreParams };

const stubCreateCore = (
  result: CreateInviteCoreResult,
  calls: CreateCoreCall[],
) => {
  return async (
    _deps: CreateInviteCoreDeps,
    params: CreateInviteCoreParams,
  ): Promise<CreateInviteCoreResult> => {
    calls.push({ params });
    return result;
  };
};

type RevokeCoreCall = { params: RevokeInviteCoreParams };

const stubRevokeCore = (
  result: RevokeInviteCoreResult,
  calls: RevokeCoreCall[],
) => {
  return async (
    _deps: RevokeInviteCoreDeps,
    params: RevokeInviteCoreParams,
  ): Promise<RevokeInviteCoreResult> => {
    calls.push({ params });
    return result;
  };
};

type CookieSetCall = { name: string; value: string };

const stubCookieStore = (): {
  store: FlashCookieStore;
  setCalls: CookieSetCall[];
} => {
  const setCalls: CookieSetCall[] = [];
  const store: FlashCookieStore = {
    get: () => undefined,
    set: (name, value) => {
      setCalls.push({ name, value });
    },
    delete: () => {
      // no-op for unit tests
    },
  };
  return { store, setCalls };
};

const FAKE_TOKEN = 'a'.repeat(64);
const FAKE_PREFIX = FAKE_TOKEN.slice(0, 8);

const FAKE_RESULT: CreateInviteCoreResult = {
  token: FAKE_TOKEN,
  tokenPrefix: FAKE_PREFIX,
  expiresAt: new Date('2026-04-30T18:00:00Z'),
  cached: false,
};

const baseFormFields = {
  idempotency_key: IDEMP_KEY,
  team_id: TEAM_ID,
  email_pattern: '*@example.com',
  max_uses: '5',
  expires_in_hours: '8',
};

/**
 * Build a FormData with checkbox-group multi-values for
 * `allowed_sso_providers` plus the base scalar fields. The browser submits
 * checkbox groups as repeated entries with the same name; mirror that here
 * so the Server Action's `formData.entries()` reads see the same shape.
 *
 * If `providers` includes `'__bare_string__'` as the only element, set a
 * single scalar string (not an array) — used to assert that the schema
 * rejects a single-string submission.
 */
const buildFormDataWithProviders = (
  scalars: Record<string, string>,
  providers: ReadonlyArray<string>,
): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(scalars)) fd.set(k, v);
  for (const p of providers) fd.append('allowed_sso_providers', p);
  return fd;
};

describe('createInviteImpl', () => {
  it('TC-I-10: manager invokes the action → core called with parsed params; cookie set with full URL', async () => {
    const calls: CreateCoreCall[] = [];
    const { store, setCalls } = stubCookieStore();
    let setCookiePayload: string | null = null;

    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: (s, p) => {
        setCookiePayload = p;
        s.set('onboard_flash', p, {
          httpOnly: true,
          secure: false,
          sameSite: 'strict',
          path: '/manager/invites/created',
          maxAge: 120,
        });
      },
    });

    expect(res).toEqual({ ok: true, tokenPrefix: FAKE_PREFIX, cached: false });

    // The core was called with the parsed-and-mapped params.
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      actorUserId: ACTOR_ID,
      orgId: ORG_ID,
      idempotencyKey: IDEMP_KEY,
      teamId: TEAM_ID,
      emailPattern: '*@example.com',
      maxUses: 5,
      expiresInHours: 8,
      allowedSsoProviders: ['google'],
    });

    // The cookie was set, and the payload contains the full token (the
    // 64-hex value) — that's the whole point of the flash cookie.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].name).toBe('onboard_flash');
    expect(setCookiePayload).not.toBeNull();
    expect(setCookiePayload).toContain('#token=' + FAKE_TOKEN);
    expect(setCookiePayload).toContain('/onboard');
  });

  it('admin role also accepted (TC-I-60d coverage at the action layer)', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(ADMIN_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* no-op */
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('TC-I-11: member-role caller → unauthorized; core NOT invoked', async () => {
    const calls: CreateCoreCall[] = [];
    const { store, setCalls } = stubCookieStore();
    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(MEMBER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
    expect(calls).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
  });

  it('no session → unauthorized', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(null),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('session without user.id → unauthorized (defensive: id is REQ-11 invariant)', async () => {
    const session: Session = {
      user: { email: 'x@x', role: 'manager', orgId: ORG_ID },
      expires: '2099-01-01',
    };
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(session),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
  });

  // Boundary tests use it.each — every Zod boundary documented in the spec.
  it.each([
    {
      name: 'TC-I-12: expires_in_hours=0 rejected',
      override: { expires_in_hours: '0' },
      okExpected: false,
    },
    {
      name: 'TC-I-13: expires_in_hours=1 (valid min) accepted',
      override: { expires_in_hours: '1' },
      okExpected: true,
    },
    {
      name: 'TC-I-14: expires_in_hours=168 (valid max) accepted',
      override: { expires_in_hours: '168' },
      okExpected: true,
    },
    {
      name: 'TC-I-15: expires_in_hours=169 (over max) rejected',
      override: { expires_in_hours: '169' },
      okExpected: false,
    },
    {
      name: 'TC-I-16: max_uses=0 rejected',
      override: { max_uses: '0' },
      okExpected: false,
    },
    {
      name: 'TC-I-17: max_uses=1 (valid min) accepted',
      override: { max_uses: '1' },
      okExpected: true,
    },
    {
      name: 'TC-I-18: max_uses=100 (valid max) accepted',
      override: { max_uses: '100' },
      okExpected: true,
    },
    {
      name: 'TC-I-19: max_uses=101 (over max) rejected',
      override: { max_uses: '101' },
      okExpected: false,
    },
  ])('$name', async ({ override, okExpected }) => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(
      buildFormData({ ...baseFormFields, ...override }),
      {
        authFn: stubAuth(MANAGER_SESSION),
        cookieStore: store,
        core: stubCreateCore(FAKE_RESULT, calls),
        coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
        setCookie: () => {
          /* noop */
        },
      },
    );
    if (okExpected) {
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
    } else {
      expect(res).toEqual({
        ok: false,
        code: 'invalid_input',
        detail: expect.any(String),
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('TC-I-20: unknown fields are rejected by .strict()', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(
      buildFormData({ ...baseFormFields, hax_field: 'oops' }),
      {
        authFn: stubAuth(MANAGER_SESSION),
        cookieStore: store,
        core: stubCreateCore(FAKE_RESULT, calls),
        coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('invalid_input');
    }
    expect(calls).toHaveLength(0);
  });

  it('idempotency_key must be a UUID', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const res = await createInviteImpl(
      buildFormData({ ...baseFormFields, idempotency_key: 'not-a-uuid' }),
      {
        authFn: stubAuth(MANAGER_SESSION),
        cookieStore: store,
        core: stubCreateCore(FAKE_RESULT, calls),
        coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      },
    );
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('team_id and email_pattern are optional (omit → core gets null)', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormData({
      idempotency_key: IDEMP_KEY,
      max_uses: '1',
      expires_in_hours: '8',
    });
    await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.teamId).toBeNull();
    expect(calls[0].params.emailPattern).toBeNull();
  });

  it('defaults apply when max_uses / expires_in_hours are omitted', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    await createInviteImpl(
      buildFormData({ idempotency_key: IDEMP_KEY }),
      {
        authFn: stubAuth(MANAGER_SESSION),
        cookieStore: store,
        core: stubCreateCore(FAKE_RESULT, calls),
        coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
        setCookie: () => {
          /* noop */
        },
      },
    );
    expect(calls[0].params.maxUses).toBe(1);
    expect(calls[0].params.expiresInHours).toBe(8);
  });

  // ---------------------------------------------------------------------
  // allowed_sso_providers — TASK-15 (REQ-7, REQ-8).
  //
  // Write-path semantics: schema requires ≥1 provider (`.min(1)`) and
  // dedups via `.transform`. Empty array / missing field / invalid enum
  // value / wrong shape (single string) all surface as
  // `{ok: false, code: 'invalid_input'}`. Legacy read-path semantics
  // (`[]` = "any provider allowed") are preserved at the DB layer and
  // exercised in `sso-auto-provision.test.ts` — not here.
  // ---------------------------------------------------------------------

  it('TC-I-20: accepts a single supported provider and passes it through to core', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, ['google']);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.allowedSsoProviders).toEqual(['google']);
  });

  it('accepts a multi-provider selection (all four providers)', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, [
      'google',
      'okta',
      'microsoft',
      'auth0',
    ]);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0].params.allowedSsoProviders).toEqual([
      'google',
      'okta',
      'microsoft',
      'auth0',
    ]);
  });

  it('TC-I-22: rejects an empty array on the create path with invalid_input', async () => {
    const calls: CreateCoreCall[] = [];
    const { store, setCalls } = stubCookieStore();
    // Empty checkbox group → no entries appended; absent from FormData.
    const fd = buildFormDataWithProviders(baseFormFields, []);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('invalid_input');
      expect(typeof res.detail).toBe('string');
    }
    expect(calls).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
  });

  it('TC-I-21: rejects an unsupported provider value with invalid_input', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, ['nonexistent']);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('rejects a mixed valid + invalid provider list', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, ['google', 'nope']);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('dedups repeated providers (google,google → google)', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, ['google', 'google']);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0].params.allowedSsoProviders).toEqual(['google']);
  });

  it('dedups a longer repeated selection while preserving the first-seen order', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormDataWithProviders(baseFormFields, [
      'okta',
      'google',
      'okta',
      'auth0',
      'google',
    ]);
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: () => {
        /* noop */
      },
    });
    expect(res.ok).toBe(true);
    expect(calls[0].params.allowedSsoProviders).toEqual([
      'okta',
      'google',
      'auth0',
    ]);
  });

  it('rejects when allowed_sso_providers is omitted entirely (write path requires ≥1)', async () => {
    const calls: CreateCoreCall[] = [];
    const { store } = stubCookieStore();
    const fd = buildFormData(baseFormFields, { withDefaultProviders: false });
    const res = await createInviteImpl(fd, {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(FAKE_RESULT, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('TC-I-21: cache-hit path still sets the flash cookie + returns cached:true', async () => {
    const calls: CreateCoreCall[] = [];
    const { store, setCalls } = stubCookieStore();
    const cachedResult: CreateInviteCoreResult = { ...FAKE_RESULT, cached: true };
    const res = await createInviteImpl(buildFormData(baseFormFields), {
      authFn: stubAuth(MANAGER_SESSION),
      cookieStore: store,
      core: stubCreateCore(cachedResult, calls),
      coreDeps: { db: {} as CreateInviteCoreDeps['db'] },
      setCookie: (s, p) => {
        s.set('onboard_flash', p, {
          httpOnly: true,
          secure: false,
          sameSite: 'strict',
          path: '/manager/invites/created',
          maxAge: 120,
        });
      },
    });
    expect(res).toEqual({ ok: true, tokenPrefix: FAKE_PREFIX, cached: true });
    expect(setCalls).toHaveLength(1);
  });
});

describe('revokeInviteImpl', () => {
  it('TC-I-23: manager revokes → core called → returns kind=revoked', async () => {
    const calls: RevokeCoreCall[] = [];
    const res = await revokeInviteImpl('cafef00d', {
      authFn: stubAuth(MANAGER_SESSION),
      core: stubRevokeCore(
        { ok: true, kind: 'revoked', tokenPrefix: 'cafef00d' },
        calls,
      ),
      coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
    });
    expect(res).toEqual({
      ok: true,
      kind: 'revoked',
      tokenPrefix: 'cafef00d',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      actorUserId: ACTOR_ID,
      orgId: ORG_ID,
      prefix: 'cafef00d',
    });
  });

  it('TC-I-24: already-revoked → ok with kind=already-revoked', async () => {
    const calls: RevokeCoreCall[] = [];
    const res = await revokeInviteImpl('cafef00d', {
      authFn: stubAuth(MANAGER_SESSION),
      core: stubRevokeCore(
        { ok: true, kind: 'already-revoked', tokenPrefix: 'cafef00d' },
        calls,
      ),
      coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
    });
    expect(res).toEqual({
      ok: true,
      kind: 'already-revoked',
      tokenPrefix: 'cafef00d',
    });
  });

  it('TC-I-25: not-found surfaces as code="not_found"', async () => {
    const calls: RevokeCoreCall[] = [];
    const res = await revokeInviteImpl('00000000', {
      authFn: stubAuth(MANAGER_SESSION),
      core: stubRevokeCore({ ok: false, kind: 'not-found' }, calls),
      coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'not_found' });
  });

  it('TC-I-26: collision surfaces as code="collision"', async () => {
    const calls: RevokeCoreCall[] = [];
    const res = await revokeInviteImpl('deadbeef', {
      authFn: stubAuth(MANAGER_SESSION),
      core: stubRevokeCore({ ok: false, kind: 'collision' }, calls),
      coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'collision' });
  });

  it('member caller → unauthorized; core NOT invoked', async () => {
    const calls: RevokeCoreCall[] = [];
    const res = await revokeInviteImpl('cafef00d', {
      authFn: stubAuth(MEMBER_SESSION),
      core: stubRevokeCore(
        { ok: true, kind: 'revoked', tokenPrefix: 'cafef00d' },
        calls,
      ),
      coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
    });
    expect(res).toEqual({ ok: false, code: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { prefix: '', desc: 'empty' },
    { prefix: 'short', desc: 'too short' },
    { prefix: 'too-long-prefix', desc: 'too long' },
    { prefix: 'CAFEF00D', desc: 'uppercase rejected (regex is lowercase)' },
    { prefix: 'NOTHEX!@', desc: 'non-hex chars' },
  ])(
    'invalid prefix shape ($desc) → invalid_input; core NOT invoked',
    async ({ prefix }) => {
      const calls: RevokeCoreCall[] = [];
      const res = await revokeInviteImpl(prefix, {
        authFn: stubAuth(MANAGER_SESSION),
        core: stubRevokeCore(
          { ok: true, kind: 'revoked', tokenPrefix: prefix },
          calls,
        ),
        coreDeps: { db: {} as RevokeInviteCoreDeps['db'] },
      });
      expect(res).toEqual({ ok: false, code: 'invalid_input' });
      expect(calls).toHaveLength(0);
    },
  );
});

// =============================================================================
// allowedSsoProvidersSchema — standalone unit tests.
//
// Source: .specs/sso-test-coverage-orphans.md (REQ-1, TC-U-01a..g).
// The schema is extracted to a named export so a regression that breaks
// `.min(1)` or `.transform(dedup)` is caught directly, not subsumed by
// the action-layer integration TCs above.
// =============================================================================
describe('allowedSsoProvidersSchema (standalone)', () => {
  // TC-U-01a — happy: single supported provider parses.
  it('accepts a single supported provider', () => {
    expect(allowedSsoProvidersSchema.parse(['google'])).toEqual(['google']);
  });

  // TC-U-01b — happy: multi-provider preserves insertion order.
  it('accepts multiple supported providers in original order', () => {
    expect(allowedSsoProvidersSchema.parse(['google', 'okta'])).toEqual(['google', 'okta']);
  });

  // TC-U-01c — validation: empty array rejected with too_small.
  it('rejects an empty array (safeParse) with too_small error code', () => {
    const result = allowedSsoProvidersSchema.safeParse([]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('too_small');
    }
  });

  // TC-U-01d — validation: unknown provider rejected. Zod 4 emits
  // `invalid_value` (renamed from Zod 3's `invalid_enum_value`).
  it('rejects an unknown provider (safeParse) with invalid_value error code', () => {
    const result = allowedSsoProvidersSchema.safeParse(['nonexistent']);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('invalid_value');
    }
  });

  // TC-U-01e — business: duplicates deduped (Set first-seen).
  it('dedupes duplicates (Set first-seen semantics)', () => {
    expect(allowedSsoProvidersSchema.parse(['google', 'google'])).toEqual(['google']);
  });

  // TC-U-01f — business: dedup preserves first-seen order across mixed values.
  it('dedupes a longer sequence while preserving first-seen order', () => {
    expect(
      allowedSsoProvidersSchema.parse(['google', 'okta', 'google']),
    ).toEqual(['google', 'okta']);
  });

  // TC-U-01g — validation: .parse() throws on invalid input.
  // Pins that this schema does NOT use .catch(); .parse() MUST throw on
  // empty input. Complements TC-U-01c which exercises the .safeParse path.
  it('parse() throws ZodError on an empty array (no .catch() configured)', () => {
    expect(() => allowedSsoProvidersSchema.parse([])).toThrow();
  });
});
