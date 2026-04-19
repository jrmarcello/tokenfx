# Spec: Tool Success Trends — erro-por-ferramenta ao longo do tempo

## Status: DONE

## Context

O dashboard hoje mostra contagens agregadas de tool_calls via `getToolLeaderboard` (Bash, Read, Edit…), mas só numa janela fixa. O que ele **não** responde: "A taxa de erro do Bash subiu nas últimas semanas?" ou "Depois que migrei de MCP X pra MCP Y, o Grep começou a falhar mais?". Sem dimensão temporal fica impossível detectar degradação progressiva.

Dados reais do autor (6 meses): Bash 7247 calls (7% erro), Read 6438 (3.5%), Edit 3007 (4.8%), Grep 1421 (1.5%), Write 824 (2.4%), Glob 767 (2.9%). Top 6 cobrem >90% do volume; ferramentas da cauda têm <50 calls/ total e produzem series muito voláteis quando bucketizadas. Qualquer design razoável tem que:

1. Focar nas ferramentas de maior volume (top-N; default N=5)
2. Suprimir buckets com poucos calls pra não exibir "100% de erro em 1 call"
3. Seguir o layout visual de `AcceptRateTrend` (multi-line seria um afastamento — mas o domínio exige, então herdamos grid/axes/tooltip stylings)

Entrega:
- Query `getToolErrorTrend(db, { days, topN })` retornando série temporal semanal
- Componente `<ToolSuccessTrend />` (multi-line chart) em `/effectiveness`
- Gap (null points) em buckets sub-threshold — o visual "corta" o traço mostrando dado insuficiente
- Paleta de cores determinística por nome de ferramenta (mesmo tool → mesma cor em re-renders)

## Requirements

- [ ] **REQ-1**: GIVEN há tool_calls na janela de `days` dias WHEN `getToolErrorTrend(db, { days, topN })` é chamada THEN retorna `{ tools: string[]; points: TrendPoint[] }` onde `tools` é a lista ordenada das top-N ferramentas pelo total de calls na janela (tiebreak alfabético ASC), e `points` é a série temporal com uma entrada por semana contendo `{ week, calls, errors }` por ferramenta.

- [ ] **REQ-2**: GIVEN `days` é passado e > 0 WHEN a query executa THEN só tool_calls de sessões com `sessions.started_at >= now - days*86400000` entram na agregação. O corte usa `sessions.started_at`, não `turns.timestamp`, pra consistência com `weeklyRatio` e `weeklyAcceptRate`.

- [ ] **REQ-3**: GIVEN `topN` é passado WHEN a query executa THEN `topN` é clampado a `[1, 10]` (default 5). Valores fora → clamp silencioso.

- [ ] **REQ-4**: Bucketing semanal via `strftime('%Y-%W', started_at/1000, 'unixepoch', 'localtime')` — mesmo formato que `getWeeklyRatio` e `getWeeklyAcceptRate`. Consistência é hard requirement.

- [ ] **REQ-5**: GIVEN uma semana W tem `calls < MIN_CALLS_PER_BUCKET` (constante = 5) pra uma dada ferramenta T WHEN o ponto é emitido THEN `errorRate[T][W] = null` (gap no traço). O threshold é computado PER (tool, week) — não global. `calls` e `errors` continuam populados para o tooltip apresentar "só 2 chamadas, dado insuficiente" quando aplicável.

- [ ] **REQ-6**: GIVEN uma semana W tem `calls >= 5` pra uma ferramenta T WHEN o ponto é emitido THEN `errorRate = errors / calls` (float em `[0, 1]`).

- [ ] **REQ-7**: GIVEN nenhuma tool_call na janela WHEN a query executa THEN retorna `{ tools: [], points: [] }` (sem erro; componente decide esconder).

- [ ] **REQ-8**: GIVEN a mesma janela é consultada 2x consecutivas WHEN `getToolErrorTrend` executa THEN o prepared statement é reusado via WeakMap cache (padrão do projeto; sem `db.prepare` per-call).

- [ ] **REQ-9**: `TrendPoint.week` é ordenado ASC cronologicamente. Semanas sem nenhum call pra NENHUMA das top-N ferramentas são omitidas (não emitir entry "empty week").

- [ ] **REQ-10**: GIVEN o componente `<ToolSuccessTrend />` recebe `data: { tools: string[]; points: TrendPoint[] }` com `tools.length > 0 && points.length > 0` WHEN renderiza THEN exibe um `LineChart` com uma `Line` por ferramenta, Y em `[0, 1]` renderizado como %, X = week label, grid/axes iguais aos outros trends do projeto. Legenda (Recharts `Legend`) lista as ferramentas.

