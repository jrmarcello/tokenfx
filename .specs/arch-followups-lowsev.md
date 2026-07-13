# Spec: arch-followups-lowsev

## Status: DONE (pending commit)

## Context

Item 4.3 do `docs/execution-plan-2026-07.md` (Fase 4 — dívida arquitetural,
pós-apresentação). Dois follow-ups de baixa severidade da revisão:

### (a) Singleton SQLite vaza handles WAL sob HMR

[lib/db/client.ts:30-45](lib/db/client.ts) guarda o handle SQLite numa variável
module-level (`let singleton`). No dev server do Next, o **HMR recarrega o módulo**
a cada edição — a nova cópia do módulo começa com `singleton = null` e abre um novo
handle, enquanto o handle antigo (e seu writer WAL) **fica órfão, nunca fechado**.
Ao longo de uma sessão de dev longa isso acumula file descriptors e locks WAL
(sintoma: `SQLITE_BUSY` esporádico, `.db-wal` inchado).

**Prior art no próprio repo**: `lib/ingest/watcher.ts:119-120` já resolve
exatamente esse problema para o watcher, guardando o handle em
`globalThis.__tokenfxWatcher` (com `declare global { var __tokenfxWatcher: ... }`).
`globalThis` sobrevive ao HMR — o mesmo handle é reusado entre reloads. Aplicar o
mesmo padrão ao DB singleton.

### (b) Rate limiter in-memory do server sem premissa documentada

