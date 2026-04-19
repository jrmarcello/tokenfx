# Spec: Paginação em `/sessions`

## Status: DONE

## Context

`/sessions` hoje chama `listSessions(db, 100)` — LIMIT hardcoded, sem offset. 61 sessões no DB real, mas a curva é monotonicamente crescente: em poucos meses o corte de 100 começa a esconder histórico, e tacar 1000 no limit só muda o número do problema pra depois.

A página também aceita `?date=YYYY-MM-DD` pra filtrar sessões de um dia específico (via `listSessionsByDate`). Paginação precisa **coexistir** com esse filtro — dentro de um dia, raramente há 25+ sessões, mas o caso precisa estar coberto pra não quebrar silenciosamente.

Já existe um pattern de paginação consolidado em `/search` (`app/search/page.tsx`): URL param `?offset=N`, `PAGE_SIZE=25`, prev/next Links que preservam outros params (`?q=`, `?days=`), componente interno `PaginationLink` que desabilita nos boundaries. Reusar o shape — consistência pro usuário + menos código novo.

### Decisões já travadas (locked antes da execução)

1. **Page size**: 25 (igual `/search`). Não exposto na UI por enquanto.
2. **URL shape**: `?offset=N` pra listagem; `?date=YYYY-MM-DD` continua como filtro. Ambos coexistem. Ausência de `offset` ⇒ página 1.
3. **Total count query**: `countSessions(db)` e `countSessionsByDate(db, date)` via `SELECT COUNT(*)`. Prepared statements adicionados ao `PreparedSet` existente em `lib/queries/session.ts`. Custo: uma passada na PK index — negligível em qualquer tamanho previsível.
4. **Navegação**: apenas prev/next (sem page numbers). Texto `N sessões · exibindo A–B`. Prev/next ganham `aria-label` explícito.
5. **Boundary behavior**:
   - `offset < 0` → clamp pra 0 (sem redirect; server trata silenciosamente).
   - `offset >= total` quando total > 0 → renderiza `items = []` + CTA "Voltar pra primeira página" (link preservando `date`).
   - `total === 0` → empty state atual (sem paginação) mantido inalterado.
6. **Ordenação**: mantém `ORDER BY started_at DESC` (mais recentes primeiro). Paginação avança no tempo pra trás.
7. **Signature breaking change**: `listSessions(db, limit)` vira `listSessions(db, { limit, offset })`. Único caller é `app/sessions/page.tsx` — migrado na mesma task que refatora a query.
8. **Sem scroll infinito** — stateless, URL-driven, SSR-friendly, grep-able URLs. Consistente com `/search`.
9. **Validação do `offset`**: parse via Zod `z.coerce.number().int().min(0).max(10_000)` na page. Valor fora do range cai no clamp (REQ-5).
10. **Perf / OFFSET**: `LIMIT/OFFSET` degrada com OFFSET alto. Em 61 rows é instantâneo; em 10k+ pode começar a pesar. Keyset pagination fica como follow-up explícito (seção "Out of scope") — não entra nesta spec.

## Requirements

- [ ] **REQ-1**: GIVEN o usuário acessa `/sessions` sem `?offset` e sem `?date` WHEN a página renderiza THEN exibe as primeiras 25 sessões ordenadas por `started_at DESC` + contagem total "N sessões" + controles de paginação quando `total > 25`.

- [ ] **REQ-2**: GIVEN o usuário acessa `/sessions?offset=25` (sem date) e há ≥50 sessões no DB WHEN a página renderiza THEN exibe sessões 26–50, label "exibindo 26–50 de N", e Prev/Next ambos habilitados.

- [ ] **REQ-3**: GIVEN `offset=0` WHEN renderiza THEN o link "Anterior" é renderizado como `<span>` visível com classe `opacity-40` (mesmo pattern do `/search` — desabilitado-mas-visível, não oculto). `aria-disabled="true"` + sem `href`.

- [ ] **REQ-4**: GIVEN `offset + pageSize >= total` (última página) WHEN renderiza THEN o link "Próxima" é desabilitado.

- [ ] **REQ-5a** (normalização silenciosa): GIVEN `?offset=-5` OR `?offset=abc` OR `?offset=1.5` OR `?offset=10001` (> max Zod) na URL WHEN a page server-renderiza THEN o valor é clampado para `0` sem banner nem redirect; a página 1 renderiza normalmente. Nenhum throw.

