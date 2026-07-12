# Spec: fix-score-sampling-transparency

## Status: DONE (pending commit)

## Context

Item 2.5 do `docs/execution-plan-2026-07.md` (Fase 2 — credibilidade dos números).

`getSessionScores` em [lib/queries/effectiveness.ts:313-351](lib/queries/effectiveness.ts)
calcula o score composto por sessão, mas hoje amostra apenas as **50 sessões mais
caras** da janela:

```ts
const MAX_SCORED_SESSIONS = 50;                       // :44
const sessions = p.topSessions.all(cutoff, MAX_SCORED_SESSIONS); // :316 — ORDER BY cost DESC LIMIT 50
```

`getSessionScores` é a fonte única de score, consumida por **cinco** superfícies —
todas herdam o viés "top-50 por custo", sem nenhuma disclosure na UI:

| Consumidor | Arquivo | Efeito do viés |
| --- | --- | --- |
| `getEffectivenessKpis.avgScore` | `effectiveness.ts:263` | média enviesada p/ sessões caras |
| `getSessionScoreDistribution` | `effectiveness.ts:368+` | distribuição só das 50 caras |
| `getTopSessionsByScore` | `overview.ts:342-360` | sessões "piores mas baratas" (as mais valiosas p/ drill) nunca aparecem |
| `getQuartileComparison` | `effectiveness-v2.ts:612` | quartis sobre só 50 sessões |
| `getDailyEffectivenessHeatmap` (heatmap) | `effectiveness-v2.ts:724` | dias cujas sessões não estão no top-50 ficam sem score |

Além das queries, a **UI descreve o cap textualmente** em dois KpiCards — copy que
passa a MENTIR se o cap for removido sem atualizá-la:

- [app/page.tsx:276-285](app/page.tsx) — `hint="0..100 · top 50 por custo"` +
  tooltip "Média dos scores compostos das **50 sessões mais caras** da janela
  (performance cap)…"
- [app/effectiveness/page.tsx:117-125](app/effectiveness/page.tsx) — mesmo hint +
  tooltip "…das **50 sessões mais caras** da janela…"

### Por que o cap existia (arqueologia — motivo original JÁ resolvido)

O cap nasceu no commit `067d759` (effectiveness page): a implementação original de
`getSessionScores` fazia **1 query de turnos POR SESSÃO dentro de um loop** (N+1) —
`p.turnsForSession.all(s.id)` por iteração. O `MAX_SCORED_SESSIONS = 50` era a
proteção contra esse N+1 (50 round-trips no pior caso). O commit `e26f5d1`
(`perf(effectiveness): collapse N+1 turns fetch into single json_each query`)
eliminou o N+1 — hoje são **3 round-trips constantes** (sessões, turnos batch via
`json_each`, accept-rates) independentemente de N. O cap ficou **órfão**: a razão
de existir dele já foi resolvida, mas a constante (e o viés) permaneceram.

**Decisão de produto travada (2026-07-12): REMOVER o cap.** O score passa a cobrir
**todas** as sessões da janela. Sem o `LIMIT`, o custo cresce linearmente com o nº
de sessões/turnos da janela — aceitável para o volume de um único usuário (ordem de
10³–10⁴ turnos por janela de 30d), e guardado por medição com gate automatizado
(TC-I-12) + live validation.

### Bug acoplado — `correctionDensity` 0-vs-null

[effectiveness.ts:339-340](lib/queries/effectiveness.ts):

```ts
const correctionDensity =
  turns.length > 0 ? penalties.size / turns.length : 0;   // ← BUG: deveria ser null
```

