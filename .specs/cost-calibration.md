# Spec: Cost calibration — aprender o multiplicador efetivo do plano

## Status: DONE

## Context

A spec anterior `.specs/pricing-otel-source-of-truth.md` fez OTEL a fonte autoritativa do custo quando disponível. Ficou um buraco: **a maioria das sessões do usuário não tem OTEL** (sessões antigas, concorrentes que perderam a porta 9464, períodos em que o dashboard não estava scraping). Nessas, o dashboard mostra `computeCost()` puro — list price da Anthropic.

No DB atual do autor: list price 30d = **$9.037**, efetivo 30d = **~$2.083** (ratio 0.23, coerente com Claude Max). Gap de **4.3×**. E métricas derivadas herdam esse erro:

- **Score de efetividade via seleção indireta** — `effectivenessScore` em si não usa cost (pondera output/input, cache hit, rating, correção, tool error, accept rate). Mas `getSessionScores` usa `topSessions` ordenado por custo pra escolher as 50 sessões a pontuar. Calibração muda a ordem → muda quais entram no top-50 → muda `avgScore`.
- `getTopSessions` ordena por `total_cost_usd` — ordem pode mudar
- Heatmap de atividade colore por quartil de spend → distribuição distorcida
- Cost per line (cost ÷ lines) → 4× inflado
- Model breakdown pie → proporções corretas, mas valores absolutos errados

**Solução**: quando temos OTEL *e* local pra uma sessão, a razão `otel/local` revela o multiplicador efetivo do plano da Anthropic. Com ≥1 amostra válida a gente calibra; recalibra a cada ingest à medida que mais OTEL chega. Sessões só-local passam a mostrar `effective = local × rate` com badge `calibrated` na UI.

**Confirmação empírica no dry-run**: 1 sessão com OTEL no autor (562f31db) tem ratio 0.2305. Aplicado no total 30d, aproxima do custo real que ele paga no Max.

**Bônus (não-central)**: o parser de tokens mescla `cache_creation.ephemeral_5m_input_tokens` e `ephemeral_1h_input_tokens` num único campo, e ignora `service_tier`. Corrigir enquanto mexemos no pricing é barato e tira fontes residuais de erro.

## Requirements

