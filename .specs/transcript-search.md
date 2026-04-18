# Spec: Transcript Search — busca full-text em user_prompt + assistant_text

## Status: DONE

## Context

Hoje o dashboard lista sessões por custo/data mas não responde *"como eu resolvi aquele bug do auth há duas semanas?"*. O transcript inteiro está no DB (`turns.user_prompt`, `turns.assistant_text`), mas sem índice de texto a única saída é abrir sessão por sessão.

SQLite traz FTS5 nativo — uma virtual table espelha as colunas de `turns` e oferece `MATCH` com ranking BM25 e `snippet()` pra highlights. Custo zero em deps novas. A sincronização é feita via triggers nas escritas (`AFTER INSERT/UPDATE/DELETE ON turns`), garantindo que o índice nunca divergir dos dados.

A feature entrega:

- Página `/search` com input, resultados paginados e highlights
- Query server-side tipada, com janela temporal opcional
- API interna só pra Server Components (sem fetch do cliente ao SQLite)
- Navegação direto ao turn dentro da session detail (via anchor + scroll)
- Backfill FTS5 na migração pra popular dados já existentes

Shortcut `/` pra abrir busca e melhorias visuais ficam pra follow-up — o escopo aqui é a feature funcional completa mas sem atalhos globais (eles vêm junto com o item "Keyboard shortcuts" do roadmap).

## Requirements

- [ ] **REQ-1**: GIVEN o schema é aplicado por `migrate()` em um DB existente com turns WHEN `migrate()` completa THEN existe uma virtual table `turns_fts` usando FTS5 (tokenizer `unicode61 remove_diacritics 2`) contendo uma linha por turn com as colunas `user_prompt` e `assistant_text` sincronizadas.

- [ ] **REQ-2**: GIVEN `turns_fts` foi criada num DB já populado WHEN `migrate()` completa THEN `turns_fts` tem exatamente o mesmo `COUNT(*)` que `turns` (backfill idempotente).

- [ ] **REQ-3**: GIVEN triggers `trg_turns_ai`, `trg_turns_au`, `trg_turns_ad` existem WHEN uma linha é inserida/atualizada/deletada em `turns` THEN a linha correspondente em `turns_fts` é inserida/atualizada/deletada na mesma transação.

- [ ] **REQ-4**: GIVEN `searchTurns(db, { query, days, limit, offset })` é chamada com `query` não-vazia WHEN executada THEN retorna `{ items: SearchHit[], total: number }` onde `items` está ordenado por `bm25()` ascendente (melhor primeiro) e limitado por `limit`. `total` é o count de matches ignorando `limit`/`offset`.

- [ ] **REQ-5**: Cada `SearchHit` contém: `turnId`, `sessionId`, `project`, `sequence`, `timestamp`, `model`, `score` (bm25 rank), `promptSnippet` e `responseSnippet` (ambos strings, com marcadores `<mark>...</mark>` no match; snippet truncado a ~30 tokens com `...` nas bordas quando necessário).

- [ ] **REQ-6**: GIVEN `query` é vazia, só espaços em branco ou ≤ 1 caractere útil WHEN `searchTurns` é chamada THEN retorna `{ items: [], total: 0 }` sem tocar no DB (fast-path).

- [ ] **REQ-7**: GIVEN `query` contém caracteres especiais do MATCH (`"`, `:`, `*`, `(`, `)`, `AND`, `OR`, `NOT` em posição sintática) WHEN `searchTurns` é chamada THEN a query é sanitizada para um prefix-match seguro (cada termo `foo` vira `"foo"*`; operadores literais `AND`/`OR`/`NOT` vindos do usuário são tratados como termos, não como operadores FTS5). Queries maliciosas nunca lançam `SQLITE_ERROR`.

- [ ] **REQ-8**: GIVEN o filtro `days` é passado (> 0) WHEN a query é executada THEN apenas turns de sessões com `sessions.started_at >= (now - days * 86400000)` entram no resultado. Quando `days` é omitido, todas as sessões participam.

- [ ] **REQ-9**: GIVEN `limit` é omitido WHEN a query é executada THEN é aplicado o default de **25**; `limit` é clampado ao intervalo `[1, 100]`. `offset` default `0`, mínimo `0`.

