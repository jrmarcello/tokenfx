import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    email: text('email').unique().notNull(),
    // NULLABLE since central-server-onboarding (REQ-4): invite-provisioned
    // users have no SSO yet. First SSO login fills these via auth.ts:signIn.
    ssoProvider: text('sso_provider'),
    ssoSubject: text('sso_subject'),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roleCheck: check('users_role_check', sql`${t.role} IN ('member','manager','admin')`),
  }),
);

export const userMachines = pgTable('user_machines', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  machineId: uuid('machine_id').notNull(),
  keyId: text('key_id').unique().notNull(),
  secretHash: text('secret_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const sessionsAgg = pgTable(
  'sessions_agg',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    projectSlug: text('project_slug').notNull(),
    gitBranch: text('git_branch'),
    ccVersion: text('cc_version'),
    totalInputTokens: bigint('total_input_tokens', { mode: 'number' }).notNull(),
    totalOutputTokens: bigint('total_output_tokens', { mode: 'number' }).notNull(),
    totalCacheReadTokens: bigint('total_cache_read_tokens', { mode: 'number' }).notNull(),
    totalCacheCreationTokens: bigint('total_cache_creation_tokens', { mode: 'number' }).notNull(),
    totalCostUsd: numeric('total_cost_usd', { precision: 14, scale: 6 }).notNull(),
    totalCostUsdOtel: numeric('total_cost_usd_otel', { precision: 14, scale: 6 }),
    turnCount: integer('turn_count').notNull(),
    toolCallCount: integer('tool_call_count').notNull(),
    avgRating: numeric('avg_rating', { precision: 4, scale: 3 }),
    cacheHitRatio: numeric('cache_hit_ratio', { precision: 4, scale: 3 }),
    outputInputRatio: numeric('output_input_ratio', { precision: 8, scale: 4 }),
    subagentUsageRatio: numeric('subagent_usage_ratio', { precision: 4, scale: 3 }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.sessionId] }),
    startedIdx: index('idx_sessions_agg_started').on(t.startedAt),
    userStartedIdx: index('idx_sessions_agg_user_started').on(t.userId, t.startedAt),
  }),
);

// Compound FK to sessions_agg(user_id, session_id) is added in the migration SQL
// (raw ALTER TABLE) — Drizzle's compound-FK syntax is awkward and we only need
// the runtime constraint, not the type-level reference here.
export const modelBreakdownAgg = pgTable(
  'model_breakdown_agg',
  {
    userId: uuid('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull(),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull(),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.sessionId, t.model] }),
  }),
);

export const toolCountAgg = pgTable(
  'tool_count_agg',
  {
    userId: uuid('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    count: integer('count').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.sessionId, t.toolName] }),
  }),
);

export const costCalibrationPerUser = pgTable(
  'cost_calibration_per_user',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    family: text('family').notNull(),
    effectiveRate: numeric('effective_rate', { precision: 6, scale: 4 }).notNull(),
    sampleSessionCount: integer('sample_session_count').notNull(),
    sumOtelCost: numeric('sum_otel_cost', { precision: 14, scale: 6 }).notNull(),
    sumLocalCost: numeric('sum_local_cost', { precision: 14, scale: 6 }).notNull(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.family] }),
  }),
);

export const ingestionLog = pgTable(
  'ingestion_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    userId: uuid('user_id'),
    machineId: uuid('machine_id').notNull(),
    keyId: text('key_id').notNull(),
    payloadSizeBytes: integer('payload_size_bytes').notNull(),
    acceptedCount: integer('accepted_count').notNull(),
    skippedCount: integer('skipped_count').notNull(),
    rejectedCount: integer('rejected_count').notNull(),
    requestIp: text('request_ip'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    errorsJson: jsonb('errors_json'),
  },
  (t) => ({
    receivedIdx: index('idx_ingestion_log_received').on(t.receivedAt),
    userIdx: index('idx_ingestion_log_user').on(t.userId, t.receivedAt),
  }),
);

// ---------------------------------------------------------------------------
// central-server-onboarding (REQ-1..3): invite-token onboarding tables.
// Outcome enum is defined module-level (Drizzle requires this for pgEnum).
// ---------------------------------------------------------------------------

export const onboardingOutcomeEnum = pgEnum('onboarding_outcome', [
  'accepted',
  'token-invalid',
  'token-expired',
  'token-revoked',
  'token-exhausted',
  'email-mismatch',
  'rate-limited',
  'validation-error',
  'infra-error',
]);

export const onboardingAuditActionEnum = pgEnum('onboarding_audit_action', [
  'invite-created',
  'invite-revoked',
]);

// REQ-1: onboarding_invites — manager-issued invite tokens for new dev machines.
// `created_by` is NULLABLE (ON DELETE SET NULL) so deleting a manager preserves
// the historical row (audit invariant). `team_id` is NULLABLE; deleting a team
// SET NULLs the column rather than cascading the invite.
export const onboardingInvites = pgTable(
  'onboarding_invites',
  {
    token: text('token').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    emailPattern: text('email_pattern'),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    maxUsesCheck: check('max_uses_positive', sql`${t.maxUses} >= 1`),
    orgCreatedIdx: index('idx_onboarding_invites_org_created').on(t.orgId, t.createdAt),
    // Functional expression index — supports the 8-char-prefix lookup for the
    // revoke flow (REQ-19). Drizzle's `index().on(sql\`...\`)` emits the raw
    // SQL `CREATE INDEX ... ON onboarding_invites (left(token, 8))`.
    prefixIdx: index('idx_onboarding_invites_prefix').on(sql`left(${t.token}, 8)`),
  }),
);

// REQ-2: onboarding_redemption_log — audit trail for redeem attempts.
// Privacy: stores `email_domain` + peppered `email_hash` only. NEVER the full email.
// `machine_id` is NULL on rejection (no row inserted in user_machines).
export const onboardingRedemptionLog = pgTable(
  'onboarding_redemption_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tokenPrefix: text('token_prefix').notNull(),
    machineId: uuid('machine_id'),
    emailDomain: text('email_domain').notNull(),
    emailHash: text('email_hash').notNull(),
    requestIp: text('request_ip'),
    outcome: onboardingOutcomeEnum('outcome').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    receivedIdx: index('idx_redemption_log_received').on(t.receivedAt),
    outcomeIdx: index('idx_redemption_log_outcome').on(t.outcome, t.receivedAt),
  }),
);

// REQ-3: onboarding_audit_log — admin operation log (create/revoke).
// `actor_user_id` NULLABLE (ON DELETE SET NULL) so deleting an actor preserves
// the historical row. `target_token_prefix` is constrained to length 8.
export const onboardingAuditLog = pgTable(
  'onboarding_audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: onboardingAuditActionEnum('action').notNull(),
    targetTokenPrefix: text('target_token_prefix').notNull(),
    metadata: jsonb('metadata'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenPrefixLenCheck: check('token_prefix_len', sql`length(${t.targetTokenPrefix}) = 8`),
    orgOccurredIdx: index('idx_audit_log_org_occurred').on(t.orgId, t.occurredAt),
  }),
);