- [ ] **REQ-1**: GIVEN o DB tem ≥1 sessão com `total_cost_usd_otel IS NOT NULL AND total_cost_usd > 0` WHEN `ingestAll` completa (ou `pnpm recompute-costs --recalibrate` roda) THEN a tabela `cost_calibration` é populada com `effective_rate = SUM(otel) / SUM(local)` por família de modelo.
- [ ] **REQ-2**: `effective_rate` é aceito **se e somente se** `MIN_RATE <= rate <= MAX_RATE`, com `MIN_RATE = 0.01` e `MAX_RATE = 2.0` **inclusivos**. Fora disso a linha correspondente não é inserida/atualizada; família fica sem calibração e cai pro fallback. Previne poluição por 1 sample pathológico. O helper `effectiveCostForSession` **também** re-valida ao ler (defense-in-depth): se uma rate rogue aparecer na tabela, é ignorada e cai pro próximo nível da cascata.
- [ ] **REQ-3**: Função `effectiveCostForSession({ localCost, otelCost, model, calibration })` retorna `{ value: number, source: 'otel' | 'calibrated' | 'list', calibration?: { family, rate, sampleCount } }` com a cascata: OTEL → calibrated (family-specific) → calibrated (global fallback) → list.
- [ ] **REQ-4**: GIVEN família `opus` tem calibração AND família `sonnet` não tem WHEN `effectiveCostForSession` é chamado pra um modelo sonnet THEN aplica o **ratio global** (agregado de todas famílias) em vez de cair direto pro `list`. Só cai pro `list` quando zero amostras OTEL em todo o DB.
- [ ] **REQ-5**: GIVEN model string da sessão é `other` (não-claude) WHEN calibração busca rate THEN usa o ratio global (não há "family=other" calibração própria — só 3 famílias claude + global).
- [ ] **REQ-6**: Todas as queries que expõem custo agregado passam a usar **effective cost**: `getOverviewKpis.spend*`, `getDailySpend.spend`, `getTopSessions.totalCostUsd`, `getSession.totalCostUsd`, `listSessions.totalCostUsd`, `listSessionsByDate.totalCostUsd`, `getCostPerTurnValues`, `getModelBreakdown`, `getOtelInsights.costPerLineOfCode`, `getSessionScores` (via cost-per-turn input).
- [ ] **REQ-7**: Per-turn cost no transcript viewer continua como `list price` (não se calibra granularidade de turno — calibração é session-level pela definição do ratio `SUM(otel)/SUM(local)`).
- [ ] **REQ-7b**: O header do transcript viewer ganha uma **nota única** (não por turno, pra não poluir) avisando: `"Custos por turno abaixo são list price — a calibração e o OTEL são aplicados só no total da sessão."`. Renderizada uma vez, no topo da lista de turnos.
- [ ] **REQ-8**: `CostSourceBadge` ganha 3º estado `calibrated` (cor amber-500 — entre emerald OTEL e neutral list). Tooltip: `"Custo calibrado via sua média OTEL: ratio 0.23 aprendido de 1 sessão. Mais sessões OTEL melhoram a estimativa."`
- [ ] **REQ-9**: Home KPI "Custo total (30d)" estende o tooltip agregado com a contagem dos 3 fontes: `"X OTEL · Y calibrado (ratio ~0.23) · Z list price"`.
- [ ] **REQ-10**: Session detail quando `costSource === 'calibrated'` exibe hint: `"calibrado · ratio 0.23 (1 amostra opus) · list: $Y"`. Quando `costSource === 'list'` e existe calibração em outra família: hint menciona "nenhuma amostra pra opus — aplicada calibração global".
- [ ] **REQ-11**: Nova seção em `/effectiveness`: "Fonte dos custos" — tabela pequena mostrando, por família, `effective_rate`, `sample_session_count`, `last_updated_at`, e o footprint no dashboard (N sessões cobertas por cada fonte nos 30d). Pede OTEL se ratio=null em tudo. **Posição**: logo após o grid de KPIs principais, antes dos charts (histograma, weekly ratio, tool leaderboard, model breakdown) — o usuário entende a fidelidade antes de olhar os dados derivados.
- [ ] **REQ-12**: Parser JSONL passa a ler `cache_creation.ephemeral_5m_input_tokens` e `ephemeral_1h_input_tokens` separadamente. **Prioridade explícita**: (a) se `message.usage.cache_creation` (objeto) existir, lê os 2 fields; (b) senão, se `cache_creation_input_tokens` (agregado legado) existir, assume `5m = total, 1h = 0`; (c) senão, ambos = 0. Nunca soma (a) com (b) — são representações alternativas do mesmo dado.
- [ ] **REQ-13**: Parser JSONL passa a ler `service_tier` do usage. Default: `"standard"`. `computeCost` aplica multiplicadores por tier: `standard=1.0, priority=[NEEDS CLARIFICATION: documentar quando surgir], batch=0.5`.
- [ ] **REQ-14**: Pricing table ganha `cacheCreation1h` (2× input) separado de `cacheCreation` (que vira `cacheCreation5m`, 1.25× input — nome explícito). `computeCost` usa ambos.
- [ ] **REQ-15**: Novas colunas em `turns`: `cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0`, `cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0`, `service_tier TEXT NOT NULL DEFAULT 'standard'`. Migration idempotente mesma shape de `backfillTurnsSubagentType`: `PRAGMA table_info(turns)` → se coluna faltar, `ALTER TABLE ... ADD COLUMN` + **(imediatamente no mesmo ramo `if`)** `UPDATE turns SET cache_creation_5m_tokens = cache_creation_tokens` pra migrar os valores legados. Em re-runs, `hasCol === true`, ALTER e UPDATE são pulados. Não depende de valor nas rows pra decidir — só de "coluna acabou de nascer nesta migration". Previne re-migração quando parser novo criar linhas com `5m=0, 1h>0` legítimos.
- [ ] **REQ-16**: `cost_calibration` é recomputada **toda `ingestAll`** no sweep final (depois do sweep de OTEL cost já existente). Custo: 1 query agregação + até 4 UPSERTs (opus/sonnet/haiku/global). Negligível.
- [ ] **REQ-17**: `pnpm recompute-costs --recalibrate` é uma 3ª variante: **só** recomputa a tabela `cost_calibration` (não toca `turns.cost_usd` nem `sessions.total_cost_usd_otel`). Idempotente.

