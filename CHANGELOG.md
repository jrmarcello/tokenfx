# Changelog

Todas as mudanças notáveis deste projeto estão documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Commits seguem [Conventional Commits](https://www.conventionalcommits.org/).

---

## [0.4.0] - 2026-07-13

### Correções

- **effectiveness**: Score all sessions in window — remove orphaned 50-session cap
- **auth**: Give AUTH_REQUIRED=false synthetic user a real UUID + seeded row
- **security**: Hash invite tokens at rest; gate /api/manager; require https central_url
- **pricing**: Price Claude 5 family + warn on unknown models; real 404 for sessions; unify cache-hit formula
- **apps/server**: Wire missing Tailwind CSS pipeline (global import + postcss dep + Dockerfile static path)
- **sso-e2e**: Root-cause + partial fix of 8 long-broken SSO Playwright tests
- **smoke**: Smoke-seed writes data/reporter-config.json + clarify auth.config.ts comment
- **ingest**: Eliminate watcher test flakes under parallel pool
- **smoke**: Align SSO issuer URL via host.docker.internal bridge
- **docker**: Unblock root tokenfx build under pnpm v11
- **smoke**: Close 10 gaps surfaced by first live cross-stack execution
- **infra**: Unblock /manager/invites E2E surface + apply orphan migrations
- **apps/server**: Org-scope predicate on manager-alert acknowledgeAlert
- **apps/server**: Same-origin guard on manager CSV export GET routes
- **ingest-subagent-skip**: Exclude subagents/ JSONLs from listTranscriptFiles + cleanup script
- **docker**: Move sqlite to named volume + enable OTEL scrape
- **ingest**: Always run pull as safety net when watcher drops events

### Documentação

- Reflect @tokenfx/shared workspace package across project docs
- **plan**: Mark 4.2 wire-protocol-versioning DONE (1d0d68c)
- **server**: Production deploy guide + fix stale audit-role naming
- **reconciliation**: Align docs with code — score weights, privacy allowlist, stale claims
- **plan**: Execution plan for presentation-readiness (4 phases, agent guide)
- **spec**: Add Threat Model checklist for auth-surface specs
- **specs**: Lock 11 Open Questions/judgment-calls in SSO threat model
- **specs**: Threat model for central-server-onboarding-v2-sso (analysis-only)
- **specs**: Mark outcome-integration-git-v2-pr-lookup status DONE post-commit
- **apps/server**: Document `pnpm install --ignore-workspace` requirement
- **specs**: Mark refactor-prepared-statements-evaluator status DONE post-commit
- **specs**: Mark outcome-integration-git-v3-422-as-not-found status DONE post-commit
- **specs**: Mark fix-ingest-skip-subagent-jsonls status DONE post-commit
- **roadmap**: Mark Fase 4 (manager-dashboard-v2) DONE + carve-outs to Fase 5+
- **specs**: Mark manager-dashboard-v2 status DONE post-commit
- **sdd**: Port marvel-snap-tracker SDD flow with 3 improvements
- **specs**: Add 4 reviewed DRAFT specs for upcoming work
- **sdd**: Align flow with review-then-execute-then-review pattern

### Funcionalidades

- **reporter**: Make the first wire-protocol version bump non-breaking
- **retention**: 24-month data retention prune + admin offboarding
- **admin**: Machine-revocation UI — stolen-laptop flow without manual SQL
- **sso-e2e**: Fix all 5 originally-failing SSO Playwright tests + 2 manager-ui regressions
- **auth**: Optional-auth mode (AUTH_REQUIRED=false) + fix 3 SSO bugs
- **smoke**: Cross-stack validation infra + scripts + tests
- **review-fixes**: Resolve 22 findings + 7 self-review hardenings
- **sso-e2e**: Promote TC-E2E-06/07 to live + seed sso-auto fixture
- **sso**: Enable nonce validation on Okta provider + nonce-replay audit row
- **sso**: Write rejected-replay audit row on NextAuth state-cookie failure
- **idp-stub**: Add local OIDC stub to unblock 7 deferred SSO E2E + integration TCs
- **apps/server**: Manager-UI surfaces for SSO auto-provision + ALS/SMTP/MaxMind follow-ups
- **apps/server**: SSO auto-provision backend orchestrator + decision-engine + audit logging
- **apps/server**: SSO auto-provision schema preconditions + users.email refactor
- **i18n**: Consolidate microcopy locale per surface (pt-BR pessoal, EN manager)
- **recompute-cost**: Scope filters + dry-run + package.json entry
- **auth**: Test-only Credentials bypass for E2E specs — fixes ERR_TOO_MANY_REDIRECTS
- **manager-v3-outcomes**: TASK-SMOKE — deterministic v3 seed + E2E spec + global-setup wiring
- **manager-v3-outcomes**: TASK-6 + TASK-7 — /manager/outcomes page + /me/visibility extension
- **manager-v3-outcomes**: TASK-3 + TASK-4 — ingest UPSERT + cron rollup
- **manager-v3-outcomes**: TASK-1+2+5 — reporter pipe, server schema, query helpers
- **outcome-git-v3-422-as-not-found**: Map gh 422 SHA-not-found → not-found (was error/NULL)
- **outcome-git-v2-pr-lookup**: Merged-PR cross-reference via gh api
- **manager-dashboard-v2-followups**: Per-org cron probe + dismiss helper + drilldown notify hoist + E2E wiring
- **manager-dashboard-v2**: Manager-facing org effectiveness + health surfaces + drilldown audit
- **central-server-onboarding**: Invite-token onboarding + reporter auth refactor (HMAC → Bearer + bcrypt)
- **central-reporter-server**: Manager-view MVP — multi-dev cost + adoption dashboard
- **effectiveness-personal-v2**: Personal AI use effectiveness dashboard
- **outcome-integration-git**: Per-session git outcomes (LOC, commits, reverts, status)
- **docker**: Enable push-based watcher in container
- **docker**: Add docker commands to package.json

### Manutenção

- Checkpoint agent-memory from Phase 1-3 reviews
- **specs**: Mark Phase 1-3 items DONE + execution-plan status
- **specs**: Mark security-hardening-lowsev DONE post-commit
- **specs**: Mark fix-pricing-unknown-model-family DONE post-commit
- Tidy gitignore + checkpoint agent-memory artifacts
- **spec**: Finalize review-report-2026-05-14-fixes status → DONE
- **idp-stub**: Delete unused logger.ts
- **node**: Bump .tool-versions to 26.1.0 (latest asdf-installable)
- **node**: Revert .tool-versions to 25.9.0 — asdf-nodejs plugin lags
- **node**: Bump .tool-versions to Node 26.0.0
- **apps/server**: Allow bcrypt postinstall under --ignore-workspace install
- **node**: Pin Node 25.9.0 via .tool-versions + isolate auto.test.ts FS
- Untrack roadmap.md (local-only planning notes)
- **specs**: Add tracked roadmap.md + remove seed-server.ts.tmp leftover
- **hooks**: Fix pnpm PATH in subshells
- **release**: Bump package.json to 0.3.0
- **release**: V0.3.0 [skip ci]

### Refatoração

- **monorepo**: Extract @tokenfx/shared workspace package, kill the split-brain
- **db**: HMR-safe SQLite singleton on globalThis + document rate-limiter premise
- **skills**: Consolidate /review + /full-review-team; fix /spec-review
- **onboarding**: Consolidate IP truncation + sliding-window health limiter + flash-cookie boot guard
- **evaluator**: Hoist UPSERT prepare via WeakMap-by-DB cache
- **calibration**: WeakMap-cache the cost calibration prepared statement

### Testes

- **auth**: Canary for NextAuth Credentials() seam in e2e-bypass-provider
- **sso**: Close 4 orphan TCs from manager-ui spec self-review

## [0.3.0] - 2026-04-20

### Correções

- **ingest**: Mitigate watcher flakes under vitest parallel load
- **e2e**: Eliminate flakes — race, concurrency, WAL visibility, timeouts

### Funcionalidades

- **quota**: Thresholds dialog, resets calibráveis, block-aware usage, painel de estatísticas
- **effectiveness**: Token breakdown tooltip + subagent delegation metric
- **dashboard**: Unificar / + /effectiveness, search widget global, auditoria de componentes

### Manutenção

- **release**: V0.2.0 [skip ci]

## [0.2.0] - 2026-04-19

### Correções

- **metrics**: Audit findings — pricing fallback, ratio formulas, UX labels

### Documentação

- Rename README sections to Como funciona / Na prática

### Funcionalidades

- **docker**: Containerizar TokenFx + reorganizar README (spec dockerize)
- **ui**: Light/dark/system themes + audit fixes (2 specs consolidated)
- **sessions**: Pagination com ?offset + overflow CTA
- **quota**: Max plan quota tracking — usage vs threshold em janelas rolling
- **ingest**: Watch mode — chokidar-based push ingestion
- **sessions**: Share as markdown + PDF — endpoint, UI, print CSS
- **effectiveness**: Tool success trends — weekly error-rate per tool
- **pricing**: Cost calibration — learned plan multiplier from OTEL samples
- **pricing**: Hybrid OTEL + local cost, metric name audit, UI polish
- **sessions**: Sub-agent cost attribution per session
- **overview**: Session timeline heatmap + /sessions date filter
- **search**: Transcript full-text search via SQLite FTS5
- **effectiveness**: Model breakdown pie chart by family (30d)

### Manutenção

- **sdd**: Add best-way-possible check to spec + ralph-loop checkpoints
- **dev**: Bind dev/start to port 3131
- **sdd**: Codify discipline checkpoints in skills + rules + CLAUDE
- Address full-review-team findings (code + security + data)
- **release**: V0.1.0 [skip ci]

### Performance

- **docker**: Reduce image from 1.2GB to 484MB via standalone-strict

## [0.1.0] - 2026-04-18

### Correções

- **ui**: Tooltip placement props to avoid viewport overflow
- **ingest**: Reconcile per-session sequences + rollups after each write
- **e2e**: Inline openDatabase in global-setup

### Documentação

- OTEL activation covers VSCode via ~/.claude/settings.json
- Atualizar critérios de avaliação manual no README
- README com linguagem direta para devs, em pt-BR
- Restructure README as fazer \xe2\x86\x92 entender \xe2\x86\x92 aprofundar \xe2\x86\x92 refer\xc3\xaancia

### Funcionalidades

- **otel**: 5 OTEL-derived features with graceful degradation
- Expand scoring + OTEL badge + pricing staleness + docs
- **ux**: Skeleton loading states + explanatory tooltips on KPIs
- Auto-ingest on page load + auto-detect OTEL + package scripts
- Add project state and threat model documentation; include user language preference
- **batch-5**: E2E smoke tests + seed-dev + README
- **batch-4**: Effectiveness page with composite scoring
- **batch-3**: Ingestion pipeline + overview + session drill-down
- **batch-2**: SQLite schema + parsers + pricing + UI shell

### Manutenção

- **brand**: Rename project to TokenFx
- **dx**: CONTRIBUTING + CHANGELOG tooling via git-cliff
- Bootstrap Next.js 15 + pnpm + Claude Code DX config

### Performance

- **effectiveness**: Collapse N+1 turns fetch into single json_each query

### Refatoração

- **effectiveness**: Drop redundant comment on MAX_SCORED_SESSIONS
- **pipeline**: Address 6 findings from pipeline review
- **ui**: Polish visual hierarchy + fix 2 style bugs
- **review**: Apply MUST FIX findings from full review team

### Testes

- Add fs-paths, fmt, logger, api-routes integration + getSessionIdForTurn coverage

### I18n

- Translate dashboard UI to pt-BR

---

> Gerado automaticamente com [git-cliff](https://github.com/orhun/git-cliff).
> Para entradas manuais, edite `CHANGELOG.md` após `pnpm release`.
