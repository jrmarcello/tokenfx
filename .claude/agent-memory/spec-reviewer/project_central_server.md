---
name: project context — central server specs
description: Key facts about what central-reporter-server (spec 3) + central-server-onboarding + manager-dashboard-v2 actually shipped, for downstream spec reviews
type: project
---

Spec 3 (central-reporter-server.md) shipped at commit 1ded383, status DONE.
central-server-onboarding shipped at commit 0594e39, status DONE. It absorbed the HMAC→bcrypt switch.
manager-dashboard-v2 shipped at commit 95c0f43, status DONE. Per-org cron probe, per-team rollups, /me/visibility, anti-surveillance audit.

## Schema facts (confirmed from apps/server/lib/db/schema.ts, post manager-dashboard-v2)

**users table — HAS `display_name` column (nullable).** Added by manager-dashboard-v2 (REQ-18). COALESCE(display_name, split_part(email,'@',1)) used everywhere.

**users.team_id:** nullable FK to teams.id (ON DELETE SET NULL). Confirmed.

**users.role enum:** text CHECK IN ('member','manager','admin'). Confirmed.

**sessions_agg — NO `team_id` column.** Per-session keyed on (user_id, session_id). Team join path: sessions_agg.user_id → users.user_id → users.team_id.

**sessions_agg has `subagent_usage_ratio` (numeric 4,3):** pre-computed ratio per session. No raw `subagent_count` integer.

**`org_settings` table EXISTS** (created by manager-dashboard-v2): (org_id PK FK orgs.id, drilldown_notification_enabled bool, created_at, updated_at).

**`cron_runs` table EXISTS** (created by manager-dashboard-v2): (id bigserial PK, job_name text, started_at, finished_at, status CHECK IN ('running','ok','failed'), rows_written, error_message).

**`team_metrics_daily` table EXISTS** (created by manager-dashboard-v2): PK (org_id, team_id, day). Columns: cache_hit_ratio_avg, good_session_pct, subagent_adoption_pct, composite_avg, total_sessions, total_devs, tool_mix_json, computed_at. NO outcome columns.

**`manager_drilldown_audit` table EXISTS** (manager-dashboard-v2): append-only, UNIQUE on (manager_user_id, target_user_id, viewed_on, reason).

**`manager_anomalies`, `manager_dismissed_anomalies`, `manager_notifications` tables EXIST** (manager-dashboard-v2).

**Cross-package Zod sharing:** `SanitizedSessionPayload` is defined in `lib/reporter/types.ts` (root). The server re-exports it via `apps/server/lib/ingest/sanitizer-shared.ts` using the `@root/*` path alias. The ingest route imports from `@/lib/ingest/sanitizer-shared`. Path alias `@root/*` → `../../lib/*` is defined in `apps/server/tsconfig.json`. The file `lib/reporter/types.ts` is explicitly included in tsconfig. This cross-package sharing IS clean and works — no duplication needed.

**lib/reporter/runner.ts** (root) — does NOT include session_outcomes in `selectCandidates`. The SessionRow type and SQL query must be extended by manager-dashboard-v3-outcomes spec.

**tool_count_agg shape:** (user_id, session_id, tool_name text, count integer).

**auth.ts — session.user.id IS populated.** jwt() callback sets token.userId; session() mirrors to session.user.id.

**middleware.ts:** lives at apps/server/middleware.ts (root matcher). Matcher covers /manager/:path* and /me/:path*.

**bcrypt auth:** BCRYPT_COST=10, bearer-auth.ts with 60s plaintext cache. Confirmed.

## Why

Accurate knowledge of what shipped prevents spec reviewers from approving specs that assume a different contract.

## How to apply

When reviewing specs that depend on central-reporter-server or manager-dashboard-v2, verify column names, unique constraints, and file paths against the actual shipped code before approving.
