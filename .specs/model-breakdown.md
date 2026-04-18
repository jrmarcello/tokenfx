# Spec: Model Breakdown — spend por família de modelo em /effectiveness

## Status: DONE

## Context

Hoje o dashboard mostra o **custo total** e **custo por turno**, mas não responde *"quanto do meu gasto foi em Opus vs Sonnet vs Haiku?"*. Saber isso é a base pra decidir downgrades estratégicos: se 80% do spend da semana foi em Opus pra tarefas que Sonnet resolveria, tem ROI imediato em mudar a escolha-padrão.

Os dados já estão no DB — cada `turn` tem `model` + `cost_usd`. O trabalho é apenas agregar, agrupar por família e renderizar.

## Requirements

- [ ] **REQ-1**: GIVEN o usuário abre `/effectiveness` AND há turns em ≥2 famílias de modelo com `cost_usd > 0` nos últimos 30 dias WHEN a página renderiza THEN uma seção "Distribuição de spend por modelo" é exibida com um **pie chart** com uma fatia por família.
- [ ] **REQ-2**: GIVEN apenas **1 família** tem `cost_usd > 0` nos últimos 30 dias WHEN a página renderiza THEN a mesma seção é exibida mas como **stat simples** (ex: `"100% em opus — $12.34"`), não como pie.
- [ ] **REQ-3**: GIVEN nenhum turn nos últimos 30 dias tem `cost_usd > 0` WHEN a página renderiza THEN a seção é **omitida inteiramente** (nenhum placeholder, nenhuma heading).
- [ ] **REQ-4**: Cada fatia/item mostra: nome da família (`opus` / `sonnet` / `haiku` / `other`), custo absoluto em USD, percentual do total. Ordenação por custo decrescente.
- [ ] **REQ-5**: Família é derivada do string `turns.model` via match case-insensitive do prefixo `claude-(opus|sonnet|haiku)`. Qualquer outro valor (inclusive string vazio) é agrupado como `other`. Sufixos como `[1m]` ou `-YYYYMMDD` não afetam a classificação.
- [ ] **REQ-6**: Cores por família são estáveis entre page loads: Opus = violet, Sonnet = sky-blue, Haiku = emerald, Other = neutral-400.
- [ ] **REQ-7**: A query agrega `SUM(turns.cost_usd)` com filtro `sessions.started_at >= cutoff` (JOIN via `turns.session_id`), mesma semântica de janela usada pelas outras queries da página.

## Test Plan

### Unit Tests — `lib/analytics/model.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-5 | happy | `deriveModelFamily('claude-opus-4-7')` | `'opus'` |
| TC-U-02 | REQ-5 | happy | `deriveModelFamily('claude-sonnet-4-6')` | `'sonnet'` |
| TC-U-03 | REQ-5 | happy | `deriveModelFamily('claude-haiku-4-5')` | `'haiku'` |
| TC-U-04 | REQ-5 | edge | Date suffix `claude-opus-4-1-20250401` | `'opus'` |
| TC-U-05 | REQ-5 | edge | Bracket suffix `claude-opus-4-7[1m]` | `'opus'` |
| TC-U-06 | REQ-5 | edge | Uppercase `CLAUDE-OPUS-4-7` | `'opus'` |
| TC-U-07 | REQ-5 | validation | Unknown model `'gpt-4'` | `'other'` |
| TC-U-08 | REQ-5 | validation | Empty string `''` | `'other'` |
| TC-U-09 | REQ-4 | happy | `groupByFamily([{model:'claude-opus-4-7',cost:6},{model:'claude-opus-4-1',cost:4},{model:'claude-sonnet-4-6',cost:10}])` | 2 items, opus total 10, sonnet total 10, both pct 0.5 |
| TC-U-10 | REQ-4 | happy | Sort order — larger cost first | `[sonnet(10), opus(10)]` tied → deterministic order (alphabetic family id on tie) |
| TC-U-11 | REQ-4 | business | Pct computation | Sum of pcts within 1e-6 of 1.0 |
| TC-U-12 | REQ-3 | edge | `groupByFamily([])` | `[]` |
| TC-U-13 | REQ-3 | edge | All costs zero | `[]` |

