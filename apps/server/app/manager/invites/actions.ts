/**
 * Server Actions for invite management (REQ-18, REQ-19, REQ-22).
 *
 * Thin wrappers over the pure-ish core in `lib/queries/invites.ts`. The
 * action surface owns three Next-only concerns:
 *   - `auth()` (require role manager | admin),
 *   - `cookies()` (set the show-once flash cookie on success — REQ-22),
 *   - `revalidatePath('/manager/invites')` after every mutation.
 *
 * Everything else (idempotency cache, audit-log writes, status derivation,
 * tenant scope) lives in the core module so it can be unit-tested without
 * the Next.js runtime. The colocated `actions.test.ts` exercises the
 * `*Impl` functions exported below — production code only ever calls the
 * thin wrappers `createInviteAction` / `revokeInviteAction`.
 *
 * Defense-in-depth: the role check in this file is in addition to the
 * middleware that gates `/manager/*`. A misconfigured matcher should not
 * be the only thing preventing a `member` from minting invites.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import {
  createInviteCore,
  revokeInviteCore,
  type CreateInviteCoreDeps,
  type CreateInviteCoreParams,
  type CreateInviteCoreResult,
  type RevokeInviteCoreDeps,
  type RevokeInviteCoreParams,
  type RevokeInviteCoreResult,
} from '@/lib/queries/invites';
import {
  setFlashCookie,
  type FlashCookieStore,
} from '@/lib/auth/flash-cookie';

// ---------------------------------------------------------------------------
// Zod schemas — boundary validation. `.strict()` rejects unknown fields so
// a tampered form payload with extra keys can't smuggle data through.
// ---------------------------------------------------------------------------

const createInviteFormSchema = z
  .object({
    idempotency_key: z.string().uuid(),
    team_id: z.string().uuid().optional(),
    email_pattern: z.string().min(1).max(254).optional(),
    max_uses: z.coerce.number().int().min(1).max(100).default(1),
    expires_in_hours: z.coerce.number().int().min(1).max(168).default(8),
  })
  .strict();

/**
 * Revoke takes a single 8-hex prefix. `regex` plus `length(=8)` keeps the
 * input shape locked — anything else fails validation up front rather than
 * reaching the DB query.
 */
const revokeInviteSchema = z.string().regex(/^[0-9a-f]{8}$/);

// ---------------------------------------------------------------------------
// Auth + result types — exported so the *Impl functions are testable.
// ---------------------------------------------------------------------------

export type AuthFn = () => Promise<Session | null>;
export type CookiesFn = () => FlashCookieStore;

export type CreateInviteResult =
  | { ok: true; tokenPrefix: string; cached: boolean }
  | {
      ok: false;
      code: 'unauthorized' | 'invalid_input';
      detail?: string;
    };

export type RevokeInviteResult =
  | { ok: true; kind: 'revoked' | 'already-revoked'; tokenPrefix: string }
  | {
      ok: false;
      code: 'unauthorized' | 'invalid_input' | 'not_found' | 'collision';
    };

// ---------------------------------------------------------------------------
// URL builder — the same canonical shape used by the spec docs.
// ---------------------------------------------------------------------------

/**
 * Build the `https://central/onboard#token=...` URL. `BASE_URL` is preferred
 * (`NEXTAUTH_URL`); falls back to `http://localhost:${PORT|3232}` so dev
 * setups without an explicit env still work.
 */
const buildOnboardUrl = (token: string): string => {
  const base =
    process.env.NEXTAUTH_URL ??
    `http://localhost:${process.env.PORT ?? '3232'}`;
  // Trim a trailing slash so `${base}/onboard` doesn't produce `//onboard`.
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/onboard#token=${token}`;
};

// ---------------------------------------------------------------------------
// createInviteImpl — pure-ish (no `next/cache`, no `next/headers` import).
// ---------------------------------------------------------------------------

export type CreateInviteImplDeps = {
  authFn: AuthFn;
  cookieStore: FlashCookieStore;
  /** Allows tests to swap in a stub core without going to Postgres. */
  core?: (
    deps: CreateInviteCoreDeps,
    params: CreateInviteCoreParams,
  ) => Promise<CreateInviteCoreResult>;
  coreDeps?: CreateInviteCoreDeps;
  /** Test seam — defaults to setting the cookie via `setFlashCookie`. */
  setCookie?: (store: FlashCookieStore, payload: string) => void;
};

/**
 * The unit-testable core of `createInviteAction`. Returns a discriminated
 * Result; the production wrapper `createInviteAction` adapts the failure
 * shapes to the (1) thrown error for unauthorized, (2) silent-ignore for
 * invalid input convention used by the form.
 *
 * Side effects on success:
 *   - Sets the `onboard_flash` cookie with the full URL (REQ-22).
 *   - Returns the 8-char prefix to the form (full token never returned).
 *
 * The flash cookie is set on BOTH the cache-miss path AND the cache-hit
 * (idempotent replay) path so a double-click that lands on the cache hit
 * still navigates to the show-once page with the URL displayed.
 */