## Test Plan

### Unit Tests — `lib/analytics/cost-calibration.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-3 | happy | `effectiveCostForSession({ localCost: 100, otelCost: 23, model: 'claude-opus-4-7', calibration })` | `{ value: 23, source: 'otel' }` (OTEL vence) |
| TC-U-02 | REQ-3 | happy | OTEL null, calibration tem opus 0.2, model opus | `{ value: 20, source: 'calibrated', calibration: { family: 'opus', rate: 0.2, ... } }` |
| TC-U-03 | REQ-4 | business | OTEL null, calibration tem opus 0.2 apenas, model sonnet | Aplica ratio global → `{ value: local × globalRate, source: 'calibrated', calibration.family: 'global' }` |
| TC-U-04 | REQ-3, REQ-4 | edge | OTEL null, calibration vazia | `{ value: localCost, source: 'list' }` |
| TC-U-05 | REQ-5 | business | model string não-claude ("gpt-4"), calibration tem global | Usa ratio global |
| TC-U-06 | REQ-2 | validation | Input: localCost=100, otelCost=0.00001 (ratio 0.0000001 fora do bound) | `effective_rate` rejected upstream; chamador não recebe essa família — mas se forçar, helper ignora e cai pro fallback (teste isola essa situação) |
| TC-U-07 | REQ-3 | edge | `localCost=0` (sessão zero-cost rara) | `{ value: 0, source: 'list' }` (nenhum ratio aplicável) |
| TC-U-08 | REQ-14 | business | `computeCost` com 1000 tokens em `cache_creation_1h` Opus | `0.001 * 30 = $0.030` (2× input rate, confirmado) |
| TC-U-09 | REQ-13 | business | `computeCost` com `service_tier='batch'`, 1M input Opus | `1 * 15 * 0.5 = $7.50` |
| TC-U-10 | REQ-13 | validation | `service_tier='priority'` (não-canonical) | Default multiplier 1.0 (permissivo, não crasheia) |
| TC-U-11 | REQ-12 | happy | Parser: `message.usage.cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 }` | `ParsedTurn.cacheCreation5mTokens=100, cacheCreation1hTokens=50` |
| TC-U-12 | REQ-12 | edge | Parser: apenas `cache_creation_input_tokens: 200` (formato legado) | `5m=200, 1h=0` — fallback pro agregado |
| TC-U-13 | REQ-12 | edge | Parser: nem split nem agregado presentes | Ambos `= 0` |
| TC-U-14 | REQ-12 | edge | Parser: **ambos** split E agregado presentes | Prioridade split — ignora agregado, não soma |
| TC-U-15 | REQ-13 | happy | Parser: `message.usage.service_tier: 'batch'` | `ParsedTurn.serviceTier='batch'` |
| TC-U-16 | REQ-13 | edge | Parser: sem `service_tier` no usage | `ParsedTurn.serviceTier='standard'` (default) |

### Integration Tests