[apps/server/app/api/ingest/route.ts:59-73](apps/server/app/api/ingest/route.ts)
tem um rate limiter in-memory (`rateLimitBuckets = new Map`) por máquina/minuto. É
correto para deploy single-instance. O header JSDoc do route JÁ menciona a premissa
en passant (`route.ts:25`: "Single-instance v1 design — upgrade to Redis when
scaling out"), mas (i) **não há comentário inline adjacente ao `rateLimitBuckets`**
(o limiter de redeem `lib/queries/rate-limit.ts` documenta no ponto da declaração —
padrão a seguir) e (ii) **o README de operações do server não registra a premissa**.
Num deploy multi-réplica cada instância teria seu próprio Map → limite efetivo
`RATE_LIMIT × nº_de_réplicas`.

### Decisões já travadas

- **SQLite singleton**: mover para `globalThis.__tokenfxDb`, seguindo byte-a-byte o
  padrão do watcher. Preservar TODO o comportamento observável: re-key por
  `DASHBOARD_DB_PATH` (troca de path fecha o antigo e abre o novo), `migrate()` na
  criação, e `resetDbSingleton()` (usado por 7 arquivos de teste) fechando e
  limpando. Só a LOCALIZAÇÃO do estado muda (module-level → globalThis).
- **Rate limiter**: escopo é **documentar** a premissa single-instance (comentário no
  código + nota no README de operações), NÃO mover para Postgres/Redis (isso é uma
  spec maior — "honest scaling work", como o próprio comment do redeem-limiter diz).
- Sem mudança de API pública: `getDb()`, `openDatabase()`, `resetDbSingleton()`
  mantêm assinatura e semântica.

## Requirements

- [ ] REQ-1: GIVEN o DB singleton, WHEN `getDb()` é chamado, THEN o handle é
      armazenado em `globalThis.__tokenfxDb` (não em variável module-level), de modo
      que um reload do módulo (HMR) reuse o MESMO handle em vez de vazar o anterior.
- [ ] REQ-2: GIVEN o singleton no globalThis, WHEN `getDb()` é chamado duas vezes
      com o mesmo `DASHBOARD_DB_PATH`, THEN retorna a MESMA instância (idempotente).
- [ ] REQ-3: GIVEN um singleton existente para o path A, WHEN `DASHBOARD_DB_PATH`
      muda para B e `getDb()` é chamado, THEN o handle de A é FECHADO e um novo handle
      para B é aberto+migrado (re-key preservado, sem vazamento do antigo).
- [ ] REQ-4: GIVEN `resetDbSingleton()`, WHEN chamado, THEN o handle atual (se houver)
      é fechado e o estado no globalThis é limpo (`getDb()` subsequente reabre) — o
      contrato usado pelos 7 testes existentes permanece idêntico.
- [ ] REQ-5: GIVEN o rate limiter in-memory do ingest, THEN um comentário INLINE
      adjacente a `rateLimitBuckets`/`checkRateLimit` documenta a premissa
      single-instance (multi-réplica multiplicaria o limite efetivo → exigiria store
      compartilhado; cross-ref ao `rate-limit.ts` do redeem), E o README de operações
      do server registra a mesma premissa — sem mudança de comportamento. (O header
      JSDoc já menciona en passant; isto move a doc para o ponto da declaração +
      README.)

## Test Plan

Unit contra SQLite in-memory (`:memory:`) e um path temporário em scratch, mesmo
harness dos testes existentes que já usam `resetDbSingleton`. Novo arquivo
`lib/db/client.test.ts` (não existe hoje).

**Isolamento (obrigatório)**: `globalThis.__tokenfxDb` persiste entre arquivos de
teste no mesmo worker do vitest (é o objetivo do REQ-1). Portanto o novo
`client.test.ts` DEVE ter `beforeEach(() => resetDbSingleton())` E
`afterEach(() => resetDbSingleton())` em volta de TODOS os TCs — o mesmo padrão
belt-and-suspenders dos 7 consumidores existentes (`proxy.test.ts`,
`recompute-costs.test.ts`, etc.). Sem isso, um global vazado de outro arquivo
faria asserções passarem vacuamente. Cada TC de idempotência começa assertando
`globalThis.__tokenfxDb === undefined` antes do primeiro `getDb()`.

**Erros tipados**: o módulo não surface nenhum erro tipado (Result pattern N/A);
todas as falhas são edge (TC-U-06). Regra "todo erro tipado tem TC" vacuamente
satisfeita.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | após `beforeEach` reset (assert `globalThis.__tokenfxDb===undefined`), `getDb()` 2× com o mesmo path (via `DASHBOARD_DB_PATH` scratch) | retorna a MESMA instância (`===`) — idempotência ganha, não herdada |
| TC-U-02 | REQ-1 | business | após `getDb()`, `globalThis.__tokenfxDb` está setado com `{db, key}` | globalThis reflete o singleton (prova o armazenamento HMR-safe) |
| TC-U-03 | REQ-1 | edge | simular HMR: setar `globalThis.__tokenfxDb = { db: manualHandle, key }` manualmente, depois `getDb()` com o mesmo key | valor retornado `=== manualHandle` (igualdade de referência prova reuso sem abrir novo handle; o antigo não vaza) |
| TC-U-04 | REQ-3 | business | `getDb()` no path A, muda `DASHBOARD_DB_PATH` para B, `getDb()` de novo | `B !== A`; `A.open === false` (fechado no re-key); `B.open === true` (utilizável) |
| TC-U-05 | REQ-4 | happy | `getDb()`, guardar `oldHandle`, depois `resetDbSingleton()`; `getDb()` de novo com o MESMO key | `getDb()` reabre uma instância NOVA (`!== oldHandle`) — não devolve o handle fechado |
| TC-U-05b | REQ-4 | business | após `resetDbSingleton()`, asserções mecânicas independentes do `getDb()` seguinte | `globalThis.__tokenfxDb === undefined` E `oldHandle.open === false` (contrato: fecha E limpa o global — pega o bug "key stale apontando p/ handle fechado") |
| TC-U-06 | REQ-4 | edge | `resetDbSingleton()` sem singleton prévio | no-op, sem throw |
| TC-U-07 | REQ-3 | edge | sequência A→B→A rastreando cada handle | `firstA.open===false`, `B.open===false` (após 2ª troca), `secondA !== firstA` e `secondA.open===true` — cada troca fecha exatamente o handle substituído |
| TC-U-08 | REQ-1 | infra | `getDb({ migrate: () => { throw new Error('boom') } })` (deps seam) | rethrow `boom`; o handle recém-aberto foi FECHADO e `globalThis.__tokenfxDb === undefined` — sem órfão, sem handle unmigrated stale |
| TC-U-09 | REQ-5 | edge | grep-guard: comentário "single-instance"/"single instance" no MESMO bloco do `rateLimitBuckets` em `app/api/ingest/route.ts` (proximidade, não "em qualquer lugar do arquivo") | comentário inline presente perto do limiter |
| TC-U-10 | REQ-5 | edge | grep-guard: `apps/server/README.md` menciona "single-instance"/"single instance" na seção de rate-limit/operações | nota presente (a 2ª metade do REQ-5, hoje sem cobertura) |

## Design

### Architecture Decisions

1. **`lib/db/client.ts`** — substituir `let singleton` / `let singletonKey` por estado
   no `globalThis`, espelhando `watcher.ts` (tipo nomeado + JSDoc de por-quê-globalThis;
   **sem** `eslint-disable no-var` — o `watcher.ts` real não usa e linta limpo):

   ```ts
   /**
    * Stored on `globalThis` so it survives Next.js HMR reloads (and the RSC /
    * route / edge module-graph duplication) — a module-level `let` would leak
    * the old WAL handle on every reload. See arch-followups-lowsev.md.
    */
   type DbSingleton = { db: DB; key: string };
   declare global {
     var __tokenfxDb: DbSingleton | undefined;
   }

   // Optional deps seam (default = real migrate) so a test can inject a
   // throwing migrate without a mocking framework. `getDb()` (no args) is
   // unchanged — API-compatible per the locked decisions.
   export function getDb(deps: { migrate?: typeof migrate } = {}): DB {
     const migrateFn = deps.migrate ?? migrate;
     const key = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
     const existing = globalThis.__tokenfxDb;
     if (existing && existing.key === key) return existing.db;
     if (existing) existing.db.close();            // re-key: close the old handle
     const db = openDatabase(key);
     try {
       migrateFn(db);
     } catch (err) {
       // Migrate failed → close the just-opened handle and clear the global so
       // no orphaned WAL writer leaks and a stale/unmigrated handle can never
       // be handed back by a later getDb() with a matching key. Then rethrow.
       db.close();
       globalThis.__tokenfxDb = undefined;
       throw err;
     }
     globalThis.__tokenfxDb = { db, key };
     return db;
   }

   export function resetDbSingleton(): void {
     globalThis.__tokenfxDb?.db.close();
     globalThis.__tokenfxDb = undefined;
   }
   ```

   `openDatabase()` e o tipo `DB` ficam inalterados. Um único objeto
   `{ db, key }` no globalThis substitui as duas variáveis. A ordem
   close-then-set entre statements é segura sem lock: o event loop single-thread
   do Node nunca intercala chamadas de `getDb()` no meio da função. `db.open`
   (property boolean do better-sqlite3) é a API correta para "handle ainda
   utilizável" — usada nos TCs de re-key.
2. **`apps/server/app/api/ingest/route.ts`** — o header JSDoc (route.ts:24-26) já
   diz "Single-instance v1 design — upgrade to Redis when scaling out". **Consolidar,
   não duplicar**: adicionar um comentário INLINE direto acima de `rateLimitBuckets`
   (linha ~61) apontando para a premissa e cross-ref a `lib/queries/rate-limit.ts`
   (que documenta o mesmo no ponto da declaração). Deixar o header como está ou
   apontá-lo ao inline — uma fonte de verdade, sem dois textos inconsistentes.
   Adicionar uma nota curta na seção de operações do `apps/server/README.md`.
3. **Isolamento de teste**: depende do default `isolate: true` do Vitest (não há
   override de `pool`/`isolate` em `vitest.config.ts`) — cada arquivo de teste tem
   contexto/global fresco, então `globalThis.__tokenfxDb` NÃO vaza entre arquivos.
   Se o isolamento for desligado por velocidade no futuro, singletons em globalThis
   precisam de re-auditoria. (Dentro de um MESMO arquivo o global persiste entre TCs
   → daí o `beforeEach`/`afterEach` reset obrigatório no Test Plan.)
4. Sem mudança de dependências, schema, ou API.

### Files to Create

- `lib/db/client.test.ts` (TC-U-01..08) — com `beforeEach`/`afterEach` `resetDbSingleton()`
- `apps/server/app/api/ingest/rate-limit-doc.test.ts` (TC-U-09) — grep-guard puro (fs, sem PG)

### Files to Modify

- `lib/db/client.ts` — singleton no globalThis (tipo `DbSingleton`, migrate-safe try/catch, deps seam opcional)
- `apps/server/app/api/ingest/route.ts` — comentário inline de premissa single-instance junto ao `rateLimitBuckets` (TC-U-09)
- `apps/server/README.md` — nota de operações sobre o rate limiter in-memory (TC-U-10)

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: mover o DB singleton para `globalThis.__tokenfxDb` (padrão do watcher,
      tipo nomeado, migrate-safe, deps seam), preservando re-key e `resetDbSingleton`.
      O test file usa `beforeEach`/`afterEach` `resetDbSingleton()`.
  - files: lib/db/client.ts, lib/db/client.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-05b, TC-U-06, TC-U-07, TC-U-08
- [x] TASK-2: documentar a premissa single-instance do rate limiter do ingest
      (comentário inline junto ao `rateLimitBuckets` + nota no README) + grep-guards
  - files: apps/server/app/api/ingest/route.ts, apps/server/app/api/ingest/rate-limit-doc.test.ts, apps/server/README.md
  - tests: TC-U-09, TC-U-10

## Parallel Batches

Batch 1: [TASK-1, TASK-2]  — arquivos disjuntos (root client vs apps/server route+README), independentes

## Validation Criteria

- [ ] `pnpm typecheck` passa (raiz)
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (raiz + apps/server)
- [ ] `pnpm build` passa
- [ ] Os 7 testes existentes que usam `resetDbSingleton` continuam verdes (contrato
      preservado) — regression check explícito.
- [ ] Nenhum handle SQLite órfão: após a suíte, o comportamento de re-key/reset
      fecha todos os handles (validado por TC-U-04/05/07).

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-2] (2026-07-12)

