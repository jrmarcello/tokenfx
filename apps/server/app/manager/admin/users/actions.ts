/**
 * Server Action for admin role assignment (REQ-17, TASK-20).
 *
 * Defense-in-depth: even though the route is gated by middleware
 * (`/manager/admin/*` requires `role === 'admin'`) AND by the manager layout,
 * we re-check the caller's role on every submit. A misconfigured matcher
 * shouldn't be the only thing standing between a `manager` and a privilege
 * grant.
 *
 * Tenant scoping: the UPDATE WHERE clause ANDs `id = userId` AND `orgId =
 * adminOrgId`, so a cross-org write is structurally a no-op (zero rows
 * affected) — never an error that could leak existence.
 *
 * Inputs come from a `<form action={...}>` so we treat `formData` as
 * untrusted: Zod validates `userId` (uuid) and `role` (enum) at the boundary.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq, type SQL } from 'drizzle-orm';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import {
  offboardUserCore,
  type OffboardUserParams,
  type OffboardUserResult,
} from '@/lib/queries/offboard';

const RoleEnum = z.enum(['member', 'manager', 'admin']);

const FormSchema = z.object({
  userId: z.string().uuid(),
  role: RoleEnum,
});

/**
 * Minimal DB shape `updateUserRoleImpl` depends on. Decouples the Server
 * Action from the concrete `getDb()` Drizzle instance so unit tests can
 * inject a hand-written stub without `vi.mock`.
 */
export type UserRoleDb = {
  update: (table: typeof users) => {
    set: (values: { role: 'member' | 'manager' | 'admin' }) => {
      where: (predicate: SQL | undefined) => Promise<unknown>;
    };
  };
};

export type AuthFn = () => Promise<Session | null>;

/**
 * Pure-ish core for the action — no `revalidatePath` here so it can be
 * unit-tested without a Next runtime. Surfaces explicit error codes instead
 * of throwing on the validation paths so callers can decide how to respond.
 */
export const updateUserRoleImpl = async (
  formData: FormData,
  authFn: AuthFn,
  db: UserRoleDb,
): Promise<
  | { ok: true }
  | { ok: false; code: 'unauthorized' | 'invalid_input' }
> => {
  const session = await authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  if (role !== 'admin' || !orgId) {
    return { ok: false, code: 'unauthorized' };
  }

  const parsed = FormSchema.safeParse({
    userId: formData.get('userId'),
    role: formData.get('role'),
  });
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }

  // Tenant scope: the WHERE ANDs `orgId` so an admin from org A cannot mutate
  // a user in org B. Drizzle parameterized — values are bound, not concatenated.
  await db
    .update(users)
    .set({ role: parsed.data.role })
    .where(and(eq(users.id, parsed.data.userId), eq(users.orgId, orgId)));

  return { ok: true };
};

/**
 * Production Server Action wired up to the real `auth()` and `getDb()`. Throws
 * on `unauthorized` so Next surfaces a 500 (the route is also gated by
 * middleware, so this branch should be unreachable in practice). Silently
 * ignores `invalid_input` to avoid leaking validation details — the form is
 * server-rendered with a `<select>` of valid values, so any bad payload is a
 * tampered request.
 */
const lazyDefaultAuth: AuthFn = async () => {
  // Lazy import keeps `next-auth` out of vitest's module graph for the
  // `actions.test.ts` unit tests, mirroring the pattern in
  // `apps/server/lib/auth/middleware.ts`.
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

export const updateUserRoleAction = async (formData: FormData): Promise<void> => {
  const result = await updateUserRoleImpl(
    formData,
    lazyDefaultAuth,
    getDb() as unknown as UserRoleDb,
  );
  if (!result.ok && result.code === 'unauthorized') {
    throw new Error('Unauthorized');
  }
  revalidatePath('/manager/admin/users');
};

// ---------------------------------------------------------------------------
// Offboarding — data-retention-policy (REQ-4, REQ-5, REQ-7). Admin-strict,
// irreversible identity anonymization. Split impl/action like machine-revoke.
// ---------------------------------------------------------------------------

const OffboardSchema = z.object({ userId: z.string().uuid() });

export type OffboardImplResult =
  | { ok: true; kind: OffboardUserResult['kind'] }
  | { ok: false; code: 'unauthorized' | 'invalid_input' };

export type OffboardImplDeps = {
  authFn: AuthFn;
  core?: (db: ReturnType<typeof getDb>, params: OffboardUserParams) => Promise<OffboardUserResult>;
  db?: ReturnType<typeof getDb>;
};

export const offboardUserImpl = async (
  formData: FormData,
  deps: OffboardImplDeps,
): Promise<OffboardImplResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const actorUserId = session?.user?.id;
  // Admin-strict (not manager|admin) — offboarding is destructive/irreversible.
  if (role !== 'admin' || !orgId || !actorUserId) {
    return { ok: false, code: 'unauthorized' };
  }

  const parsed = OffboardSchema.safeParse({ userId: formData.get('userId') });
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }

  const coreFn = deps.core ?? offboardUserCore;
  const db = deps.db ?? getDb();
  const result = await coreFn(db, {
    orgId,
    actorUserId,
    targetUserId: parsed.data.userId,
  });
  return { ok: true, kind: result.kind };
};

export const offboardUserAction = async (formData: FormData): Promise<void> => {
  const result = await offboardUserImpl(formData, { authFn: lazyDefaultAuth });
  if (!result.ok && result.code === 'unauthorized') {
    throw new Error('Unauthorized');
  }
  revalidatePath('/manager/admin/users');
};