**Em `tests/integration/cost-calibration.test.ts`** (novo):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | Seed 2 sessões opus com OTEL: (local 100, otel 20), (local 200, otel 40) → `getCostCalibration(db)` | opus rate=0.2, samples=2, sum_otel=60, sum_local=300; global rate=0.2 |
| TC-I-02 | REQ-4 | business | Seed 1 sessão opus com OTEL + 1 sessão sonnet sem OTEL → calibração | opus rate calculado; sonnet não tem linha própria; global = opus rate |
| TC-I-03 | REQ-2 | validation | Seed sessão com ratio 0.0001 (fora do bound inferior) | opus não aparece na tabela (rejeitado) |
| TC-I-04 | REQ-2 | validation | Seed sessão com ratio 50 (fora do bound superior) | idem |
| TC-I-05 | REQ-1, REQ-16 | idempotency | Rodar recalibração 2× sem mudanças | Segunda não altera `last_updated_at` (skip quando rate e samples iguais) |
| TC-I-06 | REQ-17 | happy | `recomputeCosts({ recalibrate: true })` com OTEL no DB | `cost_calibration` populada; `turns.cost_usd` e `total_cost_usd_otel` intocados |
| TC-I-07 | REQ-17 | edge | `recomputeCosts({ recalibrate: true })` com zero OTEL no DB | Tabela fica vazia, sem erro |
| TC-I-08 | REQ-15 | infra | Legacy DB sem colunas `cache_creation_5m/1h_tokens` passa por `migrate()` | Colunas criadas via ALTER; rows existentes têm 5m=original_total, 1h=0 |
| TC-I-09 | REQ-15 | idempotency | `migrate()` 2× em DB já migrado | Sem erro, sem duplicação |
| TC-I-12 | REQ-1 | edge | Family com `sum_local = 0` (ex: turnos locais zeraram mas OTEL existe) → `recomputeCostCalibration` | Skip silencioso: família não aparece na tabela, sem crash de division-by-zero |

**Em `lib/queries/overview.test.ts`** (extensão):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-10 | REQ-6 | happy | `getOverviewKpis` com calibração ativa: 1 sessão OTEL + 2 sessões só-local | `spend30d` = otel + (local × rate) × 2. `spend30dCostSources` conta 3 categorias (otel: 1, calibrated: 2, list: 0) |
| TC-I-11 | REQ-6 | edge | `getOverviewKpis` com zero OTEL no DB | `spend30d = SUM(total_cost_usd)` puro, todas as sessões `source: 'list'` |

### E2E Tests — `tests/e2e/smoke.spec.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-10 | REQ-8 | happy | Seed inclui 1 sessão OTEL + 1 só-local (mesma família). Visit `/sessions` | Sessão só-local mostra badge amber (calibrated); OTEL mostra emerald |
| TC-E2E-11 | REQ-11 | happy | Visit `/effectiveness` → seção "Fonte dos custos" visível | Tabela mostra família + rate + sample count |

## Design

### Architecture Decisions

1. **Calibração é leitura, não escrita.** `turns.cost_usd` e `sessions.total_cost_usd` permanecem em list price — eles são o **denominador** do ratio. Calibração vira multiplicador aplicado no SELECT (helper `effectiveCostForSession`). Consequência: zero risco de corromper dados se a calibração tiver bug.

2. **Tabela dedicada `cost_calibration`** (não coluna derivada em view). Motivos: (a) precisamos de `sample_count`, `last_updated_at` pra UI, (b) recalcular em view a cada SELECT pesa pra queries frequentes. Schema exato:

   ```sql
   CREATE TABLE IF NOT EXISTS cost_calibration (
     family TEXT PRIMARY KEY,            -- 'opus' | 'sonnet' | 'haiku' | 'global'
     effective_rate REAL NOT NULL,       -- SUM(otel) / SUM(local), dentro de [MIN_RATE, MAX_RATE]
     sample_session_count INTEGER NOT NULL,
     sum_otel_cost REAL NOT NULL,        -- agregado usado pro ratio, pra debug/UI
     sum_local_cost REAL NOT NULL,
     last_updated_at INTEGER NOT NULL    -- epoch-ms da última recomputação
   );
   ```

   `recomputeCostCalibration` faz UPSERT (`INSERT ... ON CONFLICT(family) DO UPDATE`). `last_updated_at` só muda quando algum campo material (rate, sample_count, sums) mudou — reruns com zero novidade não geram escrita.

3. **Ratio global como default inteligente**, não média simples das 3 famílias. Se só opus tem samples, o ratio global é `SUM(otel)/SUM(local)` sobre todas as sessões com OTEL — não uma média matemática `(opus_rate + 0 + 0)/3`. Isso preserva peso proporcional.

4. **Recalcular a cada ingest** em vez de em primeiro acesso. Ingest é batch e já tem tx; adicionar 1 query extra é trivial. Queries de leitura ficam simples (só lookup da tabela, sem side effect).

