---
name: TokenFx schema overview
description: Current state of both SQLite (root) and PostgreSQL (apps/server) data layers, open findings from the pre-release review
type: project
---

## Root tokenfx — SQLite (lib/db/)

**Tables:** sessions, turns, tool_calls, ratings, otel_scrapes, ingested_files, cost_calibration, session_outcomes, user_settings, compaction_events, reporter_pushed_sessions, session_effectiveness (view).

**PRAGMA (lib/db/client.ts):** foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000. All correct.

**Prepared statements:** WeakMap-cached via getPrepared/getStatements in all query modules and writer.ts. Correct.

**Idempotency:**
- sessions: ON CONFLICT(id) DO UPDATE — PK is the session UUID from JSONL. (CLAUDE.md says natural key is sessionId+sourceFile, but implementation keys on PK id alone — deliberate, multiple files same session ID is deduplicated at session level.)
- turns, tool_calls: ON CONFLICT(id) DO UPDATE — correct.
- otel_scrapes: ON CONFLICT(metric_name, labels_json, scraped_at) DO NOTHING — correct.
- compaction_events: ON CONFLICT(session_id, source_file, sequence_in_file) DO UPDATE — correct composite PK.
- reporter_pushed_sessions: ON CONFLICT(session_id) DO UPDATE — correct.
- ingested_files: ON CONFLICT(path) DO UPDATE — correct.

**Indexes on turns.timestamp:** MISSING. Multiple quota queries (sumTokensSince, heatmap, dailyTokensSince, sessionAnchor) do SCAN TABLE turns. With 26K+ turns this is the main performance gap.

**sessions.ended_at index:** MISSING. runOutcomeSweep (writer.ts) filters `s.ended_at >= ?` causing SCAN sessions.

**ROLLUP_ALL_SQL correlated subquery for tool_call_count:** technically O(sessions) × O(index lookup) — is fine in practice because SQLite MATERIALIZES the aggregate. Not an issue.

**N+1 in getPersonalEffectivenessAggregates:** fetches all session IDs (sessionIdsInWindow), then calls getPersonalEffectivenessSession (7 prepared stmt executions) per session in a loop. With 55 sessions in 30d this is ~385 round-trips. Bounded for personal use but degrades linearly.

## apps/server — PostgreSQL (Drizzle ORM)

**CRITICAL: Migrations 0004 and 0005 are NOT in _journal.json.** Drizzle's migrator iterates journal.entries only — it will NEVER apply 0004_sso_auto_provision_schema.sql or 0005_manager_alert_acks.sql. These contain: SSO auto-provision enum values, auth_event_log table, onboarding_invites.allowed_sso_providers column, composite uniqueness swap on users, and manager_alert_acks table. The server is running without these tables/columns.

**Migration journal path:** apps/server/lib/db/migrations/meta/_journal.json — has entries 0000-0003 only.

**Schema/migration sync:** Drizzle schema.ts has all tables including authEventLog and managerAlertAcks (from 0004/0005), but the migration runner won't create them. Schema.ts and migrations are out of sync.

**Cross-app integration:** session_id flows as TEXT in both apps (local UUID TEXT → server sessions_agg.session_id TEXT). Consistent.

**Positive patterns:** All tables have CHECK constraints for enumerations, composite PKs, idempotent IF NOT EXISTS DDL, REVOKE DELETE on append-only audit tables.

**Why these matter:** The journal gap means auth_event_log, manager_alert_acks, and the SSO-auto column additions don't exist in the server DB. Any code path that writes to those tables will fail at runtime.

**How to apply:** In reviews, always check that new .sql migration files are also registered in _journal.json. Flag missing turns.timestamp index as the top performance item on the root app.

## Root tokenfx — analytics/metrics correctness (2026-07-11 review)

See [[analytics_metrics_findings]] for the full findings list (cache-hit-ratio formula drift, README/score-weight mismatch, unknown-model silent-zero-cost risk, MAX_SCORED_SESSIONS=50 sampling bias). Re-check these are still open before re-flagging in a future review — some may get fixed between sessions.
