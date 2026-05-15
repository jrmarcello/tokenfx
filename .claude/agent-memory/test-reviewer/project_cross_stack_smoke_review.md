---
name: cross-stack-smoke-validation test-plan review
description: 2026-05-14 DRAFT review — REQ-2/4 zero TCs, REQ-6 branch gaps, REQ-7/13 infra-failure absent, 5xx detection missing for REQ-10/11, TC-I-12 vacuous, ratio barely 1:1.09
type: project
---

2026-05-14 DRAFT review of `.specs/cross-stack-smoke-validation.md` (14 REQs, 23 TCs: 7 unit + 12 integration + 4 E2E).

**Why:** smoke/validation spec for cross-stack reset+seed+reporter integration. Load-bearing because it's the first time the full docker stack is exercised end-to-end.

**How to apply:** when this spec moves to IN_PROGRESS, verify these gaps are addressed before APPROVED.

## MUST FIX gaps

- **REQ-2 zero TCs** — compose startup ≤90s has no TC at all; add TC-I-13 (all 4 services healthy) + TC-I-14 (postgres-smoke unhealthy → fail fast)
- **REQ-4 zero TCs** — docker internal network (tokenfx → tokenfx-server) not covered; add TC-I-15 (reporter via http://tokenfx-server:3232 reaches server on smoke-net)
- **REQ-6 branch gaps** — smoke-reset.ts has 3 branches; TC-U-01/02 cover SQLite but not (a) docker compose exec failure and (b) idp-stub POST non-200; add TC-U-08 + TC-U-09
- **REQ-7 infra-failure absent** — seed DB-write has no failure-mode TC; add TC-I-16 (DATABASE_URL unreachable → fail fast with ECONNREFUSED)
- **REQ-13 container-start-failure absent** — testcontainer Postgres timeout not covered; add TC-I-17 (Postgres container fails → descriptive error not hang)

## SHOULD FIX gaps

- **REQ-8 mid-run kill absent** — add TC-I-19 (SIGTERM mid-ingest + re-run → no duplicates, count=N)
- **REQ-9 mid-batch kill absent** — add TC-I-20 (reporter killed after 1/3 sessions pushed, re-run → 3 rows, pushed=2)
- **REQ-10/11 5xx detection** — add TC-E2E-06 (all main routes return 200 pós-seed pós-reporter-push)
- **REQ-11 cross-service data-flow proof weak** — TC-E2E-04 passes even if seed-server inserted data directly; add TC-E2E-07 (clean Postgres + root seed + reporter push only → manager UI shows correct cost)
- **TC-I-12 vacuous** — "full test passes when env=1" is tautology; eliminate or articulate what it verifies beyond TC-I-09..11
- **REQ-14 post-smoke section** — TC-U-07 only checks sections exist, not that #test-gaps-found was populated; add TC-U-10 (grep non-comment content in that section)
- **REQ-5 logout path absent** — add TC-E2E-05 (after SSO login, logout → /me/dashboard redirects to login)

## Ratio

Real ratio: 11 happy : 12 non-happy = 1:1.09 (barely over threshold). SDD rule requires non-happy to clearly outnumber happy.

## REQs with zero TCs

- REQ-2 (compose startup timing)
- REQ-4 (docker internal network connectivity)