- [ ] **REQ-10**: GIVEN o usuário navega para `/search?q=<texto>&days=<n>&page=<p>` WHEN a página renderiza THEN exibe: (a) input pré-populado com `q`; (b) controles de janela (`todas`, `7d`, `30d`, `90d`) — default `todas` quando `days` ausente; (c) lista de até 25 hits por página; (d) contagem total; (e) paginação prev/next respeitando `total`.

- [ ] **REQ-11**: Cada hit na UI mostra: nome do projeto, sequence + timestamp, snippet do prompt, snippet da resposta, link para `/sessions/<sessionId>#turn-<turnId>`.

- [ ] **REQ-12**: GIVEN o usuário clica num hit WHEN a session detail renderiza com o fragment `#turn-<turnId>` THEN o turn alvo recebe um destaque visual (ring/border) por ~2s após o scroll-into-view. Scroll deve acontecer mesmo em reload direto (âncora nativa do browser).

- [ ] **REQ-13**: `q` é validado por Zod no boundary da página: `string().trim().min(1).max(200)`. Acima do limite → retorna vazio com mensagem *"Consulta muito longa (máx. 200 caracteres)"*. Caracteres de controle são removidos.

- [ ] **REQ-14**: A API route `GET /api/search` é servida apenas a origens loopback (mesmo padrão de `/api/ingest`). É consumida só por Server Components — Client Components não chamam o DB.

- [ ] **REQ-15**: `searchTurns` usa prepared statement memoizado via WeakMap (padrão estabelecido nas outras queries). Sem `db.prepare(...)` per-call.

- [ ] **REQ-16**: GIVEN um turn é ingerido via `writeSession` WHEN o commit da transação ocorre THEN o trigger `trg_turns_ai` (ou `au` em reingest) popula `turns_fts` automaticamente sem código extra no writer.

## Test Plan

### Unit Tests — `lib/search/query.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-7 | happy | `sanitizeFtsQuery('auth bug')` | `'"auth"* "bug"*'` |
| TC-U-02 | REQ-7 | happy | `sanitizeFtsQuery('  foo   bar  ')` (extra whitespace) | `'"foo"* "bar"*'` |
| TC-U-03 | REQ-7 | security | `sanitizeFtsQuery('foo"); DROP TABLE')` | string sem `"`, `;`, ou `)` não balanceados; MATCH-safe |
| TC-U-04 | REQ-7 | security | `sanitizeFtsQuery('AND OR NOT')` (operadores sozinhos) | todos os tokens envolvidos em aspas (tratados como termo) |
| TC-U-05 | REQ-7 | edge | `sanitizeFtsQuery('foo*bar')` | operadores `*` removidos internamente; resultado `'"foobar"*'` OU `'"foo"* "bar"*'` (doc a escolha no helper) |
| TC-U-06 | REQ-6 | validation | `sanitizeFtsQuery('')` | `null` |
| TC-U-07 | REQ-6 | validation | `sanitizeFtsQuery('   ')` | `null` |
| TC-U-08 | REQ-6 | validation | `sanitizeFtsQuery('a')` (1 char) | `null` |
| TC-U-09 | REQ-13 | validation | `sanitizeFtsQuery('a'.repeat(300))` | trunca/respeita política (≤200 após trim) ou retorna `null` |
| TC-U-10 | REQ-7 | edge | Unicode: `sanitizeFtsQuery('café')` | `'"café"*'` (diacríticos preservados no token) |
| TC-U-11 | REQ-9 | happy | `normalizeLimit(undefined)` | `25` |
| TC-U-12 | REQ-9 | edge | `normalizeLimit(0)` | `1` |
| TC-U-13 | REQ-9 | edge | `normalizeLimit(200)` | `100` |
| TC-U-14 | REQ-9 | edge | `normalizeOffset(-5)` | `0` |