Inline (arquivos disjuntos: root client vs apps/server route+README).

- TASK-1: `lib/db/client.ts` — singleton em `globalThis.__tokenfxDb` (tipo
  `DbSingleton`, JSDoc de por-quê-globalThis, sem eslint-disable), migrate-safe
  try/catch (fecha handle + limpa global + rethrow), deps seam opcional
  `getDb({migrate?})`. `resetDbSingleton` preservado. `client.test.ts` novo com
  reset em beforeEach+afterEach. TDD: RED(4 fail) → GREEN(9 pass). Regression:
  os 7 consumidores existentes + suíte raiz inteira verde (1274).
- TASK-2: comentário inline de premissa single-instance junto ao `rateLimitBuckets`
  ([route.ts]) + nota na seção "Rate limits" do README (cross-ref ao redeem limiter)
  e `rate-limit-doc.test.ts` (grep-guards de proximidade + README). GREEN(2 pass).

### Validação (2026-07-12)

- typecheck + lint limpos (raiz + apps/server).
- **suíte raiz 1274 passed / 6 skipped**; **apps/server 1526 passed / 11 skipped**.
- Live validation: N/A — mudança interna (singleton) + docs, sem superfície
  user-facing. O comportamento HMR é coberto por TC-U-03 (simulação: handle
  pré-setado no globalThis é reusado por igualdade de referência) e o re-key/reset
  por TC-U-04/05/05b/07 contra handles SQLite reais (`.open`).
