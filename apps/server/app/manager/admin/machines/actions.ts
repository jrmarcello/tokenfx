'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import {
  revokeMachineCore,
  type RevokeMachineParams,
  type RevokeMachineResult,
} from '@/lib/queries/machines';

/**
 * Machine revocation takes the 8-char key-id prefix (`k_` + 6 hex) — never the
 * full key_id. `regex` locks the shape so anything malformed fails up front,
 * before reaching the DB.
 */
const revokeMachineSchema = z.string().regex(/^k_[0-9a-f]{6}$/);

export type AuthFn = () => Promise<Session | null>;

export type RevokeMachineActionResult =
  | { ok: true; kind: RevokeMachineResult['kind'] }
  | { ok: false; code: 'unauthorized' | 'invalid_input' | 'not_found' | 'collision' };

export type RevokeMachineImplDeps = {
  authFn: AuthFn;
  core?: (
    db: ReturnType<typeof getDb>,
    params: RevokeMachineParams,
  ) => Promise<RevokeMachineResult>;
  db?: ReturnType<typeof getDb>;
};

/**
 * Pure-ish twin of the Server Action — no Next.js runtime needed. Admin-only
 * (stricter than the invite flow's manager|admin) because revoking a push
 * credential is destructive. Re-checks role + orgId + user.id defensively on
 * top of the middleware/layout gates.
 */
export const revokeMachineImpl = async (
  prefix: string,
  deps: RevokeMachineImplDeps,
): Promise<RevokeMachineActionResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const userId = session?.user?.id;
  // Strict admin — a manager or member is rejected here even though they can
  // reach other /manager/* surfaces.
  if (role !== 'admin' || !orgId || !userId) {
    return { ok: false, code: 'unauthorized' };
  }

  const parsed = revokeMachineSchema.safeParse(prefix);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }

  const coreFn = deps.core ?? revokeMachineCore;
  const db = deps.db ?? getDb();
  const result = await coreFn(db, {
    orgId,
    actorUserId: userId,
    keyPrefix: parsed.data,
  });

  switch (result.kind) {
    case 'revoked':
    case 'already-revoked':
      // Idempotent success — a double-click race lands here and is fine.
      return { ok: true, kind: result.kind };
    case 'collision':
      return { ok: false, code: 'collision' };
    case 'not-found':
      return { ok: false, code: 'not_found' };
    default: {
      const _exhaustive: never = result;
      throw new Error(`unhandled revoke kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

/**
 * Production Server Action bound to the per-row revoke form. On success,
 * `revalidatePath` re-renders the list (row flips to "revoked"). On a
 * collision or not-found, redirect back with an `?error=` so the page banner
 * can explain (collision → use the full-key SQL fallback).
 */
export const revokeMachineAction = async (formData: FormData): Promise<void> => {
  const prefix = String(formData.get('prefix') ?? '');
  const result = await revokeMachineImpl(prefix, { authFn: lazyDefaultAuth });
  if (result.ok) {
    revalidatePath('/manager/admin/machines');
    return;
  }
  redirect(`/manager/admin/machines?error=${result.code}`);
};
