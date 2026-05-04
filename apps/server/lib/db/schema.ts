import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
    // manager-dashboard-v2 (REQ-18): NULL allowed for users created before
    // this column existed. Populated on next SSO login by `auth.ts:signIn`
    // from `profile.name`. UI/queries fall back to email local-part via
    // `displayLabelFor()` and `COALESCE(display_name, split_part(email,'@',1))`.
    displayName: text('display_name'),
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

// ---------------------------------------------------------------------------
// manager-dashboard-v2 — effectiveness depth + health signals (Q2-C/Q2-D).
// 7 new tables — see `.specs/manager-dashboard-v2.md` Design / DDL section.
// Partial indexes (`idx_mda_dismiss_until`, `idx_mn_pending`) and the RLS
// column GRANTs on manager_drilldown_audit live in the migration's raw-SQL
// postlude — Drizzle's `index().on()` does not support `.where()` clauses,
// and DCL (GRANT/REVOKE/CREATE ROLE) is not modeled by drizzle-kit.
// ---------------------------------------------------------------------------

// REQ-20: team_metrics_daily — flat per-(org, team, day) rollup. NO
// metric_set discriminator (B6 lock — collapsed to one row, all metric
// columns flat; the discriminator was architecturally wasteful).
export const teamMetricsDaily = pgTable(
  'team_metrics_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    cacheHitRatioAvg: numeric('cache_hit_ratio_avg', { precision: 5, scale: 4 }),
    goodSessionPct: numeric('good_session_pct', { precision: 5, scale: 2 }),
    subagentAdoptionPct: numeric('subagent_adoption_pct', { precision: 5, scale: 2 }),
    compositeAvg: numeric('composite_avg', { precision: 5, scale: 2 }),
    totalSessions: integer('total_sessions').notNull().default(0),
    totalDevs: integer('total_devs').notNull().default(0),
    toolMixJson: jsonb('tool_mix_json'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.teamId, t.day] }),
    teamDayIdx: index('idx_tmd_team_day').on(t.teamId, t.day.desc()),
  }),
);

// REQ-15: manager_drilldown_audit — append-only audit. UNIQUE on
// (manager_user_id, target_user_id, viewed_on, reason) drives the
// idempotent ON CONFLICT upsert. RLS column grants (postlude) make
// the table append-only at the DB layer; writeAudit() enforces it
// at the code layer too as defense in depth.
export const managerDrilldownAudit = pgTable(
  'manager_drilldown_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    reasonText: text('reason_text'),
    sourceRoute: text('source_route').notNull(),
    // /24 IPv4 or /48 IPv6 truncated CIDR string; NULLed by cleanup cron
    // after 30d (matches spec 3 REQ-27 retention policy).
    ipAddressTrunc: text('ip_address_trunc'),
    viewedOn: date('viewed_on').notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reasonCheck: check(
      'manager_drilldown_audit_reason_check',
      sql`${t.reason} IN ('training-check','quota-investigation','cost-investigation','other')`,
    ),
    uniqDay: unique('manager_drilldown_audit_unique_day').on(
      t.managerUserId,
      t.targetUserId,
      t.viewedOn,
      t.reason,
    ),
    targetViewedIdx: index('idx_mda_target_viewed').on(t.targetUserId, t.viewedAt.desc()),
    managerViewedIdx: index('idx_mda_manager_viewed').on(t.managerUserId, t.viewedAt.desc()),
  }),
);

// REQ-22: manager_anomalies — nightly cron output. Idempotent on
// (org, team, dev, kind, day). 'knowledge-sharing' kind is reserved
// for forward-compat (currently computed live).
export const managerAnomalies = pgTable(
  'manager_anomalies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    detectedOn: date('detected_on').notNull(),
    contextJson: jsonb('context_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCheck: check(
      'manager_anomalies_kind_check',
      sql`${t.kind} IN ('spend-spike-30d','spend-spike-wow','dropoff-wow','knowledge-sharing')`,
    ),
    uniqRow: unique('manager_anomalies_unique_row').on(
      t.orgId,
      t.teamId,
      t.targetUserId,
      t.kind,
      t.detectedOn,
    ),
  }),
);

// REQ-22 (dismiss): manager_dismissed_anomalies — per-manager 7-day
// dismissals. The UNIQUE key intentionally includes manager_user_id —
// dismissals are PER MANAGER, not org-wide. The partial index on
// (manager_user_id, dismissed_until) WHERE dismissed_until > now() is
// in the migration's raw-SQL postlude (Drizzle's index().on() does NOT
// support .where() clauses).
export const managerDismissedAnomalies = pgTable(
  'manager_dismissed_anomalies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dismissedUntil: timestamp('dismissed_until', { withTimezone: true }).notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqRow: unique('manager_dismissed_anomalies_unique_row').on(
      t.orgId,
      t.managerUserId,
      t.targetUserId,
      t.kind,
    ),
  }),
);

// REQ-20: org_settings — org-wide configuration. NEW (does not exist
// in spec 1 / spec 3). One row per org, FK CASCADE on org_id.
export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  drilldownNotificationEnabled: boolean('drilldown_notification_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// REQ-23: cron_runs — every cron invocation regardless of outcome.
// NEW (does not exist in spec 1 / spec 3).
export const cronRuns = pgTable(
  'cron_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobName: text('job_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
    rowsWritten: integer('rows_written'),
    errorMessage: text('error_message'),
  },
  (t) => ({
    statusCheck: check(
      'cron_runs_status_check',
      sql`${t.status} IN ('running','ok','failed')`,
    ),
    jobStartedIdx: index('idx_cron_runs_job_started').on(t.jobName, t.startedAt.desc()),
  }),
);

// REQ-16: manager_notifications — DB-backed notification queue stub.
// THIS spec writes 'pending' rows; a follow-up spec adds the actual
// delivery worker. Tests verify rows present (NO mock channels —
// Q9 lock). Partial index on `WHERE status = 'pending'` lives in the
// migration's raw-SQL postlude.
export const managerNotifications = pgTable(
  'manager_notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('pending'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    errorMessage: text('error_message'),
  },
  (t) => ({
    statusCheck: check(
      'manager_notifications_status_check',
      sql`${t.status} IN ('pending','sent','failed')`,
    ),
    targetEnqueuedIdx: index('idx_mn_target_enqueued').on(
      t.targetUserId,
      t.enqueuedAt.desc(),
    ),
  }),
);
