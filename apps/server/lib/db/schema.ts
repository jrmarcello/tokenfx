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
    email: text('email').notNull(),
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
    // central-server-onboarding-v2-sso (REQ-18): the global email UNIQUE
    // was replaced by (org_id, email) — the same email may exist in
    // different orgs (multi-tenant), but only once per org. SSO matching
    // is scoped per org.
    orgEmailUnique: unique('users_org_email_unique').on(t.orgId, t.email),
    // central-server-onboarding-v2-sso (REQ-18): single SSO identity
    // per org. Prevents multiple users in the same org binding to the
    // same (provider, subject) pair after first-login auto-provision.
    orgSsoUnique: unique('users_org_sso_unique').on(t.orgId, t.ssoProvider, t.ssoSubject),
  }),
);

export const userMachines = pgTable(
  'user_machines',
  {
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
    // central-server-onboarding-v2-sso (REQ-18): how this machine credential
    // was provisioned. 'pre-v2-unknown' default backfills historic rows
    // created before this column existed; new rows are written explicitly
    // as 'manual-token' (invite redemption) or 'sso-auto' (auto-provision).
    provisionedVia: text('provisioned_via').notNull().default('pre-v2-unknown'),
  },
  (t) => ({
    provisionedViaCheck: check(
      'user_machines_provisioned_via_check',
      sql`${t.provisionedVia} IN ('manual-token', 'sso-auto', 'pre-v2-unknown')`,
    ),
  }),
);

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

// Note (central-server-onboarding-v2-sso, migration 0004): the live PG enum
// has been widened with 10 SSO-auto outcomes via `ALTER TYPE ADD VALUE`. The
// Drizzle pgEnum declaration is purely type-level (no DDL generated) — we
// widen it here so TypeScript accepts INSERTs with the new values via the
// `redemption-log` writer used by the SSO auto-provision flow (TASK-10).
export const onboardingOutcomeEnum = pgEnum('onboarding_outcome', [
  // v1 values (migration 0001)
  'accepted',
  'token-invalid',
  'token-expired',
  'token-revoked',
  'token-exhausted',
  'email-mismatch',
  'rate-limited',
  'validation-error',
  'infra-error',
  // v2 SSO-auto values (migration 0004 — central-server-onboarding-v2-sso)
  'accepted-sso-auto',
  'rejected-public-domain',
  'rejected-multiple-matches',
  'rejected-no-match',
  'rejected-race',
  'rejected-csrf',
  'rejected-replay',
  'rejected-cross-idp',
  'rejected-pre-existing-binding',
  'email-not-verified',
]);

export const onboardingAuditActionEnum = pgEnum('onboarding_audit_action', [
  'invite-created',
  'invite-revoked',
]);