### Integration Tests — `lib/search/queries.test.ts` (nova) + `lib/db/migrate.test.ts` (possível update)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | infra | `migrate()` em DB novo cria virtual table `turns_fts` | `SELECT name FROM sqlite_master WHERE name='turns_fts'` retorna 1 linha |
| TC-I-02 | REQ-2 | infra | `migrate()` em DB com 5 turns já inseridos antes da virtual table | `SELECT COUNT(*) FROM turns_fts` == 5 |
| TC-I-03 | REQ-3 | happy | Insert em `turns` reflete em `turns_fts` | `SELECT rowid FROM turns_fts WHERE user_prompt MATCH 'foo'` encontra o turn |
| TC-I-04 | REQ-3 | happy | Update em `turns.user_prompt` reflete no índice | query antiga some, query nova acha |
| TC-I-05 | REQ-3 | happy | Delete em `turns` remove do índice | `COUNT(*)` decresce junto |
| TC-I-06 | REQ-4, REQ-5 | happy | `searchTurns(db, { query: 'auth' })` retorna hits ordenados por bm25 | items[0].score ≤ items[1].score; snippets contêm `<mark>` |
| TC-I-07 | REQ-5 | happy | Hit inclui `sessionId`, `project`, `sequence`, `timestamp`, `model` | todos os campos preenchidos |
| TC-I-08 | REQ-6 | validation | `searchTurns(db, { query: '' })` | `{ items: [], total: 0 }`; sem chamar prepare |
| TC-I-09 | REQ-6 | validation | `searchTurns(db, { query: '   ' })` | idem |
| TC-I-10 | REQ-7 | security | `searchTurns(db, { query: 'a"b\'c);DROP' })` não lança e retorna array (possivelmente vazio) | nunca throw |
| TC-I-11 | REQ-8 | business | Seed 3 sessões (2 recentes, 1 com 90d); `searchTurns({ query, days: 30 })` | apenas hits das 2 recentes |
| TC-I-12 | REQ-8 | happy | Sem `days` inclui todas | hits da sessão antiga presentes |
| TC-I-13 | REQ-9 | edge | `limit: 500` clampa pra 100 | `items.length ≤ 100` |
| TC-I-14 | REQ-9 | edge | `offset: 10` com 15 hits totais | `items.length === 5`, `total === 15` |
| TC-I-15 | REQ-4 | business | `total` independe de `limit`/`offset` | total retorna contagem real |
| TC-I-16 | REQ-15 | infra | Duas chamadas consecutivas reusam o prepared statement (WeakMap não reinicia) | `getPrepared` retorna o mesmo objeto |
| TC-I-17 | REQ-16 | infra | `writeSession` ingere um turn; turn vira pesquisável sem nenhum código no writer | `searchTurns` encontra |
| TC-I-18 | REQ-3 | edge | Turn com `user_prompt = NULL` e `assistant_text = 'xyz'` | pesquisável só pelo texto da resposta |
| TC-I-19 | REQ-5 | edge | Snippet truncado tem `...` quando match está no meio do texto | snippet contém `...` no prefixo ou sufixo quando aplicável |

### Integration Tests — API Route `tests/integration/search-route.test.ts` (nova)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-20 | REQ-14 | security | `GET /api/search` com Host não-loopback | 403 |
| TC-I-21 | REQ-14 | security | Host loopback, Origin maliciosa | 403 |
| TC-I-22 | REQ-13 | validation | Sem `q` ou `q` vazio | 400 com `{ error: { message, code: 'VALIDATION_ERROR' } }` |
| TC-I-23 | REQ-13 | validation | `q` com 201 chars | 400 |
| TC-I-24 | REQ-4 | happy | `q=auth` retorna shape `{ items, total }` | 200, items é array |
| TC-I-25 | REQ-9 | edge | `limit=9999` clampa | `items.length ≤ 100` |
| TC-I-26 | REQ-4 | idempotency | Duas chamadas idênticas retornam o mesmo resultado | deep equal |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-10, REQ-11 | happy | Acessar `/search?q=<termo presente no seed>` — heading, input, lista, link pra session | visíveis |
| TC-E2E-02 | REQ-6, REQ-10 | validation | `/search` sem `q` — input vazio, sem lista, mensagem "Digite um termo" | visível |
| TC-E2E-03 | REQ-12 | happy | Clicar num hit navega pra `/sessions/<id>#turn-<turnId>` e o turn tem destaque | destaque visível |

## Design

### Architecture Decisions

