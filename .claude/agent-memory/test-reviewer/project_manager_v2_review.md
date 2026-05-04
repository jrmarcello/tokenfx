---
name: manager-dashboard-v2 test-plan review
description: Gaps found in manager-dashboard-v2.md test plan — original DRAFT review 2026-04-30, post-Pause-1 re-review 2026-05-01 (124 TCs), IN_PROGRESS implementation review 2026-05-02
type: project
---

# manager-dashboard-v2 test-plan review

## DRAFT review (2026-04-30) — 75 TCs

Spec authored 2026-04-28, DRAFT awaiting Pause-1.
75 TCs total: TC-U-01..28, TC-I-01..35, TC-E2E-01..12.

### Key patterns from sibling spec to enforce

- Testcontainers Postgres single shared instance, fileParallelism: false, TRUNCATE CASCADE (9 tables) in beforeAll
- New tables added by this spec (team_metrics_daily, manager_drilldown_audit, manager_anomalies, manager_dismissed_anomalies) must expand TRUNCATE list in every integration test file
- Hand-written stubs in same *.test.ts — no vi.mock
- TC-I-29/30 "mock channel" must be a hand-written stub channel object passed via DI, not vi.mock

### CRITICALs identified (DRAFT)

1. TC-I-29/30 use "mock channel intercept" — undefined seam. Must specify hand-written DI stub.
2. No TC for cross-org isolation (manager org A queries team in org B).
3. No TC for IP truncation correctness (/24 IPv4, /48 IPv6).
4. TASK-CRON-CLEANUP has zero TCs in Test Plan (comment in tasks says "covered manually").
5. No idempotency TC for drilldown audit same-day refresh (ON CONFLICT path).
6. No idempotency TC for dismiss-anomaly POST (UPDATE on conflict).
7. INTERNAL_CRON_SECRET missing at runtime — no TC for fail-fast.
8. Cron route missing auth-header TC (correct secret = 200, wrong secret = 401, missing = 401).
9. No TC for cron same-day re-run overlap (concurrent 15-min runs).
10. No TC for /me/visibility pagination boundaries (page=0, page=-1, page>maxPages).
11. MANAGER_GOOD_SESSION_THRESHOLD env var: 0, 100, 101, non-integer — no TCs.
12. Small-team z-score guard at exactly 5 devs (boundary) — no TC.
13. Knowledge-sharing 1.99× median (just below) vs 2.0× (at boundary) — no TC.
14. TRUNCATE list in integration test files not updated to include 4 new tables.
15. seed-manager-v2.ts additive vs destructive vs spec 3 seed — not specified.

### WARNINGs (DRAFT)

- detectSpike 3σ boundary (exactly 3.0σ) not tested — only 5σ (flagged) and 2.5σ (not).
- WoW spike at exactly +50% vs +50.01% — TC-U-11 says "flagged: +50%" but threshold is ">= 50%" not "> 50%", need to confirm.
- Two managers drill same dev same day same reason — concurrency/row isolation not tested.
- SQL injection fuzz on route params missing.
- /me/visibility audit rows of OTHER users not shown — isolation not tested.
- TC-I-34 says "lint or test" — ambiguous; must pick one (test is the only verifiable form here).
- TASK-CRON-AUTH has no tests in its own task; covered "indirectly" — indirect coverage is not a substitute.
- reasonText required only when reason=other; TC-I-22..25 cover this but only at integration level. No unit TC for "reasonText present with reason=training-check" (should be ignored or 400?).

## Post-Pause-1 re-review (2026-05-01) — 124 TCs after v2 rewrite

49 new TCs: TC-U-29..40, TC-I-36..73, TC-E2E-13.
13 architectural blockers fixed (B1-B13). Status: APPROVED.

### Remaining CRITICALs after v2 rewrite

