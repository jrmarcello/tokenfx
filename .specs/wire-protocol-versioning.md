# Spec: wire-protocol-versioning

## Status: DONE

## Context

Item 4.2 do `docs/execution-plan-2026-07.md` (Fase 4 — dívida arquitetural).

O wire de ingestão hoje é rígido em **v1** com zero tolerância a versão:

- `lib/reporter/types.ts:96` — `IngestEnvelope.version: 1` (tipo literal).
- `lib/reporter/runner.ts:494` — o reporter constrói `{ version: 1, ... }`.
- `apps/server/app/api/ingest/route.ts:82` — `Envelope` valida `version: z.literal(1)`
  dentro de um objeto `.strict()`.

**O problema (forward-compat):** quando o servidor central bumpar o protocolo (v2),
um reporter antigo enviando v1 — ou um reporter novo enviando v2 contra um servidor
antigo — cai no `Envelope.safeParse` que falha e retorna um **400 genérico**
("envelope validation failed") indistinguível de payload malformado. O client
([lib/reporter/client.ts:150](lib/reporter/client.ts)) trata **todo 4xx≠429 como
`permanent`** e **descarta o batch silenciosamente**. Resultado: um mismatch de
protocolo vira perda de dados sem sinal acionável ("atualize o reporter").

**O fix torna o PRIMEIRO bump de protocolo não-quebrável**: o servidor passa a
responder um erro estruturado `unsupported_version` com o range suportado, e o
client o distingue de um 4xx genérico — logando alto em vez de descartar cego.

### Prior art (padrões a seguir)

- Erro estruturado com `code`: o próprio route já usa
  `errorBody(message, code)` → `{error:{message, code?}}`
  (`route.ts` — ex. `errorBody('invalid credentials', 'unauthorized')`).
- Union discriminada de resultado no client: `PushBatchResult` já tem
  `{ok:true} | {ok:false, kind:'transient'} | {ok:false, kind:'permanent'}`
  (`client.ts:42-51`). Adicionar um 4º kind segue o padrão.
- Logger: `lib/logger.ts` (o client já usa `log.warn`/`log.error` no caminho de
  retries).

### Decisões já travadas

- **Single source of truth em `reporter/types.ts`**: exportar
  `WIRE_VERSION = 1` (o que o client ENVIA) e `WIRE_VERSION_MIN = 1` /
  `WIRE_VERSION_MAX = 1` (o range que o server ACEITA). O tipo
  `IngestEnvelope.version` continua `1` (o client só envia a versão corrente).
  `runner.ts` passa a usar `WIRE_VERSION` em vez do literal `1`.
- **Server**: valida `version` contra `[MIN, MAX]` ANTES da validação genérica do
  envelope. Fora do range OU não-inteiro/ausente → `unsupported_version`. A checagem
  de versão vem PRIMEIRO para que um mismatch de protocolo sempre ganhe de um erro
  de payload (o sinal certo é "atualize", não "payload inválido").
- **HTTP status = 400** (é erro do cliente), mas com body estruturado
  `{error:{code:'unsupported_version', message, supported_min, supported_max, received}}`.
  Manter 400 (não inventar um status novo) preserva o contrato de retry do client
  (4xx≠429 = permanent) — só adiciona o discriminador `code`.
- **Client**: detecta `body.error.code === 'unsupported_version'` num 4xx e retorna
  um kind NOVO `{ ok:false, kind:'unsupported_version', status, supportedMin,
  supportedMax, received }`. O client é uma lib pura-ish — **NÃO loga** aqui (evita
  double-log); só retorna a estrutura. Um 4xx sem esse code continua `permanent`.
- **Runner (orquestrador)**: `runner.ts` consome `pushBatch` (linha ~512, `if
  result.kind === 'transient'` + else que lê `result.body`). Adicionar um branch
  explícito `kind === 'unsupported_version'` que **loga `log.error` acionável**
  ("wire version X não suportada; range S..M; atualize o reporter") e **dropa o batch
  sem re-enfileirar** (retry nunca sucederia). É o ÚNICO logger deste evento. Sem esse
  branch o typecheck quebra (o novo kind não tem `.body`).
