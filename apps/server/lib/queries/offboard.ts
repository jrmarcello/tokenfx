/**
 * Admin offboarding: anonymize a departed dev's identity in place.
 * Spec: .specs/data-retention-policy.md (REQ-4, REQ-5, REQ-6).
 *
 * The user row is UPDATEd, never DELETEd — a delete would cascade away the
 * dev's aggregate rows, changing historical org/team totals. Anonymization
 * keeps the same `user_id` so the totals are unchanged while the identity
 * (email, display name, SSO binding) is scrubbed and all machines revoked.
 *
 * Everything runs in a single transaction: a failure anywhere rolls the whole
 * thing back, so there is never a partially-anonymized user.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';
import {
  managerDrilldownAudit,
  onboardingAuditLog,
  userMachines,
  users,
} from '@/lib/db/schema';
import { writeAuditUserOffboarded } from '@/lib/queries/audit-log';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ANON_DOMAIN = '@anonymized.invalid';

/** Deterministic, unique-by-construction anonymized email for a user UUID. */
export const anonymizedEmailFor = (userId: string): string =>
  `departed-${userId}${ANON_DOMAIN}`;

const isAnonymized = (email: string): boolean => email.endsWith(ANON_DOMAIN);

/**
 * The self-guarding anonymize UPDATE, exported so a test can prove it no-ops
 * for a foreign org even if the resolve is bypassed (TC-I-09b). Returns rows
 * affected. The `org_id` predicate rides on the mutation, not just the resolve.
 */
export const offboardAnonymizeUpdateForTest = async (
  db: Db | DrizzleTx,
  params: { orgId: string; userId: string },
): Promise<number> => {
  const res = await db
    .update(users)
    .set({
      email: anonymizedEmailFor(params.userId),
      displayName: null,
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)));
  return (res as unknown as { rowCount: number }).rowCount ?? 0;
};

export type OffboardUserParams = {
  orgId: string;
  actorUserId: string;
  targetUserId: string;
};

export type OffboardUserResult =
  | { kind: 'offboarded' }
  | { kind: 'already-offboarded' }
  | { kind: 'not-found' }
  | { kind: 'self-offboard-blocked' };

/**
 * DI seams — tests inject throwing stubs to prove the transaction rolls back,
 * and to verify each residual-PII scrub runs.
 */
export type OffboardUserDeps = {
  revokeMachines?: (tx: DrizzleTx, targetUserId: string) => Promise<void>;
  scrubLegacyAudit?: (tx: DrizzleTx, targetUserId: string, oldEmail: string) => Promise<void>;
  scrubReasonText?: (tx: DrizzleTx, targetUserId: string) => Promise<void>;
  writeAudit?: typeof writeAuditUserOffboarded;
};

const defaultRevokeMachines = async (tx: DrizzleTx, targetUserId: string): Promise<void> => {
  await tx
    .update(userMachines)
    .set({ revokedAt: new Date() })
    .where(and(eq(userMachines.userId, targetUserId), isNull(userMachines.revokedAt)));
};

/**
 * Remove the `userEmail` key from any legacy `machine-revoked` audit metadata
 * for the departed user (older rows written before the metadata switched to
 * `userId`). Matches by `machineId` → user_machines OR by the stored plaintext
 * email itself — so a legacy row with an absent/null `machineId` (which the
 * machineId join would miss) is still scrubbed. Must run with the PRE-
 * anonymization email, captured before the users UPDATE.
 */
const defaultScrubLegacyAudit = async (
  tx: DrizzleTx,
  targetUserId: string,
  oldEmail: string,
): Promise<void> => {
  await tx.execute(sql`
    UPDATE onboarding_audit_log
    SET metadata = ${onboardingAuditLog.metadata} - 'userEmail'
    WHERE ${onboardingAuditLog.action} = 'machine-revoked'
      AND (
        (${onboardingAuditLog.metadata} ->> 'machineId') IN (
          SELECT machine_id::text FROM user_machines WHERE user_id = ${targetUserId}
        )
        OR (${onboardingAuditLog.metadata} ->> 'userEmail') = ${oldEmail}
      )
  `);
};

const defaultScrubReasonText = async (tx: DrizzleTx, targetUserId: string): Promise<void> => {
  await tx
    .update(managerDrilldownAudit)
    .set({ reasonText: null })
    .where(eq(managerDrilldownAudit.targetUserId, targetUserId));
};

/**
 * Idempotent, org-scoped, admin-triggered offboarding. Resolves the target in
 * the actor's org, refuses self-offboard, then in one transaction anonymizes
 * the identity, revokes machines, scrubs residual PII, and writes the audit
 * row.
 */
export const offboardUserCore = async (
  db: Db,
  params: OffboardUserParams,
  deps: OffboardUserDeps = {},
): Promise<OffboardUserResult> => {
  // Guard before touching the DB — an admin must not lock themselves out.
  if (params.targetUserId === params.actorUserId) {
    return { kind: 'self-offboard-blocked' };
  }
  const revokeMachines = deps.revokeMachines ?? defaultRevokeMachines;
  const scrubLegacyAudit = deps.scrubLegacyAudit ?? defaultScrubLegacyAudit;
  const scrubReasonText = deps.scrubReasonText ?? defaultScrubReasonText;
  const writeAudit = deps.writeAudit ?? writeAuditUserOffboarded;

  return db.transaction(async (tx) => {
    const matches = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.id, params.targetUserId), eq(users.orgId, params.orgId)))
      .limit(1);

    if (matches.length === 0) return { kind: 'not-found' } as const;
    const target = matches[0];
    if (isAnonymized(target.email)) return { kind: 'already-offboarded' } as const;
    // Capture the pre-anonymization email so the legacy-audit scrub can also
    // match rows by email (defense-in-depth for absent machineId).
    const oldEmail = target.email;

    // Single self-guarding UPDATE code path (shared with the exported
    // ForTest helper so the org predicate can never drift out of sync).
    await offboardAnonymizeUpdateForTest(tx, { orgId: params.orgId, userId: target.id });

    await revokeMachines(tx, target.id);
    await scrubLegacyAudit(tx, target.id, oldEmail);
    await scrubReasonText(tx, target.id);
    await writeAudit(tx, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      targetTokenPrefix: target.id.replace(/-/g, '').slice(0, 8),
      metadata: { targetUserId: target.id },
    });

    return { kind: 'offboarded' } as const;
  });
};
