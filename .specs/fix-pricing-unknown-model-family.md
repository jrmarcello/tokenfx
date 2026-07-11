# Spec: fix-pricing-unknown-model-family

## Status: DONE

## Context

Item 1.1 (+ 1.3, 1.4) de `docs/execution-plan-2026-07.md`. Três defeitos confirmados ao vivo na avaliação de 2026-07-11:

1. **Custo $0 silencioso para famílias de modelo desconhecidas.** `getPricing()` (`lib/analytics/pricing.ts:86-107`) só tem fallback de família para `claude-(opus|sonnet|haiku)`. O modelo `claude-fable-5` (família Claude 5, lançada após o último audit da tabela) retorna `null`, e `computeCost` retorna `0` sem nenhum warning — `writer.ts` não checa o caso. **Evidência real**: 7.497 turnos ingeridos com custo $0,00 (9,4M output tokens). É a MESMA classe de bug que o fallback de família foi criado para corrigir (incidente `claude-opus-4-6` citado no comentário de `pricing.ts:80-84`) — o fix anterior só protegeu as 3 famílias então conhecidas e não adicionou observabilidade para a próxima família nova.
2. **Fórmula de cache hit divergente.** `overview.ts:119` (`cacheRatioSince`, KPI da home) não inclui `total_cache_creation_tokens` no denominador; a view `session_effectiveness` (`lib/db/schema.sql:150-157`) inclui, deliberadamente e com justificativa em comentário. Mesmo dado → números diferentes entre `/` e `/effectiveness`.
3. **Soft-404 em `/sessions/[id]`.** A página chama `notFound()` (`page.tsx:35`), mas o segmento tem `loading.tsx` → Next faz streaming do shell com HTTP 200 antes do throw. `curl -s -o /dev/null -w '%{http_code}' /sessions/nonexistent` retorna 200 com corpo de 404.

**Decisões já travadas:**

- Pricing Claude 5 (fonte: tabela oficial de modelos, cache 2026-06-24, via skill claude-api): **input $10/MTok, output $50/MTok**. Derivados pelas razões padrão Anthropic (mesmas usadas nas entradas OPUS/SONNET/HAIKU existentes): cache read 0,1× input = **$1.00**; cache write 5m 1,25× = **$12.50**; cache write 1h 2× = **$20.00**. `claude-mythos-5` tem pricing idêntico (mesmo modelo, canal de distribuição diferente).
- Warning de modelo desconhecido: **uma vez por modelo normalizado por processo** (não por turno — 7k turnos = 7k warnings inundaria o log), incluindo o primeiro `sessionId`/`turnId` visto como contexto. Dedup vive em `pricing.ts` com seam de reset para testes (mesmo padrão do `__resetSsoRateLimit` em `apps/server/lib/auth/rate-limit-sso.ts:71`).
- **Risco residual aceito (documentado, fora de escopo):** o fallback de família precifica versões futuras (`claude-fable-6`) com a tabela Claude 5 atual. Se a Anthropic mudar o preço de uma geração futura da mesma família, o valor sai errado-mas-plausível sem warning. Mitigação existente: audit manual + staleness check de 90 dias (`PRICING_LAST_UPDATED`). Mesmo trade-off já aceito para opus/sonnet/haiku.
- Fix do 404: **`generateMetadata` faz o lookup de existência e chama `notFound()`** — `generateMetadata` roda ANTES do streaming começar, então o status HTTP sai 404 de verdade, e o `loading.tsx` (skeleton) é preservado. Para evitar falso-404 numa sessão recém-criada ainda não ingerida (contrato pull-based do CLAUDE.md), `generateMetadata` TAMBÉM chama `await ensureFreshIngest()` — a chamada é coalescida via promise in-flight em `lib/ingest/auto.ts`, então o custo real é um await compartilhado com o body. O lookup usa `getSession` embrulhado em `React.cache()` para não duplicar a query entre metadata e body. Alternativa rejeitada: remover `loading.tsx` (perde o skeleton).
- Correção histórica: usar `pnpm recompute-cost --all` (`scripts/recompute-costs.ts`, modo 1). **Gap pré-existente descoberto no review e trazido para o escopo (REQ-8):** `recomputeTurnsDefault` (`recompute-costs.ts:271-279`) só passa o agregado legado `cacheCreationTokens` ao `computeCost` — ignora `cache_creation_5m_tokens`/`cache_creation_1h_tokens`, sub/superprecificando turnos com cache 1h (2× vs 1,25×). Sem esse fix, a alegação do REQ-4 ("recompute corrige o histórico") não se sustenta para turnos com split.
- `PRICING_LAST_UPDATED` → `'2026-07-11'` (data deste audit).
- **Nota para o implementador (logger):** `lib/logger.ts` NÃO é no-op em testes (gate é só `LOG_LEVEL`, default `info`; `vitest.config.ts` não seta override). Testes que exercitam `warnIfUnknownModel` devem stubar `log.warn` (mutação da propriedade no objeto exportado, hand-written stub — sem mocking framework). A frase "logger is a no-op in tests" no CLAUDE.md está desatualizada — corrigir na spec de docs (item 2.3 do plano), não aqui.