- **Ordem de checagem (trust boundary)**: o pre-check de versão vem ANTES do
  `Envelope.safeParse`, ou seja **após a checagem de FORMATO do header Authorization
  (`parseBearerAuthorization`) mas ANTES da verificação de CREDENCIAL** (`key_id`
  lookup + bcrypt, que hoje roda depois do safeParse). Logo um caller com um Bearer
  sintaticamente-válido-mas-falso pode sondar `supported_min/max` — mesmo já hoje com
  o 400 genérico. `supported_min/max` não é sensível (é contrato público de
  protocolo). Não é regressão; documentado para não superestimar a garantia de auth.
- **Sem mudança de PII ou schema.** O envelope continua `.strict()`.

## Requirements

- [ ] REQ-1: GIVEN `reporter/types.ts`, THEN exporta `WIRE_VERSION`,
      `WIRE_VERSION_MIN`, `WIRE_VERSION_MAX` (todos `1` hoje) como single source of
      truth do range do wire; `runner.ts` constrói o envelope com `WIRE_VERSION`
      (não o literal `1`).
- [ ] REQ-2: GIVEN o ingest route, WHEN o envelope chega com `version` DENTRO de
      `[MIN, MAX]` (i.e. `1`), THEN o comportamento é idêntico ao atual (parse
      normal, 200/rejeições existentes) — sem regressão.
- [ ] REQ-3: GIVEN `version` FORA de `[MIN, MAX]` (`0`, `2`, ...), WHEN o route
      valida, THEN retorna HTTP 400 com body
      `{error:{code:'unsupported_version', message, supported_min, supported_max, received}}`
      — a checagem de versão precede a validação genérica do envelope (um payload
      também malformado ainda retorna `unsupported_version`, não "validation failed").
- [ ] REQ-4: GIVEN `version` ausente ou não-inteiro (string, float, null), WHEN o
      route valida, THEN retorna `unsupported_version` (recebido reportado como o
      valor cru ou `null`) — não um 400 genérico.
- [ ] REQ-5: GIVEN o client recebe um 4xx com `body.error.code ===
      'unsupported_version'`, THEN retorna
      `{ ok:false, kind:'unsupported_version', status, supportedMin, supportedMax,
      received }` (via narrowing por Zod do `errBody` unknown) — NÃO descarta como
      `permanent` genérico. O client NÃO loga (o runner é o logger — REQ-7).
- [ ] REQ-6: GIVEN o client recebe um 4xx≠429 SEM esse code (ex. 400 de payload
      malformado, 401), THEN continua retornando `{ ok:false, kind:'permanent' }`
      (comportamento atual preservado).
- [ ] REQ-7: GIVEN `runner.ts` recebe `pushBatch` → `kind:'unsupported_version'`,
      THEN loga `log.error` com o range e a instrução de upgrade E dropa o batch sem
      re-enfileirar (mensagem DISTINTA do genérico "permanent push failure — dropped";
      compila sem erro apesar do novo kind não ter `.body`).

## Test Plan

Unit para os schemas/constantes e a lógica do client/runner (stubs de `fetch`
hand-written, sem mocking framework — padrão do `client.test.ts` existente).
Integração do route contra o handler real (padrão de `ingest.test.ts`).

**Nota de PG-gating**: os TCs do version pre-check (TC-I-02/03/05/06/06b/07/09a/09b)
retornam ANTES de qualquer acesso ao DB (o pre-check precede `Envelope.safeParse` e o
lookup de credencial). Não precisam de Postgres. Colocar num `describe` leve
SEM dependência de Testcontainers (ou, se estendendo o `ingest.test.ts` PG-gated,
extrair esses num bloco não-gated) para que rodem mesmo com `SKIP_PG_TESTS=1` —
é caminho de validação security-relevant que não deve sumir sem Docker. TC-I-01 e
TC-I-08 (fluxo v1 completo / payload malformado com credencial) permanecem PG-gated.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `WIRE_VERSION`, `WIRE_VERSION_MIN`, `WIRE_VERSION_MAX` exportados e coerentes (`MIN ≤ WIRE_VERSION ≤ MAX`) | valores `1/1/1`; invariante do range |
| TC-U-02 | REQ-1 | business | `runner.ts` constrói o envelope com `version === WIRE_VERSION` (não hardcode) | envelope.version === WIRE_VERSION |
| TC-U-03 | REQ-5 | business | client: resposta 400 com `{error:{code:'unsupported_version', supported_min:1, supported_max:1, received:2}}` | retorna `{ok:false, kind:'unsupported_version', supportedMin:1, supportedMax:1, received:2}`; client NÃO loga (REQ-7 é o logger) |
| TC-U-04 | REQ-6 | business | client: 400 com `{error:{message:'envelope validation failed'}}` (sem code) | retorna `{ok:false, kind:'permanent'}` (inalterado) |
| TC-U-05 | REQ-6 | edge | client: 401 com `{error:{code:'unauthorized'}}` | `kind:'permanent'` (só `unsupported_version` é especial) |
| TC-U-06 | REQ-5 | edge | client: 400 com `code:'unsupported_version'` mas body sem `supported_min/max` (servidor parcialmente incompatível) | kind `unsupported_version` com `supportedMin === null` E `supportedMax === null` (coerção `?? null` de undefined→null; nunca `undefined`, que violaria o tipo `number ou null`), sem throw |
| TC-U-07 | REQ-7 | edge | runner: `pushBatch` retorna `kind:'unsupported_version'` | `log.error` chamado com o range + instrução de upgrade (mensagem DISTINTA da genérica "permanent push failure — dropped"); batch NÃO re-enfileirado |