5. **Bounds de rate hard-coded no código** (`MIN_RATE=0.01`, `MAX_RATE=2.0`). Evita overfit em 1 outlier ou ratio absurdo. Valores escolhidos pra cobrir: desconto extremo (0.05 = Claude Max "very heavy"), markup improvável (rate > 1 = usuário paga MAIS que list price, impossível). Fora disso ignora.

6. **`service_tier` e `cache_creation_1h`** — custo baixo implementar, gain pequeno agora mas corrige matemática pra planos futuros da Anthropic. Não são o ponto central da spec mas ficam juntos pra não quebrar `computeCost` em 2 mudanças separadas.

7. **Per-turn cost no transcript viewer fica como list price** — calibração é session-level (baseada em `SUM(otel)/SUM(local)`). Aplicar per-turn seria mentir: não sabemos qual turno específico "custou menos" pelo plano. Mantemos granularidade list na visualização do transcript e documentamos.

8. **UI badge amber em vez de outra cor**: `bg-amber-500` é intermediário visual entre emerald (autoridade máxima) e neutral (estimativa pior). Sinaliza "calibrated = confiável mas estimado".

9. **Calibração fica stale se pricing muda sem re-ingest.** Se Anthropic mudar preço e eu bumpar `pricing.ts`, o denominador `turns.cost_usd` reflete o preço novo **só em turns recém-ingeridos**. Histórico continua no preço velho até `pnpm recompute-costs` (default, não `--recalibrate`). Então o ratio na `cost_calibration` fica misturando list-prices-antigos com OTEL-atual até o próximo recompute-costs completo. Documentar em CONTRIBUTING: quando mudar pricing, rodar `pnpm recompute-costs` primeiro e depois `pnpm recompute-costs --recalibrate` pra recalibrar em cima da base uniforme. (Alternativa: fazer `--recalibrate` implícito após recompute-costs default, mas preserva flexibilidade por ora.)

### Files to Create

- `lib/analytics/cost-calibration.ts` — tipo `Calibration`, helper `effectiveCostForSession`, constantes `MIN_RATE`/`MAX_RATE`
- `lib/analytics/cost-calibration.test.ts` — TC-U-01..10
- `lib/queries/calibration.ts` — `getCostCalibration(db): Map<family, { rate, sampleCount, sumOtel, sumLocal, lastUpdatedAt }>` + `recomputeCostCalibration(db)` (escreve a tabela)
- `lib/queries/calibration.test.ts` — nada novo (tests estão em integration)
- `tests/integration/cost-calibration.test.ts` — TC-I-01..09
- `components/effectiveness/cost-sources-breakdown.tsx` — seção "Fonte dos custos" na página /effectiveness

### Files to Modify

- `lib/db/schema.sql` — nova tabela `cost_calibration`; novas colunas em `turns` (5m/1h/service_tier)
- `lib/db/migrate.ts` — `backfillTurnsCacheCreationSplit` + `ensureCostCalibrationTable` (idempotentes, mesmo padrão de `backfillTurnsSubagentType`)
- `lib/analytics/pricing.ts` — `ModelPricing.cacheCreation5m` / `cacheCreation1h`; `computeCost` assina agora com `{ cacheCreation5mTokens, cacheCreation1hTokens, serviceTier }`; retrocompat: callers antigos passando `cacheCreationTokens` geram warning e assumem 100% 5m
- `lib/analytics/pricing.test.ts` — novos TCs pra 1h e batch
- `lib/ingest/transcript/parser.ts` — ler `cache_creation.ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`, `service_tier` do `message.usage`; popular `ParsedTurn`
- `lib/ingest/transcript/types.ts` — adicionar campos em `ParsedTurn`
- `lib/ingest/writer.ts` — INSERT de `turns` inclui novas colunas; sweep final também chama `recomputeCostCalibration(db)`
- `lib/ingest/reconcile.ts` — `ROLLUP_ONE_SQL` incorpora as novas colunas nos `SUM` de tokens
- `lib/queries/overview.ts` — `spend30d`, `dailySpend.spend`, `topSessions.totalCostUsd` passam por `effectiveCostForSession` (em JS após o SELECT, usando calibração carregada 1× por request)
- `lib/queries/session.ts` — `getSession` e `listSessions*` idem
- `lib/queries/effectiveness.ts` — `getCostPerTurnValues`, `getModelBreakdown`, `getSessionScores` idem
- `lib/queries/otel.ts` — `getOtelInsights.costPerLineOfCode` (o numerador: soma de custos efetivos)
- `app/page.tsx` — home KPI tooltip menciona fontes otel/calibrated/list
- `app/sessions/page.tsx` — badge calibrated em linhas; tooltip explica
- `app/sessions/[id]/page.tsx` — hint de calibração no card de custo
- `app/effectiveness/page.tsx` — renderiza `<CostSourcesBreakdown>`
- `components/cost-source-badge.tsx` — 3º estado `calibrated`
- `scripts/recompute-costs.ts` — flag `--recalibrate`
- `tests/e2e/global-setup.ts` — seed de sessão só-local pra teste de calibrated
- `tests/e2e/smoke.spec.ts` — TC-E2E-10/11

