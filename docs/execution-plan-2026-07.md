# Plano Geral de Execução — TokenFx "apresentável" (2026-07)

Consolidação da avaliação completa de 2026-07-11: 5 revisões paralelas (negócio,
métricas, dashboard de gestor, arquitetura, segurança) + simulação ao vivo dos
dois apps (dashboard pessoal :3131 e servidor de gestor :3232, incluindo fluxo
completo do reporter: convite → redeem → push → render → CSV export).

**Estado validado na avaliação:** typecheck + lint limpos nos dois apps;
2.610 testes unit/integration verdes (raiz 1.193, server 1.417); ingestão real
de 40 arquivos / 31.158 turnos com 0 erros; contrato de privacidade verificado
ao vivo (campo proibido rejeitado por item). E2E Playwright pendente por
bloqueio de rede (CDN do Chromium), não por defeito do projeto.

**Objetivo:** fechar os gaps em 4 fases. Cada item vira uma spec SDD (fluxo
`/spec` → aprovação → `/ralph-loop`) ou um chore direto quando pequeno demais.

---

## Fase 1 — Bugs que quebram a demo (BLOQUEADORES)

Visíveis ao vivo. Nada de apresentar antes desta fase fechada.

| # | Item | Evidência | Spec | Tamanho | Status |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Pricing `claude-fable-5` + warning para família de modelo desconhecida (`getPricing` null → `logger.warn` com modelo/sessão) + `pnpm recompute-cost` nos dados existentes | `lib/analytics/pricing.ts:86-107`; 7.497 turnos reais ingeridos com custo $0 (9,4M output tokens) | `fix-pricing-unknown-model-family.md` | S | TODO |
| 1.2 | UUID constante para o usuário sintético do modo `AUTH_REQUIRED=false` + TC de integração do modo localhost com DB vazio | `lib/auth/auth-required.ts:97` (`id:'local-dev'`) → 500 em `/manager` (`app/manager/page.tsx:56-69`) e `/me/visibility` (`lib/queries/me-visibility.ts:260`), cast `string_to_uuid` | `fix-local-mode-synthetic-user-uuid.md` | S | TODO |
| 1.3 | Unificar fórmula de cache hit: `overview.ts` deve incluir `cache_creation_tokens` no denominador, igual à view `session_effectiveness` | `lib/queries/overview.ts:119` vs `lib/db/schema.sql:156-157` — home e /effectiveness mostram números diferentes | agrupar com 1.4 em `fix-demo-blockers-metrics-and-404.md` (ou tasks na 1.1) | XS | TODO |
| 1.4 | `/sessions/[id]` inexistente retorna HTTP 200 (soft-404) → `notFound()` real | verificado ao vivo: `curl /sessions/nonexistent-id` → 200 com corpo de 404 | idem | XS | TODO |

## Fase 2 — Credibilidade dos números e docs

O que os gestores vão ler. Erros aqui minam a confiança nos números certos.

| # | Item | Evidência | Spec | Tamanho | Status |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Reconciliar README com o score real: **6 sinais** (rating 30%, correção 20%, tool-error 15%, accept-rate 15%, cache 10%, output/input 10%) — hoje há 3 descrições conflitantes, nenhuma correta | `README.md:24` ("quatro sinais"), `README.md:121-128` (pesos 40/20/30/10), `README.md:312-320` (5 sinais) vs `lib/analytics/scoring.ts:150-207` | `docs-reconciliation.md` (agrupa 2.1–2.3) | S | TODO |
| 2.2 | Allowlist de privacidade: documentar os **27 campos** (20 + 7 outcomes v3) no README do server — doc canônico de privacidade está errado | `apps/server/README.md:44` ("20 fields") vs `lib/reporter/types.ts` (27 no schema) | idem | XS | TODO |
| 2.3 | Demais docs stale: CLAUDE.md "Next.js 15"→16 (app raiz); seção `--ignore-workspace` invertida (workspace agora inclui `apps/*`); "9 tables"→23; SECURITY.md §6 (spec deletada/idp-stub shipped); "role assignment until it ships" (já shipped); README raiz undersell (5 páginas, não 3; API routes faltando) | `apps/server/README.md:20,22-33,117`; `apps/server/SECURITY.md §6`; `CLAUDE.md` | idem | S | TODO |
| 2.4 | Fechar 5 specs com código já commitado: `oauth-idp-stub`, `onboarding-followups-lowsev`, `sso-nonce-replay`, `sso-replay-audit-row` (IN_PROGRESS) e `fix-e2e-auth-bypass` ("DONE pending commit") | commits `c218fb2`, `f37afa5`, `4eec79e`, `1961b61`, `48bbe6b` | chore direto, sem spec | XS | TODO |
| 2.5 | Cap de 50 sessões no score: **decidir** — remover o cap (medir custo) OU expor "amostra: top 50 por custo" na UI. Incluir fix do `correctionDensity` 0-vs-null | `lib/queries/effectiveness.ts:44,316,339-340` — todos os KPIs de score enviesados p/ as 50 sessões mais caras, sem disclosure | `fix-score-sampling-transparency.md` | M | **DECISÃO DE PRODUTO PENDENTE** |