## Requirements

- [x] REQ-1: GIVEN um turno com modelo `claude-fable-5` (ou variantes com sufixo de data/`[1m]`/caixa alta — matching é case-insensitive via `normalizeModel`), WHEN `computeCost` é chamado, THEN o custo é calculado com pricing input $10/output $50/cacheRead $1.00/cache5m $12.50/cache1h $20.00 por MTok.
- [x] REQ-2: GIVEN um modelo de família `fable` ou `mythos` não listado exatamente na tabela (ex.: `claude-fable-5-1`, `claude-mythos-5`), WHEN `getPricing` é chamado, THEN o fallback de família resolve para o pricing Claude 5; e near-misses (`claude-fabled-5`, `claude-mythosx-6`) NÃO casam (boundary `\b`).
- [x] REQ-3: GIVEN um modelo cuja família NÃO tem pricing (ex.: `claude-newfamily-6`), WHEN o writer ingere turnos desse modelo, THEN um `logger.warn` é emitido com o modelo, o **primeiro** `sessionId` e o **primeiro** `turnId` vistos — exatamente uma vez por modelo normalizado por processo, com modelos distintos warnando independentemente — e o turno é gravado com custo 0 (comportamento atual preservado; a novidade é a observabilidade).
- [x] REQ-4: GIVEN um DB com turnos históricos gravados a custo 0 por família desconhecida, WHEN `recomputeCosts({scope: all})` roda após o fix da tabela, THEN `turns.cost_usd` e `sessions.total_cost_usd` passam a refletir o pricing correto (idempotente em re-runs); turnos de família AINDA desconhecida permanecem em 0 sem crash.
- [x] REQ-5: GIVEN sessões com `total_cache_creation_tokens > 0`, WHEN o KPI de cache hit da home é calculado (`getOverviewKpis`), THEN a fórmula por linha é `cache_read / (input + cache_read + cache_creation)` — idêntica à view `session_effectiveness` — e retorna 0 (não erro) quando o denominador é 0.
- [x] REQ-6: GIVEN um id de sessão inexistente, WHEN `GET /sessions/<id>` é requisitado, THEN a resposta tem status HTTP **404**; sessões existentes retornam 200 com skeleton preservado; e uma sessão nova ainda não ingerida NÃO produz falso-404 (ingest coalescido roda antes do lookup do metadata).
- [x] REQ-7: GIVEN o fix aplicado, THEN `PRICING_LAST_UPDATED` é `'2026-07-11'` e o staleness check (`getPricingAgeDays`) segue funcionando.
- [x] REQ-8: GIVEN turnos históricos com `cache_creation_5m_tokens`/`cache_creation_1h_tokens` preenchidos (split), WHEN `recomputeCosts` recomputa, THEN o custo usa os buckets split (1h a 2×, 5m a 1,25×) — não o agregado legado tratado como 100% 5m.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `getPricing('claude-fable-5')` | pricing Claude 5 exato ($10/$50/$1.00/$12.50/$20.00) |
| TC-U-02 | REQ-1 | happy | `getPricing('claude-mythos-5')` | mesmo objeto de pricing Claude 5 |
| TC-U-03 | REQ-1 | edge | `getPricing('claude-fable-5-20260601')`, `getPricing('claude-fable-5[1m]')`, `getPricing('Claude-Fable-5')` | normalização (sufixos + case) → pricing Claude 5 |
| TC-U-04 | REQ-2 | business | `getPricing('claude-fable-6')` e `getPricing('claude-mythos-7-2')` (versões futuras não tabeladas) | fallback de família → pricing Claude 5 |
| TC-U-05 | REQ-2 | edge | near-miss NÃO casa: `getPricing('claude-fabled-5')`, `getPricing('claude-mythosx-6')` | `null` (boundary `\b` rejeita) |
| TC-U-06 | REQ-2 | business | famílias existentes não regridem: `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5` | OPUS / SONNET / HAIKU respectivamente |
| TC-U-07 | REQ-3 | edge | `getPricing('claude-newfamily-6')` e `getPricing('')` | `null` (sem crash) |
| TC-U-08 | REQ-1 | happy | `computeCost` com modelo fable e tokens conhecidos (input 1M, output 1M, cacheRead 1M, cache5m 1M) | `10 + 50 + 1 + 12.5 = 73.5` |
| TC-U-09 | REQ-3 | business | `warnIfUnknownModel('claude-x-1', ctx)` duas vezes + variante com sufixo de data do mesmo modelo | 1 único warn (dedup por modelo normalizado); stub hand-written de `log.warn`; `beforeEach(__resetUnknownModelWarnings)` |
| TC-U-10 | REQ-3 | business | dois modelos desconhecidos DISTINTOS (`claude-x-1`, depois `claude-y-2`) | 2 warns — um por modelo, dedup não suprime modelo não relacionado |
| TC-U-11 | REQ-3 | business | `warnIfUnknownModel` com modelo CONHECIDO | nenhum warn |
| TC-U-12 | REQ-3 | infra | `__resetUnknownModelWarnings()` entre chamadas | warn volta a ser emitido (seam de teste funciona) |
| TC-U-13 | REQ-7 | happy | `PRICING_LAST_UPDATED === '2026-07-11'`; `getPricingAgeDays` com `vi.setSystemTime()` fixado | delta de dias exato; sem dependência do relógio real |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-3 | business | `writeSession` com 2 turnos do mesmo modelo desconhecido em 2 sessões (SQLite real) | turnos gravados com `cost_usd = 0`, ingestão não falha, warn chamado **exatamente 1×** com payload `{model, sessionId: <primeira sessão>, turnId: <primeiro turno>}` (prova semântica "first-seen"); `beforeEach(__resetUnknownModelWarnings)` |
| TC-I-02 | REQ-4 | happy | DB com turnos fable a custo 0 (simulando ingestão pré-fix) → `recomputeCosts({kind:'all'})` | `turns.cost_usd > 0` corretos + `sessions.total_cost_usd` reconciliado |
| TC-I-03 | REQ-4 | idempotency | `recomputeCosts` rodado 2× seguidas | segunda rodada relata 0 mudanças; valores idênticos |
| TC-I-04 | REQ-4 | edge | `recomputeCosts` NÃO toca `total_cost_usd_otel` | coluna OTEL inalterada |
| TC-I-05 | REQ-4 | edge | DB com turnos de família AINDA desconhecida (`claude-newfamily-6`) → `recomputeCosts` | `cost_usd` permanece 0, sem throw |
| TC-I-06 | REQ-8 | business | turno com `cache_creation_1h_tokens > 0` (split) → `recomputeCosts` | custo usa bucket 1h a 2× (difere do cálculo legado-100%-5m) |
| TC-I-07 | REQ-5 | happy | `getOverviewKpis` com sessões com cache_creation > 0 | ratio por linha = read/(input+read+creation), igual ao valor da view `session_effectiveness` para a mesma sessão |
| TC-I-08 | REQ-5 | edge | sessões com input=read=creation=0; e caso parcial creation=0/input>0 | ratio 0 sem divisão por zero; caso parcial bate com a fórmula da view |
| TC-I-09 | REQ-6 | validation | `generateMetadata({params: {id: inexistente}})` contra DB seedado | `notFound()` disparado (throw de NEXT_NOT_FOUND) |
| TC-I-10 | REQ-6 | happy | `generateMetadata({params: {id: existente}})` | não lança; retorna `title` com o projeto da sessão |
| TC-I-11 | REQ-6 | infra | `getSession` lança (handle de DB fechado/stub) dentro de `generateMetadata` | erro propaga (boundary `error.tsx`/500) — não retorna 200 silencioso nem engole a exceção |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-6 | validation | `GET /sessions/nonexistent-id` via request do Playwright (novo `tests/e2e/session-404.spec.ts`) | status HTTP **404** |
| TC-E2E-02 | REQ-6 | happy | `GET /sessions/<seed-id>` existente — verificado pelo `tests/e2e/smoke.spec.ts` EXISTENTE (sem novo `it`) | status 200, transcript renderiza |
| TC-E2E-03 | REQ-5 | business | Com seed data, KPI "Cache hit" da home consistente com `/effectiveness`. **Nota de agregação:** a home usa SUM-ratio global; `/effectiveness` pode usar AVG por sessão — o TC compara com a MESMA estratégia de agregação recomputada do DB de seed, não igualdade cega entre os dois números renderizados | fórmula por linha idêntica confirmada fim-a-fim |