O contrato de `effectivenessScore` ([scoring.ts:154-157](lib/analytics/scoring.ts))
**documenta** que `correctionDensity` é `null` quando a sessão não tem turnos ("no
denominator"): nesse caso o sinal é *ausente* e seu peso (20%) é redistribuído. Ao
passar `0`, a sessão ganha o valor "densidade de correção zero = perfeito" com peso
cheio, **inflando** o score. Com o cap removido, sessões sem turnos ingeridos (só
metadados) passam a ser scoradas também, então o bug amplifica. Fix: retornar `null`
quando `turns.length === 0`.

### Decisões já travadas

- Remover o cap (não expor amostragem na UI). O `MAX_SCORED_SESSIONS` é **deletado**.
- `getTopSessionsByScore` (overview.ts): o candidate set atual (`Math.max(50, limit)`
  por custo, que também é a fonte de metadata) reintroduz o mesmo viés na lista
  "piores por score" — sessões baratas com score ruim nunca entram. Reescrever para
  derivar candidatos do conjunto completo de `getSessionScores` e buscar metadata
  por-id via nova prepared `sessionsByIds` — ver REQ-4/Design §3.
- `correctionDensity` → `null` quando sem turnos.
- Sem mudança nos pesos do score nem em `effectivenessScore` (já corretos).

## Requirements

- [ ] REQ-1: GIVEN uma janela com N sessões (N > 50), WHEN `getSessionScores(db, days)`
      roda, THEN retorna score para **todas** as N sessões da janela (não 50);
      `MAX_SCORED_SESSIONS` não existe mais no módulo.
- [ ] REQ-2: GIVEN uma sessão sem turnos ingeridos (`turns.length === 0`), WHEN seu
      score é computado, THEN `correctionDensity` passado a `effectivenessScore` é
      `null` (sinal ausente, peso redistribuído), não `0`.
- [ ] REQ-3: GIVEN o cap removido, WHEN `getEffectivenessKpis.avgScore`,
      `getSessionScoreDistribution`, `getQuartileComparison` e `getDailyEffectivenessHeatmap` rodam,
      THEN cada um agrega sobre o conjunto completo de sessões da janela (herdado de
      `getSessionScores`), sem regressão de shape/contrato.
- [ ] REQ-4: GIVEN `getTopSessionsByScore(db, limit, days)`, WHEN roda, THEN o
      candidate set considera **todas** as sessões scoradas (não só as top-N por
      custo), de modo que uma sessão barata com score baixo pode aparecer entre as
      "piores por score"; o resultado final continua sendo `limit` sessões ordenadas
      por score ascendente (tie-break `sessionId asc` para determinismo) com a
      metadata correta buscada por id (via `sessionsByIds`), inclusive para sessões
      baratas fora do antigo top-50-por-custo.
- [ ] REQ-5: GIVEN `getSessionScores` e `getTopSessionsByScore`, WHEN a janela não
      tem sessões, THEN retornam `[]` conforme o contrato atual (sem regressão do
      empty-state). Os demais consumidores (`getSessionScoreDistribution`, `getQuartileComparison`,
      `getDailyEffectivenessHeatmap`) já têm cobertura de empty-DB no bloco existente de
      `effectiveness.test.ts`/`effectiveness-v2.test.ts` — TASK-3 verifica que
      continuam verdes sob o caminho sem cap.
- [ ] REQ-6: GIVEN `getTopSessionsByScore(db, limit, days)` com menos sessões
      scoradas que `limit`, WHEN roda, THEN retorna todas as sessões disponíveis (não
      preenche nem erra); GIVEN empates de score, a ordem é determinística.
- [ ] REQ-7: GIVEN o cap removido, WHEN os KpiCards "Score médio" de `/` e
      `/effectiveness` renderizam, THEN hint e tooltip descrevem o comportamento
      real — hint `"0..100 · todas as sessões da janela"` e tooltip sem "50 sessões
      mais caras"/"performance cap" (a explicação dos pesos permanece). Nenhuma
      ocorrência de "top 50" ou "50 sessões" resta em `app/`/`components/`.

## Test Plan

Testes de integração contra SQLite in-memory (`openDatabase` + `migrate` + helpers
`insertSession`/`insertTurn`), mesmo harness de `lib/queries/effectiveness.test.ts`.
Unit puro onde aplicável.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | edge | `effectivenessScore` com `avgRating=-1` e demais sinais null, variando só `correctionDensity`: `null` vs `0` | `null` → só avgRating presente → (0.3·0)/0.3 = **0**; `0` → (0.3·0 + 0.2·1.0)/0.5 = **40**. Asserta 0 e 40 exatos (não `!==`) — prova que null (sinal ausente) ≠ 0 (densidade perfeita) |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | seed exatamente **51** sessões (antigo cap+1) com custo/rating variados; `getSessionScores(db,30)` | retorna 51 scores (prova que o cap sumiu, não foi só elevado) |
| TC-I-01b | REQ-1 | business | seed 200 sessões | retorna 200 (nenhum teto hardcoded em nenhum ponto da cadeia) |
| TC-I-02 | REQ-1 | business | seed 60 sessões; a MAIS BARATA (custo $0.01, fora do antigo top-50) com rating -1 | aparece no resultado com seu score real (não descartada) |
| TC-I-03 | REQ-5 | edge | janela vazia | `getSessionScores` → `[]` |
| TC-I-04 | REQ-2 | edge | sessão com ZERO turnos ingeridos e **só `cacheHitRatio=0.5`** presente (sinal turn-independent — seed: `input=0, output=0, cache_read=500, cache_creation=500` → `cache_hit_ratio=500/1000=0.5` e `output_input_ratio=NULL` pela view; rating é impossível sem turno — FK `ratings.turn_id→turns.id`) | score ≈ **50** (`correctionDensity` null → só cache conta: (0.1·0.5)/0.1); explicitamente NÃO ≈83.33 (que seria densidade 0: (0.1·0.5+0.2·1.0)/0.3) — `toBeCloseTo` |
| TC-I-05 | REQ-2 | business | duas sessões com `cacheHitRatio=0.5`, demais sinais null: A com 1 turno SEM correção (densidade 0 → válida), B sem turnos (null) | A → (0.1·0.5+0.2·1.0)/0.3 ≈ **83.33**; B → ≈**50**; prova que "zero correções real" (A) ≠ "sem turnos" (B) — o bug fazia B virar 83.33 também |
| TC-I-06 | REQ-3 | happy | seed 60 sessões; `getEffectivenessKpis.avgScore` | igual à média manual dos 60 scores (não dos 50 mais caros) |
| TC-I-07 | REQ-3 | business | `getSessionScoreDistribution` com 60 sessões espalhadas por faixas | soma das contagens = 60 (não 50) |
| TC-I-08 | REQ-3 | business | `getQuartileComparison` com 8 sessões de scores conhecidos e distintos (quartileSize=2), incluindo uma barata (fora do antigo top-50 se houvesse >50) na bottom-quartile | retorna `{topQuartile, bottomQuartile}` (AvgMetrics) não-null; a bottom-quartile reflete as 2 piores por score (prova que o cálculo opera sobre o conjunto completo, não amostra por custo) |
| TC-I-09 | REQ-3 | edge | `getDailyEffectivenessHeatmap` com sessões em vários dias, algumas baratas fora do antigo top-50 | todos os dias com sessões recebem score (sem gaps por amostragem) |
| TC-I-10 | REQ-4 | business | seed 60 sessões; a MAIS BARATA (custo $0.01, rank 60 por custo) é estritamente a de menor score; `getTopSessionsByScore(db, 1, 30)` | retorna exatamente essa sessão barata na posição 0 (prova metadata por-id + candidate set completo) |
| TC-I-10b | REQ-4 | edge | seed **51** sessões; a pior-por-score é a única mais barata (rank 51 por custo); `getTopSessionsByScore(db, 1, 30)` | essa sessão aparece (pina o boundary 50/51) |
| TC-I-11 | REQ-4/5 | edge | `getTopSessionsByScore` com janela vazia | `[]` |
| TC-I-13 | REQ-6 | edge | janela com 3 sessões, `limit=5` | retorna 3 (não preenche nem erra) |
| TC-I-14 | REQ-6 | edge | duas sessões com score idêntico | ordem determinística (`sessionId asc` no tie); resultado estável entre execuções |
| TC-I-12 | REQ-1 | infra | seed volumétrico (500 sessões × ~20 turnos); medir tempo agregado de **uma renderização-equivalente** (os 5 consumidores: `getEffectivenessKpis` + `getSessionScoreDistribution` + `getQuartileComparison` + `getDailyEffectivenessHeatmap` + `getTopSessionsByScore`) | completa com `expect(elapsedMs).toBeLessThan(5000)`; registrar o tempo medido no Execution Log |
| TC-U-02 | REQ-7 | validation | copy dos KpiCards: (a) grep NEGATIVO — zero ocorrências de `top 50`/`50 sessões`/`performance cap` em `app/**` e `components/**`; (b) grep POSITIVO — o hint `"0..100 · todas as sessões da janela"` presente em `app/page.tsx` E `app/effectiveness/page.tsx` | ambos os asserts (ausência do stale + presença da nova copy) |

## Design

### Architecture Decisions

1. **`getSessionScores` (effectiveness.ts)** — remover `MAX_SCORED_SESSIONS` (const
   :44 e uso :316). **Fato verificado (grep):** a prepared `topSessions` de
   `effectiveness.ts` é usada SÓ em `getSessionScores` (a `topSessions` de
   `overview.ts` é outra query, não tocada). Portanto: remover o `LIMIT ?` in place
   da prepared (mantendo o nome `topSessions`), e a chamada passa a bindar só
   `(cutoff)`. O `ORDER BY cost DESC` é mantido (ordem determinística para os
   testes), apenas sem o teto. Nenhum sentinela `-1` (obscuro) nem query duplicada.
2. **`correctionDensity` null** — trocar `: 0` por `: null` na linha 339-340. O
   contrato de `effectivenessScore` ([scoring.ts:124-128,154-157](lib/analytics/scoring.ts))
   já declara `correctionDensity: number | null` e documenta "null quando zero turnos"
   — este fix apenas alinha o caller ao contrato. `null` faz o peso de 20% ser
   redistribuído; `0` dava valor "densidade perfeita" com peso cheio (inflando).
   Nenhuma mudança de tipo.
3. **`getTopSessionsByScore` (overview.ts)** — DOIS problemas:
   - **(a) import via `require()`** ([overview.ts:348-349](lib/queries/overview.ts)):
     o lazy `require('./effectiveness')` tem justificativa stale — **verificado**:
     `effectiveness.ts` NÃO importa `overview.ts` (sem ciclo). Trocar por
     `import { getSessionScores } from './effectiveness'` estático no topo e
     **deletar o comentário stale** "Lazy-import to avoid circular refs…"
     (overview.ts:346-347) — mesma classe de drift que este spec elimina na UI.
   - **(b) candidate set + fonte de metadata capados por custo**: hoje
     `getTopSessions(db, Math.max(50, limit), days)` é a fonte tanto do candidate set
     quanto da metadata (`project/startedAt/totalCostUsd/turnCount/costSource`), e é
     `ORDER BY cost DESC LIMIT`. Uma sessão barata com score péssimo (o cenário do
     TC-I-10) teria score em `getSessionScores` mas NENHUMA row de metadata → seria
     silenciosamente descartada, reintroduzindo o próprio viés que REQ-4 conserta.
     **Correção** — a chamada `getTopSessions(db, Math.max(50, limit), days)`
     (overview.ts:354) é **deletada por inteiro**, não repurposed: (1) obter todos
     os scores de `getSessionScores` (agora completo),
     (2) ordenar por score asc com tie-break determinístico (`score asc, sessionId
     asc`), pegar os primeiros `limit` ids, (3) buscar a metadata desses ids
     específicos via uma **nova prepared statement `sessionsByIds`** em `overview.ts`,
     usando `json_each(?)` sobre um array JSON de ids (mesmo padrão de
     `turnsForSessions` em `effectiveness.ts:177-184`), mapeando para `TopSession`.
     A `sessionsByIds` **reusa** as constantes `EFFECTIVE_COST_EXPR`/`COST_SOURCE_EXPR`
     já existentes (overview.ts:75-90) — NÃO uma terceira cópia inline do
     cost-cascade. **Todos** os campos do `TopSession` (inclusive `project`) vêm da
     row de `sessionsByIds`, não do `SessionScore` — sem objeto de fonte mista.
     Preservar o contrato de retorno (`TopSession[]`, score asc, ≤ `limit`).
4. **Índice**: `getSessionScores` faz um scan de janela em `turns` via
   `turnsForSessions` (`ORDER BY session_id, sequence`). **Verificado**: o índice
   `idx_turns_session ON turns(session_id, sequence)` já existe
   ([schema.sql:48](lib/db/schema.sql)) — sem migration nova.
5. **UI copy (REQ-7)** — os dois KpiCards "Score médio" têm hint/tooltip que
   descrevem o cap. Atualizar: hint → `"0..100 · todas as sessões da janela"`;
   tooltip → remover "50 sessões mais caras"/"(performance cap)", mantendo a
   explicação dos pesos (30/20/15/15/10/10) intacta. Sem mudança estrutural de
   componente — só copy. É a única mudança de UI; não há disclosure de amostragem a
   adicionar porque não há mais amostragem.
6. **Sem novas dependências, sem mudança de schema.** A `sessionsByIds` é uma
   prepared statement nova no `getPrepared` memoizado de `overview.ts`, não um
   `db.prepare` por chamada.
7. **Memoização per-render (decisão a validar por medição)** — `getSessionScores` é
   chamado independentemente por `getEffectivenessKpis`, `getSessionScoreDistribution`,
   `getQuartileComparison`, `getDailyEffectivenessHeatmap` e `getTopSessionsByScore` — ou
   seja, 3–5× por renderização de página, cada uma agora O(N) sem cap. **Decisão
   default deste spec: NÃO adicionar memoização ainda**; TC-I-12 mede o custo
   AGREGADO de uma renderização-equivalente com gate `< 5s` a 500 sessões × 20
   turnos. Se a medição real (Validation) mostrar custo inaceitável, a mitigação
   correta é `React.cache` na fronteira dos Server Components (dedupe por request) —
   NÃO um `WeakMap<db,days>` (o `db` é singleton; cachearia entre requests e ficaria
   stale após ingestão). Isto é um ponto de atenção para o usuário (escolha
   arquitetural), não aplicado silenciosamente.
8. **Cross-ref stale**: `.specs/cost-calibration.md:11` documenta o comportamento
   antigo dependente do cap ("calibração muda quais entram no top-50"). Após este
   spec shippar, aquele parágrafo fica incorreto — TASK-3 inclui uma nota de 1 linha
   amendando-o.

### Guia de implementação (código quase-final dos pontos-chave)

Snippets fiéis ao código atual — o executor segue isto, não improvisa.

**TASK-1a — `lib/queries/effectiveness.ts`, prepared `topSessions` (linhas 153-176).**
Só duas mudanças: apagar a linha `LIMIT ?` do SQL e o tipo do Statement muda de
`[number, number]` para `[number]` (se tipado). O resto da query fica intacto:

```diff
        ORDER BY COALESCE(
          s.total_cost_usd_otel,
          s.total_cost_usd * (SELECT effective_rate FROM cost_calibration WHERE family='global' LIMIT 1),
          s.total_cost_usd
-       ) DESC
-       LIMIT ?`,
+       ) DESC`,
```