- [ ] **REQ-5b** (overflow explícito): GIVEN `?offset=N` válido (0 ≤ N ≤ 10000) mas `N >= total` AND `total > 0` WHEN renderiza THEN substitui a lista por um `<div>` com CTA "Voltar pra primeira página" (link para `/sessions` ou `/sessions?date=...` preservando `date` se presente). Paginação Prev/Next não renderiza nesta branch.

- [ ] **REQ-6**: GIVEN `?date=YYYY-MM-DD` filtra pra um dia com 3 sessões WHEN renderiza THEN exibe as 3 + contagem "3 encontradas". Paginação (Prev/Next) **não aparece** quando `total <= pageSize`.

- [ ] **REQ-7**: GIVEN `?date=YYYY-MM-DD&offset=25` e o dia filtrado tem 40 sessões WHEN renderiza THEN exibe sessões 26–40, label respeita total do dia ("exibindo 26–40 de 40"), e preserva `date` nos links Prev/Next.

- [ ] **REQ-8**: GIVEN `?date=2026-02-30` (inválido) WHEN renderiza THEN mantém comportamento atual: banner "Parâmetro date inválido — mostrando todas" + fallback na branch `all` paginada conforme REQ-1.

- [ ] **REQ-9**: `listSessions(db, opts?: { limit?: number; offset?: number })`. Defaults: `limit = 25`, `offset = 0`. Chamar `listSessions(db)` retorna as 25 mais recentes. `listSessionsByDate(db, { start, end, limit?, offset? })` com os mesmos defaults. Ambos reusam o cache WeakMap existente (prepared statements atualizados para `Statement<[number, number, number]>` / `Statement<[number, number, number, number]>`). O default `pageSize = 25` do `computePagination` é **independente** mas coincide com o default de `limit` — dois locais, mesmo valor, pra cada um ser self-contained.

- [ ] **REQ-10**: `countSessions(db): number` retorna `SELECT COUNT(*) FROM sessions`. `countSessionsByDate(db, { start, end }): number` retorna count no intervalo. Ambos via prepared statements adicionados ao `PreparedSet` existente em `lib/queries/session.ts`.

- [ ] **REQ-11**: Prev/Next Links têm:
   - Labels visíveis: `"← Anterior"` e `"Próxima →"` (texto idêntico ao `/search` pra consistência visual).
   - `aria-label="Página anterior de sessões"` / `aria-label="Próxima página de sessões"` nos `<a>` habilitados. Nos desabilitados (REQ-3/REQ-4), renderizar como `<span>` com `aria-disabled="true"` e mesmo `aria-label`.

- [ ] **REQ-12**: URL preserva `?date=` quando presente em toda navegação Prev/Next. Trocar filtro de data reseta `offset` implicitamente (user navega via link `?date=X` sem offset).

- [ ] **REQ-13**: Texto de contagem muda com a branch (e **não** aparece quando REQ-5b overflow substitui a lista):
   - Branch `all` sem filtro + `total <= pageSize`: `"N sessões"`.
   - Branch `all` sem filtro + `total > pageSize`: `"N sessões · exibindo A–B"`.
   - Branch `filtered` + `total <= pageSize`: `"N encontrada(s) em YYYY-MM-DD"` (já existente, preservado).
   - Branch `filtered` + `total > pageSize`: `"N encontrada(s) em YYYY-MM-DD · exibindo A–B"`.
   - Em overflow (REQ-5b), o texto de contagem permanece visível (usuário precisa saber quantas existem pra entender o overflow), mas a lista vira o CTA.

## Test Plan

### Unit Tests — `lib/analytics/pagination.ts` (helper puro)