## Design

### Architecture Decisions

- **`lib/analytics/pricing.ts`** — adicionar `const CLAUDE5: ModelPricing = { input: 10, output: 50, cacheRead: 1.0, cacheCreation5m: 12.5, cacheCreation1h: 20 }`; entradas diretas `'claude-fable-5'` e `'claude-mythos-5'` em `PRICING`; estender `FAMILY_PATTERN` para `/^claude-(opus|sonnet|haiku|fable|mythos)\b/` e `FAMILY_PRICING` com `fable: CLAUDE5, mythos: CLAUDE5`. Atualizar `PRICING_LAST_UPDATED`. Comentário na tabela citando fonte e data do audit (padrão do arquivo).
- **Warning dedupado** — em `pricing.ts`, exportar `warnIfUnknownModel(model: string, ctx: { sessionId: string; turnId: string }): void` com `Set<string>` module-level keyed por `normalizeModel(model)` (cardinalidade implícita pequena — punhado de famílias; comentar isso), usando `lib/logger.ts` (`log.warn`). Exportar `__resetUnknownModelWarnings()` para testes. Testes stubam `log.warn` por mutação de propriedade (hand-written stub).
- **`lib/ingest/writer.ts`** — no map de turnos (`writeSession`), quando `getPricing(t.model) === null`, chamar `warnIfUnknownModel(t.model, { sessionId: parsed.id, turnId: t.id })` antes de `computeCost`. Custo 0 preservado (0 explícito e alarmado > falhar a ingestão). Dupla chamada de `getPricing` aceita (O(1), não é hot-path).
- **`scripts/recompute-costs.ts`** — `recomputeTurnsDefault` passa a selecionar `cache_creation_5m_tokens` e `cache_creation_1h_tokens` e repassá-los ao `computeCost` (prioridade split > legado, mesma regra REQ-12 do `computeCost`). REQ-8.
- **`lib/queries/overview.ts`** — `cacheRatioSince` passa a `SUM(total_input_tokens + total_cache_read_tokens + total_cache_creation_tokens)` no denominador (espelha a view; comentário aponta `schema.sql` como fonte da fórmula).
- **[ATUALIZADO NA EXECUÇÃO — ver Execution Log 17:20]** O mecanismo autoritativo do 404 real é **`proxy.ts`** (raiz; middleware renomeado no Next 16): matcher `/sessions/:id`, existence check via prepared statement, `ensureFreshIngest()` coalescido + re-check antes do 404 (sem falso-404), `NextResponse.rewrite(url, {status:404})`. Motivo: generateMetadata/notFound não altera status com boundaries `app/loading.tsx`/`app/sessions/loading.tsx` streamando o shell (confirmado em dev e produção). Testes em `tests/integration/proxy.test.ts` (4 branches). O generateMetadata abaixo permanece para title + defesa em profundidade.
- **`app/sessions/[id]/page.tsx`** — `const getCachedSession = cache((id: string) => getSession(getDb(), id))` (React `cache()`); `export async function generateMetadata({ params })`: `await ensureFreshIngest()` (coalescido — `lib/ingest/auto.ts` já dedupa via promise in-flight) → `getCachedSession(id)` → `notFound()` se ausente, senão `{ title }`. Body passa a usar `getCachedSession` também (uma query por request). `dynamic = 'force-dynamic'` e `runtime = 'nodejs'` já existem no módulo e se aplicam ao metadata — nenhuma config nova de segmento.
- **Operação pós-deploy (documentar no Execution Log ao concluir):** rodar `pnpm recompute-cost --all` no DB real para corrigir os 7.497 turnos históricos. Comando manual documentado — não é tarefa automatizada (toca o DB do usuário).