**TASK-1b — `getSessionScores` (linha 313-316).** Deletar a const `MAX_SCORED_SESSIONS`
(linha 44) e o segundo bind:

```diff
-const MAX_SCORED_SESSIONS = 50;
 ...
-  const sessions = p.topSessions.all(cutoff, MAX_SCORED_SESSIONS) as TopSessionRow[];
+  const sessions = p.topSessions.all(cutoff) as TopSessionRow[];
```

**TASK-1c — `correctionDensity` (linhas 339-340):**

```diff
-    const correctionDensity =
-      turns.length > 0 ? penalties.size / turns.length : 0;
+    // Contrato de effectivenessScore: null quando não há turnos (sinal
+    // ausente, peso redistribuído) — 0 significaria "zero correções", que é
+    // informação que não temos.
+    const correctionDensity =
+      turns.length > 0 ? penalties.size / turns.length : null;
```

**TASK-2 — `lib/queries/overview.ts`, `getTopSessionsByScore` (linhas 341-360) reescrita completa:**

1. Topo do arquivo: `import { getSessionScores } from './effectiveness';`
2. Em `PreparedSet`, adicionar `sessionsByIds: import('better-sqlite3').Statement<[string]>;`
3. Em `getPrepared`, nova prepared (reusa `EFFECTIVE_COST_EXPR`/`COST_SOURCE_EXPR` — nunca copiar o cost-cascade inline):

   ```ts
   sessionsByIds: db.prepare(
     `SELECT id,
             project,
             started_at AS startedAt,
             ${EFFECTIVE_COST_EXPR} AS totalCostUsd,
             turn_count AS turnCount,
             ${COST_SOURCE_EXPR} AS cost_source
      FROM sessions
      JOIN json_each(?) j ON j.value = sessions.id`
   ),
   ```