1. **FTS5 virtual table espelhando `turns`**, com `content=turns` e `content_rowid=turns.rowid`. Sem duplicação de texto — FTS5 referencia as colunas de `turns` diretamente (mode "contentless-delete" não é preciso; contentful é mais simples e não dobra o storage porque FTS5 não replica quando `content=` aponta pra tabela real).
2. **Sincronização por triggers**, não por código no writer. Três triggers (`AFTER INSERT`, `AFTER UPDATE OF user_prompt, assistant_text`, `AFTER DELETE`) garantem coerência mesmo quando o DB é manipulado fora do `writeSession` (ex: seed-dev, migrations futuras).
3. **Backfill idempotente em `migrate()`**: `INSERT INTO turns_fts(rowid, user_prompt, assistant_text) SELECT rowid, user_prompt, assistant_text FROM turns WHERE NOT EXISTS (SELECT 1 FROM turns_fts WHERE rowid = turns.rowid)`. Após o primeiro boot, esse `INSERT ... WHERE NOT EXISTS` vira no-op.
4. **Sanitização em TS, não em SQL**. Um helper `sanitizeFtsQuery(input: string): string | null` parseia a entrada do usuário, remove caracteres sintáticos, envolve cada termo em aspas e anexa `*` pra prefix-match. Retorna `null` quando a query é vazia depois da sanitização — o caller faz o fast-path sem tocar no DB.
5. **Tokenizer `unicode61 remove_diacritics 2`**. Remove acentos no índice e no query-side (via `snippet()`), então "café" casa "cafe" e vice-versa. É o tokenizer recomendado pra texto em PT/EN misturado.
6. **Snippets via `snippet()` nativo**. Formato: `<mark>` / `</mark>` como marcadores (delimiters '1' e '2' do FTS5), `'...'` como fallback, 30 tokens. UI aplica `dangerouslySetInnerHTML` APENAS no conteúdo do snippet — os marcadores são os únicos HTML permitidos, e o texto ao redor passa por sanitização que remove qualquer outra tag.
7. **Sanitização do snippet antes do render**: helper `renderSnippet(html: string): { __html: string }` que (a) escapa todo HTML via replace; (b) depois substitui somente as sequências literais `&lt;mark&gt;` / `&lt;/mark&gt;` por `<mark>` / `</mark>`. Garante zero XSS mesmo se o transcript contiver `<script>`.
8. **API route `/api/search` existe para simetria** com `/api/ingest` e `/api/ratings`, mas a página `/search` consome `searchTurns` **diretamente** como Server Component. A route é o contrato pra futuros callers (autocomplete, shortcut global) sem quebrar compatibilidade.
9. **URL-as-state**. Query + days + page viram query-string. Facilita bookmark, back/forward e deep-linking a partir de outras páginas.
10. **Âncora + highlight**. `id="turn-<turnId>"` no `<li>` do `TranscriptViewer`. Um Client Component pequeno lê `window.location.hash` no mount, faz `scrollIntoView({ block: 'center' })` e aplica classe `ring-2 ring-amber-400` por ~2s.
11. **Sem índices auxiliares em `turns` além do já existente** (`idx_turns_session`). FTS5 tem seu próprio índice invertido; o JOIN `turns_fts → turns → sessions` usa o PK já existente.

### Files to Create

- `lib/search/query.ts` — `sanitizeFtsQuery`, `normalizeLimit`, `normalizeOffset`, `renderSnippet`, tipo `SearchHit`
- `lib/search/query.test.ts` — testes unitários TC-U-01..14
- `lib/search/queries.ts` — `searchTurns(db, opts)` com prepared statements via WeakMap
- `lib/search/queries.test.ts` — testes de integração TC-I-01..19
- `app/api/search/route.ts` — Route handler (`GET`) chamando `searchTurns`, com Host/Origin allowlist
- `tests/integration/search-route.test.ts` — testes API TC-I-20..26
- `app/search/page.tsx` — Server Component com form (GET method), listagem de hits, paginação
- `app/search/loading.tsx` — skeleton simples
- `components/search/search-form.tsx` — Client Component com input + select de janela (controlled pela URL)
- `components/search/search-hit.tsx` — item da lista (Server Component — só texto + `dangerouslySetInnerHTML` controlado)
- `components/turn-scroll-to.tsx` — Client Component que lê `window.location.hash`, faz scroll e aplica highlight temporário

### Files to Modify