### Integration Tests (ingest route)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | POST com `version:1` + envelope válido + bearer válido | 200 (fluxo atual intacto) |
| TC-I-02 | REQ-3 | validation | POST com `version:2`, resto válido | 400, body `code:'unsupported_version'`, `supported_min:1`, `supported_max:1`, `received:2` |
| TC-I-03 | REQ-3 | validation | POST com `version:0` (MIN−1) | 400 `unsupported_version`, `received:0` |
| TC-I-04 | REQ-3 | business | POST com `version:2` E payload malformado (> 50 itens ou item inválido) | 400 `unsupported_version` (a versão PRECEDE a validação genérica — não "envelope validation failed") |
| TC-I-05 | REQ-4 | validation | POST com `version:"1"` (string) | 400 `unsupported_version`, `received === null` (não-number → null, conforme o ternário do Design) |
| TC-I-06 | REQ-4 | validation | POST com `version` ausente (key omitida) | 400 `unsupported_version`, `received === null` |
| TC-I-06b | REQ-4 | validation | POST com `version: null` EXPLÍCITO no JSON | 400 `unsupported_version`, `received === null` (path distinto de key-omitida em JS) |
| TC-I-07 | REQ-4 | edge | POST com `version:1.5` (float) | 400 `unsupported_version`, `received === 1.5` (é number → ecoa o cru; único caso onde `received ≠ null`) |
| TC-I-08 | REQ-2 | edge | POST com `version:1` mas payload malformado (item inválido) | 400 "envelope validation failed" (genérico — versão OK, payload não; NÃO unsupported_version) |
| TC-I-09a | REQ-3 | security | POST `version:2` SEM header Authorization (ou malformado) | **401 unauthorized** — a checagem de FORMATO do header (route.ts:107) short-circuita ANTES do body/versão; pina a precedência auth-format > version |
| TC-I-09b | REQ-3 | security | POST `version:2` com Bearer bem-formado mas `key_id` inexistente / secret errado | **400 unsupported_version** — o pre-check de versão precede a verificação de CREDENCIAL (DB lookup/bcrypt, que roda após o safeParse); mesma precedência do TC-I-04 |
| TC-I-10 | REQ-7 | edge | runner: pushBatch retorna `kind:'unsupported_version'` (via stub) | `log.error` acionável, batch dropado sem re-enfileirar (integração runner↔client) |

## Design

### Architecture Decisions

1. **`lib/reporter/types.ts`** — adicionar constantes:

   ```ts
   /** Wire protocol version this reporter emits. */
   export const WIRE_VERSION = 1 as const;
   /** Inclusive range of wire versions the central server accepts. */
   export const WIRE_VERSION_MIN = 1 as const;
   export const WIRE_VERSION_MAX = 1 as const;
   ```

   `IngestEnvelope.version` continua o literal `1` (o client só emite a corrente).