export const createInviteImpl = async (
  formData: FormData,
  deps: CreateInviteImplDeps,
): Promise<CreateInviteResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const userId = session?.user?.id;
  if ((role !== 'manager' && role !== 'admin') || !orgId || !userId) {
    return { ok: false, code: 'unauthorized' };
  }

  // Materialize ALL FormData entries so `.strict()` can see (and reject)
  // any unknown field. Each value is normalized so empty strings collapse
  // to `undefined` — that way `.optional()` and `.default()` apply cleanly
  // without an empty-string slipping past Zod and crashing min-length
  // checks downstream.
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    const norm = optString(v);
    if (norm !== undefined) stripped[k] = norm;
  }

  const parsed = createInviteFormSchema.safeParse(stripped);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_input',
      detail: parsed.error.issues[0]?.message,
    };
  }

  const coreFn = deps.core ?? createInviteCore;
  const coreDeps = deps.coreDeps ?? { db: getDb() };
  const result = await coreFn(coreDeps, {
    actorUserId: userId,
    orgId,
    idempotencyKey: parsed.data.idempotency_key,
    teamId: parsed.data.team_id ?? null,
    emailPattern: parsed.data.email_pattern ?? null,
    maxUses: parsed.data.max_uses,
    expiresInHours: parsed.data.expires_in_hours,
  });

  // Set the flash cookie with the full onboard URL — token is in the URL
  // fragment so it never reaches server access logs.
  const onboardUrl = buildOnboardUrl(result.token);
  const setter = deps.setCookie ?? ((store, p) => setFlashCookie(store, p));
  setter(deps.cookieStore, onboardUrl);

  return { ok: true, tokenPrefix: result.tokenPrefix, cached: result.cached };
};

const optString = (v: FormDataEntryValue | null): string | undefined => {
  if (v === null) return undefined;
  if (typeof v !== 'string') return undefined;
  if (v === '') return undefined;
  return v;
};

// ---------------------------------------------------------------------------
// revokeInviteImpl — pure-ish twin.
// ---------------------------------------------------------------------------

export type RevokeInviteImplDeps = {
  authFn: AuthFn;
  core?: (
    deps: RevokeInviteCoreDeps,
    params: RevokeInviteCoreParams,
  ) => Promise<RevokeInviteCoreResult>;
  coreDeps?: RevokeInviteCoreDeps;
};

export const revokeInviteImpl = async (
  prefix: string,
  deps: RevokeInviteImplDeps,
): Promise<RevokeInviteResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const userId = session?.user?.id;
  if ((role !== 'manager' && role !== 'admin') || !orgId || !userId) {
    return { ok: false, code: 'unauthorized' };
  }

  const parsed = revokeInviteSchema.safeParse(prefix);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }

  const coreFn = deps.core ?? revokeInviteCore;
  const coreDeps = deps.coreDeps ?? { db: getDb() };
  const result = await coreFn(coreDeps, {
    actorUserId: userId,
    orgId,
    prefix: parsed.data,
  });

  if (result.ok) {
    return { ok: true, kind: result.kind, tokenPrefix: result.tokenPrefix };
  }
  if (result.kind === 'collision') {
    return { ok: false, code: 'collision' };
  }
  return { ok: false, code: 'not_found' };
};

// ---------------------------------------------------------------------------
// Production Server Action wrappers.
// ---------------------------------------------------------------------------

/**
 * Lazy-loaded `auth()` — keeps `next-auth` out of vitest's module graph
 * for unit tests, mirroring the pattern in `manager/admin/users/actions.ts`.
 */
const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

const lazyCookieStore = async (): Promise<FlashCookieStore> => {
  const { cookies } = await import('next/headers');
  // Next 15: `cookies()` is async (returns ReadonlyRequestCookies-ish
  // promise). Adapt to the FlashCookieStore shape — we only use get/set/delete.
  const store = await cookies();
  return {
    get: (name) => {
      const c = store.get(name);
      return c ? { value: c.value } : undefined;
    },
    set: (name, value, options) => {
      store.set(name, value, options);
    },
    delete: (name) => {
      store.delete(name);
    },
  };
};

/**
 * Production Server Action. Calls the `Impl`, surfaces errors via thrown
 * for `unauthorized` (route-level error.tsx handles), returns the Result
 * for the calling form to read on success / invalid_input.
 *
 * The form's redirect-to-show-once page lives in the calling component
 * (TASK-9) — it inspects the returned `tokenPrefix` and calls `redirect()`
 * itself.
 */
export const createInviteAction = async (
  formData: FormData,
): Promise<CreateInviteResult> => {
  const cookieStore = await lazyCookieStore();
  const result = await createInviteImpl(formData, {
    authFn: lazyDefaultAuth,
    cookieStore,
  });
  if (!result.ok && result.code === 'unauthorized') {
    throw new Error('Unauthorized');
  }
  if (result.ok) {
    revalidatePath('/manager/invites');
  }
  return result;
};

export const revokeInviteAction = async (
  prefix: string,
): Promise<RevokeInviteResult> => {
  const result = await revokeInviteImpl(prefix, {
    authFn: lazyDefaultAuth,
  });
  if (!result.ok && result.code === 'unauthorized') {
    throw new Error('Unauthorized');
  }
  if (result.ok) {
    revalidatePath('/manager/invites');
  }
  return result;
};