### Integration Tests — `lib/queries/effectiveness.test.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1, REQ-4 | happy | Insert 3 sessions (opus/sonnet/haiku) within window → `getModelBreakdown(db, 30)` | 3 items, costs match SUMs, sorted desc |
| TC-I-02 | REQ-7 | business | Session with `started_at` 40d old → excluded by 30d window | `[]` or excluded |
| TC-I-03 | REQ-3 | edge | Empty DB → `getModelBreakdown(db, 30)` | `[]` |
| TC-I-04 | REQ-2 | edge | Only opus turns → `getModelBreakdown(db, 30)` | 1 item with `pct: 1.0` |
| TC-I-05 | REQ-7 | edge | Turn with `cost_usd = 0` → excluded from totals | Not in result |
| TC-I-06 | REQ-5 | edge | Turn with unknown model → grouped under `'other'` | Present in result as `other` |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-04 | REQ-1, REQ-4 | happy | `/effectiveness` exibe heading "Distribuição de spend por modelo" e três labels (opus/sonnet/haiku) quando seed-dev popula modelos mistos | Visible |

Seed já cobre modelos mistos (ver `tests/e2e/global-setup.ts`); se não cobrir, TASK-2 inclui ajuste.

## Design

### Architecture Decisions

1. **Agrupamento em JS, não em SQL.** A query retorna `(model, total_cost)` raw por string exata de modelo; o mapeamento model→família é em TS via `deriveModelFamily`. Mantém o schema de famílias numa única fonte (compartilhável com testes) e evita reescrever a regra em SQL quando aparecer `claude-opus-5`.
2. **Filtro de janela usa `sessions.started_at`.** Consistência com as outras queries da página — uma sessão de 40d atrás não entra mesmo que tenha turns recentes (cenário improvável, mas a regra tem que ser uma).
3. **Graceful degrade no componente, não na query.** A query sempre retorna o array agrupado; o componente decide entre `pie` / `stat` / `hidden` baseado em `items.length`.
4. **Tipo `ModelFamily`.** Union literal: `'opus' | 'sonnet' | 'haiku' | 'other'`. Usado pela query, componente e testes.
5. **Cor por família.** Mapa constante em `lib/analytics/model.ts` exportado como `MODEL_FAMILY_COLORS`. Consumido pelo componente pra manter a fonte única.
6. **Sem nova dependência.** `recharts` já está em uso; `PieChart` + `Pie` + `Cell` cobrem o caso.

### Files to Create

- `lib/analytics/model.ts` — `ModelFamily` type, `deriveModelFamily`, `groupByFamily`, `MODEL_FAMILY_COLORS`
- `lib/analytics/model.test.ts` — unit tests para TC-U-01..13
- `components/effectiveness/model-breakdown.tsx` — client component com Recharts `PieChart`, variante stat-simples, variante hidden

### Files to Modify

- `lib/queries/effectiveness.ts` — adicionar `getModelBreakdown(db, days)` + prepared statement + tipo exportado
- `lib/queries/effectiveness.test.ts` — TC-I-01..06
- `app/effectiveness/page.tsx` — fetch + renderizar a seção (próxima ao `ToolLeaderboard`)
- `tests/e2e/smoke.spec.ts` — TC-E2E-04
- `tests/e2e/global-setup.ts` — se necessário, garantir seed com ≥2 famílias

### Dependencies

Nenhuma nova. `recharts` já instalado (usado em `cost-per-turn-histogram.tsx`, `ratio-trend.tsx`, `accept-rate-trend.tsx`).

## Tasks

- [x] **TASK-1**: Helper `lib/analytics/model.ts` — tipo `ModelFamily`, funções `deriveModelFamily`, `groupByFamily`, constante `MODEL_FAMILY_COLORS`. Testes unitários correspondentes.
  - files: lib/analytics/model.ts, lib/analytics/model.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13

- [x] **TASK-2**: Query `getModelBreakdown` em `lib/queries/effectiveness.ts`. Prepared statement que retorna `(model, total_cost)` agregado por `turns.model` dentro da janela. Mapeamento em JS via `groupByFamily`. Testes de integração cobrindo happy path, janela, vazio, 1-família, cost-zero, unknown-model.
  - files: lib/queries/effectiveness.ts, lib/queries/effectiveness.test.ts
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06

- [x] **TASK-3**: Componente `components/effectiveness/model-breakdown.tsx`. Props: `items: ModelBreakdownItem[]`. Renderiza pie quando `items.length >= 2`; stat quando `length === 1`; `null` quando `length === 0`. Cores de `MODEL_FAMILY_COLORS`. Tooltip nos formatos USD + percent.
  - files: components/effectiveness/model-breakdown.tsx
  - depends: TASK-1

