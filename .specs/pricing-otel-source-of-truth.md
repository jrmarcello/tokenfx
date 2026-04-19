# Spec: Pricing híbrido — OTEL como fonte de verdade, tabela hardcoded como fallback

## Status: DONE

## Context

A auditoria recente descobriu um bug silencioso: `claude-opus-4-6` não estava na tabela hardcoded de `lib/analytics/pricing.ts` → 22.508 turns congelados em `$0` → KPI de custo 30d subregistrado em **172%** ($3.2k displayed vs $8.7k real). O fix (family-prefix fallback) resolve o caso específico, mas **a tabela hardcoded continua sendo single point of failure**: depende de auditoria manual a cada 30–60 dias, não captura descontos corporativos, e qualquer família nova que fuja do pattern `claude-(opus|sonnet|haiku)` regride o bug.

O Claude Code **já exporta via OTEL Prometheus** duas métricas diretamente relevantes — e a gente já ingere outros metrics do mesmo endpoint. Os nomes abaixo foram **validados em produção** (6 scrapes reais no DB do autor incluindo um valor de $61.83 na sessão opus-4-7[1m]):

- `claude_code_cost_usage_total` — counter cumulativo em USD, labels `session_id` + `model` + `user_id` + `organization_id`. **É a autoridade.** Sai do Claude Code, que sabe o preço exato que a Anthropic cobrou (incluindo descontos, promo credits, taxas diferenciadas por org).
- `claude_code_token_usage_total` — counter de tokens, labels `type` + `model`. **Fora de escopo desta spec** — `turns.input_tokens` etc. vêm do JSONL com granularidade por turno, enquanto OTEL agrega por sessão. Sem ganho óbvio em trocar.

### Contexto adicional: nomes de métrica OTEL precisam auditoria