- `lib/db/schema.sql` — adicionar `CREATE VIRTUAL TABLE turns_fts USING fts5(...)` + 3 triggers + backfill via `INSERT ... WHERE NOT EXISTS`
- `lib/db/migrate.ts` — garantir que o backfill de `turns_fts` roda dentro da transação do migrate, ordem: exec(schema) → se `turns_fts` vazio e `turns` tem linhas, inserir; (pode ficar todo em `schema.sql` via `WHERE NOT EXISTS`)
- `components/transcript-viewer.tsx` — adicionar `id="turn-<turnId>"` ao `<li>` e renderizar `<TurnScrollTo />` no topo do componente
- `components/nav.tsx` — adicionar link `{ href: '/search', label: 'Busca' }`
- `tests/e2e/global-setup.ts` — garantir que o seed inclui turns com texto pesquisável distintivo (ex: "resolve auth bug in route handler")
- `tests/e2e/smoke.spec.ts` OU novo `tests/e2e/search.spec.ts` — TC-E2E-01..03

### Dependencies

Nenhuma nova. `better-sqlite3` (linkado contra SQLite 3.4x+) inclui FTS5. Zod já está instalado.

## Tasks

- [x] **TASK-1**: Helper `lib/search/query.ts` — `sanitizeFtsQuery`, `normalizeLimit`, `normalizeOffset`, `renderSnippet`, tipo `SearchHit`. Testes unitários cobrindo TC-U-01..14.
  - files: lib/search/query.ts, lib/search/query.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14

- [x] **TASK-2**: Schema FTS5 — adicionar virtual table `turns_fts`, triggers `trg_turns_ai/au/ad`, backfill idempotente via `INSERT ... WHERE NOT EXISTS` em `lib/db/schema.sql`. Verificar em `migrate.ts` que a ordem do `db.exec(sql)` + reconcile continua válida (a virtual table deve existir antes do reconcile pra que seus triggers executem em atualizações posteriores).
  - files: lib/db/schema.sql, lib/db/migrate.ts
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-17, TC-I-18

- [x] **TASK-3**: `searchTurns` em `lib/search/queries.ts` com `PreparedSet` + WeakMap; tipo `SearchHit` e `SearchResult`. Query compõe: CTE de FTS5 hits com `bm25()` + snippets, JOIN em `turns` e `sessions`, filtro opcional por janela temporal, `LIMIT/OFFSET`, `total` via count separado (ou `COUNT() OVER()` no mesmo SELECT se viável). Sanitização via `sanitizeFtsQuery` do TASK-1.
  - files: lib/search/queries.ts, lib/search/queries.test.ts
  - depends: TASK-1, TASK-2
  - tests: TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-19

- [x] **TASK-4**: API route `app/api/search/route.ts`. Zod schema de query string (`q`, `days?`, `limit?`, `offset?`), guard Host+Origin loopback, chama `searchTurns`, retorna `{ items, total }` ou `{ error: { message, code } }` no padrão do projeto.
  - files: app/api/search/route.ts, tests/integration/search-route.test.ts
  - depends: TASK-3
  - tests: TC-I-20, TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25, TC-I-26

- [x] **TASK-5**: Client Component `components/search/search-form.tsx`. Input controlado pela URL (via `useSearchParams` + `router.push`), select de janela (`todas`/`7d`/`30d`/`90d`), debounce ~250ms no submit. Acessível sem JS (form GET nativo como fallback).
  - files: components/search/search-form.tsx
  - depends: TASK-1

- [x] **TASK-6**: Componente `components/search/search-hit.tsx` + util de render de snippet seguro. Exibe projeto, sequence, timestamp, snippets com `<mark>`, link `/sessions/<sessionId>#turn-<turnId>`.
  - files: components/search/search-hit.tsx
  - depends: TASK-1

- [x] **TASK-7**: Página `app/search/page.tsx` (Server Component) + `app/search/loading.tsx`. Faz `await ensureFreshIngest()`, `searchTurns(db, { query, days, limit: 25, offset })`. Renderiza form + resultado + paginação. Lida com estado "vazio sem query" e "vazio com query".
  - files: app/search/page.tsx, app/search/loading.tsx
  - depends: TASK-3, TASK-5, TASK-6

- [x] **TASK-8**: Navegação e highlight. Adicionar link "Busca" em `components/nav.tsx`. Adicionar `id="turn-<turnId>"` ao `<li>` em `components/transcript-viewer.tsx`. Criar `components/turn-scroll-to.tsx` (Client Component) que lê hash, scrolla e aplica classe `ring-2 ring-amber-400 ring-offset-2 ring-offset-neutral-950` por 2s. Incluir o componente no topo do `TranscriptViewer`.
  - files: components/nav.tsx, components/transcript-viewer.tsx, components/turn-scroll-to.tsx