4. Corpo novo (a chamada `getTopSessions(db, Math.max(50, limit), days)` e o
   comentário "Lazy-import to avoid circular refs" são DELETADOS):

```ts
export function getTopSessionsByScore(
  db: DB,
  limit: number,
  days: number,
): TopSession[] {
  const scored = getSessionScores(db, days);
  if (scored.length === 0) return [];
  // Piores primeiro; tie-break por sessionId p/ ordem determinística.
  const worst = [...scored]
    .sort((a, b) => a.score - b.score || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit);
  const ids = worst.map((s) => s.sessionId);
  const p = getPrepared(db);
  const rows = p.sessionsByIds.all(JSON.stringify(ids)) as TopSessionRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Ordem final = ordem de `worst` (score asc); TODOS os campos vêm da row.
  return worst.flatMap((s) => {
    const r = byId.get(s.sessionId);
    return r
      ? [{
          id: r.id,
          project: r.project,
          startedAt: r.startedAt,
          totalCostUsd: r.totalCostUsd,
          turnCount: r.turnCount,
          costSource: r.cost_source as CostSource,
        }]
      : [];
  });
}
```

**TASK-4 — copy exata dos KpiCards:**

- `app/page.tsx:276`: `hint="0..100 · top 50 por custo"` → `hint="0..100 · todas as sessões da janela"`;
  no tooltip (linhas 279-281), trocar "Média dos scores compostos das **50 sessões
  mais caras** da janela (performance cap)." por "Média dos scores compostos de
  **todas as sessões** da janela." — o restante (pesos 30/20/15/15/10/10) fica.