- [ ] **REQ-11**: GIVEN `tools.length === 0` OR `points.length === 0` WHEN o componente renderiza THEN retorna `null`. O server component da página decide se exibe um empty-state externo.

- [ ] **REQ-12**: Cores por ferramenta são **determinísticas**: mapeadas de um hash estável (ex: `hashCode` simples do nome) → índice numa paleta fixa de 10 cores pensadas pro tema dark (ver Design). Mesma ferramenta → mesma cor em qualquer render.

- [ ] **REQ-13**: GIVEN o usuário navega pra `/effectiveness` com dados WHEN a página renderiza THEN uma seção "Tendência de erro por ferramenta" é exibida logo após "Ferramentas mais usadas" (que é `ToolLeaderboard`). Oculta quando a query retorna vazio.

- [ ] **REQ-14**: Tooltip do gráfico mostra para o bucket apontado: nome da ferramenta, `calls` brutos, `errors` brutos, `errorRate` em %. Em buckets sub-threshold, mostra "calls insuficientes (N)". **Validação manual** — não existe TC automatizado (detalhe UI difícil de testar de forma estável sem snapshot frágil).

- [ ] **REQ-15**: `MIN_CALLS_PER_BUCKET` é exportado por **`lib/analytics/tool-trend.ts`** (módulo dono da regra). `lib/queries/effectiveness.ts` importa. Evita magic-number e permite override futuro.

- [ ] **REQ-16**: Acessibilidade — o wrapper do gráfico tem `role="img"` e `aria-label` descrevendo o conteúdo (ex: "Tendência semanal de taxa de erro por ferramenta nos últimos 30 dias"). Leitores de tela não podem parsear SVG Recharts diretamente; o label é o mínimo honesto.

- [ ] **REQ-17**: Bucketing semanal usa `localtime` no `strftime` — mesma convenção das outras queries temporais. Consistência evita "semana X" dividida entre dois buckets quando horários de verão mudam.

## Test Plan

### Unit Tests — `lib/analytics/tool-trend.ts`

Helper puro que transforma as linhas raw do SQL (`(week, toolName, calls, errors)`) numa estrutura `TrendPoint[]` com `null` gaps. A separação SQL→JS segue o padrão de `groupByFamily` em `lib/analytics/model.ts`.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-6 | happy | Raw `[{week:'2026-W10',tool:'Bash',calls:20,errors:2}]` + topTools=`['Bash']` | `[{week:'2026-W10', rates:{Bash:0.10}, counts:{Bash:{calls:20,errors:2}}}]` |
| TC-U-02 | REQ-5 | edge | calls=4 (< threshold 5) | `rates.Bash = null`, counts preservados |
| TC-U-03 | REQ-5 | edge | calls=5 (exactly threshold, valid min) | `rates.Bash = 0` (0 errors → 0%) |
| TC-U-04 | REQ-5 | edge | calls=1 errors=1 (100% volátil) | `rates.Bash = null` (suprimido) |
| TC-U-05 | REQ-9 | happy | múltiplas semanas + tools → ordenado ASC por week | weeks em ordem crescente |
| TC-U-06 | REQ-6 | happy | uma semana com TODAS as top-N tools | point único com todas as `rates` preenchidas |
| TC-U-07 | REQ-9 | edge | raw tem dados pra tools FORA do topN | omitidos do output (points só têm chaves do topN) |
| TC-U-08 | REQ-9 | edge | raw vazio | `[]` |
| TC-U-09 | REQ-9 | edge | raw tem SOMENTE semanas sub-threshold pra todas tools | `[]` (ponto seria 100% null em todas → omitido) |
| TC-U-10 | REQ-12 | happy | `colorForTool('Bash')` retorna uma cor da `PALETTE`, idêntica em 100 chamadas consecutivas | determinístico |
| TC-U-11 | REQ-12 | happy | `colorForTool(name)` ∈ `PALETTE` para todas as tools da lista top-5 real (Bash/Read/Edit/Grep/Write) | todas dentro da paleta |
| TC-U-12 | REQ-12 | edge | `colorForTool('')` retorna um elemento da `PALETTE` sem throw | fallback estável |
| TC-U-13 | REQ-4 | happy | `buildTrend` com rows de 2 semanas distintas → `points[0].week < points[1].week` lexicograficamente | ordem ASC preservada |

### Unit Tests — `lib/analytics/percent.ts` (já existe; não alterar)

N/A — reusamos.

