import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
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
    ssoProvider: text('sso_provider').notNull(),
    ssoSubject: text('sso_subject').notNull(),
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