- [x] **TASK-4**: Integrar na página `app/effectiveness/page.tsx`. Chamar `getModelBreakdown(db, 30)` no Server Component. Renderizar `<ModelBreakdown items={...} />` numa `<section>` ao lado do `ToolLeaderboard` (ajustar grid pra `lg:grid-cols-2` se necessário). O componente cuida de hide/stat/pie.
  - files: app/effectiveness/page.tsx
  - depends: TASK-2, TASK-3

- [x] **TASK-SMOKE**: E2E smoke test (TC-E2E-04). Verificar heading da seção + ≥2 labels de família. Ajustar `tests/e2e/global-setup.ts` se o seed não cobrir famílias mistas.
  - files: tests/e2e/smoke.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-4
  - tests: TC-E2E-04

## Parallel Batches

```text
Batch 1: [TASK-1]                    — foundation (pure helper + tests)
Batch 2: [TASK-2, TASK-3]            — parallel (query e componente não compartilham arquivos; ambos só dependem de TASK-1)
Batch 3: [TASK-4]                    — integração na página
Batch 4: [TASK-SMOKE]                — E2E final
```

File overlap analysis:

- `lib/analytics/model.ts` + `.test.ts`: exclusivo do TASK-1
- `lib/queries/effectiveness.ts` + `.test.ts`: exclusivo do TASK-2
- `components/effectiveness/model-breakdown.tsx`: exclusivo do TASK-3
- `app/effectiveness/page.tsx`: exclusivo do TASK-4
- `tests/e2e/smoke.spec.ts` + `tests/e2e/global-setup.ts`: exclusivo do TASK-SMOKE

Zero sobreposição — Batch 2 pode rodar em worktrees paralelos.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos os TC-U + TC-I verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-04 verde com o seed-dev populado)
- [ ] Conferir visualmente em `pnpm dev` → `/effectiveness` com seed misto: pie renderiza, cores estáveis, tooltip mostra USD + pct
- [ ] Conferir com seed de 1 só família: mostra stat simples
- [ ] Conferir com DB vazio: seção não aparece

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — TASK-1 (2026-04-18 15:13)

Criou `lib/analytics/model.ts` com `ModelFamily`, `deriveModelFamily`, `groupByFamily` e `MODEL_FAMILY_COLORS`. Testes unitários cobrem TC-U-01..13 mais 3 auxiliares.
TDD: RED(1 failing — module not found) → GREEN(16 passing) → REFACTOR(clean).
Full suite: 211/211 passing, typecheck limpo.

### Iteration 2 — TASK-2 + TASK-3 paralelos (2026-04-18 15:28)

Batch 2 executado em dois worktrees isolados:

- **TASK-2** (agent-a81f337c): `getModelBreakdown(db, days)` em `lib/queries/effectiveness.ts`, prepared statement agregando `SUM(turns.cost_usd)` com filtro `sessions.started_at >= ?` e exclusão SQL de custos ≤ 0. Agrupamento final delegado a `groupByFamily`. TCs TC-I-01..06 verdes.
- **TASK-3** (agent-a840cf16): `components/effectiveness/model-breakdown.tsx` — Client Component com três branches (hidden/stat/pie), Recharts `PieChart`+`Cell` consumindo `MODEL_FAMILY_COLORS`, tooltip com `fmtUsdFine`+`fmtPct`.

Worktrees merged + removidos. Typecheck limpo; model + effectiveness tests: 28/28 verdes.

### Iteration 3 — TASK-4 (2026-04-18 15:30)

Wire em `app/effectiveness/page.tsx`: import de `getModelBreakdown` + `ModelBreakdown`, fetch no server component, render em `<section className="lg:col-span-2">` antes do Tool Leaderboard com guard `{models.length > 0 && ...}` para satisfazer REQ-3 (seção inteiramente omitida quando não há dados). Typecheck + lint limpos.

### Iteration 4 — TASK-SMOKE (2026-04-18 15:30)

TC-E2E-04 adicionado em `tests/e2e/smoke.spec.ts`: navega para `/effectiveness`, asserta heading "Distribuição de spend por modelo" + ≥2 labels de família (opus/sonnet/haiku — o seed de `tests/e2e/global-setup.ts` já cobre os três). Rodou verde em 5.8s.

### Final Validation (2026-04-18 15:31)

- `pnpm typecheck` ✓
- `pnpm lint` ✓
- `pnpm test --run` ✓ 217/217
- `pnpm build` ✓ compiled successfully
- `pnpm test:e2e --grep TC-E2E-04` ✓

Spec DONE.