2. **`lib/reporter/runner.ts:494`** — trocar `version: 1` por `version: WIRE_VERSION`.
3. **`apps/server/app/api/ingest/route.ts`** — antes do `Envelope.safeParse`, extrair
   `version` do body cru com **narrowing por Zod** (NÃO `as` cast em `unknown` — viola
   a regra "no any, narrow unknown"; segue o precedente dos guards por-item do próprio
   route). Consolidar o shape do erro via `errorBody` estendido (ver abaixo):

   ```ts
   // `body` é unknown (route.ts). Zod narrowa com segurança.
   const rawVersion = z.object({ version: z.unknown() }).safeParse(body).data?.version;
   const receivedNumber = typeof rawVersion === 'number' ? rawVersion : null;
   if (
     receivedNumber === null ||
     !Number.isInteger(receivedNumber) ||
     receivedNumber < WIRE_VERSION_MIN ||
     receivedNumber > WIRE_VERSION_MAX
   ) {
     return NextResponse.json(
       errorBody(
         `unsupported wire version; this server accepts ${WIRE_VERSION_MIN}..${WIRE_VERSION_MAX}`,
         'unsupported_version',
         { supported_min: WIRE_VERSION_MIN, supported_max: WIRE_VERSION_MAX, received: receivedNumber },
       ),
       { status: 400 },
     );
   }
   // ...then the existing Envelope.safeParse (version now guaranteed in-range).
   ```

   O `Envelope` schema mantém `version: z.literal(1)` por ora (defense-in-depth;
   quando MAX subir, vira `z.number().int().min(MIN).max(MAX)` ou union). A ordem
   relativa ao auth check é preservada exatamente como está hoje (TC-I-09 documenta a
   ordem observada; não a altera).
3b. **`errorBody` estendido** — hoje `errorBody(message, code?)`. Estender para
   `errorBody(message, code?, extra?: Record<string, unknown>)` que faz spread de
   `extra` dentro de `{error:{...}}`, e rotear TANTO o `unsupported_version` QUANTO o
   "envelope validation failed" (que hoje hand-builda com `issues`) por ele — uma
   única fonte de shape de erro.
4. **`lib/reporter/client.ts`** — adicionar o 4º kind ao `PushBatchResult`:

   ```ts
   | { ok: false; kind: 'unsupported_version'; status: number;
       supportedMin: number | null; supportedMax: number | null;
       received: number | null }
   ```

   `errBody` é `unknown` (do `res.json().catch(()=>null)`) — **narrowing por Zod**,
   NÃO `errBody?.error?.code` cru (não compila sob strict):

   ```ts
   const UnsupportedVersionBody = z.object({
     error: z.object({
       code: z.string().optional(),
       supported_min: z.number().nullable().optional(),
       supported_max: z.number().nullable().optional(),
       received: z.number().nullable().optional(),
     }),
   });
   const uv = UnsupportedVersionBody.safeParse(errBody);
   if (uv.success && uv.data.error.code === 'unsupported_version') {
     log.error('wire version unsupported — upgrade the reporter', {
       supportedMin: uv.data.error.supported_min ?? null,
       supportedMax: uv.data.error.supported_max ?? null,
       received: uv.data.error.received ?? null,
     });
     return { ok: false, kind: 'unsupported_version', status: res.status,
       supportedMin: uv.data.error.supported_min ?? null,
       supportedMax: uv.data.error.supported_max ?? null,
       received: uv.data.error.received ?? null };
   }
   // ...else the existing `permanent`.
   ```

   `client.ts` hoje NÃO importa o logger — adicionar `import { log } from '@/lib/logger'`
   (confirmar o path relativo correto de `lib/reporter/`). Zod já é dep do módulo.
5. **Exaustividade dos callers**: grep todos os `pushBatch(` e `switch`/`if` sobre
   `result.kind` (ex.: `runner.ts`) — se houver `switch` com fallback `never`, ele
   compila-falha ao ver o novo kind (bom), e deve ganhar um branch `unsupported_version`
   explícito (logar/alertar, não silenciar). Incluir os call sites em Files to Modify.
6. Sem dependências, schema, ou auth novos.

### Files to Modify