// REQ-1: onboarding_invites — manager-issued invite tokens for new dev machines.
// `created_by` is NULLABLE (ON DELETE SET NULL) so deleting a manager preserves
// the historical row (audit invariant). `team_id` is NULLABLE; deleting a team
// SET NULLs the column rather than cascading the invite.
//
// security-hardening-lowsev (REQ-1): the invite token is stored HASHED at rest.
// `token_hash` (PK) holds `sha256(plaintext)` — the plaintext bearer token is
// never persisted (a read-only DB leak no longer exposes usable credentials).
// `token_prefix` holds the first 8 chars of the PLAINTEXT for UI/audit
// correlation (it matches `onboarding_redemption_log.token_prefix`, which is
// derived from the plaintext at redeem time). See `lib/auth/tokens.ts`.
export const onboardingInvites = pgTable(
  'onboarding_invites',
  {
    tokenHash: text('token_hash').primaryKey(),
    tokenPrefix: text('token_prefix').notNull(),
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
    // central-server-onboarding-v2-sso (REQ-18): whitelist of SSO providers
    // accepted by this invite (e.g. ['google','microsoft']). Empty array
    // means "no SSO restriction — manual-token redeem only". Stored as
    // text[] (Postgres native array) to keep queries indexable.
    allowedSsoProviders: text('allowed_sso_providers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => ({
    maxUsesCheck: check('max_uses_positive', sql`${t.maxUses} >= 1`),
    orgCreatedIdx: index('idx_onboarding_invites_org_created').on(t.orgId, t.createdAt),
    // Supports the 8-char-prefix lookup for the revoke flow (REQ-19). Since
    // security-hardening-lowsev (REQ-1) the plaintext prefix is a physical
    // column (`token_prefix`), so the index is a plain column index rather than
    // the old functional expression `left(token, 8)` (which now hashes to the
    // prefix of the digest — meaningless for correlation).
    prefixIdx: index('idx_onboarding_invites_prefix').on(t.tokenPrefix),
    // central-server-onboarding-v2-sso (REQ-18): invites with an
    // email_pattern (SSO-eligible) MUST expire within 180 days — caps
    // the blast radius of a leaked invite that auto-provisions on first
    // SSO login. Manual-token invites (email_pattern IS NULL) are
    // exempted from the cap.
    ssoExpiresCheck: check(
      'onboarding_invites_sso_expires_check',
      sql`${t.emailPattern} IS NULL OR ${t.expiresAt} <= ${t.createdAt} + INTERVAL '180 days'`,
    ),
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
    // central-server-onboarding-v2-sso (REQ-18): distinguishes manual-token
    // redeems (the historic path) from sso-auto provisioning. Default
    // 'manual-token' preserves the pre-v2 invariant for historic rows.
    method: text('method').notNull().default('manual-token'),
    // SSO context — populated when method = 'sso-auto'. NULL for manual-token.
    // ssoSubjectHash is peppered (same pepper as auth_event_log.ssoSubjectHash)
    // to keep the raw subject out of audit storage.
    ssoProvider: text('sso_provider'),
    ssoSubjectHash: text('sso_subject_hash'),
    iss: text('iss'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    receivedIdx: index('idx_redemption_log_received').on(t.receivedAt),
    outcomeIdx: index('idx_redemption_log_outcome').on(t.outcome, t.receivedAt),
    // central-server-onboarding-v2-sso (REQ-18): the redemption method
    // is exhaustive — only the two valid paths. 'pre-v2-unknown' is NOT
    // a valid method here (historic rows pre-date the column; default
    // 'manual-token' is correct for them).
    methodCheck: check(
      'onboarding_redemption_log_method_check',
      sql`${t.method} IN ('manual-token', 'sso-auto')`,
    ),
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

// ============================================================================
// manager-dashboard-v3-outcomes (REQ-8): per-session outcome data.
// ALL metric columns NULLABLE — preserves "not computed" vs "computed and 0"
// distinction (REQ-9). Composite FK to sessions_agg(user_id, session_id)
// added in raw SQL migration (same pattern as model_breakdown_agg).
// No additional index — rollup queries drive from
// sessions_agg.idx_sessions_agg_user_started.
// ============================================================================
export const sessionOutcomesAgg = pgTable(
  'session_outcomes_agg',
  {
    userId: uuid('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    commitCount: integer('commit_count'),
    locAdded: integer('loc_added'),
    locRemoved: integer('loc_removed'),
    filesChanged: integer('files_changed'),
    revertsWithin7d: integer('reverts_within_7d'),
    mergedPrCount: integer('merged_pr_count'),
    // Stored as text + CHECK constraint in migration (see 0003 raw SQL).
    // Drizzle pgEnum was rejected to avoid coupling enum migrations to
    // local-schema enum drift (manager-dashboard-v3-outcomes spec REQ-3).
    outcomeStatus: text('outcome_status'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.sessionId] }),
  }),
);

// Compound FK to sessions_agg(user_id, session_id) ON DELETE CASCADE is
// added in 0003 migration raw SQL — same pattern as model_breakdown_agg.

// ============================================================================
// manager-dashboard-v3-outcomes (REQ-10): per (org, team, day) outcome
// rollup. Computed by `aggregate-team-outcomes` cron from session_outcomes_agg
// JOINed via sessions_agg → users → team_id. Filters to outcome_status =
// 'evaluated' before SUM (non-evaluated rows excluded from rollup).
// NO org-level aggregate row (Postgres PK columns can't be NULL; org-level
// rollups are computed in JS at the page component, mirroring Fase 4
// effectiveness/page.tsx).
// ============================================================================
export const teamOutcomesDaily = pgTable(
  'team_outcomes_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    totalCommits: integer('total_commits').notNull().default(0),
    totalLocAdded: integer('total_loc_added').notNull().default(0),
    totalLocRemoved: integer('total_loc_removed').notNull().default(0),
    totalFilesChanged: integer('total_files_changed').notNull().default(0),
    totalRevertsWithin7d: integer('total_reverts_within_7d').notNull().default(0),
    // NULL when ALL contributing sessions had merged_pr_count = NULL
    // (preserves "feature off / no data" vs "feature on, 0 PRs").
    totalMergedPrCount: integer('total_merged_pr_count'),
    totalInputTokens: bigint('total_input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    totalOutputTokens: bigint('total_output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    totalCostUsd: numeric('total_cost_usd', { precision: 14, scale: 6 })
      .notNull()
      .default('0'),
    // Denominator for `avg_merged_prs_per_session_with_outcome`. NOT the
    // denominator for `revert_rate` (that uses total_commits).
    sessionsWithOutcome: integer('sessions_with_outcome').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.teamId, t.day] }),
  }),
);

