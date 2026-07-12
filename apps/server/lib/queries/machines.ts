/**
 * Query layer for the admin machine-revocation UI.
 * Spec: .specs/machine-revocation-ui.md (REQ-1, REQ-2, REQ-3, REQ-5, REQ-6).
 *
 * `user_machines` has no `org_id` column — tenant scope is enforced via a join
 * on `users.org_id`. Both the read (`listOrgMachines`) AND the mutating UPDATE
 * carry the org predicate, so cross-org access is impossible even if the
 * resolving SELECT is refactored away (security rule: the write self-guards).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';
import { userMachines, users } from '@/lib/db/schema';
import { writeAuditMachineRevoked } from '@/lib/queries/audit-log';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** 8-char prefix (`k_` + 6 hex) — the only fragment of key_id that leaves the server. */
const PREFIX_LEN = 8;

/** First 8 chars of a key_id (`k_` + 6 hex). Satisfies the length-8 audit CHECK. */
export const maskKeyId = (keyId: string): string => keyId.slice(0, PREFIX_LEN);

export type MachineRow = {
  /** Stable unique row id (the machine's UUID) — used as the React list key. */
  machineId: string;
  keyPrefix: string;
  userEmail: string;
  provisionedVia: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};

/**
 * Every machine credential in the acting admin's org, active first. Only the
 * 8-char key prefix is exposed — never the full key_id or the secret_hash.
 */
export const listOrgMachines = async (
  db: Db,
  orgId: string,
): Promise<MachineRow[]> => {
  // Mask to the 8-char prefix IN SQL so the full key_id never enters JS memory
  // — and thus can never leak into an RSC flight payload / DOM. (A live check
  // caught the full key_id in the flight when masking was done app-side.)
  const rows = await db
    .select({
      machineId: userMachines.machineId,
      keyPrefix: sql<string>`left(${userMachines.keyId}, ${PREFIX_LEN})`,
      userEmail: users.email,
      provisionedVia: userMachines.provisionedVia,
      createdAt: userMachines.createdAt,
      lastSeenAt: userMachines.lastSeenAt,
      revokedAt: userMachines.revokedAt,
    })
    .from(userMachines)
    .innerJoin(users, eq(users.id, userMachines.userId))
    .where(eq(users.orgId, orgId))
    // Active (revoked_at NULL) first, then most-recently created.
    .orderBy(sql`${userMachines.revokedAt} IS NOT NULL`, desc(userMachines.createdAt));

  return rows.map((r) => ({
    machineId: r.machineId,
    keyPrefix: r.keyPrefix,
    userEmail: r.userEmail,
    provisionedVia: r.provisionedVia,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
  }));
};

export type RevokeMachineParams = {
  orgId: string;
  actorUserId: string;
  /** The 8-char key-id prefix (`k_` + 6 hex). */
  keyPrefix: string;
};

export type RevokeMachineResult =
  | { kind: 'revoked'; keyPrefix: string }
  | { kind: 'already-revoked'; keyPrefix: string }
  | { kind: 'not-found' }
  | { kind: 'collision'; matchCount: number };

/**
 * DI seams for the transactional revoke — tests inject throwing stubs to prove
 * the transaction rolls back (no revoke without audit, no partial state).
 */
export type RevokeMachineDeps = {
  writeAudit?: typeof writeAuditMachineRevoked;
  /** Runs the self-guarding UPDATE; returns rows affected. */
  runUpdate?: typeof revokeMachineUpdateForTest;
};

/**
 * The self-guarding UPDATE, exported so a test can prove it no-ops for a
 * foreign org even when handed a key_id resolved elsewhere (TC-I-05b). The
 * `user_id IN (SELECT ... org_id = $org)` predicate makes the mutation stand
 * on its own — it does not trust the preceding resolve.
 */
export const revokeMachineUpdateForTest = async (
  db: Db | DrizzleTx,
  params: { orgId: string; keyId: string },
): Promise<number> => {
  const res = await db
    .update(userMachines)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userMachines.keyId, params.keyId),
        isNull(userMachines.revokedAt),
        sql`${userMachines.userId} IN (SELECT id FROM users WHERE org_id = ${params.orgId})`,
      ),
    );
  // better-sqlite3 vs node-postgres both expose rowCount/changes; node-postgres
  // returns `{ rowCount }`. Drizzle's pg result surfaces it as `.rowCount`.
  return (res as unknown as { rowCount: number }).rowCount ?? 0;
};

/**
 * Idempotent, org-scoped machine revocation. Resolves the machine by 8-char
 * prefix within the org (0 → not-found, >1 → collision), then in a single
 * transaction sets `revoked_at` via the self-guarding UPDATE and writes the
 * `machine-revoked` audit row. If the audit write throws, the whole
 * transaction rolls back — a revocation is never recorded without its audit.
 */
export const revokeMachineCore = async (
  db: Db,
  params: RevokeMachineParams,
  deps: RevokeMachineDeps = {},
): Promise<RevokeMachineResult> => {
  if (params.keyPrefix.length !== PREFIX_LEN) {
    // Defense-in-depth — the Server Action's Zod also enforces this.
    return { kind: 'not-found' };
  }
  const writeAudit = deps.writeAudit ?? writeAuditMachineRevoked;
  const runUpdate = deps.runUpdate ?? revokeMachineUpdateForTest;

  return db.transaction(async (tx) => {
    const matches = await tx
      .select({
        keyId: userMachines.keyId,
        machineId: userMachines.machineId,
        revokedAt: userMachines.revokedAt,
        userEmail: users.email,
      })
      .from(userMachines)
      .innerJoin(users, eq(users.id, userMachines.userId))
      .where(
        and(
          eq(users.orgId, params.orgId),
          sql`left(${userMachines.keyId}, ${PREFIX_LEN}) = ${params.keyPrefix}`,
        ),
      )
      .limit(2);

    if (matches.length === 0) return { kind: 'not-found' } as const;
    if (matches.length > 1) {
      return { kind: 'collision', matchCount: matches.length } as const;
    }

    const row = matches[0];
    if (row.revokedAt !== null) {
      return { kind: 'already-revoked', keyPrefix: params.keyPrefix } as const;
    }

    await runUpdate(tx, { orgId: params.orgId, keyId: row.keyId });
    await writeAudit(tx, {
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      targetTokenPrefix: params.keyPrefix,
      metadata: {
        keyPrefix: params.keyPrefix,
        machineId: row.machineId,
        userEmail: row.userEmail,
      },
    });

    return { kind: 'revoked', keyPrefix: params.keyPrefix } as const;
  });
};