Extrair pra um módulo pequeno pra ser testável sem touching DB. Input: `offset` bruto do searchParam + `total`. Output: `{ offset: number, pageSize: number, hasPrev: boolean, hasNext: boolean, rangeStart: number, rangeEnd: number, overflow: boolean }`.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `computePagination({ rawOffset: undefined, total: 100 })` | `offset:0, rangeStart:1, rangeEnd:25, hasPrev:false, hasNext:true, overflow:false` |
| TC-U-02 | REQ-2 | happy | `computePagination({ rawOffset: '25', total: 100 })` | `offset:25, rangeStart:26, rangeEnd:50, hasPrev:true, hasNext:true` |
| TC-U-03 | REQ-4 | edge | `computePagination({ rawOffset: '75', total: 100 })` última página cheia | `offset:75, rangeEnd:100, hasNext:false` |
| TC-U-04 | REQ-4 | edge | `computePagination({ rawOffset: '80', total: 100 })` última parcial | `offset:80, rangeEnd:100, hasNext:false` |
| TC-U-05 | REQ-5 | validation | `computePagination({ rawOffset: '-5', total: 100 })` | `offset:0, overflow:false` |
| TC-U-06 | REQ-5 | validation | `computePagination({ rawOffset: 'abc', total: 100 })` | `offset:0, overflow:false` |
| TC-U-07 | REQ-5b | edge | `computePagination({ rawOffset: '999', total: 100 })` overflow | `offset:999, overflow:true, hasPrev:true, hasNext:false, rangeStart:0, rangeEnd:0` (sem range quando overflow) |
| TC-U-08 | REQ-5 | edge | `computePagination({ rawOffset: '1.5', total: 100 })` non-integer | `offset:0` (floor via Zod coerce) |
| TC-U-09 | REQ-6 | edge | `computePagination({ rawOffset: undefined, total: 3 })` abaixo do pageSize | `hasPrev:false, hasNext:false` (sem controles) |
| TC-U-10 | REQ-6 | edge | `computePagination({ rawOffset: undefined, total: 0 })` vazio | `hasPrev:false, hasNext:false, rangeStart:0, rangeEnd:0` |
| TC-U-11 | REQ-1 | edge | `computePagination({ rawOffset: '25', total: 25 })` offset bate no total | `offset:25, overflow:true` (offset>=total && total>0) |
| TC-U-12 | REQ-1 | business | `computePagination({ rawOffset: '0', total: 25 })` primeira página exata | `hasNext:false, rangeEnd:25` |
| TC-U-13 | REQ-5a | validation | `computePagination({ rawOffset: '10001', total: 100 })` acima do max Zod | `offset:0` (clamp pós-Zod) |
| TC-U-14 | REQ-5a | edge | `computePagination({ rawOffset: '5', total: 0 })` offset > 0 em DB vazio | `offset:5, overflow:false` (total=0 short-circuit evita overflow CTA; página vazia natural) |

### Integration Tests — `lib/queries/session.test.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-9 | happy | `listSessions(db, { limit: 10, offset: 0 })` com 15 sessions seeded | retorna 10 (primeiras por `started_at DESC`) |
| TC-I-02 | REQ-9 | happy | `listSessions(db, { limit: 10, offset: 10 })` | retorna 5 (as 5 mais antigas das 15) |
| TC-I-03 | REQ-9 | edge | `listSessions(db, { limit: 10, offset: 100 })` acima do total | retorna `[]` |
| TC-I-04 | REQ-9 | edge | `listSessions(db)` defaults | retorna até 25 (todas se total ≤ 25) |
| TC-I-05 | REQ-10 | happy | `countSessions(db)` com 15 sessions | retorna `15` |
| TC-I-06 | REQ-10 | edge | `countSessions(db)` em DB vazio | retorna `0` |
| TC-I-07 | REQ-10 | happy | `countSessionsByDate(db, { start, end })` com 3 sessions no dia | retorna `3` |
| TC-I-08 | REQ-10 | edge | `countSessionsByDate(db, { start, end })` dia sem sessions | retorna `0` |
| TC-I-09 | REQ-9 | business | `listSessions(db, { limit: 5, offset: 5 })` preserva `cost_source` branch | rows retornadas têm `costSource` preenchido ('otel' \| 'calibrated' \| 'list') |
| TC-I-10 | REQ-7, REQ-9 | happy | `listSessionsByDate(db, { start, end, limit: 10, offset: 10 })` com 25 sessions no dia | retorna 10 (as sessões 11–20 do dia ordenadas DESC) |
| TC-I-11 | REQ-7 | edge | `listSessionsByDate(db, { start, end, limit: 10, offset: 30 })` com 25 sessions no dia | retorna `[]` |

### E2E Tests — `tests/e2e/sessions-pagination.spec.ts`