### Files to Create

- `app/sessions/[id]/page.test.ts` — TC-I-09..11 (integração do `generateMetadata` com SQLite real)
- `tests/e2e/session-404.spec.ts` — TC-E2E-01, TC-E2E-03

### Files to Modify

- `lib/analytics/pricing.ts` — tabela Claude 5 + fallback + `warnIfUnknownModel` + `PRICING_LAST_UPDATED`
- `lib/analytics/pricing.test.ts` — TC-U-01..13
- `lib/ingest/writer.ts` — chamada de `warnIfUnknownModel`
- `lib/ingest/writer.test.ts` — TC-I-01
- `scripts/recompute-costs.ts` — split cache tokens no recompute (REQ-8)
- `scripts/recompute-costs.test.ts` — TC-I-02..06
- `lib/queries/overview.ts` — fórmula do `cacheRatioSince`
- `lib/queries/overview.test.ts` — TC-I-07..08
- `app/sessions/[id]/page.tsx` — `generateMetadata` + `getCachedSession`

### Dependencies

Nenhuma dependência externa nova.

## Tasks

- [x] TASK-1: Pricing Claude 5 + fallback de família + `warnIfUnknownModel` + `PRICING_LAST_UPDATED` em `lib/analytics/pricing.ts` (TDD: RED primeiro)
  - files: lib/analytics/pricing.ts, lib/analytics/pricing.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13