### Dependencies

Nenhuma nova. Tudo SQL + TS + Tailwind.

## Tasks

- [x] **TASK-1**: Schema + migração — nova tabela `cost_calibration`, novas colunas em `turns` (`cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `service_tier`). Migration idempotente: ALTER TABLE turns ADD COLUMN quando faltarem + initial data copy (`UPDATE turns SET cache_creation_5m_tokens = cache_creation_tokens, cache_creation_1h_tokens = 0` só em rows com `cache_creation_5m_tokens = 0 AND cache_creation_tokens > 0` — condição evita re-rodar em re-runs). Cria tabela `cost_calibration` vazia.
  - files: lib/db/schema.sql, lib/db/migrate.ts, tests/integration/migrate-cost-calibration.test.ts (novo)
  - tests: TC-I-08, TC-I-09

- [x] **TASK-2**: `pricing.ts` + pricing tests — split `cacheCreation` em `cacheCreation5m` (1.25× input) e `cacheCreation1h` (2× input). `computeCost` assinatura nova; retrocompat aceita `cacheCreationTokens` legado assumindo 100% 5m. `service_tier` multiplier (standard=1.0, batch=0.5, priority=1.0).
  - files: lib/analytics/pricing.ts, lib/analytics/pricing.test.ts
  - tests: TC-U-08, TC-U-09, TC-U-10

- [x] **TASK-3**: `lib/analytics/cost-calibration.ts` + tests — tipo `Calibration`, constantes `MIN_RATE=0.01 MAX_RATE=2.0`, função `effectiveCostForSession`. Testes unitários cobrem os 3 branches (otel/calibrated/list), fallback global, bounds, edge case de local=0.
  - files: lib/analytics/cost-calibration.ts, lib/analytics/cost-calibration.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07

- [x] **TASK-4**: `lib/queries/calibration.ts` — `getCostCalibration(db)` (lê tabela), `recomputeCostCalibration(db)` (agrega de sessões com OTEL, aplica bounds, UPSERTs). Testes de integração.
  - files: lib/queries/calibration.ts, tests/integration/cost-calibration.test.ts
  - depends: TASK-1, TASK-3
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-12

- [x] **TASK-5**: Parser + writer — `lib/ingest/transcript/parser.ts` lê `cache_creation.ephemeral_*` + `service_tier`, preenche `ParsedTurn`. Writer INSERT inclui novas colunas. Sweep final de `ingestAll` chama `recomputeCostCalibration(db)`. Atualizar `reconcile.ts` pra `SUM` também as novas colunas de cache em `sessions` (nota: ou somar só 5m+1h em `total_cache_creation_tokens` mantendo o agregado — escolher dentro da task).
  - files: lib/ingest/transcript/parser.ts, lib/ingest/transcript/parser.test.ts, lib/ingest/transcript/types.ts, lib/ingest/writer.ts, lib/ingest/reconcile.ts
  - depends: TASK-1, TASK-2, TASK-4
  - tests: TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16

- [x] **TASK-6**: Aplicar `effectiveCostForSession` nas queries de leitura. Cada query de cost carrega calibração 1× (cache por request), aplica em JS após o SELECT. Preserva `total_cost_usd_otel`/`total_cost_usd` crus pra debug. Sessões ganham `costSource: 'otel' | 'calibrated' | 'list'` e opcional `calibrationMeta`. Cost-per-turn bucketing, heatmap levels, model breakdown, getSessionScores — todos convertidos.
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts, lib/queries/session.ts, lib/queries/session.test.ts, lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts, lib/queries/otel.ts
  - depends: TASK-3, TASK-4
  - tests: TC-I-10, TC-I-11

- [x] **TASK-7**: UI — `CostSourceBadge` 3º estado `calibrated` (amber). Wire em `/sessions` list, session detail, home KPI (tooltip menciona 3 fontes). Session detail hint com ratio + sample count. Componente `components/effectiveness/cost-sources-breakdown.tsx` + seção em `/effectiveness` **logo após o grid de KPIs principais, antes dos charts** (REQ-11). Transcript viewer recebe **nota única** no header (REQ-7b): "custos por turno são list price".
  - files: components/cost-source-badge.tsx, components/effectiveness/cost-sources-breakdown.tsx, components/transcript-viewer.tsx, app/page.tsx, app/sessions/page.tsx, app/sessions/[id]/page.tsx, app/effectiveness/page.tsx
  - depends: TASK-6

- [x] **TASK-8**: `scripts/recompute-costs.ts` ganha flag `--recalibrate`. Terceira variante na discriminated union `RecomputeSummary`: `{ mode: 'recalibrate', ...stats }`. Sem flag → comportamento atual; `--prefer-otel` → atual; `--recalibrate` → só recomputa tabela.
  - files: scripts/recompute-costs.ts, tests/integration/recompute-costs.test.ts
  - depends: TASK-4
  - tests: TC-I-06, TC-I-07

- [x] **TASK-SMOKE**: E2E. Seed inclui sessão com `total_cost_usd_otel` + sessão só-local na mesma família; calibração esperada. Asserts: badge calibrated em sessão só-local; seção "Fonte dos custos" visível em `/effectiveness`.
  - files: tests/e2e/smoke.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-7
  - tests: TC-E2E-10, TC-E2E-11

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3]    — parallel (schema, pricing, helper — arquivos disjuntos)
Batch 2: [TASK-4, TASK-5]            — parallel (calibration query vs parser/writer; arquivos disjuntos, ambos precisam Batch 1)
Batch 3: [TASK-6, TASK-8]            — parallel (queries de leitura vs script; arquivos disjuntos, ambos precisam Batch 2)
Batch 4: [TASK-7]                    — UI (depende de TASK-6)
Batch 5: [TASK-SMOKE]                — E2E
```

File overlap analysis:

- `lib/db/schema.sql` + `lib/db/migrate.ts` + teste: exclusivo TASK-1
- `lib/analytics/pricing.ts` + `.test.ts`: exclusivo TASK-2
- `lib/analytics/cost-calibration.ts` + `.test.ts`: exclusivo TASK-3
- `lib/queries/calibration.ts` + teste integration: exclusivo TASK-4
- `lib/ingest/**`: exclusivo TASK-5
- `lib/queries/{overview,session,effectiveness,otel}.ts` + testes: exclusivo TASK-6
- `components/cost-source-badge.tsx` + `components/effectiveness/cost-sources-breakdown.tsx` + `app/**/page.tsx`: exclusivo TASK-7
- `scripts/recompute-costs.ts` + teste: exclusivo TASK-8
- `tests/e2e/*`: exclusivo TASK-SMOKE

Zero overlap entre batches — 3 worktrees paralelos em Batch 1, 2 em Batches 2 e 3.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos TCs verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa
- [ ] Validação com DB real:
  - `pnpm recompute-costs --recalibrate` computa `cost_calibration` com ratio opus ≈ 0.23
  - `/sessions` mostra badge amber (calibrated) em sessões pré-OTEL do usuário
  - KPI "Custo total (30d)" cai de ~$9k pra ~$2k (efetivo calibrado)
  - `/effectiveness` seção "Fonte dos custos" mostra `opus: 0.23 · 1 amostra`
  - Session detail de uma sessão só-local mostra ratio de calibração no hint
- [ ] Validação pós-implementação: `pnpm ingest` re-ingere, calibração é recalculada corretamente; se usuário continuar gerando OTEL, ratio muda aos poucos

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
