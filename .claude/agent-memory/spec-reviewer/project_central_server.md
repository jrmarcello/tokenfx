---
name: project context — central server specs
description: Key facts about what central-reporter-server (spec 3) + central-server-onboarding actually shipped, for downstream spec reviews
type: project
---

Spec 3 (central-reporter-server.md) shipped at commit 1ded383, status DONE.
central-server-onboarding shipped at commit 0594e39, status DONE. It absorbed the HMAC→bcrypt switch.

## Schema facts (confirmed from apps/server/lib/db/schema.ts)

**users table — NO `display_name` column.** Only: id, org_id, team_id (nullable), email (UNIQUE), sso_provider (nullable), sso_subject (nullable), role (CHECK in ('member','manager','admin')), created_at. Any spec that references `users.display_name` in ORDER BY or UI copy will fail at query time.

**users.team_id:** nullable FK to teams.id (ON DELETE SET NULL). Manager scope = org-wide via users.org_id, team resolution via users.team_id JOIN. Confirmed.

**users.role enum:** text CHECK IN ('member','manager','admin'). Confirmed.

**sessions_agg — NO `team_id` column.** Per-session keyed on (user_id, session_id). Team join path is: sessions_agg.user_id → users.user_id → users.team_id. REQ-21 GROUP BY team_id must JOIN through users.

**sessions_agg has `subagent_usage_ratio` (numeric 4,3):** already a pre-computed ratio per session — the reporter sends it as `subagent_usage_ratio`. No raw `subagent_count` integer column. REQ-4 and TASK-CRON-AGG must use this ratio, not a raw count.

**NO `org_settings` table exists.** Not created by spec 3 or onboarding spec. DDL ALTER TABLE in v2 spec will fail unless preceded by CREATE TABLE IF NOT EXISTS.

**NO `cron_runs` table exists.** Not created by spec 3 or onboarding spec. Spec v2 must create it unconditionally.

**NO notifications infrastructure exists.** Neither spec 3 nor onboarding created an email/Slack/in-app notification channel, templates registry, or any `lib/notifications/` module. `apps/server/lib/notifications/templates.ts` does not exist.

**tool_count_agg shape:** (user_id, session_id, tool_name text, count integer). Per-session × tool. No pre-aggregated daily rollup. Tool names are raw strings (e.g. 'Read', 'Edit', 'Bash', 'Grep', 'Write') matching SUBAGENT_TOOL_NAME constant in local analytics.

**auth.ts — session.user.id IS populated:** jwt() callback sets token.userId from loadUserByEmail(); session() callback mirrors it to session.user.id. v2 routes can read session.user.id reliably.

**middleware.ts:** lives at apps/server/middleware.ts (root). Matcher: ['/manager/:path*'] only. Files to Modify in v2 says "apps/server/lib/auth/middleware.ts" — that path does NOT exist. The correct file is apps/server/middleware.ts.

**secret_hash now uses bcrypt:** onboarding spec fixed the HMAC→bcrypt gap. BCRYPT_COST=10 exported from apps/server/lib/auth/bearer-auth.ts.

**sso_provider + sso_subject are now NULLABLE** (onboarding spec relaxed the NOT NULL constraint for invite-provisioned users). The schema comment at schema.ts:43 confirms this.

**Existing E2E seed (seed-server.ts --e2e):** 2 orgs × 2 teams × 2-3 users. 30 sessions, last 7 days only. v2 E2E seed must EXTEND (additive, .onConflictDoNothing()) this, not replace it.

## Why

Accurate knowledge of what shipped prevents spec reviewers from approving specs that assume a different contract.

## How to apply

When reviewing specs that depend on central-reporter-server or central-server-onboarding, verify column names, unique constraints, and file paths against the actual shipped code before approving.