### Integration Tests — `lib/queries/effectiveness.test.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-6 | happy | 2 sessões com Bash e Read em semanas diferentes → `getToolErrorTrend({ days:30, topN:5 })` | `tools: ['Bash','Read']` (alfabético no tie de counts), points emit rates >0 nas semanas ativas |
| TC-I-02 | REQ-2 | edge | Sessão com started_at 40d atrás + Bash calls → excluída por janela de 30d | tool não aparece no output |
| TC-I-03 | REQ-3 | edge | `topN: 99` clampa pra 10 | `tools.length <= 10` |
| TC-I-04 | REQ-3 | edge | `topN: 0` clampa pra 1 | `tools.length === 1` |
| TC-I-05 | REQ-5 | edge | Tool com 3 calls na semana (< 5) | rate dessa tool nessa semana = null |
| TC-I-06 | REQ-7 | edge | DB sem nenhum tool_call na janela | `{ tools: [], points: [] }` |
| TC-I-07 | REQ-9 | edge | Semana onde TODAS as top-N tools têm calls sub-threshold | semana omitida do output |
| TC-I-08 | REQ-1, REQ-9 | business | Raw error count > call count (corrupção) | query não throw; rates clampados a `[0,1]` |
| TC-I-09 | REQ-8 | infra | 50 chamadas consecutivas a `getToolErrorTrend` reusam prepared | mesmo objeto via `getPrepared`; resultado idêntico |
| TC-I-10 | REQ-1 | edge | Top-N seleciona pela janela, não por totais históricos | tool com muito volume fora da janela é excluída |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-13 | happy | `/effectiveness` com seed cobrindo >5 calls em 2+ tools → seção "Tendência de erro por ferramenta" visível + `<svg>` Recharts renderizado + legenda com nomes | visíveis |
| TC-E2E-02 | REQ-13, REQ-11 | edge | Seed sem tool_calls nos últimos 30d → seção oculta | heading ausente |

## Design

### Architecture Decisions

1. **Top-N selecionado DENTRO DA JANELA.** A lista de tools rankeia pelas calls dos últimos `days`, não pelo histórico total. Evita "ferramentas fantasmas" que sumiram há meses.

2. **Threshold de supressão por bucket (`MIN_CALLS_PER_BUCKET = 5`).** Abaixo de 5 calls numa (tool, week), a taxa é `null` (gap no traço). Empírico: 5 é o menor N onde 1 erro isolado (20%) já começa a deixar de parecer ruído. Constante em `lib/analytics/tool-trend.ts`, importada por `effectiveness.ts`.

3. **Paleta concreta (10 cores, locked):** `PALETTE = ['#f59e0b','#10b981','#3b82f6','#a855f7','#f43f5e','#14b8a6','#d946ef','#84cc16','#fb923c','#06b6d4']` (amber, emerald, blue, violet, rose, teal, fuchsia, lime, orange, cyan). Discrimináveis entre si no tema dark.

4. **Hash estável (Java-style 31 multiplier):** `colorForTool(name)` computa `hash = 0; for (ch of name) hash = ((hash * 31) + ch.charCodeAt(0)) | 0;` e retorna `PALETTE[Math.abs(hash) % PALETTE.length]`. Determinístico entre runs/máquinas. Nome vazio ainda produz índice 0 (não throw). Colisões são possíveis (≥11 tools) mas irrelevantes na prática (top-5 default).

5. **Multi-series sem grouping "outros".** A cauda longa é excluída do gráfico. Mostrar um 6º traço "outros" agrupado polui e dilui taxas reais. `topN=5` default; usuário que quiser mais ajusta o parâmetro.

6. **`connectNulls={false}` no Recharts.** Gaps transmitem "dado insuficiente" melhor que uma reta interpolada. Decisão locked.

7. **Y fixo em `[0, 1]` renderizado como %.** Consistente com `AcceptRateTrend`. Auto-scale seria enganoso (3% e 30% parecem iguais).

8. **`TrendPoint[]` "denso" com chaves por ferramenta.** Cada ponto: `{ week, rates: Record<Tool, number|null>, counts: Record<Tool, { calls, errors }> }`. Recharts consome como `data={points}` e renderiza `<Line dataKey={\`rates.${tool}\`} />` por tool. Zero re-shape no client.

9. **SQL: sem CTE.** A query retorna TODAS as combinações `(week, tool_name, calls, errors)` na janela (ignorando top-N em SQL). O filtro top-N acontece em `buildTrend` em JS. Justificativa: para 6k tool_calls reais × 26 tools × 12 semanas = ~300 rows retornadas — overhead negligível, e simplifica o prepared statement (1 bind de cutoff em vez de 2 no CTE). Padrão alinhado com `groupByFamily` em `lib/analytics/model.ts` (SQL minimal + JS transformation).

