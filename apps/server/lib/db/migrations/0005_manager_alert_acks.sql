-- TokenFx central reporter server — manager-alert-acks schema migration
-- Spec: .specs/central-server-onboarding-v2-sso.manager-ui.md (REQ-1, REQ-2)
-- Threat model: .specs/central-server-onboarding-v2-sso.threat-model.md (§Decisão #15)
-- Hand-crafted (matches schema.ts) — kept aligned with the prior-art style of 0004.
--
-- ============================================================================
-- Decisão #15 — per-event acknowledge for manager alert banners.
--
--   The manager dashboard renders a stacking banner ("N unacknowledged
--   events") for every auto-provision redemption row a given manager has
--   never explicitly seen. Acking event X must NOT collapse events Y, Z —
--   the forensic invariant is "when did each admin see which event". The
--   natural state for that question is the three-tuple (manager_user_id,
--   alert_kind, event_id) with a `acked_at` timestamp; no surrogate `id`
--   is needed because every read/write path is keyed by the three-tuple.
--
--   FK on `event_id → onboarding_redemption_log(id) ON DELETE CASCADE`
--   keeps the ack table consistent with the underlying audit row: if the
--   forensic event is ever pruned (e.g. data-retention sweep), the
--   acknowledgement loses its meaning and is also pruned. Same rationale
--   for the `manager_user_id → users(id) ON DELETE CASCADE`: an ack by a
--   deleted manager is forensically empty.
--
--   `acked_at` defaults to `now()`; the application performs an UPSERT
--   via Drizzle `.onConflictDoNothing()`, so the FIRST `acked_at` is
--   preserved (re-ack is a no-op). Schema does not enforce "first wins"
--   itself — that is an application-layer invariant.
--
--   CHECK on `alert_kind` restricts the column to the single value
--   `'first-auto-provision'` for now. Extending to new kinds is a single
--   constraint swap; the tighter check today catches typos in app code.
--
--   Index `idx_manager_alert_acks_user_kind (manager_user_id, alert_kind)`
--   supports the NOT-IN anti-join in the unacknowledged-events query:
--     `redemption_log_id NOT IN (SELECT event_id FROM manager_alert_acks
--      WHERE manager_user_id = $1 AND alert_kind = $2)`.
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_alert_acks (
  manager_user_id  uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_kind       text         NOT NULL,
  event_id         bigint       NOT NULL REFERENCES onboarding_redemption_log(id) ON DELETE CASCADE,
  acked_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT manager_alert_acks_pk PRIMARY KEY (manager_user_id, alert_kind, event_id),
  CONSTRAINT manager_alert_acks_kind_check CHECK (alert_kind IN ('first-auto-provision'))
);

CREATE INDEX IF NOT EXISTS idx_manager_alert_acks_user_kind
  ON manager_alert_acks (manager_user_id, alert_kind);