## Fase 3 — Perguntas que gestores farão (gaps operacionais)

Antes da apresentação se houver tempo; senão, 3.3 é o mínimo e 3.1/3.2 viram
"follow-ups documentados" (posição honesta e forte).

| # | Item | Evidência | Spec | Tamanho | Status |
| --- | --- | --- | --- | --- | --- |
| 3.1 | UI de revogação de máquina (admin) — cenário "laptop roubado"; hoje é SQL manual | `apps/server/README.md:189-199` promete UI que não existe | `machine-revocation-ui.md` | M | TODO |
| 3.2 | Política de retenção de dados: aggregates acumulam para sempre; offboarding de dev não apaga histórico. **Decidir** política → cron de cleanup + doc | único cleanup existente: IPs truncados do audit-log após 30d | `data-retention-policy.md` | M | **DECISÃO DE PRODUTO PENDENTE** |
| 3.3 | Guia de deploy de produção do servidor central (1 página): SMTP, `app_role`, pepper, TLS, `AUTH_REQUIRED` obrigatório | requisitos hoje espalhados em SECURITY.md §2-3/§7.7 + CLAUDE.md + specs | `docs-production-deploy-guide.md` | S | TODO |
| 3.4 | Hardening (security review, tudo MED/LOW; nenhum CRITICAL/HIGH): (a) invite tokens hasheados at rest (`sha256`, prefixo 8-char em claro p/ auditoria); (b) matcher do middleware cobrir `/api/manager/*` no modo localhost; (c) docstring stale do `/api/ingest` (descreve cache de plaintext que não existe mais); (d) `central_url` do reporter exigir https fora de loopback | `apps/server/lib/queries/invites.ts` + `redeem.ts`; `apps/server/middleware.ts:63-68`; `apps/server/app/api/ingest/route.ts:12-19`; `lib/reporter/config.ts:23` | `security-hardening-lowsev.md` | S/M | TODO |

## Fase 4 — Dívida arquitetural (pós-apresentação, mas planejada)

Não bloqueia a apresentação — é a resposta para "e a dívida técnica?": mapeada,
com plano. Veredito da revisão: arquitetura certa para o contexto; o contrato de
wire single-source (allowlist re-exportado, drift impossível) é o destaque.

| # | Item | Evidência | Spec | Tamanho | Status |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Split-brain do monorepo: extrair `packages/shared` (wire types, canonical-json, logger, pricing/calibration — 29 imports `@root/*` hoje), apagar `apps/server/pnpm-lock.yaml` (2 lockfiles vivos sem sync), Dockerfile via `pnpm deploy --filter` | `pnpm-workspace.yaml` vs `apps/server/README.md` (contradição); `apps/server/Dockerfile:37-66` (symlink gymnastics) | `refactor-monorepo-shared-package.md` | L | TODO |
| 4.2 | Versionamento do wire: aceitar união de versões + erro estruturado `unsupported_version` (min/max suportado); hoje `z.literal(1)` + client trata 4xx como permanente e descarta o batch | `apps/server/app/api/ingest/route.ts:82`; `lib/reporter/types.ts:96`; `lib/reporter/client.ts:149-150` | `wire-protocol-versioning.md` | M | TODO |
| 4.3 | (a) Singleton SQLite via `globalThis` (HMR do dev vaza handles WAL); (b) rate limiter do server é in-memory `Map` — documentar premissa single-instance ou mover p/ Postgres | `lib/db/client.ts:30-44`; `apps/server/app/api/ingest/route.ts:60-73` | `arch-followups-lowsev.md` | S | TODO |
| 4.4 | NextAuth GA quando sair de beta (hoje `5.0.0-beta.25` ancora o upgrade path do server) | `apps/server/package.json` | milestone, sem spec agora | — | TODO |

## Pendências de ambiente (sem spec)

- **Node**: `.tool-versions` pede `nodejs 26.1.0`, asdf só tem 24.16.0; o binário
  do `better-sqlite3` foi recompilado para Node 24 durante a avaliação. Alinhar:
  `asdf install nodejs 26.1.0` + `pnpm rebuild better-sqlite3`.
- **E2E Playwright**: rodar `pnpm exec playwright install && pnpm test:e2e`
  quando a rede permitir baixar o Chromium (CDN falhou 3× em 2026-07-11).

## Sequenciamento

