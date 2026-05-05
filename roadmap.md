# Roadmap

Lista flat das fases planejadas. Cada fase corresponde a uma spec em `.specs/` que segue o flow `/spec → revisa → /ralph-loop → revisa → commit` (ver `.claude/skills/`). Marca `[x]` quando merged em `main` — sem editar a spec; ela é a fonte da verdade.

> **Convenção**: cada fase vira **uma spec SDD**. Numeração só por ordem cronológica de execução, não por prioridade arquitetural.
>
> **Atualização**: este arquivo é atualizado quando uma spec muda de status (DRAFT → APPROVED → IN_PROGRESS → DONE). Commit com `docs(roadmap): …` ou junto do commit da própria spec.

Last updated: **2026-05-04** (post `manager-dashboard-v2` ship)

---

## At-a-glance

| Status | Count | Specs |
|---|---|---|
| ✅ DONE | 26 | Ver "Shipped" + checkboxes por fase abaixo |
| 📝 DRAFT (next up) | 0 | — |
| 🔮 Backlog (sem spec) | 6 | Fase 5+ (ver lista abaixo) |
| 📐 TEMPLATE | 1 | `.specs/TEMPLATE.md` (não é spec real) |

---

## Fase 0 — Outcome integration (DONE)

Spec: [`.specs/outcome-integration-git.md`](.specs/outcome-integration-git.md) — `feat: outcome-integration-git` (commit `faa2c33`)

- [x] Tabela `session_outcomes` com schema completo (commit_count, loc_added/removed, files_changed, reverts_within_7d, merged_pr_count nullable, status)
- [x] `lib/ingest/git/`: `runGit` helper (spawnSync shell:false + Result), parsers puros (numstat, reverts), evaluator (per-commit numstat sum, ms-precision window, %ae exact-match, empty-tree fallback, symlink cwd via realpath)
- [x] Sweep automático no fim de `pnpm ingest` (30d cutoff; `--force-outcomes` cobre o resto)
- [x] Queries via `effectiveCostForSession` (cost-per-LOC, revert rate, high-cost-no-output) com WeakMap-cached prepared statements
- [x] `<SessionOutcomePanel>` em `app/sessions/[id]` com 4 empty states derivados de `status`
- [x] `<OutcomesCard>` em `app/page.tsx` (escondido entirely quando zero outcomes)
- [x] 58 unit/integration tests + 5 E2E (TC-U-27 regressão de attribution, TC-U-28 plus-addressing, boundary ms TC-U-20..23)
- [ ] **TASK-PR (v2 deferred)**: cross-reference de merged PRs via `gh api repos/{owner}/{repo}/commits/{sha}/pulls`, gated por `TOKENFX_GH_PR_LOOKUP=1` — agora trackeado em Fase 5+

---

## Fase 1 — Personal effectiveness v2 (DONE)

Spec: [`.specs/effectiveness-personal-v2.md`](.specs/effectiveness-personal-v2.md) — `feat(effectiveness-personal-v2)` (commit `a64a771`)

Métricas profundas que vão além de "quanto gastei" e respondem "estou usando bem? estou melhorando?".

- [x] Tabela `compaction_events` (PK composta `session_id, source_file, sequence_in_file`) populada pelo parser; idempotente em re-ingest
- [x] Métricas derivadas (query-time): `tokensUntilFirstEdit`, `rereadCount` (file_path repetido em Read), `toolErrorRate`, `readsToEditsRatio`, `subagentUsageRatio`, `compactionEventCount`
- [x] `getPersonalEffectivenessAggregates(db, days)` agregando média (excluindo nulls), `sessionsWithCompaction`, `totalSessions`
- [x] `<CostRatingScatter>` (Recharts, com regressão linear pure helper)
- [x] `<EffectivenessFunnel>` (4 estágios: Started → WithEdit → CacheAboveMedian → LowToolErrors; mostra count=0 visível)
- [x] `<EffectivenessHeatmap>` colorido por effectivenessScore (paleta bipolar rose→amber→emerald)
- [x] `<EffectivenessInsightPanel>` com microcopy "Suas melhores sessões... vs piores" comparando top vs bottom quartile
- [x] Nova rota `/effectiveness` agregando KPIs + heatmap + funnel + scatter + insight + score distribution + tool success trend + subagent usage card
- [x] Cost cascade via `effectiveCostForSession` (NÃO duplica a lógica em SQL)

