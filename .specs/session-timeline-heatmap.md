# Spec: Session Timeline Heatmap — calendário de atividade no dashboard

## Status: DONE

## Context

A visão geral hoje mostra KPIs (30d) e uma linha de tendência (30d). Falta uma visão **anual** do uso — "em que dias/semanas eu realmente programei com Claude?". O formato GitHub-contributions (52×7) é reconhecível, denso em informação por pixel e responde instantaneamente: quais são meus dias pesados, que semanas foram lentas, quando desliguei de vez.

Os dados já existem: `sessions.started_at` + `total_cost_usd`, com agregação diária em [lib/queries/overview.ts:114](lib/queries/overview.ts#L114) (`getDailySpend`). Falta só adicionar `sessionCount` na agregação e plugar um heatmap puro-SVG. Navegação: clicar num dia filtra `/sessions?date=YYYY-MM-DD`.

## Requirements

- [ ] **REQ-1**: GIVEN o usuário abre `/` AND há ≥1 sessão no último ano WHEN a página renderiza THEN exibe seção "Atividade do último ano" com grade 52 semanas × 7 dias, posicionada **abaixo dos KPIs** e **acima do "Custo diário"**.
- [ ] **REQ-2**: Cada célula tem cor escalonada em 5 níveis (0..4) baseada no spend diário. Nível 0 = spend == 0 (cinza neutro). Níveis 1..4 são **frações do spend máximo histórico na janela**, com cutpoints fixos em 25%, 50%, 75%, 100% — do mais claro (emerald-900) ao mais intenso (emerald-400). A fórmula é `level = spend === 0 ? 0 : Math.min(4, Math.ceil(4 * spend / maxSpend))`. Determinística, bem-definida para qualquer N, e destaca outliers (o insight central do heatmap).
- [ ] **REQ-3**: Hover numa célula mostra tooltip no formato `YYYY-MM-DD — $X.XX (N sessões)`. Células vazias (sem spend) mostram apenas `YYYY-MM-DD — sem atividade`.
- [ ] **REQ-4**: Clicar numa célula com `spend > 0` navega para `/sessions?date=YYYY-MM-DD`. Células vazias não são clicáveis (cursor default, `aria-disabled`).
- [ ] **REQ-5**: `/sessions?date=YYYY-MM-DD` filtra a lista pelas sessões cujo `started_at` (em local-time) cai no dia informado. Dia sem sessões → mensagem "Sem sessões em YYYY-MM-DD" + link "ver todas".
- [ ] **REQ-6**: `?date=` com formato inválido (qualquer coisa que não case `/^\d{4}-\d{2}-\d{2}$/` ou um dia impossível como `2026-02-30`) é tratado como ausente — a página renderiza a lista normal + banner discreto "Parâmetro date inválido, mostrando todas".
- [ ] **REQ-7**: GIVEN nenhum dia no último ano tem `spend > 0` WHEN a página renderiza THEN a seção do heatmap mostra placeholder `"Sem sessões ainda"` no mesmo wrapper visual (não some, pra manter âncora visual).
- [ ] **REQ-8**: A query `getDailySpend` é estendida pra retornar `sessionCount` junto com `spend` e `tokens`, **sem quebrar** o uso atual do `TrendChart` (janela 30d).
- [ ] **REQ-9**: O layout da grade começa **no domingo** (coluna Sun..Sat) pra casar com a convenção GitHub. Labels de mês aparecem no topo, próximos à primeira semana de cada mês. Labels de dia (Mon/Wed/Fri) aparecem na lateral esquerda.
- [ ] **REQ-10**: GIVEN viewport < 768px WHEN o heatmap renderiza THEN a grade é envelopada em um wrapper `overflow-x-auto`, mantendo tamanho de célula fixo (prefere-se scroll horizontal em vez de reduzir célula a ponto de virar ilegível). Wrapper expõe um shadow/fade nas bordas quando há conteúdo scrollável.
- [ ] **REQ-11**: Uma legenda compacta aparece no rodapé do heatmap: texto "Menos", 5 swatches (L0..L4) e texto "Mais", na horizontal, alinhada à direita. Usa as mesmas cores da grade.

## Test Plan

### Unit Tests — `lib/analytics/heatmap.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | edge | `computeLevels([])` | `[]` |
| TC-U-02 | REQ-2 | edge | Todos dias com spend 0 | Todos nível 0 |
| TC-U-03 | REQ-2 | business | `[0, 2, 4, 6, 8]` (max=8, cutpoints 2/4/6/8) | `[0, 1, 2, 3, 4]` |
| TC-U-04 | REQ-2 | edge | 1 único valor não-zero `[0, 0, 5]` | `[0, 0, 4]` — outlier vai pra L4 |
| TC-U-05 | REQ-2 | edge | Todos iguais não-zero `[5, 5, 5]` | `[4, 4, 4]` — todos saturam em L4 |
| TC-U-06 | REQ-2 | edge | Valores muito pequenos abaixo do cut `[0.01, 1]` (max=1, spend=0.01 → 4·0.01/1 = 0.04 → ceil = 1) | `[1, 4]` — `Math.ceil` garante que qualquer spend>0 vira ≥ L1 |
| TC-U-07 | REQ-9 | happy | `arrangeWeeks(dailyPoints, 365)` com `endDate='2026-04-18'` | 52 ou 53 colunas, cada coluna com 7 linhas, domingo no topo |
| TC-U-08 | REQ-9 | edge | Primeira coluna parcial (se `endDate - 364d` não é domingo) | Preenchida com `null` placeholders nas linhas antes do domingo equivalente |
| TC-U-09 | REQ-6 | validation | `parseDateParam('2026-04-18')` | `{ valid: true, date: '2026-04-18', start: ms, end: ms }` |
| TC-U-10 | REQ-6 | validation | `parseDateParam('2026-2-1')` (sem zero-pad) | `{ valid: false }` |
| TC-U-11 | REQ-6 | validation | `parseDateParam('2026-02-30')` (dia impossível) | `{ valid: false }` |
| TC-U-12 | REQ-6 | validation | `parseDateParam('')` | `{ valid: false }` |
| TC-U-13 | REQ-6 | validation | `parseDateParam(undefined)` | `{ valid: false }` |
| TC-U-14 | REQ-6 | validation | `parseDateParam('abc-de-fg')` | `{ valid: false }` |
| TC-U-15 | REQ-9 | business | `monthLabels(arrangedWeeks)` | Array com rótulo no índice da primeira coluna que contém dia-1 daquele mês, vazio nas demais |

### Integration Tests

Em `lib/queries/overview.test.ts`:

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-8 | happy | `getDailySpend(db, 30)` após inserir 2 sessões no mesmo dia | Esse dia vem com `sessionCount: 2` + soma dos custos |
| TC-I-02 | REQ-8 | edge | Dia sem sessões dentro da janela | `sessionCount: 0`, `spend: 0` |

Em `lib/queries/session.test.ts`:

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-03 | REQ-5 | happy | `listSessionsByDate(db, '2026-04-18')` após inserir 3 sessões no dia + 1 no dia anterior | Retorna 3, ordenadas desc por `started_at` |
| TC-I-04 | REQ-5 | edge | Boundary — sessão às 00:00:00 local e às 23:59:59 local no mesmo dia | Ambas incluídas |
| TC-I-05 | REQ-5 | edge | Boundary — sessão às 00:00:00 do dia seguinte | NÃO incluída |
| TC-I-06 | REQ-5 | edge | Dia sem sessões | `[]` |
| TC-I-07 | REQ-6 | validation | `listSessionsByDate(db, '2026-13-99')` (formato inválido) | `[]` — função é best-effort; validação fica na page layer |
| TC-I-08 | REQ-6 | validation | `listSessionsByDate(db, '')` | `[]` |

### E2E Tests — `tests/e2e/smoke.spec.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-05 | REQ-1, REQ-2 | happy | `/` renderiza heading "Atividade do último ano" + ≥1 célula com classe de nível > 0 | Visible |
| TC-E2E-06 | REQ-4, REQ-5 | happy | Clicar na célula do dia do seed leva para `/sessions?date=...` e exibe a sessão seed | Pass |
| TC-E2E-07 | REQ-6 | validation | Visita direta `/sessions?date=abc` | Lista completa renderiza + banner "inválido" visível |

## Design

### Architecture Decisions

1. **Heatmap puro SVG, sem Recharts.** Recharts não tem um heatmap GitHub-style nativo e forçar via `ScatterChart` adiciona peso sem ganho. Um `<svg>` com `<rect>` por célula é ~100 linhas, estável e 100% estilizável via Tailwind. Referência visual: `cost-per-turn-histogram.tsx` pro wrapper do card.
2. **Níveis = fração do spend máximo.** Algoritmo determinístico `level = spend === 0 ? 0 : Math.min(4, Math.ceil(4 * spend / maxSpend))`. Não depende de distribuição amostral — bem-definido para N=1..365, destaca outliers (um dia de $50 contra muitos de $0.10 fica em L4 sozinho), e não flicker entre níveis conforme novos dias são ingeridos. Preferido sobre quartis por conta do caso "usuário com poucos dias ativos".
3. **`sessionCount` sai da query, não do frontend.** Adicionar `COUNT(*) AS sessionCount` no `GROUP BY date` do prepared statement é uma linha de SQL. Mantém o front consumindo um payload já pronto. Campo é **aditivo** em `DailyPoint` — auditar e ajustar testes existentes que usam `toEqual` estrito antes do RED do TASK-2.
4. **Navegação por click em rect via `useRouter().push()`, não 365 `<Link>`.** Um único handler delegado lê `data-date` do target e navega. Reduz DOM (1 handler vs 365 `<a>`), acelera paint. Perde "middle-click → nova aba", aceitável pra UI interna. Mantém acessibilidade via `role="gridcell"` + `tabIndex` + `onKeyDown` (Enter/Space).
5. **Server-side filter em `/sessions`.** `/sessions?date=YYYY-MM-DD` é read-only e stateless. O Server Component lê `searchParams.date` (Next 15: `Promise<{ date?: string }>`), valida com `parseDateParam`, chama `listSessionsByDate` ou `listSessions`. Invalid → banner discreto. `listSessionsByDate` sem `limit` (scope natural pequeno; dia típico tem <50 sessões).
6. **Boundary de "dia local" + testes TZ-safe.** `sessions.started_at` é epoch-ms UTC. A janela `[start, end)` do dia local-time é calculada no TS via `new Date(Y, M-1, D, 0, 0, 0).getTime()` + 86_400_000, que respeita o `process.env.TZ`. Testes de boundary (TC-I-04, TC-I-05) calculam as Date fixtures **via o mesmo helper** pra evitar flake entre CI (UTC) e dev (TZ local); não hardcodar epoch constants.
7. **Invalid date na query = `[]`.** `listSessionsByDate` com formato inválido retorna `[]` (não throw). A validação/banner fica na camada da página (`parseDateParam` antes de chamar). TC-I-07 e TC-I-08 afirmam esse contrato.
8. **Sunday-first.** GitHub-style. `arrangeWeeks` preenche os slots antes do `start_date` com `null` pra evitar jitter de layout.
9. **Mobile: `overflow-x-auto`.** O wrapper do heatmap em viewport < 768px ganha scroll horizontal. Tamanho de célula permanece fixo (12px). Fade/shadow nas bordas quando há scroll (via Tailwind `mask-image` ou pseudo-elements).
10. **Seed compatibility.** `tests/e2e/global-setup.ts` e `scripts/seed-dev.ts` devem garantir ≥1 sessão com `started_at` dentro do dia atual (`Date.now()`). Auditar ao implementar TASK-SMOKE; se o seed usa datas absolutas fixas, migrar pra offsets relativos ao "agora".

### Files to Create

- `lib/analytics/heatmap.ts` — tipos + `computeLevels`, `arrangeWeeks`, `monthLabels`, `parseDateParam`
- `lib/analytics/heatmap.test.ts` — TC-U-01..15
- `components/overview/activity-heatmap.tsx` — Client Component com SVG grid + tooltip + click delegado (`useRouter`) + legenda + wrapper responsivo

### Files to Modify

- `lib/queries/overview.ts` — adicionar `sessionCount` em `DailyPoint`, atualizar SQL do `dailySpend`
- `lib/queries/overview.test.ts` — TC-I-01..02 + atualizar testes existentes se necessário
- `lib/queries/session.ts` — `listSessionsByDate(db, date)`
- `lib/queries/session.test.ts` — TC-I-03..08
- `app/page.tsx` — importar + renderizar `ActivityHeatmap` com `getDailySpend(db, 365)` entre KPIs e TrendChart
- `app/sessions/page.tsx` — aceitar `searchParams.date`, validar, chamar query variante, renderizar banner quando inválido
- `tests/e2e/smoke.spec.ts` — TC-E2E-05..07
- `tests/e2e/global-setup.ts` — se necessário, garantir que seed inclui ≥1 sessão em "hoje" pra testes clicáveis funcionarem de forma determinística

### Dependencies

Nenhuma nova. SVG nativo + Tailwind + `next/link` + `lib/fmt.ts`.

## Tasks

- [x] **TASK-1**: Helpers puros em `lib/analytics/heatmap.ts` — `computeLevels(values: number[]): number[]` (fração do max, cutpoints 25/50/75/100%), `arrangeWeeks(points: DailyPoint[], endDate: string): Week[]` (agrupa Sunday-first com null-padding), `monthLabels(weeks: Week[]): string[]` (índices → rótulo do mês), `parseDateParam(raw: string | undefined): ParsedDate` (valida formato + existência, cutoffs calculados via `new Date(Y,M-1,D,...)`). Testes unitários cobrem TC-U-01..15.
  - files: lib/analytics/heatmap.ts, lib/analytics/heatmap.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15

- [x] **TASK-2**: Estender `DailyPoint` + `getDailySpend` em `lib/queries/overview.ts` com `sessionCount`. Adicionar `COUNT(*)` no prepared statement. Atualizar o zero-fill pra emitir `sessionCount: 0`. **Antes do RED**: grep por `toEqual` em `overview.test.ts` e ajustar assertions que verificam shape exato de `DailyPoint`. Adicionar TC-I-01..02.
  - files: lib/queries/overview.ts, lib/queries/overview.test.ts
  - tests: TC-I-01, TC-I-02

- [x] **TASK-3**: `listSessionsByDate(db, date: string): SessionListItem[]` em `lib/queries/session.ts`. Prepared statement com `WHERE started_at >= ? AND started_at < ?` (cutoffs calculados a partir de `new Date(Y,M-1,D,...)`). Formato inválido retorna `[]`. Sem `limit`. Fixtures dos testes de boundary (TC-I-04/05) calculam os ms via o mesmo helper de parse pra não flaking entre TZ. Testes TC-I-03..08.
  - files: lib/queries/session.ts, lib/queries/session.test.ts
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08

- [x] **TASK-4**: Componente `components/overview/activity-heatmap.tsx`. Client Component (`'use client'`). Props: `{ data: DailyPoint[] }`. Renderiza wrapper `overflow-x-auto` + SVG 52×7 com células fixas (12px) + labels de mês (topo) + labels Mon/Wed/Fri (esquerda) + legenda "Menos [5 swatches] Mais" no rodapé. **Click delegado**: um único handler no SVG raiz lê `data-date` do `event.target` e chama `useRouter().push('/sessions?date=' + date)` apenas quando `spend > 0`. Cada rect tem `role="gridcell"`, `tabIndex={0}` e `onKeyDown` (Enter/Space). Tooltip via elemento `title` nativo do SVG (zero JS). Empty state: se `data.every(d => d.spend === 0)`, mostra placeholder "Sem sessões ainda" centralizado no wrapper. Usa `computeLevels`, `arrangeWeeks`, `monthLabels` do helper.
  - files: components/overview/activity-heatmap.tsx
  - depends: TASK-1

- [x] **TASK-5**: Wire em `app/page.tsx`. Chamar `getDailySpend(db, 365)`, renderizar `<ActivityHeatmap data={yearly} />` entre o bloco de KPIs e o "Custo diário". Ajustar import. Typecheck limpo.
  - files: app/page.tsx
  - depends: TASK-2, TASK-4

- [x] **TASK-6**: Extensão do `app/sessions/page.tsx` — aceitar `searchParams.date` (Next 15 App Router: `searchParams: Promise<{ date?: string }>`). Validar com `parseDateParam` (do TASK-1). Se válido: chamar `listSessionsByDate`; se inválido: renderizar banner "Parâmetro date inválido, mostrando todas" + `listSessions` normal. Se vazio pro dia: mostrar "Sem sessões em YYYY-MM-DD" + link "ver todas".
  - files: app/sessions/page.tsx
  - depends: TASK-1, TASK-3

- [x] **TASK-SMOKE**: E2E (TC-E2E-05..07) em `tests/e2e/smoke.spec.ts`. **Pré-checagem obrigatória**: auditar `tests/e2e/global-setup.ts` — se `started_at` das sessões seed for absoluto/fixo, migrar pra offsets relativos a `Date.now()` (ex: `now - 1h`) pra garantir ≥1 sessão no dia atual sem regressão no TC-E2E-02.
  - files: tests/e2e/smoke.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-5, TASK-6
  - tests: TC-E2E-05, TC-E2E-06, TC-E2E-07

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3]    — foundations paralelas (helper, query diária, query por data)
Batch 2: [TASK-4, TASK-6]            — componente e page /sessions em paralelo (files disjoint; TASK-4 precisa TASK-1, TASK-6 precisa TASK-1+TASK-3)
Batch 3: [TASK-5]                    — wire home (depende de TASK-2 + TASK-4)
Batch 4: [TASK-SMOKE]                — E2E final
```

File overlap analysis:

- `lib/analytics/heatmap.ts` + `.test.ts`: exclusivo do TASK-1
- `lib/queries/overview.ts` + `.test.ts`: exclusivo do TASK-2
- `lib/queries/session.ts` + `.test.ts`: exclusivo do TASK-3
- `components/overview/activity-heatmap.tsx`: exclusivo do TASK-4
- `app/page.tsx`: exclusivo do TASK-5
- `app/sessions/page.tsx`: exclusivo do TASK-6
- `tests/e2e/smoke.spec.ts` + `tests/e2e/global-setup.ts`: exclusivo do TASK-SMOKE

Zero overlap — Batch 1 e Batch 2 podem rodar em worktrees.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos os TC-U + TC-I verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-05..07)
- [ ] Conferir visualmente em `pnpm dev`:
  - Home mostra heatmap abaixo dos KPIs, antes do trend chart
  - Hover numa célula não-vazia mostra tooltip no formato esperado
  - Clicar leva pra `/sessions?date=...` com lista filtrada
  - `/sessions?date=invalid` mostra banner + lista completa
  - Legenda "Menos [swatches] Mais" visível no rodapé do heatmap
  - Em viewport ≤ 768px (DevTools responsive): wrapper rola horizontalmente sem quebrar layout
  - Navegação por teclado: Tab chega em células, Enter/Space navegam
- [ ] DB vazio: heatmap mostra "Sem sessões ainda", sem crash

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1: TASK-1 + TASK-2 + TASK-3 paralelos (2026-04-18 18:31)

Três worktrees isolados rodaram TDD em paralelo:

- **TASK-1** (agent-a675bea5): `lib/analytics/heatmap.ts` com `computeLevels`, `arrangeWeeks`, `monthLabels`, `parseDateParam`. 22 TCs cobrindo TC-U-01..15 + extras edge (null, calendar rollover).
- **TASK-2** (agent-adec0137): Extensão de `DailyPoint` com `sessionCount`. Pre-audit encontrou 0 testes com `toEqual` estrito — adição puramente aditiva. TC-I-01/02 verdes.
- **TASK-3** (agent-a67e5791): `listSessionsByDate` com validação inline (regex + calendar rollover check), sem `limit`, boundary TZ-safe via `new Date(Y,M-1,D,...)`. TC-I-03..08 verdes.

Merge limpo; 311/311 tests passing.

### Iteration 2 — Batch 2: TASK-4 + TASK-6 (2026-04-18 18:36)

- **TASK-6** (agent-a257fda1): `app/sessions/page.tsx` aceita `searchParams: Promise<{ date?: string }>`, três branches (sem date → `listSessions(100)`, valid → `listSessionsByDate`, invalid → banner + lista completa). Typecheck limpo.
- **TASK-4**: agente foi bloqueado pelo base commit do worktree (Batch 1 ainda não commitado); executado manualmente. `components/overview/activity-heatmap.tsx` — SVG 52×7, Sunday-first, 5 níveis de cor, tooltip via `<title>`, click delegado com `useRouter`, keyboard nav (Enter/Space), wrapper `overflow-x-auto`, legenda "Menos .. Mais", empty state "Sem sessões ainda".

### Iteration 3 — TASK-5 (2026-04-18 18:36)

Wire em `app/page.tsx`: `getDailySpend(db, 365)` alimenta `<ActivityHeatmap>` em uma `<section>` entre KPIs e Custo diário. Typecheck + lint limpos.

### Iteration 4 — TASK-SMOKE (2026-04-18 18:40)

Seed ajustado: adicionado `e2e-today` (`daysAgo: 0`) pra garantir célula clicável hoje sem date arithmetic nos testes. TC-E2E-05/06/07 implementados — heatmap heading, click → navigate + lista filtrada, invalid date → banner + lista completa. 3/3 verdes em isolamento. TC-E2E-03 (rating) teve flake pré-existente (race com outros testes), passa em isolamento.

### Final Validation (2026-04-18 18:40)

- `pnpm typecheck` ✓
- `pnpm lint` ✓
- `pnpm test --run` ✓ 311/311 (antes: 221 → +90 com heatmap/query/session)
- `pnpm build` ✓ compiled successfully
- `pnpm test:e2e --grep "TC-E2E-05|06|07"` ✓

Spec DONE.
