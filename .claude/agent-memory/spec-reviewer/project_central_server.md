---
name: project context — central server specs
description: Key facts about what central-reporter-server (spec 3) actually shipped vs its spec text, for downstream spec reviews
type: project
---

Spec 3 (central-reporter-server.md) shipped at commit 1ded383, status DONE.

**TASK-14 deviation (CRITICAL):** `user_machines.secret_hash` stores the HMAC secret as PLAINTEXT (not bcrypt). Column name kept `secret_hash` for migration stability — see comment in `apps/server/app/api/ingest/route.ts`. The central-server-onboarding spec must resolve this by switching to bcrypt.

**users table actual unique key:** `email` is `.unique()` globally (not a composite `(org_id, email)` unique constraint). The onboarding spec's REQ-9.1 "upsert by (org_id, email)" does NOT match the real schema, which enforces global email uniqueness only.

**users table has required `sso_provider` and `sso_subject`:** columns are NOT NULL. The onboarding redeem path must INSERT a user without SSO credentials — this is a schema contract mismatch.

**middleware.ts matcher:** only covers `/manager/:path*`. The `/api/onboarding/*` path is already outside this matcher, so no middleware change is needed to exempt it — but the spec says to edit `middleware.ts` for an exemption that is structurally a no-op.

**admin gating in auth.config.ts:** `/manager/admin/*` requires `role === 'admin'`. The spec's `/manager/admin/invites` will correctly require admin role — but `manager` role is blocked from it. REQ-4 says "manager or admin" can create invites; this contradicts the existing middleware.

**lib/reporter/config.ts:** lives at `lib/reporter/config.ts` (root), not `apps/server/lib/reporter/config.ts`. TASK-8 in the onboarding spec references it correctly as `lib/reporter/config.ts`.

**Why:** Accurate knowledge of what shipped prevents spec reviewers from approving specs that assume a different contract.

**How to apply:** When reviewing specs that depend on central-reporter-server, verify column names, unique constraints, and middleware matcher against the actual shipped code, not the spec text.