1. TC-I-29 Expected still says "assert via mock channel" — contradicts Q9 lock (DB-backed queue). Must read: row in manager_notifications with status='pending'.
2. TC-U-33 packs two assertions (composite=100 good; composite=99 NOT good) into one TC row — must split or use it.each.
3. TC-U-40 packs three scenarios into one row — flagged case + 1.99× NOT case + missing 3.99× lowest NOT case. Must be 3 rows or a 3-row it.each.
4. TASK-DISMISS-ROUTE.tests: points to TC-I-60 (happy create) and TC-I-61 (idempotent re-submit) — but TC-I-60/61 in the Test Plan are CRON TCs (small-team guard / 5-dev boundary). Wiring error blocks ralph-loop RED phase.
5. No happy-path TC for dismiss-anomaly route (first successful POST → row with correct dismissed_until). TC-I-64 only covers idempotent re-submit.
6. TC-U-29..31/39 REQ column uses task ID "TASK-CRON-AUTH" instead of REQ-23 — breaks REQ × TC audit.
7. TC-I-49 REQ column says REQ-23 (backoff behavior) but tests the aggregate-team-metrics route which implements REQ-21.
8. TC-I-52 (boot-time guard integration test) has no specified mechanism for how the harness observes module-load throw — risks tautological implementation. Should be unit test or specify subprocess mechanism.
9. TC-E2E-10 still says "mock channel intercept" in description — E2E has no in-process mock access; must assert DB row in manager_notifications instead.

### Remaining WARNINGs after v2 rewrite

- REQ-3: No TC for 'Task' → 'Agent' alias (TC-U-19 input only contains 'Agent', not 'Task').
- REQ-4: TC-I-12 Expected still says "subagent_count > 0" (stale — was fixed in schema as subagent_usage_ratio). No boundary TC for ratio=0 (not counted) vs ratio=0.001 (counted).
- REQ-13: TC-U-40 missing gate-2 lower boundary — 2.0× median but 3.99× lowest → NOT flagged.
- REQ-22: No integration TC for WoW spike path in nightly cron (TC-I-05 only exercises z-score path).
- REQ-23: No failure/backoff TC for detect-anomalies cron (TC-I-07 only covers aggregate cron).
- REQ-16: Notification body verbatim copy (locked in REQ-16) never asserted in any TC — payload_json fields unchecked.
- TC-I-34 still says "lint or test" — lock to a specific test mechanism (fs.readFileSync + regex assertion).
- TC-I-55/56: No note on how test harness connects as app_runtime role (superuser-only harness would never hit the permission denied path).
- RLS GRANT migration failure path (managed Postgres, no CREATE ROLE privilege) — graceful degradation untested.
- TC-I-65 duplicates TC-I-43 exactly — consolidate.
- TC-I-66 REQ column uses task ID; should be REQ-15, REQ-16.
- REQ-11 displayLabelFor fallback not tested in card rendering (NULL display_name → email local-part in card HTML).

## IN_PROGRESS implementation review (2026-05-02) — all 6 batches implemented

### CRITICAL gaps remaining post-implementation

1. TC-U-11 spec says "flagged: +50%" but test asserts "not flagged" — one of them is wrong. Spec says strict > (TC-U-12 confirms 49.99% not flagged), so +50% exact should NOT be flagged. Test is correct; spec description misleads.
2. TC-I-52 (INTERNAL_CRON_SECRET unset in production → server fails to start) — NOT implemented. Spec requires subprocess-spawn mechanism. The boot-guard behavior IS tested in-process via vi.resetModules() + dynamic import in cron/auth.test.ts, which is a valid and stronger substitute, but TC-I-52 specifically called for subprocess + DATABASE_URL check. TC-I-52 as written is effectively collapsed into TC-U-39.
3. TC-I-55 (SET ROLE app_runtime → UPDATE denied on manager_drilldown_audit) — NOT implemented anywhere.
4. TC-I-56 (SET ROLE app_runtime → DELETE denied on manager_drilldown_audit) — NOT implemented anywhere.
5. TC-I-66 (manager A + manager B drill same dev same day → 2 audit rows + 2 notifications) — NOT implemented anywhere.
6. E2E test.skip blocks on TC-E2E-05/06/07/13 lack seed-dependency justification inline — they use conditional seed-state skips which may silently skip without ever running in CI if the seed doesn't produce the right state.

### MINOR gaps post-implementation

- TC-U-11 description mismatch (test is correct, spec description misleads).
- vi.resetModules() + vi used in cron/auth.test.ts — appropriate for dynamic-import module-eval testing, not a mocking-framework violation, but should be noted.
- TRUNCATE list in cleanup-audit-ips.test.ts is expanded (includes all 4 new tables) — GOOD.
- TC-I-17: assertion does not verify the "spike" kind field (only that Alice appears). The test comment explains 3σ is unreachable with 3 devs; WoW branch asserted indirectly by Alice being flagged.
- TC-I-61 inline comment documents the mathematical constraint clearly — GOOD.