---

## Fase 2 — Central reporter + manager dashboard MVP (DONE)

Spec: [`.specs/central-reporter-server.md`](.specs/central-reporter-server.md) — `feat(central-reporter-server)` (commit `1ded383`)

Sibling Next.js app em `apps/server/` + reporter local que pusha aggregates sanitizados. Manager dashboard MVP com cost + adoption só.

- [x] **Reporter local** (`lib/reporter/`):
  - [x] `sanitizer.ts` com Zod `.strict()` + allowlist de 20 fields (NUNCA `user_prompt`, `assistant_text`, `tool_uses_json`, full paths, rating notes)
  - [x] `signer.ts` (HMAC-SHA256 over canonical JSON) + `client.ts` (retry/backoff/Retry-After) — *refatorado em Fase 3 pra Bearer + bcrypt*
  - [x] `runner.ts` reads sessions, batches ≤50, marks pushed em `reporter_pushed_sessions`
  - [x] Gate concreto: `fs.existsSync('data/reporter-config.json')` antes de qualquer network call
  - [x] Offline buffer em `data/reporter-queue.db` (limite 10k entries)
- [x] **Servidor central** (`apps/server/`):
  - [x] Drizzle schema: `orgs`, `teams`, `users`, `user_machines`, `sessions_agg`, `model_breakdown_agg`, `tool_count_agg`, `cost_calibration_per_user`, `ingestion_log`
  - [x] Two-level Zod validation no `/api/ingest`: envelope `.strict()` whole-batch, items per-session
  - [x] NextAuth (Auth.js v5) com Google + Okta providers + role gating (member/manager/admin) + Edge/Node split
  - [x] Dashboard MVP `/manager`: org spend (calibrado via `effectiveCostForSession` em JS, NÃO SQL CASE), DAU/WAU/MAU, team breakdowns
  - [x] Testcontainers Postgres pra integration tests (`SKIP_PG_TESTS=1` skip pra dev sem Docker)
- [x] Privacy: red-team fuzz test (100 random injected fields) + 3 layers (sanitizer field-by-field + Zod strict + server re-validation)

**Carve-outs documentados**: provisionamento manual via DB seed (resolvido em Fase 3), TASK-14 deviation (`secret_hash` plaintext — resolvido em Fase 3 via Bearer + bcrypt).

---

## Fase 3 — Reporter onboarding (invite tokens) + auth refactor (DONE)

Spec: [`.specs/central-server-onboarding.md`](.specs/central-server-onboarding.md) — `feat(central-server-onboarding)` (este commit, 2026-05-01)

Fluxo de provisionamento do reporter: manager emite invite tokens, dev resgata via `pnpm reporter:setup`. Single secret exposure ever. **+ refactor da auth do reporter de HMAC pra Bearer-token + bcrypt-at-rest** (mata TASK-14 deviation do spec 2).