- [x] **TASK-SMOKE**: E2E. Criar `tests/e2e/search.spec.ts` cobrindo TC-E2E-01..03. Ajustar `tests/e2e/global-setup.ts` se o seed atual não tiver texto distintivo (ex: frase única como "resolver auth bug no route handler").
  - files: tests/e2e/search.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-7, TASK-8
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]               — foundation (helper puro + schema; files disjuntos)
Batch 2: [TASK-3]                       — query depende de ambos
Batch 3: [TASK-4, TASK-5, TASK-6]       — paralelos: route/form/hit (files disjuntos, todos prontos)
Batch 4: [TASK-7]                       — page integra form + hit + query
Batch 5: [TASK-8]                       — UI cross-file (nav + transcript-viewer + novo comp)
Batch 6: [TASK-SMOKE]                   — E2E final
```

File overlap analysis:

- `lib/search/query.ts`+`.test.ts`: exclusivo de TASK-1
- `lib/db/schema.sql`, `lib/db/migrate.ts`: exclusivos de TASK-2 (TASK-2 é o único que toca schema)
- `lib/search/queries.ts`+`.test.ts`: exclusivos de TASK-3
- `app/api/search/route.ts`, `tests/integration/search-route.test.ts`: exclusivos de TASK-4
- `components/search/search-form.tsx`: exclusivo de TASK-5
- `components/search/search-hit.tsx`: exclusivo de TASK-6
- `app/search/page.tsx`, `app/search/loading.tsx`: exclusivos de TASK-7
- `components/nav.tsx`: TASK-8 (shared-mutative se outro spec ativo o tocar — checar model-breakdown.active.md: não toca)
- `components/transcript-viewer.tsx`: TASK-8 (shared-mutative com futuros specs de transcript — hoje exclusivo)
- `components/turn-scroll-to.tsx`: exclusivo de TASK-8
- `tests/e2e/search.spec.ts`: exclusivo de TASK-SMOKE
- `tests/e2e/global-setup.ts`: shared-additive (outros specs também expandem seed) — TASK-SMOKE aplica sozinho

Batch 3 pode rodar em worktrees paralelos (API/form/hit são completamente disjuntos).

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos os TC-U + TC-I verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-01..03)
- [ ] `pnpm dev` → `/search?q=bug` retorna resultados em <200ms com DB real (1k+ turns)
- [ ] `/search` sem `q` renderiza form vazio sem warnings no console
- [ ] Clicar num hit navega e destaca o turn correto
- [ ] Reingestar um transcript (`pnpm ingest`) não duplica linhas em `turns_fts`
- [ ] `pnpm seed-dev` + rebuild do DB ainda passa (backfill idempotente)
- [ ] Auditar que snippets renderizados não carregam HTML além de `<mark>` — testar com um prompt seed contendo `<script>alert(1)</script>`

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1 (TASK-1 + TASK-2 paralelos) — 2026-04-18 15:53

Paralelizado via worktree agents (files disjuntos: `lib/search/` vs `lib/db/`).

**TASK-1** — `lib/search/query.ts` (5 exports: `SearchHit`, `sanitizeFtsQuery`, `normalizeLimit`, `normalizeOffset`, `renderSnippet`) + `lib/search/query.test.ts` (26 TCs incluindo TC-U-01..14 + XSS escape do snippet).
TDD: RED(module-not-found) → GREEN(26/26 passing) → REFACTOR(clean).

**TASK-2** — `lib/db/schema.sql` ganhou virtual table FTS5 `turns_fts` (external content, tokenizer `unicode61 remove_diacritics 2`) + triggers `trg_turns_ai/au/ad` + backfill idempotente via `INSERT INTO turns_fts(turns_fts) VALUES('rebuild')` (substituiu o `WHERE NOT EXISTS` sugerido no spec — no-op em external-content FTS5 porque `SELECT` proxia pro content table; `'rebuild'` é o primitivo documentado e idempotente). `lib/db/migrate.test.ts` criado com TC-I-01, 02, 03, 04, 05, 17, 18.
TDD: RED(7 failing — `no such table: turns_fts`) → GREEN(7/7 passing) → REFACTOR(clean).

**Merge + validação:** worktrees merged, cleanup executado. `pnpm typecheck` limpo. Full suite: 254/254 passing (+33 vs pré-batch).
