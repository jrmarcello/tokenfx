-- TokenFx central reporter server — invite-token hash-at-rest migration
-- Spec: .specs/security-hardening-lowsev.md (REQ-1)
-- Hand-crafted (matches schema.ts) — pure SQL, no drizzle-kit auto-gen.
--
-- ============================================================================
-- Hashes the onboarding invite token at rest. Before this migration
-- `onboarding_invites.token` was the PLAINTEXT 64-hex bearer credential AND
-- the primary key, so a read-only DB leak (backup / log dump) exposed every
-- un-redeemed invite in directly-usable form. After this migration the PK is
-- `token_hash = sha256(plaintext)` and a new `token_prefix` column keeps the
-- first 8 chars of the PLAINTEXT for UI / audit correlation (the redemption
-- log already stores `token_prefix` derived from the plaintext at redeem time).
--
-- SHA-256 (not bcrypt): the token has 256 bits of crypto-random entropy, and
-- redeem resolves it via `WHERE token_hash = ?` (PK equality) — bcrypt's
-- per-call salt would make that indexed lookup impossible. Full rationale in
-- `lib/auth/tokens.ts` (`hashInviteToken`).
--
-- `digest()` comes from pgcrypto, enabled since 0000_init.sql. The backfill is
-- idempotent via the `token_prefix IS NULL` guard: `token_prefix` is the only
-- signal that exists exclusively pre-migration (a 64-hex hash is
-- indistinguishable from a 64-hex plaintext, so a content-based guard is
-- impossible). Re-running the backfill therefore never double-hashes an
-- already-migrated row.
-- ============================================================================

-- 1. Add the plaintext-prefix column NULLable first — Postgres cannot add a
--    NOT NULL column without a default to a non-empty table. NOT NULL is
--    enforced in step 4, after the backfill populates every row. IF NOT EXISTS
--    keeps the step re-runnable (every DDL step here is guarded so the whole
--    file is idempotent under a manual raw-SQL re-apply — REQ-1).
ALTER TABLE onboarding_invites ADD COLUMN IF NOT EXISTS token_prefix text;

--> statement-breakpoint

-- 2. Rename the credential column. Metadata-only — preserves the PRIMARY KEY
--    and every existing row; no foreign key references onboarding_invites(token).
--    Guarded so a re-run (where the column is already `token_hash`) is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'onboarding_invites' AND column_name = 'token'
  ) THEN
    ALTER TABLE onboarding_invites RENAME COLUMN token TO token_hash;
  END IF;
END $$;

--> statement-breakpoint

-- 3. Backfill the prefix from the still-plaintext value, THEN overwrite the
--    column with its SHA-256. Both SET expressions read the PRE-UPDATE row, so
--    `left(token_hash, 8)` sees the plaintext even though the same statement
--    also hashes `token_hash`. Guarded by `token_prefix IS NULL` so a re-run is
--    a no-op (idempotent — never hashes an already-hashed value a second time).
UPDATE onboarding_invites
  SET token_prefix = left(token_hash, 8),
      token_hash = encode(digest(token_hash, 'sha256'), 'hex')
  WHERE token_prefix IS NULL;

--> statement-breakpoint

-- 4. Every row now has a prefix — enforce NOT NULL to match schema.ts.
ALTER TABLE onboarding_invites ALTER COLUMN token_prefix SET NOT NULL;

--> statement-breakpoint

-- 5. Swap the prefix index off the old functional expression `left(token, 8)`
--    (that column no longer exists, and the digest's prefix is useless for
--    correlation) onto the physical `token_prefix` column. DROP IF EXISTS keeps
--    the step re-runnable.
DROP INDEX IF EXISTS idx_onboarding_invites_prefix;
CREATE INDEX IF NOT EXISTS idx_onboarding_invites_prefix ON onboarding_invites (token_prefix);