- [x] Tabela `onboarding_invites` (token PK, org_id, team_id, email_pattern, max_uses, expires_at, revoked_at, created_by NULL ON DELETE SET NULL)
- [x] Tabelas `onboarding_redemption_log` (com `email_domain` + `email_hash` peppered SHA-256 — sem PII) e `onboarding_audit_log` (create/revoke por manager)
- [x] **Server Actions** (não API routes — CSRF built-in): `createInviteAction` com Idempotency-Key (5min TTL), `revokeInviteAction` org-scoped
- [x] `POST /api/onboarding/redeem-invite` (no auth — token IS auth) com `SELECT FOR UPDATE` + concurrency guard (TC-I-62: 5 parallel redeems on max_uses=1 → exatamente 1 ganha; TC-I-63: 6 parallel × max_uses=3)
- [x] **Rate-limit em DUAS dimensões** (step 0, antes de Zod): `(ip_24, 10/min)` AND `(token, 3/min)`. DoS protection: rate-limited e Zod-rejected requests **não escrevem** em `redemption_log`
- [x] **Generic 401 uniforme** (frozen object + Content-Length byte-equal) pras 5 rejection paths — anti-probing
- [x] `matchEmailPattern` helper (exact + `*@domain` glob + NFC normalize + ASCII fold via punycode + homoglyph guard, no mid-string wildcards)
- [x] `pnpm reporter:setup` interactive CLI (parse URL fragment ou bare token, prompts email, POSTs redeem, atomic config write `tmp+fsync+rename` mode 0600, pre-flight `/api/health?key_id=X` com Bearer)
- [x] **TLS enforcement** com `--allow-http` opcional (warning loud no stderr)
- [x] Admin UI `/manager/invites/{page,create,created}.tsx` com show-once URL via flash cookie HMAC-signed (path-scoped, sameSite=strict, maxAge=120) + Route Handler pra clear (NÃO Server Action — evita RSC re-fetch flicker)
- [x] Página pública `/onboard` que lê fragment `#token=...` client-side (fragment NUNCA vai pro server)
- [x] **Auth refactor: HMAC → Bearer + bcrypt-at-rest** (REQ-6..10)
  - [x] `lib/reporter/signer.ts` DELETED, `canonical-json.ts` extraído
  - [x] Reporter envia `Authorization: Bearer <secret>` (drop X-Signature)
  - [x] Server bcrypt-compare com 60s in-memory verification cache (compartilhado entre `/api/ingest` e `/api/health`), cost factor 10
  - [x] `users.sso_provider/sso_subject` agora NULLABLE (suporta invite-provisioned users); signIn callback handles invite-provisioned → 4-way branch (allow/bootstrap/fill-sso/reject-mismatch)
  - [x] `Session.user.id` + `JWT.userId` augmented; `loadRoleAndOrg` renomeado pra `loadUserByEmail` (email-only WHERE)
- [x] 39 REQs + ~75 unit/integration TCs + 10 fuzz TCs + 7 E2E

---

## Fase 4 — Manager dashboard v2 (effectiveness + health) (DONE)

Spec: [`.specs/manager-dashboard-v2.md`](.specs/manager-dashboard-v2.md) — `feat(manager-dashboard-v2)` (commit `95c0f43`, 2026-05-04)

Profundidade Q2-C (effectiveness) + Q2-D (health signals) com **anti-surveillance design** load-bearing: aggregated by default, audit-with-pause-and-notify on individual drilldown.