- `lib/reporter/types.ts` — constantes `WIRE_VERSION*`
- `lib/reporter/types.test.ts` — se existir (senão criar) TC-U-01
- `lib/reporter/client.ts` — novo kind + detecção do code (narrowing Zod), SEM log
- `lib/reporter/client.test.ts` — TC-U-03..06
- `lib/reporter/runner.ts` — usa `WIRE_VERSION` (TASK-1) + branch `unsupported_version` que loga e dropa (TASK-4)
- `lib/reporter/runner.test.ts` — TC-U-02 (envelope usa WIRE_VERSION) + TC-U-07/TC-I-10 (handling do novo kind); criar se não existir
- `apps/server/app/api/ingest/route.ts` — pre-check de versão + `errorBody` estendido. Inserir o pre-check **imediatamente antes de `const env = Envelope.safeParse(body);`** (após o try/catch do `req.json()`) — ancorar por símbolo, não por linha (drifta)
- `apps/server/tests/integration/ingest.test.ts` — TC-I-01, TC-I-08 (PG-gated); os demais version-guard TCs num bloco não-gated

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: constantes `WIRE_VERSION*` em `types.ts` + `runner.ts` usa `WIRE_VERSION`
  - files: lib/reporter/types.ts, lib/reporter/runner.ts, lib/reporter/types.test.ts, lib/reporter/runner.test.ts
  - tests: TC-U-01, TC-U-02
- [x] TASK-2: pre-check de versão no ingest route (erro estruturado
      `unsupported_version` via `errorBody` estendido)
  - files: apps/server/app/api/ingest/route.ts, apps/server/tests/integration/ingest.test.ts
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-06b, TC-I-07, TC-I-08, TC-I-09a, TC-I-09b
- [x] TASK-3: novo kind `unsupported_version` no client (detecção via narrowing Zod,
      SEM log)
  - files: lib/reporter/client.ts, lib/reporter/client.test.ts
  - depends: TASK-1
  - tests: TC-U-03, TC-U-04, TC-U-05, TC-U-06
- [x] TASK-4: `runner.ts` — branch `unsupported_version` (log.error acionável + drop
      sem re-enqueue) para consumir o novo kind sem quebrar o typecheck
  - files: lib/reporter/runner.ts, lib/reporter/runner.test.ts
  - depends: TASK-3
  - tests: TC-U-07, TC-I-10

## Parallel Batches

Batch 1: [TASK-1]         — foundation (constantes; ambos os lados dependem)
Batch 2: [TASK-2, TASK-3] — route (server) ∥ client (root) — arquivos disjuntos
Batch 3: [TASK-4]         — runner consome o novo kind (depende do contrato do client)

## Validation Criteria

- [ ] `pnpm typecheck` + `pnpm lint` passam (raiz + apps/server)
- [ ] `pnpm test --run` passa (raiz + apps/server)
- [ ] `pnpm build` passa
- [ ] **Live validation**: subir apps/server (Postgres descartável) + POST via curl:
      (a) `version:1` válido → 200; (b) `version:2` → 400 com
      `code:"unsupported_version"` e `supported_min/max`; (c) `version` ausente → mesmo.
      Confirma o contrato de wire ao vivo.
- [ ] Regressão: o fluxo v1 existente (ingest.test.ts) permanece verde.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### TASK-1 (2026-07-12)

TDD: RED(2) → GREEN(2) — WIRE_VERSION/MIN/MAX em types.ts (single source); runner.ts constrói envelope com `version: WIRE_VERSION` (value import). TC-U-01 (range coerente) + TC-U-02 (envelope usa a constante).

### Batch [TASK-2, TASK-3] (2026-07-12)

Executado inline (arquivos disjuntos: apps/server route vs root client).

- TASK-2: pre-check de versão precede `Envelope.safeParse` e a checagem de credencial; `errorBody(message, code?, extra?)` estendido; retorna `{error:{code:'unsupported_version', supported_min, supported_max, received}}` 400. TCs de pre-check num describe NÃO-gated (rodam sem Postgres) + TC-I-08 gated. TDD: RED → GREEN(9 no-PG + TC-I-08).
- TASK-3: 4º kind `unsupported_version` no `PushBatchResult` via narrowing Zod (`UnsupportedVersionBody`, `?? null`); client NÃO loga. TDD: RED(4) → GREEN(4) (TC-U-03..06).

### TASK-4 (2026-07-12)

TDD: RED(1) → GREEN(1) — branch `unsupported_version` no runner (log.error "upgrade the reporter" acionável, `failed += chunk.length`, sem enqueue, sem mark). TC-U-07/TC-I-10 via stub de `log.error` por mutação de propriedade. Precede a branch permanent (que lê `result.body`) — sem quebra de typecheck.

### Validation (2026-07-12)

Root: `pnpm test --run lib/reporter/*` → 33 passed. apps/server: `vitest run ingest.test.ts` → 33 passed (com Postgres/Testcontainers), 9 no-PG. typecheck limpo em ambos os lados.