10. **SQL concreta:**

    ```sql
    SELECT strftime('%Y-%W', s.started_at/1000, 'unixepoch', 'localtime') AS week,
           tc.tool_name                             AS toolName,
           COUNT(*)                                 AS calls,
           COALESCE(SUM(tc.result_is_error), 0)     AS errors
    FROM tool_calls tc
    JOIN turns t     ON t.id = tc.turn_id
    JOIN sessions s  ON s.id = t.session_id
    WHERE s.started_at >= ?
    GROUP BY week, tc.tool_name
    ORDER BY week ASC, tc.tool_name ASC
    ```

    Índices existentes cobrem: `idx_sessions_started_at`, `idx_turns_session`, `idx_tool_calls_turn`. Sem índice novo necessário.

11. **Defaults explícitos na signature:**

    ```ts
    export function getToolErrorTrend(
      db: DB,
      opts?: { days?: number; topN?: number },
    ): ToolTrendResult; // days=30, topN=5, topN clamped [1,10]
    ```

12. **Sanity clamping.** Se uma linha tiver `errors > calls` (corrupção/race), a razão é clampada a `1.0`. Não throw.

13. **Timezone.** `localtime` no `strftime` — mesma convenção de `weeklyRatio` e `weeklyAcceptRate`. Testes em in-memory DB com `openDatabase(':memory:')` respeitam o TZ da máquina; CI deve produzir mesmos buckets se o seed usa timestamps não-fronteira.

### Files to Create

- `lib/analytics/tool-trend.ts` — `MIN_CALLS_PER_BUCKET`, `PALETTE`, `colorForTool`, `buildTrend`, tipos `TrendPoint`/`ToolTrendResult`
- `lib/analytics/tool-trend.test.ts` — TCs TC-U-01..12
- `components/effectiveness/tool-success-trend.tsx` — Client Component com Recharts multi-line

### Files to Modify

- `lib/queries/effectiveness.ts` — adicionar `getToolErrorTrend(db, { days, topN })` reusando o WeakMap cache existente. Exportar `ToolTrendResult`.
- `lib/queries/effectiveness.test.ts` — TCs TC-I-01..10
- `app/effectiveness/page.tsx` — fetch + renderizar a seção
- `tests/e2e/smoke.spec.ts` OU novo `tests/e2e/tool-trends.spec.ts` — TC-E2E-01, 02
- `tests/e2e/global-setup.ts` — garantir que existe ≥ 1 sessão com ≥ 2 tools acima do threshold nos últimos 30d (se o seed atual não cobrir)

### Dependencies

Nenhuma nova. `recharts` já usado em 4 componentes; `Legend` é built-in.

## Tasks