1. **Caminho crítico da apresentação = Fases 1 + 2.** Paralelizável (arquivos
   disjuntos): 1.1+1.3 (analytics/queries) ∥ 1.2 (apps/server) ∥ 2.1–2.3 (docs).
   Estimativa: 1–2 sessões de trabalho.
2. Fase 3: 3.3 é o mínimo pré-apresentação; 3.1/3.2 podem ser apresentados como
   follow-ups documentados.
3. Fase 4: pós-apresentação.
4. Ordem sugerida de início: **1.1 → 1.2 → (1.3+1.4) → 2.1–2.3 → 2.4**.

## Decisões de produto pendentes (destravam specs)

| Decisão | Opções | Item |
| --- | --- | --- |
| Cap de 50 sessões no score | (a) remover o cap; (b) manter e expor a amostragem na UI | 2.5 |
| Retenção de aggregates | definir janela (ex.: 12/24 meses), comportamento no offboarding (anonimizar vs apagar) | 3.2 |

## Guia para agentes implementadores

Contexto operacional para qualquer agente que pegue um item deste plano.

### Fluxo obrigatório

1. Cada item de tamanho S+ segue o fluxo SDD completo (`.claude/rules/sdd.md`):
   `/spec` → self-review → **aprovação do usuário** → `/ralph-loop` →
   self-review → **aprovação do usuário** → commit. Itens XS marcados como
   "chore direto" (2.4) dispensam spec, mas não dispensam validação.
2. Validação mínima por task: `pnpm typecheck && pnpm test -- --run` (raiz) ou
   `pnpm typecheck && pnpm test` (apps/server, precisa de `DATABASE_URL`
   apontando para um Postgres 16 — testcontainers cobre se Docker estiver up).
3. Test Plan é mandatório em toda spec; TCs de erro/edge devem superar os de
   happy path. Convenções de TC-ID e categorias no `.claude/rules/sdd.md`.

### Ambiente (pegadinhas conhecidas)

- **Node**: `.tool-versions` pede 26.1.0; se o asdf não tiver, use
  `ASDF_NODEJS_VERSION=24.16.0 ASDF_PNPM_VERSION=10.20.0` e rode
  `pnpm rebuild better-sqlite3` se aparecer erro de `NODE_MODULE_VERSION`.
- **`pnpm test --run` falha** ("Unknown option") — a forma correta é
  `pnpm test -- --run`.
- **Nunca escrever em `data/dashboard.db`** (dados reais do usuário). Para
  testar com dados, use `DASHBOARD_DB_PATH=<scratch>/sim.db pnpm seed-dev`.
- Dois dev servers Next no mesmo diretório não coexistem (Next 16 recusa);
  derrube o `pnpm dev` antes de rodar `pnpm test:e2e`.
- Erro `MODULE_UNPARSABLE ... instrumentation.ts` no boot do dev = cache stale;
  `rm -rf .next` resolve.
- apps/server em dev: `AUTH_REQUIRED=false` + Postgres descartável
  (`docker run -d -p 5433:5432 postgres:16-alpine` + `pnpm db:migrate`) é o
  caminho mais rápido — mas lembre que `/manager` e `/me/visibility` dão 500
  nesse modo até o item 1.2 ser corrigido.

### Invariantes que NENHUM item pode quebrar

- **Contrato de privacidade**: o schema do allowlist vive SÓ em
  `lib/reporter/types.ts` e é re-exportado por
  `apps/server/lib/ingest/sanitizer-shared.ts`. Nunca duplicar, nunca fazer
  spread de objetos de entrada no sanitizer, manter `.strict()` nos dois lados.
- **Org scoping**: toda query nova no apps/server filtra por `orgId` da sessão.
- **Prepared statements** em todo SQL (better-sqlite3 `?` binding; Drizzle
  parametrizado — nunca `sql.raw` com input).
- **Idempotência de ingestão** (raiz: UUID do JSONL + `ON CONFLICT`; server:
  sha256 canonical-JSON) — qualquer mudança em writer/ingest preserva re-run
  seguro.
- Specs em `IN_PROGRESS`: Requirements e Test Plan são imutáveis; Execution Log
  é append-only.

### Referências dos achados originais

Os detalhes completos por área (com cenários de falha) estão na avaliação de
2026-07-11 conduzida via 5 revisões paralelas; os apontamentos acionáveis foram
todos absorvidos nas tabelas acima. O reviewer de dados também persistiu os
achados de métricas em `.claude/agent-memory/data-reviewer/analytics_metrics_findings.md`.

## Mensagem-alvo da apresentação

Com Fases 1–2 (+3.3) fechadas, a afirmação honesta e forte é:

> "Feature-complete para o escopo declarado, validado ao vivo de ponta a ponta,
> com dois follow-ups operacionais documentados (UI de revogação de máquina e
> política de retenção) e dívida arquitetural mapeada com plano."