- `app/effectiveness/page.tsx:117-121`: mesma troca de hint; tooltip "…das
  **50 sessões mais caras** da janela" → "…de **todas as sessões** da janela".

**Seeds dos TCs de valor fixado** (harness de `effectiveness.test.ts`):

- TC-I-04/05 sessão B (sem turnos, só cache): `insertSession` com
  `inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, cacheCreationTokens: 500`
  → `cache_hit_ratio = 500/1000 = 0.5`, `output_input_ratio = NULL`. Sem ratings,
  sem tool_calls, sem OTEL → únicos sinais: cache (0.1). Esperado ≈50 (`toBeCloseTo(50, 1)`).
- TC-I-05 sessão A: idem + 1 turno via `insertTurn` com prompt SEM padrão de
  correção → densidade 0 válida → ≈83.33 (`toBeCloseTo(83.33, 1)`).
- TC-U-01 (unit puro, direto em `effectivenessScore`): base
  `{outputInputRatio: null, cacheHitRatio: null, avgRating: -1, toolErrorRate: null, acceptRate: null}`
  → com `correctionDensity: null` = **0**; com `correctionDensity: 0` = **40**.

### Files to Modify

- `lib/queries/effectiveness.ts` — strip `LIMIT` da prepared `topSessions`; `correctionDensity` null.
- `lib/queries/effectiveness.test.ts` — TCs de scoring/KPIs/buckets.
- `lib/queries/overview.ts` — import estático de `getSessionScores`; nova prepared `sessionsByIds` (`json_each`); reescrever candidate set de `getTopSessionsByScore`.
- `lib/queries/overview.test.ts` — TCs de `getTopSessionsByScore` (se o arquivo existir; senão criar).
- `lib/queries/effectiveness-v2.test.ts` — TCs de quartis/heatmap (se ainda não cobrirem N>50).
- `app/page.tsx` / `app/effectiveness/page.tsx` — hint/tooltip do KpiCard "Score médio" (REQ-7, só copy).
- `.specs/cost-calibration.md` — nota de 1 linha corrigindo a menção stale ao top-50.

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: remover o cap em `getSessionScores` (strip `LIMIT` da prepared
      `topSessions`, bind só `cutoff`) + fix `correctionDensity` null. TC-U-01 vive
      em seu próprio `describe('correctionDensity null contract')` importando
      `effectivenessScore` direto (unit puro, não passa pelo DB).
  - files: lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - tests: TC-U-01, TC-I-01, TC-I-01b, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-12