- [x] **TASK-1**: Helper puro `lib/analytics/tool-trend.ts` — `MIN_CALLS_PER_BUCKET = 5`, `PALETTE` (as 10 cores hex listadas na Design #3), `colorForTool(name: string): string` (Java-style hash 31-multiplier, spec #4), `buildTrend(rawRows: RawTrendRow[], topN: number): ToolTrendResult` que (a) soma `calls` por tool pra selecionar top-N (ordenação desc por calls, tiebreak ASC alfabético), (b) aplica threshold por bucket, (c) omite semanas sem ponto válido, (d) clampa `errors/calls` em [0,1]. Tipos: `RawTrendRow`, `TrendPoint = { week: string; rates: Record<string, number|null>; counts: Record<string, { calls: number; errors: number }> }`, `ToolTrendResult = { tools: string[]; points: TrendPoint[] }`. Testes TC-U-01..13.
  - files: lib/analytics/tool-trend.ts, lib/analytics/tool-trend.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13

- [x] **TASK-2**: Query `getToolErrorTrend(db, opts?)` em `lib/queries/effectiveness.ts` — novo prepared statement usando o SQL concreto da Design #10 (sem CTE, 1 bind de cutoff). Assina `{ days?: number; topN?: number }` com defaults `days=30, topN=5` e clamp `topN ∈ [1,10]`. Chama `buildTrend` do TASK-1 em JS. Importa `MIN_CALLS_PER_BUCKET` do TASK-1 (não redeclarar). Exporta o tipo `ToolTrendResult` re-export do TASK-1. Testes TC-I-01..10.
  - files: lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10

- [x] **TASK-3**: Componente `components/effectiveness/tool-success-trend.tsx` — Client Component (`'use client'`). Props: `data: ToolTrendResult`. Renderiza `null` quando `data.tools.length === 0 || data.points.length === 0`. Wrapper `<div role="img" aria-label="Tendência semanal de taxa de erro por ferramenta">` pra a11y (REQ-16). Recharts `LineChart` com `CartesianGrid #262626`, `XAxis dataKey='week' #737373`, `YAxis domain=[0,1]` ticks em %, `Tooltip` com conteúdo custom mostrando por tool: `calls`/`errors`/`errorRate %` — em bucket sub-threshold onde `rates[tool] === null` mas `counts[tool].calls > 0`, mostra "calls insuficientes (N)" (REQ-14). `Legend` com nome das tools. Uma `<Line dataKey={\`rates.${tool}\`} stroke={colorForTool(tool)} connectNulls={false} />` por tool. Height h-64 (consistente com os outros trends).
  - files: components/effectiveness/tool-success-trend.tsx
  - depends: TASK-1

- [x] **TASK-4**: Integrar na página `app/effectiveness/page.tsx` — chamar `getToolErrorTrend(db, { days: 30, topN: 5 })`. Renderizar `<section>` com heading "Tendência de erro por ferramenta" + `<ToolSuccessTrend data={...} />` logo após a seção `ToolLeaderboard`. Oculta section (incluindo heading) quando `data.tools.length === 0`.
  - files: app/effectiveness/page.tsx
  - depends: TASK-2, TASK-3

- [x] **TASK-SMOKE**: E2E — criar `tests/e2e/tool-trends.spec.ts` com TC-E2E-01, 02. **Seed atual não cobre** (e2e-1 tem 1 tool call) — é obrigatório estender `tests/e2e/global-setup.ts` com uma nova session (ex: `e2e-tool-trends`) ou adicionar ≥10 tool_calls (Bash + Read, split entre sucessos/erros) em session dos últimos 7 dias pra passar no threshold de 5. TC-E2E-02 pode apontar pra cenário onde `days` é fora da janela (se impossível sem nova route param, aceitar que o seed sempre popula e rodar só TC-E2E-01 — marcar TC-E2E-02 como SKIPPED com razão).
  - files: tests/e2e/tool-trends.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-4
  - tests: TC-E2E-01, TC-E2E-02

## Parallel Batches

```text
Batch 1: [TASK-1]                   — foundation (helper puro)
Batch 2: [TASK-2, TASK-3]           — paralelo (query em lib/queries/ vs componente em components/; files disjuntos, ambos dependem só de TASK-1)
Batch 3: [TASK-4]                   — integração na page
Batch 4: [TASK-SMOKE]               — E2E final
```

File overlap analysis:
- `lib/analytics/tool-trend.ts` + `.test.ts`: exclusivo TASK-1
- `lib/queries/effectiveness.ts`: exclusivo TASK-2 (adicionando uma entry no PreparedSet; shared-additive histórico mas não com tasks deste spec)
- `lib/queries/effectiveness.test.ts`: exclusivo TASK-2
- `components/effectiveness/tool-success-trend.tsx`: exclusivo TASK-3
- `app/effectiveness/page.tsx`: exclusivo TASK-4
- `tests/e2e/global-setup.ts`: shared-additive histórico com outros specs; TASK-SMOKE sozinho aqui
- `tests/e2e/tool-trends.spec.ts`: exclusivo TASK-SMOKE

Batch 2 roda 2 worktrees em paralelo.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos TC-U + TC-I verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-01, 02)
- [ ] `pnpm dev` + `/effectiveness` com DB real: gráfico visível com Bash/Read/Edit/Grep/Write (ou similar) e taxas plausíveis entre 0-15%; gaps visíveis em semanas sub-threshold se existirem
- [ ] Cores por tool determinísticas: recarregar a página mantém Bash na mesma cor (REQ-12)
- [ ] **Manual (REQ-14)**: hover num bucket sub-threshold mostra "calls insuficientes (N)" em vez de %
- [ ] **Manual (REQ-16)**: DevTools > Accessibility tree mostra `role="img"` + `aria-label` no wrapper do gráfico
- [ ] Seção some completamente se a janela não tem tool_calls (testar com DB vazio ou `days=1` em DB antigo)

## Open Questions

Nenhuma. Todas as decisões ambíguas foram lockadas na seção Design:

- Paleta: 10 cores concretas (Design #3)
- Hash: Java-style 31-multiplier (Design #4)
- `connectNulls`: `false` (Design #6)
- `topN` default: 5 (Design #11)
- `MIN_CALLS_PER_BUCKET` home: `lib/analytics/tool-trend.ts` (REQ-15)
- SQL: sem CTE, filtro top-N em JS (Design #9-10)
- Timezone: `localtime` (Design #13)

Se alguma decisão for revisitada durante execução, atualizar aqui + respectivo requirement — sem deixar ambiguidade implícita.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
