-- TokenFx central reporter server — onboarding migration (v1)
-- Spec: .specs/central-server-onboarding.md (REQ-1..4)
-- Hand-crafted (matches schema.ts) to keep idempotency consistent with 0000_init.sql.
-- drizzle-kit's auto-generated 0001 was discarded because the empty 0000_snapshot
-- caused it to re-emit every existing CREATE TABLE.

-- REQ-2, REQ-3: enums for redemption outcome + audit action.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_outcome') THEN
    CREATE TYPE onboarding_outcome AS ENUM (
      'accepted',
      'token-invalid',
      'token-expired',
      'token-revoked',
      'token-exhausted',
      'email-mismatch',
      'rate-limited',
      'validation-error',
      'infra-error'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_audit_action') THEN
    CREATE TYPE onboarding_audit_action AS ENUM (
      'invite-created',
      'invite-revoked'
    );
  END IF;
END $$;

-- REQ-4: relax users.sso_provider / users.sso_subject to NULLABLE so invite-
-- provisioned users can exist before their first SSO login fills these.
ALTER TABLE users ALTER COLUMN sso_provider DROP NOT NULL;
ALTER TABLE users ALTER COLUMN sso_subject DROP NOT NULL;

-- REQ-1: onboarding_invites — manager-issued invite tokens.
CREATE TABLE IF NOT EXISTS onboarding_invites (
  token text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  email_pattern text,
  max_uses integer NOT NULL DEFAULT 1,
  used_count integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT max_uses_positive CHECK (max_uses >= 1)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_invites_org_created
  ON onboarding_invites (org_id, created_at);

-- Functional expression index — supports the 8-char-prefix lookup used by the
-- revoke flow (REQ-19) and the redemption-log token_prefix correlation.
CREATE INDEX IF NOT EXISTS idx_onboarding_invites_prefix
  ON onboarding_invites (left(token, 8));

-- REQ-2: onboarding_redemption_log — audit trail for every redeem attempt.
-- machine_id is NULL on rejection. email_domain + email_hash only — never the
-- full email (privacy invariant; see spec Threat Model).
CREATE TABLE IF NOT EXISTS onboarding_redemption_log (
  id bigserial PRIMARY KEY,
  token_prefix text NOT NULL,
  machine_id uuid,
  email_domain text NOT NULL,
  email_hash text NOT NULL,
  request_ip text,
  outcome onboarding_outcome NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redemption_log_received
  ON onboarding_redemption_log (received_at);

CREATE INDEX IF NOT EXISTS idx_redemption_log_outcome
  ON onboarding_redemption_log (outcome, received_at);

-- REQ-3: onboarding_audit_log — admin operation log (create/revoke).
-- actor_user_id ON DELETE SET NULL preserves the historical row when a manager
-- is deleted (audit invariant). target_token_prefix length pinned to 8.
CREATE TABLE IF NOT EXISTS onboarding_audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action onboarding_audit_action NOT NULL,
  target_token_prefix text NOT NULL,
  metadata jsonb,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT token_prefix_len CHECK (length(target_token_prefix) = 8)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org_occurred
  ON onboarding_audit_log (org_id, occurred_at);
