# Roadmap

Lista flat das fases planejadas. Cada fase corresponde a uma spec em `.specs/` que segue o flow `/spec → revisa → /ralph-loop → revisa → commit` (ver `.claude/skills/`). Marca `[x]` quando merged em `main` — sem editar a spec; ela é a fonte da verdade.

> **Convenção**: cada fase vira **uma spec SDD**. Numeração só por ordem cronológica de execução, não por prioridade arquitetural.
>
> **Atualização**: este arquivo é atualizado quando uma spec muda de status (DRAFT → APPROVED → IN_PROGRESS → DONE). Commit com `docs(roadmap): …` ou junto do commit da própria spec.

Last updated: **2026-05-01** (post `central-server-onboarding` ship)

---

## At-a-glance

| Status | Count | Specs |
|---|---|---|
| ✅ DONE | 25 | Ver "Shipped" + checkboxes por fase abaixo |
| 📝 DRAFT (next up) | 1 | `manager-dashboard-v2` (Fase 4) |
| 🔮 Backlog (sem spec) | 4 | Fase 5+ |
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

## Fase 4 — Manager dashboard v2 (effectiveness + health) — DRAFT

Spec: [`.specs/manager-dashboard-v2.md`](.specs/manager-dashboard-v2.md) — DRAFT, aguardando aprovação

Profundidade Q2-C (effectiveness) + Q2-D (health signals) com **anti-surveillance design** load-bearing: aggregated by default, audit-with-pause-and-notify on individual drilldown.

- [ ] Schema: `team_metrics_daily` (rollups, PK composta), `manager_drilldown_audit` (UNIQUE `(manager, target, viewed_on, reason)` — idempotência mata CSRF + duplicação), `manager_anomalies`, `manager_dismissed_anomalies`, `org_settings.drilldown_notification_enabled`
- [ ] **Effectiveness** `/manager/effectiveness`: cache_hit_ratio, % good sessions (composite ≥60 OR rating ≥0; threshold via `MANAGER_GOOD_SESSION_THRESHOLD`), tool mix stacked, subagent adoption, comparison radar (5-axis, normalized to manager's teams) — TUDO computado direto de `sessions_agg` + `tool_count_agg` (sem intermediários)
- [ ] **Composite score** divergente do local `scoring.ts` (cache+output 30/30 vs 10/10) — documentado inline
- [ ] **Health** `/manager/health`: check-in cards (3σ OR +50% WoW), drop-off cards (>50% WoW drop + active prior week), knowledge-sharing opportunities (≥2× median + ≥4× lowest)
- [ ] **Anti-surveillance**: copy verbatim ("Check-in opportunity" / "May need support" — sem alert/warning/flag/violation), no public dev rankings, alfabético por `display_name`, audit row antes de fetch (mesma tx), notification reuse spec 3 channel
- [ ] `/me/visibility` para devs: KPIs próprios + chronological audit log (mesmo se org disable notification, history persists)
- [ ] **Cron via HTTP endpoints protegidos** (`POST /api/internal/cron/{aggregate-team-metrics,detect-anomalies,cleanup-audit-ips}` com `x-internal-cron-secret`) — portátil, sem in-process scheduler
- [ ] Depends on: Fase 2 (DONE) + Fase 3 (DONE) — v0 reporter v2 outcome data deferred (TASK-PR de Fase 0 ainda pendente)

---

## Fase 5+ — Possíveis follow-ups (sem spec ainda)

Items planejados mas que ainda precisam de design + spec dedicada.

- [ ] **outcome-integration-git v2** (TASK-PR): merged PR cross-reference via `gh api commits/{sha}/pulls`, gated `TOKENFX_GH_PR_LOOKUP=1`
- [ ] **manager-dashboard-v3-outcomes**: tokens-per-merged-LOC per team, depende de outcome data fluindo no reporter payload (Fase 2 + Fase 0 já em produção)
- [ ] **central-server-onboarding-v2-sso**: SSO-based auto-machine provisioning (a dev's Google login → user_machines row criada automaticamente). Carved out dos anti-goals da Fase 3; precisa de threat model.
- [ ] **manager-dashboard-v2 follow-ups (LOW severity registrados em PAUSE 2 da Fase 3)**:
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
| 3 | [central-server-onboarding](./.specs/central-server-onboarding.md) | (este) | Invite-token onboarding (`/manager/invites`, `pnpm reporter:setup`, `/onboard`) + auth refactor HMAC → Bearer + bcrypt. 39 REQs, 14 tasks, ~75 unit/integration + 10 fuzz + 7 E2E. |
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