Seed precisa ter ≥26 sessions pra forçar paginação. Ajustar `tests/e2e/global-setup.ts` se seed atual não atende (hoje: `e2e-1/2/3/today/subagent/tool-trend` ≈ 6-7 sessões — **precisa expandir**). Alternativa: usar seed dedicado pra este spec, inserindo 30 sessões sintéticas `e2e-page-NN`.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1 | happy | Abrir `/sessions` com seed de ≥26 sessões | label "N sessões · exibindo 1–25", link "Próxima" visível + habilitado, "Anterior" desabilitado |
| TC-E2E-02 | REQ-2 | happy | Clicar "Próxima" em `/sessions` | URL vira `?offset=25`, label "exibindo 26–N", "Anterior" habilitado |
| TC-E2E-03 | REQ-6 | edge | Abrir `/sessions?date=YYYY-MM-DD` de um dia com 1 sessão no seed | label "1 encontrada em YYYY-MM-DD", nav de paginação **não** aparece |
| TC-E2E-04 | REQ-5 | validation | Abrir `/sessions?offset=-1` | renderiza primeira página (clamp silencioso), label "exibindo 1–25" |
| TC-E2E-05 | REQ-5 | edge | Abrir `/sessions?offset=9999` | CTA "Voltar pra primeira página" visível, lista vazia |
| TC-E2E-06 | REQ-12 | business | `/sessions?date=YYYY-MM-DD` (um dia com ≥26 sessões no seed — criar se não existir) + clicar "Próxima" | URL vira `?date=YYYY-MM-DD&offset=25`, preservando `date` |
| TC-E2E-07 | REQ-11 | happy | `/sessions` em página 1 — checar `getByRole('link', { name: /Próxima página/i })` exists e `getByRole('link', { name: /Página anterior/i })` resolve pra `<span>` com `aria-disabled="true"` | aria-labels presentes; desabilitado não é `<a>` |

## Design

### Architecture Decisions

1. **Helper puro `computePagination`** em `lib/analytics/pagination.ts`. Input:

   ```ts
   export type ComputePaginationInput = {
     rawOffset: string | undefined;
     total: number;
     pageSize?: number; // default 25
   };

   export type PaginationState = {
     offset: number;
     pageSize: number;
     hasPrev: boolean;
     hasNext: boolean;
     rangeStart: number; // 1-based start of current page; 0 when total=0
     rangeEnd: number; // 1-based end; 0 when total=0
     overflow: boolean; // offset >= total && total > 0
   };
   ```

   Zod parse interno:

   ```ts
   const schema = z.coerce.number().int().min(0).max(10_000).catch(0);
   const offset = schema.parse(rawOffset ?? 0);
   ```

   `.catch(0)` garante fallback silencioso pra qualquer input inválido (inclui strings não-numéricas e non-integers após coerce).

2. **Query signature change** — `listSessions(db, { limit, offset })`. SQL adicionado `OFFSET ?`:

   ```sql
   SELECT ... FROM sessions s
   LEFT JOIN session_effectiveness v ON v.id = s.id
   ORDER BY s.started_at DESC
   LIMIT ? OFFSET ?
   ```

   Prepared statement type vira `Statement<[number, number]>`. Único caller migra na mesma task (TASK-2).

3. **Nova query `countSessions`** reaproveita o PreparedSet:

   ```sql
   SELECT COUNT(*) AS c FROM sessions
   ```

   E `countSessionsByDate`:

   ```sql
   SELECT COUNT(*) AS c FROM sessions WHERE started_at >= ? AND started_at < ?
   ```

4. **`listSessionsByDate` ganha overload `{ start, end, limit, offset }`** (mesma mudança de shape). Default `limit: 25, offset: 0`. SQL adiciona `LIMIT ? OFFSET ?` ao prepared existente.

5. **UI — componente reutilizado**: `components/pagination-nav.tsx` extraído do pattern do `/search`. Props:

   ```ts
   type Props = {
     basePath: string;            // '/sessions'
     currentOffset: number;
     pageSize: number;
     total: number;
     preserveParams?: Record<string, string | undefined>; // e.g. { date: '2026-04-19' }
   };
   ```

   Renderiza Prev/Next com `aria-label` + estado desabilitado via `aria-disabled` + `<span>` em vez de `<a>` quando boundary. `/search` passa a consumir o mesmo componente (refactor suave — mesmas props, menos código duplicado).

6. **Empty-overflow state** em `/sessions`: renderizado no branch `all`/`filtered` quando `pagination.overflow === true`:

   ```tsx
   <div className="rounded border border-neutral-800 p-6 text-sm text-neutral-400">
     Nenhuma sessão nesta página.{' '}
     <Link href={firstPageHref} className="...">Voltar pra primeira página</Link>
   </div>
   ```

   `firstPageHref` preserva `date` se presente.

