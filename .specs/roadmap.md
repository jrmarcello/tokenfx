# TokenFx Roadmap

> **Live status of every spec under `.specs/*.md`.** Authoritative source for "what's done, what's next, what depends on what." Updated whenever a spec status changes (DRAFT → APPROVED → IN_PROGRESS → DONE).

Last updated: **2026-05-01** (post `central-reporter-server` ship)

---

## At-a-glance

| Status | Count | Specs |
|---|---|---|
| ✅ DONE | 24 | (see "Shipped" below) |
| 📝 DRAFT (next up) | 2 | `central-server-onboarding`, `manager-dashboard-v2` |
| 📐 TEMPLATE | 1 | `TEMPLATE.md` (not a real spec) |

---

## 🚀 Next up — DRAFT specs awaiting approval

These have been authored + self-reviewed but not yet executed. Listed in **dependency order**.

### 1. [central-server-onboarding](./central-server-onboarding.md) — DRAFT
**Provisionamento de reporter via invite-token (carved-out do spec 3).**

- **Por que existe**: `central-reporter-server` ship o servidor + dashboard, mas deixou o provisionamento (`key_id` + `secret`) como manual via DB seed. Não escala além do autor + 1 tester. Esta spec resolve com fluxo gerenciado pelo manager.
- **Depends on**: `central-reporter-server` (DONE ✅) — schema, auth, ingest endpoint, reporter config shape já lockados lá.
- **Scope**: tabela `onboarding_invites`, página `/manager/admin/invites` (CRUD), endpoint `POST /api/onboarding/redeem-invite`, `pnpm reporter:setup` interativo, bcrypt do `secret` (TASK-14 deviation pendente do spec 3 fica resolvida aqui).
- **Anti-goals**: signup self-service, SSO-based auto-machine, fluxo browser.
- **Pre-requisitos pra approval**: spec já passou pelo self-review do autor; pendente Pause 1 do usuário.

### 2. [manager-dashboard-v2](./manager-dashboard-v2.md) — DRAFT
**Effectiveness depth + health signals (Q2-C / Q2-D).**

- **Por que existe**: `central-reporter-server` v1 entrega cost (Q2-A) e adoption (Q2-B). Esta v2 adiciona effectiveness (cache hit rate, subagent usage, tool mix) e health signals (anomalia detection, check-in opportunities) — **com design anti-surveillance** lockado (5 princípios codificados no Design).
- **Depends on**: `central-reporter-server` (DONE ✅).
- **Scope**: rollups diários `team_metrics_daily` calculados via SQL `GROUP BY` direto sobre `sessions_agg` (sem tabela intermediária). Manager opera sobre toda a org (não há `team_memberships` table).
- **Anti-goals locked**:
  - **Sem ranking público de devs** em nenhum lugar do dashboard.
  - **Drill-down em dev individual** exige reason tag, audit row, notificação ao dev.
  - **Anomaly cards** enquadrados como "check-in opportunities", nunca como performance flags.
- **Out-of-scope-v1 (recorded, not lost)**: `tokens-per-merged-LOC` (REQ-5) — depende de `outcome-integration-git` carregando outcome data via reporter, que não existe ainda no payload v1. Vira `manager-dashboard-v3-outcomes.md` depois.

---

## ✅ Shipped (DONE)

Em ordem de impacto na arquitetura, mais recentes no topo. Todas com commit linkado pra navegação.

### Centralization layer — manager view across many devs (Q2)

| Spec | Commit | Resumo |
|---|---|---|
| [central-reporter-server](./central-reporter-server.md) | `1ded383` (2026-05-01) | Servidor central Postgres + manager dashboard MVP (cost + adoption). Reporter privacy-allowlisted + HMAC-signed. NextAuth v5 split Edge/Node. 22 tasks, 73 unit/integration TCs, 4 E2E. |

### Personal dashboard — local-first effectiveness (Q1)

| Spec | Commit | Resumo |
|---|---|---|
| [effectiveness-personal-v2](./effectiveness-personal-v2.md) | `a64a771` | Personal AI use effectiveness dashboard. |
| [outcome-integration-git](./outcome-integration-git.md) | `faa2c33` | Per-session git outcomes (LOC, commits, reverts, status). |
| [quota-improvements](./quota-improvements.md) | `1546519` | Thresholds dialog, resets calibráveis, block-aware usage, painel de estatísticas. |
| [tool-success-trends](./tool-success-trends.md) | `c086ef4` | Weekly error-rate per tool. |
| [unified-dashboard](./unified-dashboard.md) | `d87cf37` | Unifica `/` + `/effectiveness`, search widget global, auditoria de componentes. |
| [dockerize](./dockerize.md) | `9cc03ce` | Containerizar TokenFx + reorganizar README. |
| [themes](./themes.md) + [ui-audit-fixes](./ui-audit-fixes.md) | `347c84d` | Light/dark/system themes + audit fixes. |
| [sessions-pagination](./sessions-pagination.md) | `bc410ab` | `?offset` + overflow CTA. |
| [max-plan-quota](./max-plan-quota.md) | `152d610` | Usage vs threshold em janelas rolling. |
| [watch-mode-real](./watch-mode-real.md) | `df645fd` | Chokidar push-based ingestion. |
| [session-share](./session-share.md) | `c8c8e6f` | Share session as markdown + PDF. |
| [cost-calibration](./cost-calibration.md) | `80a5a79` | Learned plan multiplier from OTEL samples. |
| [pricing-otel-source-of-truth](./pricing-otel-source-of-truth.md) | `6c7ac2a` | Hybrid OTEL + local cost. |
| [sub-agent-cost-attribution](./sub-agent-cost-attribution.md) | `a4e424a` | Per-session sub-agent cost. |
| [session-timeline-heatmap](./session-timeline-heatmap.md) | `a06e609` | Heatmap + `/sessions` date filter. |
| [transcript-search](./transcript-search.md) | `34ba6de` | SQLite FTS5. |
| [model-breakdown](./model-breakdown.md) | `7f944c7` | Pie chart by family (30d). |
| [token-accounting-parity](./token-accounting-parity.md) | (early) | Token counts parity entre OTEL e JSONL. |
| [dashboard-mvp](./dashboard-mvp.md) | (initial) | Dashboard inicial. |

---

## 🔮 Backlog ideas (sem spec ainda)

Coisas mencionadas em conversas/specs mas que ainda não viraram DRAFT:

- **`manager-dashboard-v3-outcomes`**: depois que `manager-dashboard-v2` ship + reporter v2 carregar outcome data (LOC merged, PR status), retomar REQ-5 (tokens-per-merged-LOC per team).
- **`central-server-onboarding-v2-sso`**: SSO-based auto-machine provisioning (a dev's Google login → user_machines row criada automaticamente). Carved out de `central-server-onboarding.md` antigoals; precisa de threat model.
- **Reporter v2 — outcome payload**: extender contrato do reporter pra carregar `outcome_metrics_daily` (LOC adicionada/removida/merged via observação local de git). Pré-requisito pro `manager-dashboard-v3-outcomes`.

---

## Convenções

- **Status transitions**: `DRAFT → APPROVED → IN_PROGRESS → DONE | FAILED`. Ver `.claude/rules/sdd.md`.
- **Naming**: lowercase, hyphen-separated, descritivo. Sem prefixo numérico (este roadmap é o índice).
- **Quando atualizar este arquivo**: quando uma spec muda de status; quando uma nova spec entra em DRAFT; quando uma spec é deletada/renomeada.
- **Commit message**: usar `docs(roadmap): …` ou incluir update no commit principal da spec.