// ============================================================================
// central-server-onboarding-v2-sso (REQ-18): auth_event_log — append-only
// privacy-safe audit of every SSO login attempt (accepted + rejected).
// Stores only peppered hashes of email + subject (NEVER the raw values),
// plus coarse network context (ip, city, user_agent). Drives the rate-limit
// + replay defenses (idx by subject + by email + by iss). Outcome enum is
// stored as text + CHECK to avoid coupling enum migrations to schema drift.
// ============================================================================
export const authEventLog = pgTable(
  'auth_event_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ssoProvider: text('sso_provider').notNull(),
    iss: text('iss').notNull(),
    emailHash: text('email_hash').notNull(),
    ssoSubjectHash: text('sso_subject_hash'),
    ip: text('ip'),
    city: text('city'),
    userAgent: text('user_agent'),
    outcome: text('outcome').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Indexes drive the rate-limit + replay-defense lookups: bound on
    // (subject, time), (email, time), (iss, time) respectively. `occurred_at`
    // is the trailing column on each so range scans are O(log n).
    subjectOccurredIdx: index('idx_auth_event_log_subject_occurred').on(
      t.ssoSubjectHash,
      t.occurredAt,
    ),
    emailOccurredIdx: index('idx_auth_event_log_email_occurred').on(t.emailHash, t.occurredAt),
    issOccurredIdx: index('idx_auth_event_log_iss_occurred').on(t.iss, t.occurredAt),
    // Exhaustive outcome enum — every rejection reason has a dedicated
    // string so dashboards can pivot by failure cause without parsing.
    outcomeCheck: check(
      'auth_event_log_outcome_check',
      sql`${t.outcome} IN ('accepted-sso-auto', 'rejected-public-domain', 'rejected-multiple-matches', 'rejected-no-match', 'rejected-race', 'rejected-csrf', 'rejected-replay', 'rejected-cross-idp', 'rejected-pre-existing-binding', 'email-not-verified')`,
    ),
  }),
);

// central-server-onboarding-v2-sso.manager-ui (REQ-1, REQ-2) — Decisão #15.
// Per-event acknowledge state for manager dashboard banners. A manager-event
// pair is "acknowledged" iff a row exists; the application UPSERTs via
// `.onConflictDoNothing()` so the FIRST `ackedAt` is preserved (forensic
// invariant: "when did each admin first see this event"). Composite PK on
// (managerUserId, alertKind, eventId) is the natural lookup key — no
// surrogate `id`. The supporting index on (managerUserId, alertKind) drives
// the NOT-IN anti-join used by the banner query.
export const managerAlertAcks = pgTable(
  'manager_alert_acks',
  {
    managerUserId: uuid('manager_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // `alertKind` is constrained by CHECK to the single value
    // 'first-auto-provision' for now. Extending to new kinds is a single
    // constraint swap; the tighter check today catches typos in app code.
    alertKind: text('alert_kind').notNull(),
    // `eventId` references `onboarding_redemption_log.id` (bigserial).
    // ON DELETE CASCADE: if the audit row is pruned by retention policy,
    // the acknowledgement loses meaning and is also pruned.
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => onboardingRedemptionLog.id, { onDelete: 'cascade' }),
    ackedAt: timestamp('acked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: 'manager_alert_acks_pk',
      columns: [t.managerUserId, t.alertKind, t.eventId],
    }),
    kindCheck: check(
      'manager_alert_acks_kind_check',
      sql`${t.alertKind} IN ('first-auto-provision')`,
    ),
    userKindIdx: index('idx_manager_alert_acks_user_kind').on(t.managerUserId, t.alertKind),
  }),
);