- [x] Schema: `team_metrics_daily` (rollups, PK composta), `manager_drilldown_audit` (UNIQUE `(manager, target, viewed_on, reason)` — idempotência mata CSRF + duplicação), `manager_anomalies`, `manager_dismissed_anomalies`, `org_settings.drilldown_notification_enabled`, `manager_notifications`, `cron_runs`, `users.display_name`
- [x] **Effectiveness** `/manager/effectiveness` + `/manager/teams/[id]/effectiveness`: cache_hit_ratio, % good sessions (composite ≥60; threshold via `MANAGER_GOOD_SESSION_THRESHOLD`), tool mix stacked, subagent adoption, comparison radar (normalized to manager's teams; null/hidden quando 1-team — Q13 lock)
- [x] **Composite score** divergente do local `scoring.ts` (cache+output 40/40 vs 10/10 — `correction_density` dropped na Pause-1 v2 rewrite); `getTeamCompositeTrend` lê `team_metrics_daily.composite_avg` populado pelo cron de 15min
- [x] **Health** `/manager/health`: check-in cards (3σ OR +50% WoW strict), drop-off cards (>50% WoW drop strict + active prior week), knowledge-sharing opportunities (≥2× median AND ≥4× lowest, both gates)
- [x] **Anti-surveillance**: 5 princípios load-bearing — typed `audit: AuditContext` em manager-drilldown queries, ordering alfabético via `COALESCE(display_name, split_part(email,'@',1)) ASC`, audit row antes de fetch (atomic tx), `/me/visibility` history immutable, CI tone-word lint (`.github/workflows/lint-tone.yml`) com allow-list pra REQ-11 spec-locked phrase "It's not a flag."
- [x] `/me/visibility` (paginated 25/page): KPIs próprios + chronological audit log; persiste mesmo se `drilldown_notification_enabled = false` (REQ-17)
- [x] **Cron via HTTP endpoints protegidos** (`POST /api/internal/cron/{aggregate-team-metrics,detect-anomalies,cleanup-audit-ips}` com `assertInternalCronAuth` + boot-time guard pra empty `INTERNAL_CRON_SECRET` em production)
- [x] **Drilldown route** Server Component com Zod validation, idempotente same-day via UNIQUE+ON CONFLICT, `RETURNING (xmax = 0) AS inserted` discrimina insert real vs no-op, notification gated em `inserted=true` AND org setting; IP truncado /24 IPv4 / /48 IPv6 nulificado após 30d
- [x] **RLS column GRANTs** em `manager_drilldown_audit` (SELECT/INSERT all + UPDATE só em `viewed_at`/`ip_address_trunc` + REVOKE DELETE); TC-I-55/56 fazem live SET ROLE app_runtime + assert Postgres error 42501
- [x] 24 REQs + ~127 TCs + 19 tasks em 6 batches; **504/505 vitest pass**, typecheck + lint clean. E2E specs (4 specs Playwright) compilam clean — execução **DEFERRED**: `seed-manager-v2.ts` precisa ser wired em `apps/server/tests/e2e/global-setup.ts` (1 linha) antes do primeiro `pnpm test:e2e`.

**Carve-outs documentados (escalados em Pause 2)**:

- M4: `viewed_on` UTC midnight boundary pode emitir notification duplicada — matches spec REQ-15 (locked).
- Code MAJOR: `aggregate-team-metrics.ts` emptiness probe global, não per-org — JSDoc inline; net effect = idêntico até 2º org existir.
- Code MAJOR: dismiss SQL duplicado entre Server Action e Route Handler — refactor pra `lib/queries/manager-dismissed.ts` é Fase 5+.
- Code MAJOR: `_drilldown/render.tsx` `org_settings` read dentro do `after()` — hoist trivial, não bloqueante.
- E2E TASK-SMOKE: 4 specs Playwright compilam mas execução está deferred — wirar `seed-manager-v2.ts` no `global-setup.ts` + rodar `pnpm test:e2e`.

---

## Fase 5+ — Possíveis follow-ups (sem spec ainda)

Items planejados mas que ainda precisam de design + spec dedicada.

- [ ] **outcome-integration-git v2** (TASK-PR): merged PR cross-reference via `gh api commits/{sha}/pulls`, gated `TOKENFX_GH_PR_LOOKUP=1`
- [ ] **manager-dashboard-v3-outcomes**: tokens-per-merged-LOC per team, depende de outcome data fluindo no reporter payload (Fase 2 + Fase 0 já em produção)
- [ ] **central-server-onboarding-v2-sso**: SSO-based auto-machine provisioning (a dev's Google login → user_machines row criada automaticamente). Carved out dos anti-goals da Fase 3; precisa de threat model.
- [ ] **manager-dashboard-v2 follow-ups (registrados em PAUSE 2 da Fase 4)**:
  - [ ] **TASK-SMOKE wiring + execution**: wirar `seed-manager-v2.ts` em `apps/server/tests/e2e/global-setup.ts` (1 `execFileSync` ou `await seedManagerV2(db)` após o `seed-server.ts --e2e`), rodar `pnpm test:e2e`, capturar TC-E2E-01..13 results, abrir PR com fixes mínimos se algum spec falhar. **Ainda DEFERRED**.
  - [ ] Dismiss SQL DRY: extrair UPSERT de `app/manager/health/dismiss-action.ts` + `app/api/manager/dismiss-anomaly/route.ts` pra um helper compartilhado em `lib/queries/manager-dismissed.ts`.
  - [ ] `aggregate-team-metrics.ts` per-org emptiness probe (atualmente global) — diverge da spec REQ-21 quando 2º org onboards após o 1º estar ativo.
  - [ ] `_drilldown/render.tsx`: hoist `org_settings.drilldown_notification_enabled` read pra antes do response flush (atualmente dentro do `after()`).
- [ ] **central-server-onboarding follow-ups (LOW severity de PAUSE 2 da Fase 3)**:
  - [ ] `/api/health` rate limiter usa janela fixa — refatorar pra reusar sliding `lib/queries/rate-limit.ts`
  - [ ] IP truncation duplicada em 3 routes — extrair pra `lib/util/ip.ts`
  - [ ] `flash-cookie.ts:getSecret()` sem boot guard independente do `AUTH_SECRET`
  - [ ] TC-I-71e timing assertion absoluta — flaky em CI lento
- [ ] **spec recompute-cost CLI** com flag `--all` pra recalibrar histórico após mudança no pricing table
- [ ] **i18n**: hoje microcopy é mistura pt-BR/EN; consolidar (provavelmente pt-BR pra dashboard pessoal, EN pra manager)

---

## Shipped (DONE) — chronological commit log

Em ordem reversa (mais recentes no topo). Specs do dashboard local pré-Fase-0 não estão listadas individualmente aqui — ver `.specs/*.md` direto.

| Fase | Spec | Commit | Resumo |
|---|---|---|---|
| 4 | [manager-dashboard-v2](./.specs/manager-dashboard-v2.md) | `95c0f43` | Manager effectiveness + health surfaces (anti-surveillance design). 6 new tables + RLS column GRANTs, 3 cron endpoints, drilldown audit (atomic tx), `/me/visibility`, CI tone-word lint. 24 REQs + ~127 TCs + 19 tasks em 6 batches; 504/505 vitest pass. E2E execução deferred. |
| 3 | [central-server-onboarding](./.specs/central-server-onboarding.md) | `0594e39` | Invite-token onboarding (`/manager/invites`, `pnpm reporter:setup`, `/onboard`) + auth refactor HMAC → Bearer + bcrypt. 39 REQs, 14 tasks, ~75 unit/integration + 10 fuzz + 7 E2E. |
| 2 | [central-reporter-server](./.specs/central-reporter-server.md) | `1ded383` | Servidor central Postgres + manager dashboard MVP (cost + adoption). Reporter privacy-allowlisted + HMAC. NextAuth v5 split Edge/Node. 22 tasks, 73 TCs + 4 E2E. |
| 1 | [effectiveness-personal-v2](./.specs/effectiveness-personal-v2.md) | `a64a771` | Personal AI use effectiveness dashboard. |
| 0 | [outcome-integration-git](./.specs/outcome-integration-git.md) | `faa2c33` | Per-session git outcomes (LOC, commits, reverts, status). |
| pré-0 | [quota-improvements](./.specs/quota-improvements.md) | `1546519` | Thresholds dialog, resets calibráveis, block-aware usage, painel de estatísticas. |
| pré-0 | [tool-success-trends](./.specs/tool-success-trends.md) | `c086ef4` | Weekly error-rate per tool. |
| pré-0 | [unified-dashboard](./.specs/unified-dashboard.md) | `d87cf37` | Unifica `/` + `/effectiveness`, search widget global. |
| pré-0 | [dockerize](./.specs/dockerize.md) | `9cc03ce` | Containerizar TokenFx + reorganizar README. |
| pré-0 | [themes](./.specs/themes.md) + [ui-audit-fixes](./.specs/ui-audit-fixes.md) | `347c84d` | Light/dark/system themes + audit fixes. |
| pré-0 | [sessions-pagination](./.specs/sessions-pagination.md) | `bc410ab` | `?offset` + overflow CTA. |
| pré-0 | [max-plan-quota](./.specs/max-plan-quota.md) | `152d610` | Usage vs threshold em janelas rolling. |
| pré-0 | [watch-mode-real](./.specs/watch-mode-real.md) | `df645fd` | Chokidar push-based ingestion. |
| pré-0 | [session-share](./.specs/session-share.md) | `c8c8e6f` | Share session as markdown + PDF. |
| pré-0 | [cost-calibration](./.specs/cost-calibration.md) | `80a5a79` | Learned plan multiplier from OTEL samples. |
| pré-0 | [pricing-otel-source-of-truth](./.specs/pricing-otel-source-of-truth.md) | `6c7ac2a` | Hybrid OTEL + local cost. |
| pré-0 | [sub-agent-cost-attribution](./.specs/sub-agent-cost-attribution.md) | `a4e424a` | Per-session sub-agent cost. |
| pré-0 | [session-timeline-heatmap](./.specs/session-timeline-heatmap.md) | `a06e609` | Heatmap + `/sessions` date filter. |
| pré-0 | [transcript-search](./.specs/transcript-search.md) | `34ba6de` | SQLite FTS5. |
| pré-0 | [model-breakdown](./.specs/model-breakdown.md) | `7f944c7` | Pie chart by family (30d). |
| pré-0 | [token-accounting-parity](./.specs/token-accounting-parity.md) | (early) | Token counts parity entre OTEL e JSONL. |
| pré-0 | [dashboard-mvp](./.specs/dashboard-mvp.md) | (initial) | Dashboard inicial. |