- [x] TASK-2: Wire do warning no writer (`writeSession` chama `warnIfUnknownModel` quando pricing null)
  - files: lib/ingest/writer.ts, lib/ingest/writer.test.ts
  - depends: TASK-1
  - tests: TC-I-01
- [x] TASK-3: Recompute — split cache tokens (REQ-8) + cobertura família-nova/idempotência/OTEL/família-ainda-desconhecida
  - files: scripts/recompute-costs.ts, scripts/recompute-costs.test.ts
  - depends: TASK-1
  - tests: TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06
- [x] TASK-4: Unificar fórmula de cache hit em `overview.ts` (denominador com cache_creation)
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts
  - tests: TC-I-07, TC-I-08
- [x] TASK-5: `generateMetadata` com `ensureFreshIngest` + `getCachedSession` + `notFound()` em `/sessions/[id]` (404 real pré-streaming, sem falso-404 de sessão não ingerida)
  - files: app/sessions/[id]/page.tsx, app/sessions/[id]/page.test.ts
  - tests: TC-I-09, TC-I-10, TC-I-11
- [x] TASK-SMOKE: Executar E2E
  - Run `pnpm test:e2e`
  - If app not running / Chromium indisponível: log `E2E: DEFERRED` (nota: em 2026-07-11 a CDN do Chromium estava bloqueada nesta rede)
  - files: tests/e2e/session-404.spec.ts
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03
  - depends: TASK-2, TASK-3, TASK-4, TASK-5

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-4, TASK-5]   — independentes (arquivos disjuntos)
Batch 2: [TASK-2, TASK-3]           — dependem de TASK-1; arquivos disjuntos entre si
Batch 3: [TASK-SMOKE]               — e2e ao final, main working tree
```

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test -- --run` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (ou `E2E: DEFERRED` com motivo de rede registrado)
- [ ] **Live validation (dados reais):** com DB scratch (`DASHBOARD_DB_PATH`), `pnpm ingest` → turnos `claude-fable-5` com `cost_usd > 0`; `pnpm recompute-cost --all --dry-run` num snapshot do DB real relata upgrades dos turnos zero-cost; home e `/effectiveness` exibem cache hit consistente; `curl -w '%{http_code}' /sessions/nonexistent` → 404; `curl` numa sessão recém-ingerida → 200
- [ ] Documentar no Execution Log o passo operacional pós-merge: `pnpm recompute-cost --all` no DB real do usuário

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch [TASK-1, TASK-4, TASK-5] (2026-07-11 16:35)
Parallel via worktrees. Nota de ambiente: antes do batch, Node 26.1.0 ativado via asdf, better-sqlite3 recompilado e `pnpm 10.20.0` adicionado ao `.tool-versions` (o hook WorktreeCreate falhava sem versão de pnpm resolvível).
- TASK-1: pricing CLAUDE5 + fallback fable/mythos + warnIfUnknownModel + PRICING_LAST_UPDATED=2026-07-11 — TDD: RED(14) → GREEN(54)
- TASK-4: cacheRatioSince com denominador + cache_creation (paridade com view session_effectiveness) — TDD: RED(2) → GREEN(21)
- TASK-5: generateMetadata com ensureFreshIngest + React.cache(getSession) + notFound() pré-streaming; title "<project> — TokenFx" — TDD: RED(3) → GREEN(3)
Validação pós-merge: lint ✓ typecheck ✓ test 1219 passed / 6 skipped.