- [x] TASK-2: `getTopSessionsByScore` — import estático + nova prepared `sessionsByIds`
      (`json_each`) + candidate set a partir do conjunto completo com tie-break
      determinístico
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts
  - depends: TASK-1
  - tests: TC-I-10, TC-I-10b, TC-I-11, TC-I-13, TC-I-14
- [x] TASK-3: cobrir quartis + heatmap sob cap removido (inclui empty-state) + nota
      de 1 linha em `cost-calibration.md` removendo a menção stale ao top-50
  - files: lib/queries/effectiveness-v2.test.ts, .specs/cost-calibration.md
  - depends: TASK-1
  - tests: TC-I-08, TC-I-09
- [x] TASK-4: atualizar hint/tooltip dos KpiCards "Score médio" (`/` e
      `/effectiveness`) + grep-guard de copy stale (TC-U-02, colocado no teste da
      página ou em `lib/queries/effectiveness.test.ts` como asserção de repositório,
      mesmo padrão do TC-U-21 do spec fix-local-mode-synthetic-user-uuid)
  - files: app/page.tsx, app/effectiveness/page.tsx
  - depends: TASK-1
  - tests: TC-U-02

## Parallel Batches

Batch 1: [TASK-1]                    — foundation (fonte do score)
Batch 2: [TASK-2, TASK-3, TASK-4]    — paralelos (arquivos disjuntos: overview vs effectiveness-v2/cost-calibration vs app pages), dependem de TASK-1

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa
- [ ] `pnpm build` passa
- [ ] **Live validation com dados reais**: seed via `DASHBOARD_DB_PATH=<scratch>/sim.db pnpm seed-dev`
      (NUNCA escrever em `data/dashboard.db`), subir `pnpm dev`, e comparar o
      `avgScore` / distribuição de buckets em `/` e `/effectiveness` ANTES (com o
      cap, via git stash) e DEPOIS — confirmar que os números mudam de forma
      consistente e que sessões baratas de score ruim passam a aparecer no top-por-score;
      conferir visualmente que o hint/tooltip do "Score médio" não menciona mais o cap.
