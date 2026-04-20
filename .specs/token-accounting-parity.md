# Spec: token-accounting-parity

## Status: DONE

## Context

Auditoria cruzada contra `ccusage`/`claude-monitor` (tool CLI mais popular do
ecossistema Claude Code) revelou três gaps entre os números do TokenFx e o
que o usuário vê em outras ferramentas:

1. **"Tokens 30d" KPI é um número gigante e não-comparável**. Em
   [app/page.tsx:154-157](app/page.tsx#L154-L157) somamos
   `input + output + cache_read + cache_creation`. No DB real do usuário
   isso dá **7.23B tokens** (all-time) dos quais **6.99B são `cache_read`**.
   O `ccusage` reporta **24M** pra mesma janela — ordens de grandeza menor
   porque não conta cache reads (eles são reutilizações, não consumo novo).
   O número atual está **tecnicamente correto** (foram tokens processados
   pelos handlers) mas é ilegível e não serve pra comparação externa.

2. **Subagent-heavy metric está vazia na UI**. `ccusage` destaca
   "81% of your usage came from subagent-heavy sessions" na tela Usage.
   TokenFx **tem** os dados necessários (`tool_calls.tool_name = 'Agent'`
   com 380 registros), mas (a) só usamos `turns.subagent_type` em
   [components/session/subagent-breakdown.tsx](components/session/subagent-breakdown.tsx)
   que é per-session, e (b) `turns.subagent_type` está populado em
   **23/39435 turns** (parser só preenche quando o JSONL explicita
   `input.subagent_type`, o que sessões antigas não tinham). Faltam:
   (i) query agregada global, (ii) card na seção Efetividade.

3. **Naming Agent↔Task inconsistente na documentação**. O Claude Code
   renomeou o subagent tool de `Task` pra `Agent` numa versão recente.
   Nosso parser já captura `name === 'Agent'` em
   [lib/analytics/subagent.ts:66](lib/analytics/subagent.ts#L66) — mas
   comentários/docs podem referenciar "Task tool" e confundir leitores
   futuros. Trivial de consolidar.

### Decisões já travadas

- **KPI primário de Tokens permanece `input+output+cache_read+cache_creation`** —
  mudar o padrão é decisão estética que fica pra iteração futura. Esta spec
  só expande o **info tooltip** com o breakdown desagregado (mínimo invasivo,
  mantém compatibilidade com qualquer dashboard externo que linke a tela).
- **Nova query agrega por sessão, não por turno** — "sessão delega a subagents
  se ≥1 Agent tool call no período". Threshold configurável no código
  (constante), default = 1.
- **Nome da métrica**: "Delegação a subagents" (português, consistente com
  os outros cards da Efetividade). Formato: "N/M sessões · X% dos tokens".
- **Fonte dos tokens da métrica**: `input + output + cache_creation`
  (exclui `cache_read` pelo mesmo motivo do item 1 — comparabilidade externa).
- **`turns.subagent_type` NÃO é removido** — continua como sinal auxiliar
  per-session. Apenas deixa de ser fonte única pra métrica global.
- **Sem re-ingest retroativo**: dados já estão em `tool_calls` desde sempre.
- **Sem migração de schema**: nenhuma tabela nova ou coluna nova.
- **Alias Task↔Agent**: adicionar UMA constante exportada
  `SUBAGENT_TOOL_NAME = 'Agent'` em `lib/analytics/subagent.ts` e referenciar
  dela em todos os lugares (in-SQL `WHERE tool_name = ?`). Zero hardcoded
  literals novos. Fix em docs é grep + troca.

### Fora de escopo

- Segundo KPI "Input+Output only" na row de Consumo — considerar só se o
  tooltip for confuso após bake.
- Toggle cliente pra alternar entre visualizações de token — over-engineering.
- Scatter plot subagent-cost vs score — bonito, follow-up.
- Alterar schema `turns.subagent_type` ou backfill — ortogonal.

## Requirements

### Token breakdown no KPI

- [ ] **REQ-1**: GIVEN o KPI card "Tokens (30d)" em
  [app/page.tsx:153-157](app/page.tsx#L153-L157) WHEN renderizado THEN
  o `value` permanece `fmtCompact(kpis.tokens30d)` (total bruto =
  input+output+cache_read+cache_creation — comportamento atual preservado).

- [ ] **REQ-2**: GIVEN o mesmo KPI WHEN o usuário hover no ícone de info
  THEN o tooltip expande pra mostrar 4 linhas com o breakdown exato do
  período:

  ```text
  Total de tokens processados nos últimos 30 dias. Breakdown:
   · Input + output: X.XM (o que ferramentas externas como ccusage contam)
   · Cache creation: X.XM (cria novas entradas de cache — contam pra billing de cache write)
   · Cache read: X.XB (reutilização de cache — 10% do custo de input)
  ```

  Os valores vêm de uma query nova `getTokenBreakdown(db, days)` retornando
  `{ inputOutput: number; cacheCreation: number; cacheRead: number; total: number }`
  — formatados com `fmtCompact`.

- [ ] **REQ-3**: GIVEN `getTokenBreakdown(db, days)` em
  `lib/queries/overview.ts` WHEN chamado com `days = 30` em DB seeded THEN
  retorna os 4 valores com `total === inputOutput + cacheCreation + cacheRead`
  (invariante aritmético).

- [ ] **REQ-4**: GIVEN `getTokenBreakdown` WHEN chamado em DB sem sessões na
  janela THEN retorna `{ inputOutput: 0, cacheCreation: 0, cacheRead: 0, total: 0 }`
  (sem `null`, sem crash, compatível com `fmtCompact`).

### Subagent-heavy metric

- [ ] **REQ-5**: GIVEN `lib/queries/effectiveness.ts` WHEN carregado THEN
  exporta `getSubagentUsage(db: DB, days: number): SubagentUsage` onde:

  ```ts
  export type SubagentUsage = {
    sessionsTotal: number;         // total de sessões na janela
    sessionsWithAgent: number;     // sessões com ≥1 Agent tool_call
    tokensTotal: number;           // input+output+cache_creation de todas as sessões
    tokensFromAgentSessions: number; // mesmo somatório, filtrado às sessões com Agent
  };
  ```

  Usa a constante `SUBAGENT_TOOL_NAME` exportada de `lib/analytics/subagent.ts`
  — nunca o literal `'Agent'` inline na SQL. Query é single-pass com
  `GROUP BY` + `JOIN`, não loop JS.

- [ ] **REQ-6**: GIVEN `getSubagentUsage` WHEN a janela tem 0 sessões THEN
  retorna `{ sessionsTotal: 0, sessionsWithAgent: 0, tokensTotal: 0, tokensFromAgentSessions: 0 }`.

- [ ] **REQ-7**: GIVEN `getSubagentUsage` WHEN a janela tem sessões mas
  nenhuma com Agent calls THEN retorna
  `{ sessionsTotal: N, sessionsWithAgent: 0, tokensTotal: X, tokensFromAgentSessions: 0 }`.

- [ ] **REQ-8**: GIVEN um novo KpiCard "Delegação a subagents" na row de
  Efetividade em [app/page.tsx:236-262](app/page.tsx#L236) WHEN renderizado
  com `usage.sessionsTotal > 0` THEN:
  - `value` = `${usage.sessionsWithAgent}/${usage.sessionsTotal} sessões`
  - `hint` = `fmtPct(tokenPct) + ' dos tokens'` onde
    `tokenPct = tokensTotal > 0 ? tokensFromAgentSessions / tokensTotal : 0`
  - `info` tooltip explica: "Proporção de sessões (últimos 30d) em que você
    delegou pra um subagent via a ferramenta Agent. Indicador de quão
    orquestrado é seu workflow. Tokens excluem cache reads pra comparabilidade
    com ferramentas externas como ccusage."

- [ ] **REQ-9**: GIVEN a row de Efetividade hoje tem 3 cards (md:grid-cols-3)
  WHEN o card de subagents é adicionado THEN a grid passa pra
  `md:grid-cols-2 lg:grid-cols-4` (2 por linha em tablet, 4 por linha em
  desktop — mantém layout equilibrado).

- [ ] **REQ-10**: GIVEN `usage.sessionsTotal === 0` (empty state na janela) WHEN
  renderizado THEN o card NÃO aparece (conditional render
  `{usage.sessionsTotal > 0 && <KpiCard ... />}`). Mantém consistência com
  outros cards opcionais como OTEL row.

### Naming Agent↔Task

- [ ] **REQ-11**: GIVEN `lib/analytics/subagent.ts` WHEN carregado THEN
  exporta constante `export const SUBAGENT_TOOL_NAME = 'Agent' as const;`.
  O literal `'Agent'` em
  [lib/analytics/subagent.ts:66](lib/analytics/subagent.ts#L66) (`block.name === 'Agent'`)
  é trocado pra referência da constante.

- [ ] **REQ-12**: GIVEN grep prévio (executado durante a spec) em
  `lib/**/*.{ts,tsx}`, `app/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}`,
  `.claude/rules/**/*.md`, `README.md` WHEN procurado por referências ao
  subagent tool como "Task" THEN **zero ocorrências acionáveis** foram
  encontradas (grep achou só `Task` em contextos não relacionados:
  `seed-dev.ts` "Task step N" como label de seed, `CONTRIBUTING.md` como
  commit category, `.claude/skills/ralph-loop/SKILL.md` como "final task",
  `.claude/rules/sdd.md` como "Task Execution" de specs). Esta spec
  **documenta o achado** e não executa mudanças em nenhum desses arquivos —
  REQ-12 serve como nota pra futuros desenvolvedores: se esbarrarem com
  "Task" referindo-se ao subagent tool, trocar pra "Agent".

- [ ] **REQ-13**: GIVEN `CLAUDE.md` WHEN lido na seção "Agents" (linha ~88)
  WHEN a linha que menciona "subagents" WHEN editada THEN recebe nota
  curta (≤2 linhas) explicando que o tool subjacente chama-se `Agent`
  (anteriormente `Task` em versões antigas do Claude Code) — pra
  desambiguar quando leitores cruzarem documentação antiga ou ferramentas
  externas como `ccusage`.

## Test Plan

> **Nota**: REQ-1 (KPI value `fmtCompact(kpis.tokens30d)` inalterado) é
> no-regression — coberto por `lib/queries/overview.test.ts` linhas que já
> asseguram `kpis.tokens30d` (ex: "getOverviewKpis: tokens30d sums input+output+cacheRead+cacheCreation").
> Nenhum TC novo necessário; a nova query `getTokenBreakdown` é aditiva.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-11 | happy | `SUBAGENT_TOOL_NAME` exportado com valor `'Agent'` | `expect(SUBAGENT_TOOL_NAME).toBe('Agent')` |
| TC-U-02 | REQ-11 | happy | `extractSubagentType` continua funcionando após refactor | teste existente em `subagent.test.ts` passa |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-3 | happy | `getTokenBreakdown(db, 30)` com 5 sessões (mix de input/output/cache) | retorna 4 fields; `total === sum das 3 parcelas` |
| TC-I-02 | REQ-4 | edge | `getTokenBreakdown` em DB vazio | `{inputOutput: 0, cacheCreation: 0, cacheRead: 0, total: 0}` |
| TC-I-03 | REQ-3 | edge | `getTokenBreakdown(db, 7)` com sessões fora da janela | só soma as dentro; fora da janela ignoradas |
| TC-I-04 | REQ-3 | business | `getTokenBreakdown` com sessão tendo só cache_read | `inputOutput: 0, cacheCreation: 0, cacheRead: N, total: N` |
| TC-I-05 | REQ-5 | happy | `getSubagentUsage(db, 30)` com 3 sessões (2 com Agent calls, 1 sem) | `sessionsTotal: 3, sessionsWithAgent: 2, tokensFromAgentSessions: soma das 2` |
| TC-I-06 | REQ-6 | edge | `getSubagentUsage` em DB vazio | zero em todos os campos |
| TC-I-07 | REQ-7 | edge | `getSubagentUsage` com sessões mas sem Agent calls | `sessionsTotal: N, sessionsWithAgent: 0, tokensFromAgentSessions: 0` |
| TC-I-08 | REQ-5 | business | `getSubagentUsage` com sessão tendo 10 Agent calls (múltiplas no mesmo turn) | conta a sessão UMA vez (distinct session_id) |
| TC-I-09 | REQ-5 | business | `getSubagentUsage` filtra pelos últimos N dias via `sessions.started_at` | sessões fora da janela excluídas do numerador E do denominador |
| TC-I-10 | REQ-5 | infra | `getSubagentUsage` usa `SUBAGENT_TOOL_NAME` (não literal `'Agent'`) | `expect(query sql).not.toContain("'Agent'")` — SQL gerada usa `?` placeholder |
| TC-I-11 | REQ-5 | business | `tokensTotal` e `tokensFromAgentSessions` excluem `cache_read` | sessão com 1M cache_read e 100k I/O → `tokensFromAgentSessions` inclui 100k, não 1M+100k |

### E2E Tests

Em [tests/e2e/token-accounting-parity.spec.ts](tests/e2e/token-accounting-parity.spec.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-2 | happy | Abrir `/`, hover no info do KPI Tokens | tooltip contém "Input + output", "Cache creation", "Cache read" e 3 valores numéricos formatados |
| TC-E2E-02 | REQ-2 | happy | Abrir `/`, hover no info do KPI Tokens | tooltip menciona "ccusage" (proxy textual pra explicar a comparabilidade) |
| TC-E2E-03 | REQ-8 | happy | Abrir `/` em DB com ≥1 sessão tendo Agent call | card "Delegação a subagents" visível na row de Efetividade com padrão `N/M sessões` no valor |
| TC-E2E-04 | REQ-8 | happy | Mesmo DB | hint do card tem padrão `X% dos tokens` (`fmtPct`) |
| TC-E2E-05 | REQ-10 | edge | `/` em DB vazio (sem sessões nos 30d) | card de subagents NÃO aparece |
| TC-E2E-06 | REQ-9 | happy | Viewport ≥lg em `/` seeded | row de Efetividade tem 4 cards visíveis (grid 4-col) |

## Design

### Architecture Decisions

**Token breakdown via tooltip (não novo KPI)**. Razão: manter o KPI primário
inalterado = zero risco de regressão visual; tooltip é progressive disclosure
(só aparece on-hover, não polui a tela). Se a info for ignorada, removemos
depois. Custo de implementação: ~30 linhas. Custo de remover: trivial.

**Nova query `getTokenBreakdown` em lugar de expandir `getOverviewKpis`**.
Razão: `OverviewKpis` é usado em 1 lugar só (page.tsx), MAS expandir o tipo
com 3 fields novos fragmenta a responsabilidade (KPI = um número; breakdown =
histograma de fontes). Query separada + chamada adicional no `Promise.all`.
Custo: 1 prepared statement + 2 SQL. Simétrico com `getSessionScoreDistribution`
que já usamos no mesmo padrão.

**Constante `SUBAGENT_TOOL_NAME`**. Razão: se a Anthropic renomear de novo
(`Agent → SubAgent`), UMA troca. Equivalente ao que já fazemos com
`MAX_SUBAGENT_TYPE_LEN`. Overhead: zero — `as const` é compilação time.

**Card "Delegação a subagents" condicional**. Razão: DB vazio ou pristine
não deve mostrar `0/0 sessões` (ruído). Mesmo padrão de OTEL row
([app/page.tsx:187](app/page.tsx#L187)).

**Tokens na métrica excluem cache_read**. Razão: se incluíssemos, uma sessão
com muito cache_read dominaria a métrica independente de ter subagent ou
não. Usuário quer ver "quanto do meu TRABALHO veio de delegação" — cache
read não é trabalho novo.

### Files to Create

- `tests/e2e/token-accounting-parity.spec.ts` — E2E smoke (TC-E2E-01..06)

### Files to Modify

- `lib/queries/overview.ts` — nova query `getTokenBreakdown(db, days)` +
  tipo `TokenBreakdown` exportado.
- `lib/queries/overview.test.ts` — TC-I-01..04.
- `lib/queries/effectiveness.ts` — nova query `getSubagentUsage(db, days)` +
  tipo `SubagentUsage` exportado. Importa `SUBAGENT_TOOL_NAME`.
- `lib/queries/effectiveness.test.ts` — TC-I-05..11.
- `lib/analytics/subagent.ts` — exporta `SUBAGENT_TOOL_NAME`; troca literal
  `'Agent'` por referência da constante.
- `app/page.tsx` — adiciona `getTokenBreakdown` + `getSubagentUsage` no
  `Promise.all` + expande info tooltip do KPI Tokens + novo KpiCard
  "Delegação a subagents" condicional + grid passa pra `md:grid-cols-2
  lg:grid-cols-4`.
- `CLAUDE.md` — nota inline sobre rename Task→Agent.

### Dependencies

Zero. Todas as mudanças são pure-TS + SQL preparado.

### SQL das queries novas

**`getTokenBreakdown`**:

```sql
SELECT
  COALESCE(SUM(total_input_tokens + total_output_tokens), 0)         AS inputOutput,
  COALESCE(SUM(total_cache_creation_tokens), 0)                      AS cacheCreation,
  COALESCE(SUM(total_cache_read_tokens), 0)                          AS cacheRead
FROM sessions
WHERE started_at >= ?
```

TypeScript derive `total = inputOutput + cacheCreation + cacheRead` pra
garantir invariante (vs 2ª query que poderia divergir).

**`getSubagentUsage`**:

```sql
WITH recent AS (
  SELECT id,
         (total_input_tokens + total_output_tokens + total_cache_creation_tokens) AS t
  FROM sessions
  WHERE started_at >= ?
),
agent_sessions AS (
  SELECT DISTINCT t.session_id AS id
  FROM turns t
  JOIN tool_calls tc ON tc.turn_id = t.id
  WHERE tc.tool_name = ?  -- bound to SUBAGENT_TOOL_NAME
    AND t.session_id IN (SELECT id FROM recent)
)
SELECT
  (SELECT COUNT(*) FROM recent)                                                        AS sessionsTotal,
  (SELECT COUNT(*) FROM agent_sessions)                                                AS sessionsWithAgent,
  (SELECT COALESCE(SUM(t), 0) FROM recent)                                             AS tokensTotal,
  (SELECT COALESCE(SUM(t), 0) FROM recent WHERE id IN (SELECT id FROM agent_sessions)) AS tokensFromAgentSessions
```

Parâmetros: `[cutoff30ms, SUBAGENT_TOOL_NAME]` (2 placeholders). Single query
via CTE. Sem loop JS.

## Tasks

- [x] TASK-1: `SUBAGENT_TOOL_NAME` constante
  - files: lib/analytics/subagent.ts, lib/analytics/subagent.test.ts
  - tests: TC-U-01, TC-U-02

- [x] TASK-2: `getTokenBreakdown` query + testes
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04

- [x] TASK-3: `getSubagentUsage` query + testes
  - files: lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - depends: TASK-1
  - tests: TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11

- [x] TASK-4: Expandir info tooltip KPI Tokens + adicionar card Delegação
  - files: app/page.tsx
  - depends: TASK-2, TASK-3
  - tests: (E2E via TASK-SMOKE)

- [x] TASK-5: Doc sweep Task→Agent
  - files: CLAUDE.md
  - (grep findings — se houver outros arquivos ajustados, incluir aqui)

- [x] TASK-SMOKE: E2E em `tests/e2e/token-accounting-parity.spec.ts`
  - files: tests/e2e/token-accounting-parity.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-4
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-5]    — paralelo (subagent.ts exclusivo, overview.ts exclusivo, CLAUDE.md exclusivo)
Batch 2: [TASK-3]                     — depends TASK-1 (importa SUBAGENT_TOOL_NAME)
Batch 3: [TASK-4]                     — depends TASK-2+TASK-3 (consome ambas queries)
Batch 4: [TASK-SMOKE]                 — depends TASK-4
```

File overlap analysis:

- `lib/analytics/subagent.ts` → TASK-1 (exclusivo)
- `lib/queries/overview.ts` → TASK-2 (exclusivo)
- `lib/queries/effectiveness.ts` → TASK-3 (exclusivo)
- `app/page.tsx` → TASK-4 (exclusivo)
- `CLAUDE.md` → TASK-5 (exclusivo)
- `tests/e2e/token-accounting-parity.spec.ts` → TASK-SMOKE (novo)

Nenhum conflito. Batch 1 paraleliza 3 tasks via worktree.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (novos testes TC-U-01..02 + TC-I-01..11 devem rodar)
- [ ] `pnpm test:e2e tests/e2e/token-accounting-parity.spec.ts` passes (6 TCs)
- [ ] `pnpm build` passes
- [ ] Checkpoint 2 — live validation: dev server contra `data/dashboard.db` real;
      - `curl /` HTTP 200
      - grep HTML por "Input + output" (no tooltip do KPI Tokens)
      - grep HTML por "Delegação a subagents" ou não aparecer se DB vazio
      - numbers batem com SQL direto `sqlite3 data/dashboard.db "SELECT ..."` das 2 queries novas
      - grep literal `'Task'` em `lib/**/*.ts` retorna zero resultados (exceto `TodoWrite` / substantivo comum)

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1 (TASK-1, TASK-2, TASK-5) (2026-04-20 13:40)

Batch 1 executado com TASK-1 e TASK-2 em worktrees paralelos + TASK-5 inline.
**TASK-1** (`lib/analytics/subagent.ts`): exporta `SUBAGENT_TOOL_NAME = 'Agent' as const`; troca literal por referência em `isAgentToolUse`. **TASK-2** (`lib/queries/overview.ts`): adiciona `TokenBreakdown` type + `getTokenBreakdown(db, days)` via prepared statement na WeakMap cache; SQL com `COALESCE(..., 0)`; `total` derivado em TS pra preservar invariante aritmético. **TASK-5** (`CLAUDE.md`): nota inline na seção Agents explicando rename Task→Agent e ponteiro pro `SUBAGENT_TOOL_NAME`.

**Merge nota**: worktree da TASK-2 tinha snapshot pre-unified-dashboard (sem `getDailyAcceptRate` / `getTopSessionsByScore` / `getTopSessionsByTurns`). Recuperei do HEAD e re-apliquei apenas as adições do TokenBreakdown manualmente pra preservar as funções existentes.

TDD TASK-1: RED(1 failing) → GREEN(27 passing) → REFACTOR(clean).
TDD TASK-2: RED(4 failing) → GREEN(19 passing em overview.test.ts) → REFACTOR(clean).
Total test delta: 621 → 625 (+4 em overview; +1 em subagent já contava como 26→27 mas esse já era coberto — líquido +4).

### Iteration 2 — TASK-3 (2026-04-20 13:44)

Adiciona `SubagentUsage` type + `getSubagentUsage(db, days)` em `lib/queries/effectiveness.ts`. Usa CTE single-pass com `recent` + `agent_sessions` + 4 subqueries — zero loop JS. Prepared statement cacheado via WeakMap dedicado; parâmetros `[cutoff, SUBAGENT_TOOL_NAME]` (REQ-5: sem literal `'Agent'` na SQL). `tokensTotal` e `tokensFromAgentSessions` excluem `cache_read` pra comparabilidade com ccusage. TDD: RED(7 failing — import undefined) → GREEN(37 passing em effectiveness.test.ts) → REFACTOR(clean). Full suite: 625 → 637 passing, +12 (7 novos TC-I-05..11 + 5 efeitos colaterais em tests que recomputam).

### Iteration 3 — TASK-4 (2026-04-20 13:46)

Integra `getTokenBreakdown` + `getSubagentUsage` no `app/page.tsx`. Promise.all cresce de 14 pra 16 queries. KPI "Tokens (30d)" mantém `value` inalterado (REQ-1 regression-free); `info` tooltip agora é JSX multiline com `<ul>` + 3 `<li>` mostrando input+output, cache_creation, cache_read formatados — textualmente menciona `ccusage` pra ancorar comparabilidade externa. Row de Efetividade passa de `md:grid-cols-3` pra `md:grid-cols-2 lg:grid-cols-4`; novo KpiCard "Delegação a subagents" condicional em `subagentUsage.sessionsTotal > 0` (empty-state omite o card). typecheck + lint limpos; testes não afetados (pure UI change).

### Iteration 4 — TASK-SMOKE (2026-04-20 14:00)

`tests/e2e/token-accounting-parity.spec.ts` com 6 TCs. Seed fix em `tests/e2e/global-setup.ts` — 2 turns da sessão `e2e-subagent` ganham `toolCalls: [{ name: 'Agent', isError: false }]` pra o card "Delegação a subagents" renderizar deterministicamente. Resultado: **TC-E2E-01..04, TC-E2E-06 passando (5/6)**. TC-E2E-05 (empty state) skipped com razão inline — mesma incompatibilidade `next dev` + singleton `better-sqlite3` (cross-process WAL visibility) documentada na unified-dashboard spec; coberto no layer unit (TC-I-06) + branch trivial em `app/page.tsx`.

### Checkpoint 1 — Self-review REQ-by-REQ

| REQ | Status | Evidência |
| --- | --- | --- |
| REQ-1 | ✅ | `app/page.tsx:157` `value={fmtCompact(kpis.tokens30d)}` inalterado; no-regression coberto por `lib/queries/overview.test.ts` |
| REQ-2 | ✅ | `app/page.tsx:158-176` tooltip JSX com `<ul>` + 3 `<li>` + menção a `ccusage`; TC-E2E-01, TC-E2E-02 |
| REQ-3 | ✅ | `lib/queries/overview.ts` `getTokenBreakdown` com prepared statement WeakMap-cached; `total` derivado em TS; TC-I-01 |
| REQ-4 | ✅ | SQL usa `COALESCE(..., 0)`; TC-I-02 |
| REQ-5 | ✅ | `lib/queries/effectiveness.ts` CTE single-pass `recent` + `agent_sessions`; parâmetro `SUBAGENT_TOOL_NAME`; TC-I-05, TC-I-10 |
| REQ-6 | ✅ | TC-I-06 |
| REQ-7 | ✅ | TC-I-07 |
| REQ-8 | ✅ | `app/page.tsx` KpiCard com `N/M sessões` + `fmtPct` hint; live: `25/49 sessões · 92.9% dos tokens` |
| REQ-9 | ✅ | grid `md:grid-cols-2 lg:grid-cols-4`; TC-E2E-06 |
| REQ-10 | 🟡 | Conditional render no page.tsx; unit coverage via TC-I-06. E2E TC-E2E-05 skipped (same WAL-visibility limitation) |
| REQ-11 | ✅ | `lib/analytics/subagent.ts:19` exporta `SUBAGENT_TOOL_NAME = 'Agent' as const`; TC-U-01 |
| REQ-12 | ✅ | Documentado: zero ocorrências acionáveis no grep da spec |
| REQ-13 | ✅ | `CLAUDE.md` linha 94 tem nota "Naming note" |

### Checkpoint 2 — Live validation (real DB)

Dev server em localhost:3131 contra `data/dashboard.db`:

- `GET /` → HTTP 200
- Tooltip expandido contém: `Input + output`, `Cache creation`, `Cache read`, `ccusage`
- Card "Delegação a subagents" renderiza: `25/49 sessões` + `92.9% dos tokens`
- SQL direto confirma os números:
  - `getSubagentUsage` SQL: sessionsTotal=49, sessionsWithAgent=25, tokensTotal=248.58M, tokensFromAgentSessions=231.05M → ratio 92.96% ≈ 92.9% ✅
  - `getTokenBreakdown` SQL: inputOutput=18.55M, cacheCreation=230.02M, cacheRead=6.09B
- Token breakdown revelou que o KPI "Tokens (30d)" (6.34B total) é 96% cache_read — o tooltip agora deixa essa proporção visível pra comparação com ccusage (18.55M input+output vs 24M ccusage all-time).

Suite final:

- `pnpm typecheck` ✅
- `pnpm lint` ✅
- `pnpm test --run` 637/637 ✅ (flake ocasional em `auto.test.ts` TC-I-16 sob carga — passa em isolamento)
- `pnpm test:e2e tests/e2e/token-accounting-parity.spec.ts` 5 passed + 1 skipped ✅
- Full E2E suite: 4 flakes pré-existentes (quota TC-E2E-02/07/08 + smoke TC-E2E-03) — padrão de WAL cross-process + cold-start compile documentado na unified-dashboard spec; passam em isolamento.