7. **Page refactor** (`app/sessions/page.tsx`):
   - Parse `offset` via helper.
   - Branch `all`: `total = countSessions(db)`; `items = listSessions(db, { limit: 25, offset })`.
   - Branch `filtered`: `total = countSessionsByDate(db, parsed)`; `items = listSessionsByDate(db, { start, end, limit: 25, offset })`.
   - Render `<PaginationNav />` quando `total > pageSize`.
   - `overflow` branch mostra CTA.

8. **Text composition** (REQ-13): centralizado em função pura `formatSessionsSubtitle(branch, pagination)` ou inline no componente — escolha inline pra evitar mais um helper; a lógica é small.

### Files to Create

- `lib/analytics/pagination.ts` — `computePagination`, tipos `PaginationState` / `ComputePaginationInput`.
- `lib/analytics/pagination.test.ts` — TC-U-01..13.
- `components/pagination-nav.tsx` — componente reusável Prev/Next (Server Component, puro Link-based).
- `tests/e2e/sessions-pagination.spec.ts` — TC-E2E-01..06.

### Files to Modify

- `lib/queries/session.ts` — refatorar `listSessions` pra `{ limit, offset }`; adicionar `listSessionsByDate` overload; adicionar `countSessions` + `countSessionsByDate`; atualizar `PreparedSet`.
- `lib/queries/session.test.ts` — novos TCs TC-I-01..09.
- `app/sessions/page.tsx` — integrar paginação, consumir total, renderizar `<PaginationNav />` + overflow CTA.
- `app/search/page.tsx` — migrar pra usar `<PaginationNav />` compartilhado (eliminar `PaginationLink` inline duplicado). **Nota de backward-compat**: zero behavior change no `/search`; só DRY.
- `tests/e2e/global-setup.ts` — seed auxiliar para garantir ≥26 sessões totais (criar `e2e-page-NN` fillers, se necessário). **Cuidado**: verificar se outros E2E existentes não dependem de contagens exatas de sessões.

### Dependencies

Zero new deps. Zod, better-sqlite3, Next.js já em uso.

## Tasks

- [x] **TASK-1**: Helper puro `lib/analytics/pagination.ts` com `computePagination` + tipos. Testes TC-U-01..13.
  - files: lib/analytics/pagination.ts, lib/analytics/pagination.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13

- [x] **TASK-2**: Refatorar `listSessions` pra `opts?: { limit?, offset? }`; adicionar `listSessionsByDate` mesma shape (preservando `start/end` obrigatórios); adicionar `countSessions` + `countSessionsByDate` no `PreparedSet`. Migrar o único caller direto (`app/sessions/page.tsx` — hoje chama `listSessions(db, 100)` em 2 lugares) pra nova signature passando `{ limit: 25, offset: 0 }` temporariamente (TASK-4 substitui pelo offset computado). **Atenção**: varrer o repo por outros callsites antes de finalizar — `grep -rn "listSessions\b"` em `app/`, `lib/`, `components/`, `tests/` — migrar todos. Testes TC-I-01..11.
  - files: lib/queries/session.ts, lib/queries/session.test.ts, app/sessions/page.tsx
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11

- [x] **TASK-3**: Componente `components/pagination-nav.tsx` (Prev/Next Server Component). Props: `basePath`, `currentOffset`, `pageSize`, `total`, `preserveParams`. `aria-label` nos links, `aria-disabled` + `<span>` nos boundaries.
  - files: components/pagination-nav.tsx
  - depends: TASK-1

- [x] **TASK-4**: Integrar paginação em `app/sessions/page.tsx` — consumir `computePagination`, `count*`, `listSessions({limit,offset})`, `listSessionsByDate({start,end,limit,offset})`, renderizar `<PaginationNav />` + overflow CTA + preservar `date`.
  - files: app/sessions/page.tsx
  - depends: TASK-1, TASK-2, TASK-3

- [x] **TASK-5**: Migrar `/search` pra consumir `<PaginationNav />` compartilhado (DRY). **Zero behavior change** — `tests/e2e/search.spec.ts` existente (TC-E2E-01..03) deve continuar verde sem alterações. Se algum TC quebrar, o refactor diverge — fix antes de prosseguir. Remover a função local `PaginationLink` de `app/search/page.tsx`.
  - files: app/search/page.tsx
  - depends: TASK-3