A reality-check que embasa esta spec expôs um **bug pré-existente**: o código atual em [lib/queries/otel.ts:27](lib/queries/otel.ts#L27) busca `claude_code_code_edit_tool_decision_count_total`, mas o nome real emitido é `claude_code_code_edit_tool_decision_total` (sem `_count`). Resultado: **accept rate OTEL sempre zerado** mesmo com telemetria ligada. O mesmo pode valer pra `METRIC_ACTIVE = 'claude_code_active_time_total_seconds_total'` (nome não confirmado em runtime — só emitido em sessões interativas). Corrigir antes de adicionar novas constantes, senão herdamos o mesmo problema.

A proposta é simples: prefere OTEL quando disponível; cai pra `computeCost()` local quando não (sessões pré-OTEL, OTEL desligado no momento da ingest, primeiro scrape de uma sessão nova ainda não aconteceu). A tabela hardcoded vira **safety net** — continua recebendo manutenção de staleness, mas deixa de ser a única fonte.

## Requirements

- [ ] **REQ-1**: GIVEN o Claude Code está exportando OTEL AND uma sessão tem pelo menos um scrape de `claude_code_cost_usage_USD_total` com `session_id` igual AO da sessão WHEN a ingest processa essa sessão THEN o valor de OTEL é armazenado em uma nova coluna `sessions.total_cost_usd_otel` (REAL, nullable).
- [ ] **REQ-2**: GIVEN uma sessão tem `total_cost_usd_otel IS NOT NULL` WHEN a UI exibe custo da sessão (home KPIs, top sessions, session detail, effectiveness) THEN prefere `total_cost_usd_otel`; **tudo** que lê custo passa por um único `COALESCE(total_cost_usd_otel, total_cost_usd)` expresso como coluna/view — sem espalhar a lógica por N queries.
- [ ] **REQ-3**: GIVEN uma sessão tem `total_cost_usd_otel IS NULL` WHEN a UI exibe custo THEN usa `total_cost_usd` (fallback local via `computeCost`, comportamento atual) — sem regressão visual.
- [ ] **REQ-4**: GIVEN uma sessão mostra custo de fonte OTEL WHEN a UI renderiza o KPI/linha THEN exibe um **indicador visual discreto** (ex: ponto verde + tooltip "custo via OTEL (Claude Code)"). GIVEN vem do fallback local THEN um indicador neutro (ou ausência) + tooltip "custo estimado via tabela local (`lib/analytics/pricing.ts`)".
- [ ] **REQ-5**: GIVEN o ingest roda com OTEL ativo (`otelUrl` configurado + endpoint respondeu) WHEN `ingestAll` completa THEN o scrape OTEL é gravado **antes** do processamento de JSONLs, de forma que a atualização de `total_cost_usd_otel` pode usar scrapes do próprio run. (Hoje a ordem é inversa — JSONLs primeiro, OTEL depois.)
- [ ] **REQ-6**: GIVEN `pnpm recompute-costs` roda **sem** `--prefer-otel` WHEN termina THEN comportamento atual preservado (recomputa `turns.cost_usd` via `computeCost` e refaz rollups; `total_cost_usd_otel` intocado).
- [ ] **REQ-7**: GIVEN `pnpm recompute-costs --prefer-otel` roda WHEN termina THEN faz UPDATE de `sessions.total_cost_usd_otel` a partir dos `otel_scrapes` históricos para **todas** as sessões que têm scrape de `claude_code_cost_usage_USD_total`. Idempotente.
- [ ] **REQ-8**: GIVEN a tabela hardcoded de pricing é desatualizada (>90 dias) WHEN `pnpm ingest` roda THEN continua logando o mesmo warning de staleness atual (a tabela ainda é crítica como fallback).
- [ ] **REQ-9**: GIVEN OTEL counter do `claude_code_cost_usage_USD_total` reseta (Claude Code restart dentro da mesma sessão) WHEN a query de OTEL agrega valores THEN usa `MAX(value)` por série `(session_id, model)` — mesma convenção documentada em [lib/queries/otel.ts:14-17](lib/queries/otel.ts#L14-L17). Aceita undercount entre restarts como trade-off conhecido.
- [ ] **REQ-10**: GIVEN o Claude Code emite counter com nome `claude_code_cost_usage_total` (validado em produção) WHEN a query de OTEL busca custo THEN usa esse nome exato. Para robustez contra mudanças futuras do exporter OTEL, o matching é **case-insensitive** e aceita variações com unit suffix (`_usd_total`, `_USD_total`) via `LOWER(metric_name) IN (...)`.
- [ ] **REQ-11**: GIVEN o código atual tem constantes de metric name desalinhadas com os nomes reais emitidos pelo Claude Code (especificamente `METRIC_DECISION` e `METRIC_ACTIVE` em [lib/queries/otel.ts](lib/queries/otel.ts)) WHEN esta spec é executada THEN corrige os nomes antes de adicionar `METRIC_COST`, e documenta o método usado (comparação com `SELECT DISTINCT metric_name FROM otel_scrapes` em DB real) pra auditorias futuras.
- [ ] **REQ-12**: GIVEN uma sessão tem divergência entre `total_cost_usd_otel` (autoridade) e `total_cost_usd` (soma dos turnos via `computeCost`) **maior que 1%** WHEN a página de detalhe `/sessions/[id]` renderiza o KPI de custo THEN exibe **ambos os valores** com label diferenciado (`OTEL: $X · estimado local: $Y`). Isso evita o "paradoxo" do total da sessão não bater com a soma dos turnos no transcript viewer (que continua mostrando `computeCost` por turno).
- [ ] **REQ-13**: GIVEN um KPI agregado mistura sessões OTEL e locais (ex: "Custo 30d" com 12 OTEL + 30 locais) WHEN renderiza THEN **não mostra badge principal** (ambíguo) — exibe a contagem no tooltip do card (`info`): "12 de 42 sessões com custo via OTEL; resto via tabela local". Badge "OTEL" só aparece em itens de granularidade única (linha da lista de sessões, card de session detail, top session específico).
- [ ] **REQ-14**: GIVEN `ingestAll` completa e a ingestão de JSONLs pulou sessões (por mtime gate) que **poderiam** ter OTEL novo WHEN o orquestrador finaliza THEN executa um **sweep final** chamando `getOtelCostBySession(db)` e fazendo UPDATE de `total_cost_usd_otel` em qualquer sessão cujo valor OTEL armazenado diferir do valor OTEL atual no DB. Uma query + UPDATE batch, sem custo mensurável.

## Test Plan

### Unit Tests — `lib/analytics/pricing.test.ts` (sem mudança; testes existentes cobrem o fallback)

N/A — sem nova lógica puramente funcional. Todo o trabalho é I/O (DB + HTTP scrape).

### Integration Tests

**Em `lib/queries/otel.test.ts`** (query de custo):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | Scrape com `metric_name='claude_code_cost_usage_USD_total'`, `labels.session_id='s1'`, 3 scrapes com valores crescentes `0.1, 0.5, 1.2` → `getOtelCostBySession(db)` | Map contém `s1 → 1.2` (MAX) |
| TC-I-02 | REQ-9 | edge | Duas séries pra mesma sessão com diferentes `labels.model`: opus MAX=1.0 + sonnet MAX=0.5 | Map contém `s1 → 1.5` (SUM dos MAXes) |
| TC-I-03 | REQ-10 | edge | Scrape com metric_name em minúsculo `claude_code_cost_usage_usd_total` | Também matched; valor incluído |
| TC-I-04 | REQ-1 | edge | Scrape sem `session_id` label → ignorado | Não aparece no Map |
| TC-I-05 | REQ-3 | edge | Sem nenhum scrape de cost no DB | Map vazio `new Map()` |

**Em `tests/integration/writer-otel-cost.test.ts`** (novo):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-06 | REQ-1, REQ-5 | happy | Ingest roda com OTEL mockado que retorna scrape de `cost_usage_USD_total` pra sessão `s1` → sessão s1 é ingerida via JSONL | `sessions.total_cost_usd_otel` = valor do scrape; `sessions.total_cost_usd` = SUM(turn costs via computeCost) |
| TC-I-07 | REQ-3 | happy | Ingest sem OTEL (otel URL unreachable) | `total_cost_usd_otel IS NULL`; `total_cost_usd` = valor local como antes |
| TC-I-08 | REQ-5 | business | OTEL vem antes de JSONLs no pipeline — ao processar JSONL, a query pode encontrar o scrape | `total_cost_usd_otel` populado no **primeiro** ingest |

**Em `tests/integration/migrate-cost-source.test.ts`** (novo):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-09 | REQ-1 | infra | Legacy DB sem coluna `total_cost_usd_otel` (schema antigo) passa por `migrate()` | Coluna adicionada via ALTER TABLE; existing rows têm NULL |
| TC-I-10 | REQ-1 | idempotency | `migrate()` rodado 2x seguidas em DB já migrado | Sem erro; schema estável |

**Em `tests/integration/recompute-costs.test.ts`** (novo ou aderente ao existente):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-11 | REQ-6 | happy | DB com sessão s1 + scrapes OTEL; rodar `pnpm recompute-costs` SEM flag | `total_cost_usd` atualizado via computeCost; `total_cost_usd_otel` intocado |
| TC-I-12 | REQ-7 | happy | Mesmo DB; rodar COM `--prefer-otel` | `total_cost_usd_otel` populado pra sessões com scrape; `total_cost_usd` também permanece (fallback) |
| TC-I-13 | REQ-7 | idempotency | Rodar `--prefer-otel` 2x seguidas | Segundo run: 0 updates |
| TC-I-14 | REQ-7 | edge | Sessão sem scrape OTEL | `total_cost_usd_otel` permanece NULL após `--prefer-otel` |

**Em `lib/queries/otel.test.ts`** (nomes corrigidos):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-15 | REQ-11 | business | Fixture OTEL com `metric_name = 'claude_code_code_edit_tool_decision_total'` (nome real, sem `_count`) rodando getOtelInsights | `acceptRate` calculado corretamente (não mais 0 constante) |

**Em `tests/integration/writer-otel-cost.test.ts`** (sweep final):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-16 | REQ-14 | edge | Sessão com JSONL mtime antigo (pula writeSession) mas novo scrape OTEL chegou no mesmo run | Sweep final atualiza `total_cost_usd_otel` mesmo sem passar pelo writeSession |

### E2E Tests — `tests/e2e/smoke.spec.ts` (extensão)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-08 | REQ-4 | happy | Home page mostra badge "OTEL" ao lado do KPI de custo quando a janela tem ao menos uma sessão com `total_cost_usd_otel IS NOT NULL` (seed cobre) | Badge visible |
| TC-E2E-09 | REQ-3, REQ-4 | happy | Session detail page de uma sessão sem OTEL mostra ausência do badge (ou badge "local") | Conforme design |

## Design

### Architecture Decisions

1. **Coluna dedicada em vez de coluna única + flag.** `sessions.total_cost_usd_otel REAL NULL` guarda o valor OTEL; `sessions.total_cost_usd` guarda o valor local (como hoje). Queries escolhem via `COALESCE`. Vantagens: (a) reconcile.ts não precisa de lógica condicional — continua sendo SUM(turns.cost_usd) sempre, (b) UI pode mostrar lado a lado para debug/audit, (c) provenance é inerente à coluna lida.

2. **Nada toca `turns.cost_usd`.** OTEL é granularidade de sessão; turnos continuam via `computeCost()`. Transcript viewer (cost por turno) não muda.

3. **Ordem do ingest invertida.** `ingestAll` hoje: JSONL primeiro, OTEL depois. Nova ordem: OTEL primeiro (escrita em `otel_scrapes`), depois JSONLs (que leem `otel_scrapes` pra populate `total_cost_usd_otel` do mesmo run). Se OTEL indisponível → fallback automático.

4. **`COALESCE` inline em cada query, não via view.** Descartado usar uma coluna `authoritative_cost_usd` na view `session_effectiveness` porque a maioria das queries que leem custo (`getOverviewKpis`, `getTopSessions`, `getDailySpend`, `getCostPerTurnValues`) vão direto em `sessions`, não na view. Forçar passagem por view seria invasivo. Inline: cada SELECT de custo vira `COALESCE(total_cost_usd_otel, total_cost_usd) AS total_cost_usd`. Mais grepável ("quem lê custo?"), sem mágica de view.

5. **Nome exato do metric + defesa em profundidade.** O nome emitido hoje é `claude_code_cost_usage_total` (sem unit suffix — validado). Mas pra não ficar refém de uma mudança futura do OTEL exporter da Anthropic, a query faz `LOWER(metric_name) IN ('claude_code_cost_usage_total', 'claude_code_cost_usage_usd_total')`. Dois aliases cobrem o universo conhecido.

6. **Badge visual discreto.** Novo componente `components/cost-source-badge.tsx` — dot verde/cinza + `title` attribute (tooltip nativo), renderizado ao lado de KPIs e listas. Zero JavaScript (só aria-label + title).

7. **Recompute-costs --prefer-otel.** Flag adiciona uma fase extra antes de reconcileAllSessions: para cada sessão, consulta OTEL e seta `total_cost_usd_otel`. Default stays 100% compatível com uso atual.

8. **Migração automática.** `migrate()` detecta coluna ausente via `PRAGMA table_info(sessions)` e roda ALTER TABLE — mesmo padrão de `backfillTurnsSubagentType` em `lib/db/migrate.ts:96-107`.

### Files to Create

- `components/cost-source-badge.tsx` — badge visual
- `tests/integration/writer-otel-cost.test.ts` — cobertura do write path com OTEL
- `tests/integration/migrate-cost-source.test.ts` — cobertura da migração
- `tests/integration/recompute-costs.test.ts` — cobertura do script (pode já existir embrionário; criar se não)

### Files to Modify

- `lib/db/schema.sql` — nova coluna `total_cost_usd_otel`; view `session_effectiveness` ganha `authoritative_cost_usd`
- `lib/db/migrate.ts` — backfill da coluna (`backfillSessionsOtelCost`)
- `lib/queries/otel.ts` — constante `METRIC_COST`, função `getOtelCostBySession(db): Map<string, number>`, (opcional) `getOtelCostForSession(db, id): number | null`
- `lib/ingest/writer.ts` — reordem no `ingestAll` (OTEL → JSONLs); em `writeSession`, após reconcile, UPDATE `total_cost_usd_otel` se OTEL tem valor; expor helper pra `recompute-costs`
- `lib/queries/overview.ts`, `lib/queries/session.ts`, `lib/queries/effectiveness.ts` — SELECT passa a ler `authoritative_cost_usd` (via view) em vez de `total_cost_usd`; tipos e tests atualizados
- `app/page.tsx`, `app/sessions/page.tsx`, `app/sessions/[id]/page.tsx`, `app/effectiveness/page.tsx` — renderizar `<CostSourceBadge source={...} />` onde custo aparece
- `scripts/recompute-costs.ts` — parse `--prefer-otel`; adicionar fase de update de `total_cost_usd_otel`
- `tests/e2e/global-setup.ts` — seed adiciona scrape OTEL de custo pra `e2e-today` session
- `tests/e2e/smoke.spec.ts` — TC-E2E-08/09

### Dependencies

Nenhuma nova. Tudo é SQL + TS + leitura de `otel_scrapes` (que já é ingerida).

## Tasks

- [x] **TASK-0**: Auditar e corrigir nomes de métricas OTEL existentes em [lib/queries/otel.ts](lib/queries/otel.ts) contra os nomes reais emitidos pelo Claude Code. Comparação base: `SELECT DISTINCT metric_name FROM otel_scrapes` no DB do dev (6 nomes confirmados). Conhecido: `METRIC_DECISION` usa `_count_total` mas deveria ser `_total` sem `_count`. Verificar `METRIC_ACTIVE` também. Atualizar constantes + fixtures dos tests (`otel.test.ts` usa os nomes "errados" consistentes — corrigir também). Adicionar comentário `// validated against <data dump>` em cada constante com a data.
  - files: lib/queries/otel.ts, lib/queries/otel.test.ts
  - tests: TC-I-15

- [x] **TASK-1**: Estender schema + migração com `sessions.total_cost_usd_otel REAL NULL`. Backfill ALTER TABLE idempotente em `migrate.ts` seguindo o padrão de `backfillTurnsSubagentType`. Testes de migração.
  - files: lib/db/schema.sql, lib/db/migrate.ts, tests/integration/migrate-cost-source.test.ts
  - tests: TC-I-09, TC-I-10

- [x] **TASK-2**: Query OTEL de custo em `lib/queries/otel.ts` — constante `METRIC_COST = 'claude_code_cost_usage_total'`, função `getOtelCostBySession(db): Map<string, number>` (MAX per (session_id, model) series, SUM across models por sessão). Matching case-insensitive com 2 aliases (`_total` e `_usd_total`). Opcional: `getOtelCostForSession(db, id)` wrapper. Testes.
  - files: lib/queries/otel.ts, lib/queries/otel.test.ts
  - depends: TASK-0
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05

- [x] **TASK-3**: `writer.ts` — (a) reordenar `ingestAll` pra fetch OTEL **antes** dos JSONLs; (b) após `writeSession`, consultar `getOtelCostForSession(db, parsed.id)` e UPDATE `sessions.total_cost_usd_otel`; (c) **sweep final no fim do `ingestAll`** (REQ-14): `getOtelCostBySession(db)` + UPDATE em batch pra sessões com divergência (cobre o caso de JSONL com mtime-gate). Fallback gracioso quando OTEL off.
  - files: lib/ingest/writer.ts, tests/integration/writer-otel-cost.test.ts
  - depends: TASK-1, TASK-2
  - tests: TC-I-06, TC-I-07, TC-I-08, TC-I-16

- [x] **TASK-4**: Ajustar queries de leitura pra usar **inline `COALESCE(total_cost_usd_otel, total_cost_usd) AS total_cost_usd`** (Design §4) nas SELECTs de custo. Retornar também `cost_from_otel: boolean` (via `total_cost_usd_otel IS NOT NULL`) no row type. Tipos expandidos: `SessionListItem.costSource`, `OverviewKpis.spend30dCostSources: { otel: number, local: number }` (contadores pra REQ-13). Atualizar tests.
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts, lib/queries/session.ts, lib/queries/session.test.ts, lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - depends: TASK-1

- [x] **TASK-5**: `components/cost-source-badge.tsx` — Client (ou Server, é stateless) component. Props: `{ source: 'otel' | 'local' }`. Renderiza dot + aria-label + `title` (tooltip nativo). Variação em `{ counts: { otel: number; local: number } }` pra agregados: não renderiza badge principal, só texto no tooltip (REQ-13).
  - files: components/cost-source-badge.tsx
  - depends: (nada; tipo de prop é inline, independe de TASK-4)

- [x] **TASK-6**: Integrar badge na UI: session detail card de custo (REQ-12: exibe OTEL + local lado a lado se divergem >1%), session list row (badge por item), session top list na home (idem), KPI "Custo 30d" (tooltip com contagem, não badge principal — REQ-13).
  - files: app/page.tsx, app/sessions/page.tsx, app/sessions/[id]/page.tsx, app/effectiveness/page.tsx, components/kpi-card.tsx (talvez ajuste no prop `info`)
  - depends: TASK-4, TASK-5

- [x] **TASK-7**: `scripts/recompute-costs.ts` — parse flag `--prefer-otel`. Sem flag: comportamento atual intocado. Com flag: **só** atualiza `total_cost_usd_otel` (não mexe em `total_cost_usd`), usando `getOtelCostBySession`. Log separado `updated_otel_costs`. Idempotente.
  - files: scripts/recompute-costs.ts, tests/integration/recompute-costs.test.ts
  - depends: TASK-2
  - tests: TC-I-11, TC-I-12, TC-I-13, TC-I-14

- [x] **TASK-SMOKE**: E2E — seed inclui scrape OTEL de `claude_code_cost_usage_total` pra sessão `e2e-today`. Assert badge "OTEL" na row dessa session; assert ausência em session sem OTEL; assert tooltip agregado na home KPI mostra contagem.
  - files: tests/e2e/smoke.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-6
  - tests: TC-E2E-08, TC-E2E-09

## Parallel Batches

```text
Batch 1: [TASK-0, TASK-1, TASK-5]    — parallel (fix metric names, schema/migrate, badge component; arquivos disjoint)
Batch 2: [TASK-2]                    — OTEL cost query (depende de TASK-0 para não colidir em otel.ts)
Batch 3: [TASK-3, TASK-4, TASK-7]    — parallel (writer, reads, script; arquivos disjoint, ambos precisam de Batch 1+2)
Batch 4: [TASK-6]                    — UI integration (depende de TASK-4 + TASK-5)
Batch 5: [TASK-SMOKE]                — E2E final
```

File overlap analysis:

- `lib/queries/otel.ts` + `.test.ts`: **compartilhado** entre TASK-0 e TASK-2 (shared-additive — TASK-0 renomeia constantes, TASK-2 adiciona nova constante). Serializados em batches sucessivos.
- `lib/db/schema.sql` + `lib/db/migrate.ts` + teste migração: exclusivo do TASK-1
- `lib/ingest/writer.ts` + teste writer-otel-cost: exclusivo do TASK-3
- `lib/queries/{overview,session,effectiveness}.ts` + `.test.ts`: exclusivo do TASK-4
- `components/cost-source-badge.tsx`: exclusivo do TASK-5
- `app/**/page.tsx`: exclusivo do TASK-6
- `scripts/recompute-costs.ts` + teste: exclusivo do TASK-7
- `tests/e2e/*`: exclusivo do TASK-SMOKE

Batches 1 e 3 rodam 3 tarefas em paralelo em worktrees; Batch 2 é solo (single file overlap).

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos os TCs verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa
- [ ] Conferir em `pnpm dev`:
  - Sem OTEL ativo: comportamento idêntico ao atual (fallback local, nenhum badge ou badge "local")
  - Com OTEL ativo: badge visível nos KPIs/listas que mostram custo; tooltip explicativo
  - `/sessions/[id]` de uma sessão com OTEL mostra custo de fonte OTEL; de uma sessão antiga continua mostrando via tabela
- [ ] Cross-check: `SELECT id, total_cost_usd, total_cost_usd_otel FROM sessions WHERE total_cost_usd_otel IS NOT NULL LIMIT 10;` — diferenças entre as duas colunas são explicáveis (e típicas: descontos ou undercount por restart)
- [ ] `pnpm recompute-costs --prefer-otel` popula coluna OTEL sem tocar `total_cost_usd`

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
