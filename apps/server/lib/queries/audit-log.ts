/**
 * Audit-log writer for admin onboarding operations
 * (central-server-onboarding REQ-3, REQ-18, REQ-19).
 *
 * Appends one row per admin op (invite-created or invite-revoked). Rows are
 * the only durable trail of who provisioned what — `actor_user_id` is
 * NULLABLE (`ON DELETE SET NULL`) at the schema level so deleting a manager
 * preserves the historical row. We intentionally accept `actorUserId: null`
 * here so the helper compiles with whatever upstream auth state the caller
 * has (e.g. system-issued invites in a future cron-driven path), but normal
 * Server-Action callers will always pass a concrete UUID.
 *
 * `targetTokenPrefix` is the 8-char prefix; the full token is NEVER stored
 * in audit log (CHECK constraint `length(target_token_prefix) = 8` enforces
 * the shape at the DB level — see schema.ts).
 *
 * Two helpers because the metadata shape differs:
 *   - create: `{max_uses, expires_at, email_pattern, team_id}` (TC-I-60c)
 *   - revoke: no metadata (passing NULL — TC-I-61)
 *
 * Both wrap a single Drizzle insert; we keep them as separate exports so
 * the call sites read at a glance ("audit a CREATE here, not a REVOKE").
 */
import { onboardingAuditLog } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type WriteAuditCreateParams = {
  orgId: string;
  /** NULLABLE — preserves the row when an actor is deleted. */
  actorUserId: string | null;
  /** First 8 chars of the invite token; CHECK-constrained to length 8. */
  targetTokenPrefix: string;
  /** Captured at create time so a later revoke doesn't lose this context. */
  metadata: {
    max_uses: number;
    expires_at: string; // ISO8601 — the row's `expires_at` is stringified for stable JSONB
    email_pattern: string | null;
    team_id: string | null;
  };
};

export type WriteAuditRevokeParams = {
  orgId: string;
  actorUserId: string | null;
  targetTokenPrefix: string;
};

export const writeAuditCreate = async (
  db: Db | DrizzleTx,
  params: WriteAuditCreateParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'invite-created',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: params.metadata,
  });
};

export const writeAuditRevoke = async (
  db: Db | DrizzleTx,
  params: WriteAuditRevokeParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'invite-revoked',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: null,
  });
};