- [x] **TASK-6**: Seed E2E — garantir ≥26 sessões totais + pelo menos 1 dia com ≥26 sessões (pra TC-E2E-06). Inspecionar `tests/e2e/global-setup.ts`, adicionar fillers se necessário. Confirmar que outros E2E existentes não dependem de contagens exatas (revisão manual dos specs atuais).
  - files: tests/e2e/global-setup.ts
  - depends: TASK-4

- [x] **TASK-SMOKE**: E2E tests TC-E2E-01..07.
  - files: tests/e2e/sessions-pagination.spec.ts
  - depends: TASK-4, TASK-5, TASK-6
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07

## Parallel Batches

```text
Batch 1: [TASK-1]                   — helper puro, sem deps
Batch 2: [TASK-2, TASK-3]           — paralelo (queries vs componente; files disjuntos, ambos só precisam da TASK-1)
Batch 3: [TASK-4, TASK-5, TASK-6]   — paralelo (page.tsx /sessions vs /search vs seed E2E; files disjuntos)
Batch 4: [TASK-SMOKE]               — E2E final
```

File overlap analysis:

- `lib/analytics/pagination.ts` + `.test.ts`: exclusivo TASK-1.
- `lib/queries/session.ts` + `.test.ts`, `app/sessions/page.tsx` (inicial): exclusivos TASK-2.
- `components/pagination-nav.tsx`: exclusivo TASK-3.
- `app/sessions/page.tsx`: tocado por TASK-2 (migração de signature) e TASK-4 (integração de paginação). **Shared-mutative entre TASK-2 e TASK-4** — por isso TASK-4 está na Batch 3 depois da TASK-2 completar.
- `app/search/page.tsx`: exclusivo TASK-5.
- `tests/e2e/global-setup.ts`: exclusivo TASK-6 (shared-additive histórico com outras specs — hoje só esta task modifica).
- `tests/e2e/sessions-pagination.spec.ts`: exclusivo TASK-SMOKE.

Batch 3 é o único com paralelismo real — 3 worktrees disjuntos.

## Out of Scope (follow-ups explícitos)

- **Keyset pagination** (cursor-based, usando `(started_at, id)`). OFFSET degrada em tabelas gigantes; 61 rows não sente. Vira spec própria se/quando passar de ~10k sessions.
- **Page size configurável pela UI** (dropdown 10/25/50/100). Não pediram; 25 é bom default.
- **Scroll infinito / lazy-load**. Decisão travada: stateless + URL-driven.
- **Sorting custom (por custo, por turns)**. Fica fixo em `started_at DESC` por enquanto.

## Validation Criteria

- [ ] `pnpm typecheck` passa.
- [ ] `pnpm lint` passa.
- [ ] `pnpm test --run` passa (+13 TC-U + ~9 TC-I).
- [ ] `pnpm build` passa.
- [ ] `pnpm test:e2e` passa (+6 TC-E2E).

### Discipline Checkpoints (non-negotiable)

**Checkpoint 1 — Self-review REQ-by-REQ**: walk REQ-1..REQ-13 com evidência concreta (`file:line`, test name). Marcar ✅ / 🟡 / ❌ — nenhum partial silencioso.

**Checkpoint 2 — Live validation com dados reais**:

- `pnpm dev` em background.
- `curl http://localhost:3000/sessions` → HTTP 200, HTML contém label de contagem.
- Inspecionar HTML: header mostra "N sessões" onde N = `sqlite3 data/dashboard.db "SELECT COUNT(*) FROM sessions"`.
- Navegar manualmente: acessar `/sessions?offset=25` (se DB tem ≥26 sessions, senão criar com `pnpm seed-dev`). Verificar "exibindo 26–…".
- `/sessions?offset=9999` → CTA "Voltar pra primeira página" visível.
- `/sessions?offset=-1` → renderiza página 1 normal (clamp).
- Se DB tem um dia com múltiplas sessões: `/sessions?date=YYYY-MM-DD` + offset preserva date nos links.
- Parar dev server. `SIGTERM (exit 143)` esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — TASK-1 (2026-04-19 13:41)

`lib/analytics/pagination.ts` + `.test.ts` criados. Helper puro com Zod `z.coerce.number().int().min(0).max(10_000).catch(0)`, short-circuit em `total=0`, overflow branch quando `offset >= total && total > 0`. 15 TCs (TC-U-01..14 + 1 bonus custom pageSize).
TDD: RED(module-not-found) → GREEN(15/15) → REFACTOR(typecheck + lint clean).