- [ ] **Medição de custo** registrada no Execution Log: tempo de `getSessionScores`
      no seed volumétrico (TC-I-12) — confirmar que remover o cap é aceitável.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1] (2026-07-12)

Foundation, inline no working tree. Removido `MAX_SCORED_SESSIONS` + `LIMIT ?` da
prepared `topSessions` (tipo `Statement<[number]>`); `correctionDensity` → `null`
quando sem turnos. Também feito o swap mínimo `require`→import estático de
`getSessionScores` em `overview.ts` (o `require` quebrava sob ESM do vitest e o
TC-I-12 da TASK-1 depende de `getTopSessionsByScore`). TDD: RED(8 fail) → GREEN(47 pass).

### Batch 2 [TASK-2, TASK-3, TASK-4] (2026-07-12)

Inline sequencial (não worktrees: root usa `better-sqlite3` nativo; arquivos
disjuntos — overview.ts vs effectiveness-v2.test.ts/cost-calibration.md vs app pages).

- TASK-2: `getTopSessionsByScore` reescrito — candidate set do conjunto completo de
  `getSessionScores`, tie-break `sessionId asc`, metadata por-id via nova prepared
  `sessionsByIds` (`json_each`, reusa `EFFECTIVE_COST_EXPR`/`COST_SOURCE_EXPR`);
  `getTopSessions(Math.max(50,limit))` deletado. TDD: RED(3 fail) → GREEN(26 pass).
- TASK-3: TC-I-08 (quartil sampleSize=15 prova N=60) + TC-I-09 (heatmap: sessão
  barata em dia isolado recebe score) em effectiveness-v2.test.ts; nota corrigida em
  cost-calibration.md:11 (cap removido → calibração não afeta mais o conjunto scorado).
  GREEN(2 pass — produção já mudou na TASK-1, são guards de regressão).
- TASK-4: hint/tooltip dos KpiCards "Score médio" (`app/page.tsx`,
  `app/effectiveness/page.tsx`) → "todas as sessões da janela"; TC-U-02 grep-guard
  (ausência do stale + presença da nova copy). GREEN(2 pass).

### Validação (2026-07-12)

- typecheck + lint limpos; **suíte raiz 1265 passed / 6 skipped** (+19 TCs).
- **Medição de custo (TC-I-12)**: 5 consumidores sobre 500 sessões × 20 turnos =
  **46ms** (gate < 5000ms). Memoization confirmadamente desnecessária — measure-first
  resolveu o ponto de atenção.
- **Live data** (seed-dev em DB scratch): `scored == within` (sem cap); `avgScore`
  sobre todas; sessão barata `seed-009` ($0.031) aparece entre as piores-por-score
  (antes seria descartada pelo candidate set capado por custo).