### Batch [TASK-2, TASK-3] (2026-07-11 16:45)
Executado INLINE e sequencial no main tree (desvio documentado: worktrees partem do último commit e não teriam o código não-commitado do TASK-1; arquivos disjuntos, tasks pequenas).
- TASK-2: writer chama warnIfUnknownModel (payload estruturado {model, sessionId, turnId} — warn ajustado para meta object) — TDD: RED(2) → GREEN(77)
- TASK-3: recompute usa buckets split 5m/1h (1h a 2×) com fallback legado; TCs fable-reprice/família-desconhecida/split — TDD: RED(1) → GREEN(25). Desvio: testes em tests/integration/recompute-costs.test.ts (convenção real do repo; a spec citava scripts/recompute-costs.test.ts, que não existe).
Validação pós-batch: lint ✓ typecheck ✓ test 1223 passed / 6 skipped (1 flake intermitente observado numa rodada, não reproduzido em 2 rodadas subsequentes).

### TASK-SMOKE + REQ-6 root-cause pivot (2026-07-11 17:20)
E2E Playwright: DEFERRED — CDN do Chromium inacessível nesta rede (3 tentativas, download trava). TC-E2E-01/02/03 validados AO VIVO via curl contra `pnpm build && pnpm start` (evidência abaixo).
**Pivot arquitetural no REQ-6 (descoberto na live validation):** generateMetadata + notFound NÃO produz status 404 — Next 15.2+ faz streaming de metadata, e os boundaries `app/loading.tsx` e `app/sessions/loading.tsx` fazem o shell sair com 200 antes de qualquer decisão (confirmado em dev E produção, inclusive com `htmlLimitedBots: /.*/` e removendo o loading.tsx do segmento — ambos revertidos). Única camada que decide status antes do primeiro byte: **proxy** (novo nome do middleware no Next 16). Criado `proxy.ts` (matcher `/sessions/:id+`, runtime Node): getSession direto no SQLite → se ausente, `ensureFreshIngest()` coalescido + re-check (sem falso-404 de sessão não ingerida) → `NextResponse.rewrite(url, {status: 404})`. `generateMetadata` mantido (title + lookup cacheado). `loading.tsx` do segmento preservado (skeleton intacto).
Live validation (produção, `pnpm start` + DB com 40 sessões reais ingeridas):
- `GET /sessions/nonexistent-id` → **404** com corpo amigável renderizado
- `GET /sessions/<real-id>` → **200**, title "<project> — TokenFx"
- ingest real: 7.843 turnos claude-fable-5 = **$6.376,40** (antes do fix: $0)
- snapshot do data/dashboard.db real: 3 sessões / 0 turnos (quase vazio) → recompute pós-merge desnecessário; próximo auto-ingest popula tudo já precificado
Validação final: lint ✓ typecheck ✓ build ✓ test 1223 passed / 6 skipped.

### Self-review da implementação (2026-07-11 18:50)
3 revisores em paralelo (code, test, security). Fixes triviais aplicados:
- pricing.ts: cast estale `as 'opus'|'sonnet'|'haiku'` → `as ModelFamily` (mascarava famílias novas)
- proxy.ts: guard de `decodeURIComponent` (URL malformada `/sessions/%ZZ` dava 500; agora 404), matcher estreitado para `/sessions/:id` (segmento único), comentários sobre double-check deliberado e lazy imports
- NOVO tests/integration/proxy.test.ts: 4 branches do proxy — existente→next, inexistente→404, %-malformado→404, e **sessão no disco não ingerida→ingest coalescido→next (sem falso-404)** com ingest real de fixture
- Comentários de convenção em pricing.test.ts (explicit-now) e writer.test.ts (stub inline)
Escalados (não auto-fixados): nenhum CRITICAL/HIGH de segurança; TC-E2E-03 é assertion fraca por design (documentado no próprio teste; fórmula coberta por TC-I-07/08).
Validação pós-fixes: lint ✓ typecheck ✓ build ✓ test **1227 passed / 6 skipped (75 files)**.
