# Spec: Sub-agent Cost Attribution — custo por sub-agent dentro de uma sessão

## Status: DONE

## Context

Sessões longas do Claude Code frequentemente delegam trabalho a **sub-agents** (`Explore`, `Plan`, `code-reviewer`, `general-purpose`, custom-per-project) via a tool `Agent`. Hoje o dashboard contabiliza todo o spend da sessão como se fosse trabalho do main agent — sem distinção. A sessão `devtools-observability` (1035 turnos, 1676 linhas de transcript, 15 invocações de sub-agent) é o caso-guia: a maior parte do spend pode estar em sub-agents específicos, e não saber isso impede decisões de redução de custo ("será que posso trocar o Explore por algo mais barato?", "o code-reviewer está comendo 40% do orçamento?").

### Formato no transcript (confirmado por inspeção)

Quando o main agent delega, ele emite uma `assistant` turn cujo `message.content` inclui um `tool_use` block:

```json
{
  "type": "tool_use",
  "id": "toolu_01Qpo...",
  "name": "Agent",
  "input": {
    "subagent_type": "Explore",
    "description": "...",
    "prompt": "..."
  }
}
```

**Observação crítica:** `message.usage` dessa mesma turn contém os tokens que o **sub-agent** consumiu (não os que o parent gastou pra emitir o tool_use). Confirmado em exemplo real: `input_tokens=1, output_tokens=1916, cache_read_input_tokens=74485`. Ou seja, cada turn com um `tool_use(name=Agent)` representa 100% de custo daquele sub-agent. Não precisamos dividir custo entre parent e sub-agent dentro de uma mesma turn.

A resposta do sub-agent volta na próxima `user` turn como `tool_result` referenciando o `tool_use_id` original — essa turn não gera custo próprio (é só registro do retorno).

`isSidechain` é `false` mesmo em sub-agents: não há transcript separado pra rastrear.

### Estratégia

Persistimos `subagent_type` por turn (TEXT NULL; null = trabalho do main agent). Aggregação por sub-agent vira `GROUP BY subagent_type`. UI compacta no session detail. Dados pré-existentes permanecem como "Main" até re-ingest — documentamos como forçar backfill.

## Requirements

- [ ] **REQ-1**: GIVEN uma assistant turn cujo `message.content` contém um block `{ type: "tool_use", name: "Agent", input: { subagent_type: "Explore", ... } }` WHEN `parseTranscriptFile` processa esse arquivo THEN a `ParsedTurn` correspondente tem `subagentType = "Explore"`.

- [ ] **REQ-2**: GIVEN uma assistant turn SEM `tool_use.name === "Agent"` (ex: turn de texto puro, turn com `Bash`/`Read`/`Edit` apenas) WHEN parseada THEN `subagentType = null` (trabalho do main agent).

- [ ] **REQ-3**: GIVEN uma turn cujo `tool_use(name: "Agent")` tem `input.subagent_type` AUSENTE, não-string, string vazia, só whitespace, com caracteres de controle, OR com length > 64 após trim WHEN parseada THEN `subagentType = null` (não tenta inventar; trata como main). Warn via `onWarn` porque é formato inesperado. O limite de 64 chars é sanidade — nomes reais de sub-agent (visto em prod: `code-reviewer`, `general-purpose`, `security-reviewer`) ficam bem abaixo.

- [ ] **REQ-4**: GIVEN uma turn contém MÚLTIPLOS `tool_use(name: "Agent")` no mesmo `content` (edge case) WHEN parseada THEN `subagentType` é o valor do **primeiro** Agent-block em ordem de array. Documentado no código + warn emitido.

- [ ] **REQ-5**: GIVEN a tabela `turns` no schema SQLite WHEN `migrate()` completa em DB novo THEN a coluna `subagent_type TEXT` existe (nullable).

- [ ] **REQ-6**: GIVEN um DB pré-existente sem a coluna (ingerido antes desta feature) WHEN `migrate()` roda THEN `ALTER TABLE turns ADD COLUMN subagent_type TEXT` é executado uma vez; re-execuções do `migrate()` são no-op. Turns antigos ficam com `NULL` até serem re-ingeridos.

- [ ] **REQ-7**: GIVEN `writeSession` recebe `ParsedSession` com turns contendo `subagentType` WHEN executa o insert THEN a coluna `subagent_type` da tabela `turns` reflete o valor parseado (inclusive `null`). O `ON CONFLICT(id) DO UPDATE` também atualiza o campo (uma sessão re-ingerida pega valores novos).

- [ ] **REQ-8**: GIVEN `getSubagentBreakdown(db, sessionId)` é chamada WHEN a sessão tem ≥1 turn com `subagent_type != NULL` OR `>1` turn com `subagent_type = NULL` THEN retorna um array de `{ subagentType: string | null; turns: number; costUsd: number; outputTokens: number; pct: number }` onde `pct ∈ [0,1]` é a fração do custo total da sessão. **Ordenação**: a linha `null` (Main) vem SEMPRE em primeiro (anchor visual de base); as demais linhas vêm ordenadas por `cost_usd` decrescente. Inclui a linha `null` sempre que houver turns não atribuídos.

- [ ] **REQ-9**: GIVEN `getSubagentBreakdown` é chamada em sessão com 100% main (zero sub-agent) WHEN executa THEN retorna um array com uma única entrada `{ subagentType: null, pct: 1.0, ... }`. O componente UI decide se exibe ou oculta.

- [ ] **REQ-10**: GIVEN `getSubagentBreakdown` é chamada em sessão com `total_cost_usd = 0` (edge) WHEN executa THEN retorna `[]`. Fast-path pra evitar divisão por zero no `pct`.

- [ ] **REQ-11**: GIVEN `getSubagentBreakdown` é chamada em sessão inexistente OR sem turns WHEN executa THEN retorna `[]`.

- [ ] **REQ-12**: GIVEN o usuário navega para `/sessions/<id>` de uma sessão com `≥ 2` entradas no breakdown (i.e., ≥1 sub-agent foi invocado) WHEN a página renderiza THEN uma seção "Distribuição por agente" é exibida antes do `TranscriptViewer`. A seção lista Main + cada sub-agent com: label, turnos, custo, output tokens, % do spend. Ordenação: custo decrescente.

- [ ] **REQ-13**: GIVEN a sessão tem só main (resultado de breakdown com 1 entrada) WHEN a página renderiza THEN a seção "Distribuição por agente" é **omitida**.

- [ ] **REQ-14**: A query `getSubagentBreakdown` usa prepared statement memoizado via WeakMap (padrão das outras queries) — sem `db.prepare(...)` per-call.

- [ ] **REQ-15**: Backfill de dados existentes: adicionar na documentação (README ou comentário no migrate) a instrução `rm data/dashboard.db* && pnpm ingest` como caminho pra re-ingestar tudo com o novo campo. **Motivação da exigência do `rm`**: o `ingested_files(path, mtime_ms)` gate introduzido em `lib/ingest/writer.ts` pula todo arquivo cuja mtime não avançou desde o último ingest. Um `pnpm ingest` puro, sem invalidar o gate, seria no-op mesmo após a ALTER TABLE. O `rm data/dashboard.db*` limpa também `ingested_files`, forçando reprocessamento integral. Alternativas automáticas (schema_version + invalidação seletiva) ficam como Fase 2.

- [ ] **REQ-16** (Fase 2, opcional — flag `[NEEDS CLARIFICATION]` se entrar ou não agora): GIVEN a página `/effectiveness` em 30d WHEN renderiza THEN um novo cartão "Top sub-agents por spend" mostra os 5 sub-agents com maior custo agregado na janela. Flag essa como out-of-scope se o usuário preferir mínimo viável.

- [ ] **REQ-17**: Acessibilidade — a seção "Distribuição por agente" usa `<table>` semântica com `<thead>`/`<tbody>`/`<th scope="col">`, e inclui `<caption>` (pode ser `sr-only`) descrevendo "Custo agregado por agente na sessão". Valores numéricos com `tabular-nums`.

## Test Plan

### Unit Tests — `lib/analytics/subagent.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `extractSubagentType([{type:'tool_use',name:'Agent',input:{subagent_type:'Explore'}}])` | `'Explore'` |
| TC-U-02 | REQ-1 | happy | `extractSubagentType([{type:'tool_use',name:'Agent',input:{subagent_type:'code-reviewer'}}])` | `'code-reviewer'` |
| TC-U-03 | REQ-1 | happy | mescla: tool_use(Bash) + tool_use(Agent, Explore) + text | `'Explore'` (ignora Bash e text) |
| TC-U-04 | REQ-2 | happy | só text block | `null` |
| TC-U-05 | REQ-2 | happy | tool_use(Bash) / tool_use(Read) sem Agent | `null` |
| TC-U-06 | REQ-3 | validation | tool_use(Agent) sem `input` | `null`, warn emitido |
| TC-U-07 | REQ-3 | validation | tool_use(Agent) com `input.subagent_type` ausente | `null`, warn |
| TC-U-08 | REQ-3 | validation | tool_use(Agent) com `input.subagent_type` string vazia `""` | `null`, warn |
| TC-U-09 | REQ-3 | validation | tool_use(Agent) com `input.subagent_type: 42` (número) | `null`, warn |
| TC-U-10 | REQ-3 | validation | tool_use(Agent) com `input.subagent_type: "bad\x00name"` (controle) | `null`, warn |
| TC-U-11 | REQ-3 | edge | tool_use(Agent) com `input.subagent_type` com espaços nas pontas `"  Explore  "` | `'Explore'` (trimmed) |
| TC-U-12 | REQ-4 | edge | dois tool_use(Agent) consecutivos (Explore, Plan) | `'Explore'` (primeiro), warn sobre múltiplos |
| TC-U-13 | REQ-1 | edge | Unicode: `subagent_type: "análise-código"` | preservado literal |
| TC-U-14 | REQ-1 | edge | array vazio de content | `null` |
| TC-U-15 | REQ-1 | edge | content com blocks desconhecidos (type:"thinking" etc) + um Agent | `'Explore'` (ignora desconhecidos) |
| TC-U-16 | REQ-1 | edge | Case preservado: `subagent_type: "code-reviewer"` → `'code-reviewer'`; `"Explore"` → `'Explore'` | sem normalização |
| TC-U-17 | REQ-3 | validation | `subagent_type` com 65 chars (acima do limite) | `null`, warn emitido |
| TC-U-18 | REQ-3 | validation | `subagent_type` com exatamente 64 chars | string devolvida (valid max) |
| TC-U-19 | REQ-3 | validation | `subagent_type` com caracteres de controle internos `"Ex\nplore"` | `null`, warn |

### Integration Tests — `lib/ingest/writer.test.ts` + `lib/queries/session.test.ts` + novo `lib/queries/subagent.test.ts`

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-5 | infra | `migrate(fresh_in_memory_db)` → `PRAGMA table_info(turns)` contém `subagent_type TEXT` nullable | coluna presente |
| TC-I-02 | REQ-6 | infra | `migrate()` num DB pré-existente sem a coluna: (a) primeira execução adiciona; (b) segunda execução é no-op; (c) dados pré-existentes têm subagent_type = NULL | coluna adicionada uma vez |
| TC-I-03 | REQ-7 | happy | `writeSession` com turn contendo `subagentType='Explore'` | SELECT subagent_type FROM turns retorna 'Explore' |
| TC-I-04 | REQ-7 | happy | re-ingest mesma sessão com subagentType diferente: ON CONFLICT atualiza | valor final é o novo |
| TC-I-05 | REQ-7 | happy | `writeSession` com turn `subagentType=null` | coluna permanece NULL |
| TC-I-06 | REQ-8 | happy | `getSubagentBreakdown` em sessão com 2 turns main + 1 turn Explore (custos 3, 2, 5) | `[{type:null,cost:5,pct:0.5}, {type:'Explore',cost:5,pct:0.5}]` — Main primeiro, depois sub-agents por custo desc |
| TC-I-06b | REQ-8 | happy | sessão com Main + 3 sub-agents (Explore custo 10, Plan custo 5, code-reviewer custo 20) | `[Main, code-reviewer, Explore, Plan]` — Main anchor, depois cost desc |
| TC-I-07 | REQ-8 | business | breakdown soma de pct ≈ 1.0 (tolerância 1e-6) | `sum(pct) ≈ 1.0` |
| TC-I-08 | REQ-9 | edge | breakdown de sessão 100% main (3 turns, todos null) | 1 entrada `{type:null,pct:1.0}` |
| TC-I-09 | REQ-10 | edge | breakdown de sessão com total_cost=0 | `[]` |
| TC-I-10 | REQ-11 | edge | breakdown de sessionId inexistente | `[]` |
| TC-I-11 | REQ-11 | edge | breakdown de sessão existente mas sem turns | `[]` |
| TC-I-12 | REQ-8 | happy | breakdown inclui tokens agregados (sum output_tokens por grupo) | campo `outputTokens` preenchido corretamente |
| TC-I-13 | REQ-14 | infra | duas chamadas consecutivas a `getSubagentBreakdown` reusam o prepared statement | sem erro, tempo constante |
| TC-I-14 | REQ-1, REQ-7 | happy | pipeline end-to-end: parseTranscriptFile de JSONL com Agent tool_use → writeSession → SELECT | subagent_type persiste ponta-a-ponta |
| TC-I-15 | REQ-4 | edge | JSONL com turn contendo 2 Agent tool_uses (Explore + Plan) | DB guarda `'Explore'` (primeiro) |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-12 | happy | Seed session com Explore + code-reviewer → `/sessions/<id>` exibe "Distribuição por agente" + 3 linhas (Main, Explore, code-reviewer) | heading e linhas visíveis, sort desc |
| TC-E2E-02 | REQ-13 | happy | Session 100% main (seed padrão atual) → `/sessions/<id>` NÃO exibe a seção | heading ausente |
| TC-E2E-03 | REQ-12 | edge | Breakdown precede o TranscriptViewer e não o quebra | ambos visíveis, ordem correta |

## Design

### Architecture Decisions

1. **Campo por turn, não tabela separada.** Cada assistant turn tem no máximo um `subagent_type` relevante (ou null). Armazenar numa coluna em `turns` evita JOIN em queries quentes e mantém a natureza "ledger-like" da tabela.

2. **Atribuição 1:1 turn → sub-agent.** A `message.usage` do turn onde está o `tool_use(Agent)` já captura 100% do custo daquele sub-agent (empiricamente confirmado). Não precisamos particionar custo dentro de um turn nem espalhar custo pra turns seguintes.

3. **Extração em helper puro** — `lib/analytics/subagent.ts` exporta `extractSubagentType(content: unknown[]): string | null`. Recebe `message.content` (array de blocks) e retorna o subagent_type do primeiro `tool_use(name=Agent)` válido, ou null. Testável sem DB.

4. **Schema migration via ALTER TABLE** — SQLite suporta `ALTER TABLE ... ADD COLUMN` desde 2006. Em `migrate.ts`, detecta via `PRAGMA table_info(turns)` se a coluna existe; se não, executa ALTER. Idempotente.

5. **Schema source-of-truth em schema.sql** — o `CREATE TABLE turns (...)` declara `subagent_type TEXT` entre as colunas. Pra DB novo, basta o CREATE. Pra DB existente, o ALTER detecta a lacuna.

6. **Índice opcional** — `CREATE INDEX IF NOT EXISTS idx_turns_subagent ON turns(session_id, subagent_type)`. Útil pra GROUP BY em sessões grandes (devtools tem 1035 turns). Custo de storage desprezível.

7. **Backfill manual** — dados ingeridos antes desta feature têm `subagent_type = NULL`. Pra reclassificar: `rm data/dashboard.db* && pnpm ingest`. O per-file mtime gate não ajuda aqui porque o gate mira em detectar novidade no filesystem, não em invalidar o schema. Alternativa Fase 2: incrementar um `schema_version` e invalidar `ingested_files` quando version muda — fora do escopo inicial.

8. **UI: server-rendered table** — server component na session detail renderiza a seção direto; sem client component. O sort + pct já vem do server. Cores por linha: `neutral-400` para Main, `amber-300` para sub-agents. Linha Main sempre aparece (quando presente) pra dar comparação de base.

9. **Fase 2 (fora do escopo inicial) — KPI em /effectiveness.** `getTopSubagentsGlobal(db, days, limit)` agregaria across sessions. Adicionar quando o recurso básico estiver verde.

### Files to Create

- `lib/analytics/subagent.ts` — `extractSubagentType(content: unknown[]): string | null`, warnings opcionais
- `lib/analytics/subagent.test.ts` — TC-U-01..15
- `lib/queries/subagent.ts` — `getSubagentBreakdown(db, sessionId)` + tipo `SubagentBreakdownRow`
- `lib/queries/subagent.test.ts` — TC-I-06..13
- `components/subagent-breakdown.tsx` — Server Component renderizando a tabela

### Files to Modify

- `lib/ingest/transcript/types.ts` — adicionar `subagentType: string | null` em `ParsedTurn`
- `lib/ingest/transcript/parser.ts` — chamar `extractSubagentType` ao montar cada ParsedTurn
- `lib/db/schema.sql` — adicionar coluna `subagent_type TEXT` em `CREATE TABLE turns`, adicionar `CREATE INDEX IF NOT EXISTS idx_turns_subagent ON turns(session_id, subagent_type)`
- `lib/db/migrate.ts` — adicionar `backfillTurnsSubagentType(db)` (PRAGMA table_info + ALTER se ausente), chamado dentro do tx
- `lib/ingest/writer.ts` — incluir `subagent_type: t.subagentType ?? null` no turn row mapping; atualizar SQL do INSERT + ON CONFLICT
- `app/sessions/[id]/page.tsx` — chamar `getSubagentBreakdown` e renderizar `<SubagentBreakdown items={...} />`
- `lib/ingest/writer.test.ts` — adicionar TC-I-03, 04, 05, 14, 15
- `tests/e2e/global-setup.ts` — criar seed com sub-agents (ex: sessão "e2e-subagent" com turns Agent+Explore/Plan) e um turn Agent+code-reviewer. Manter sessão main-only existente pra TC-E2E-02
- `tests/fixtures/` — adicionar `sample-with-agent.jsonl` usado por TC-I-14 (contém 1 assistant turn com `tool_use(name=Agent, input.subagent_type=Explore)` + 1 turn main)
- `tests/e2e/subagent.spec.ts` — TC-E2E-01, 02, 03

Out of scope neste spec (deliberate): `lib/queries/session.ts` não ganha `TurnDetail.subagentType`. O breakdown é rendered a partir de uma query agregada separada, independente do viewer. Se quisermos destacar turns individuais no viewer, vira spec própria.

### Dependencies

Nenhuma nova. Tudo com libs já instaladas (better-sqlite3, zod, recharts se quisermos gráfico — texto/tabela é suficiente).

## Tasks

- [x] **TASK-1**: Helper puro `lib/analytics/subagent.ts` — `extractSubagentType(content: unknown[], onWarn?: (msg: string) => void): string | null`. Regras: `MAX_SUBAGENT_TYPE_LEN = 64` (constante), trim antes de validar, rejeita strings vazias/whitespace-only/com caracteres de controle/> 64 chars. Testes TC-U-01..19.
  - files: lib/analytics/subagent.ts, lib/analytics/subagent.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19

- [x] **TASK-2**: Schema FTS + índice — adicionar `subagent_type TEXT` em `CREATE TABLE turns` e `CREATE INDEX IF NOT EXISTS idx_turns_subagent ON turns(session_id, subagent_type)` em `lib/db/schema.sql`. Adicionar `backfillTurnsSubagentType(db)` em `lib/db/migrate.ts` com PRAGMA table_info + ALTER guarded. Chamar dentro da transaction existente. Testes TC-I-01, 02.
  - files: lib/db/schema.sql, lib/db/migrate.ts, lib/db/migrate.test.ts
  - tests: TC-I-01, TC-I-02

- [x] **TASK-3**: Ingestão ponta-a-ponta — adicionar `subagentType: string | null` em `ParsedTurn` (`lib/ingest/transcript/types.ts`), popular em `parser.ts` chamando `extractSubagentType`, escrever em `writer.ts` (incluir coluna no INSERT + ON CONFLICT). Criar fixture `tests/fixtures/sample-with-agent.jsonl` com 1 assistant turn contendo `tool_use(name=Agent, input.subagent_type="Explore")` + 1 turn main-only + user turns correspondentes. Testes TC-I-03, 04, 05, 14, 15 em `writer.test.ts`.
  - files: lib/ingest/transcript/types.ts, lib/ingest/transcript/parser.ts, lib/ingest/writer.ts, lib/ingest/writer.test.ts, tests/fixtures/sample-with-agent.jsonl
  - depends: TASK-1, TASK-2
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-14, TC-I-15

- [x] **TASK-4**: Query `getSubagentBreakdown` em `lib/queries/subagent.ts` com `PreparedSet` + WeakMap. Tipo `SubagentBreakdownRow = { subagentType: string | null; turns: number; costUsd: number; outputTokens: number; pct: number }`. **Ordenação específica**: Main (subagentType=null) primeiro, depois sub-agents por `costUsd DESC`. SQL agrega via `GROUP BY subagent_type` (SQLite trata NULL como grupo próprio); JS reordena pra colocar Main no topo. Fast-path pra total=0 e sessão inexistente. Testes TC-I-06, 06b, 07..13.
  - files: lib/queries/subagent.ts, lib/queries/subagent.test.ts
  - depends: TASK-2
  - tests: TC-I-06, TC-I-06b, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13

- [x] **TASK-5**: Componente `components/subagent-breakdown.tsx` — Server Component. Props: `items: SubagentBreakdownRow[]`. Renderiza `null` quando `items.length <= 1` (só Main → oculta). Caso contrário: heading "Distribuição por agente" + `<table>` semântica com `<caption class="sr-only">`, colunas Agente / Turnos / Custo / Tokens / %, valores `tabular-nums`. Imports: `fmtUsd`, `fmtCompact`, `fmtPct` de `@/lib/fmt`. Labels: "Main" quando subagentType=null; `{subagentType}` literal caso contrário. Cores: Main `text-neutral-400`, sub-agents `text-amber-300`.
  - files: components/subagent-breakdown.tsx
  - depends: TASK-4

- [x] **TASK-6**: Integrar na página — `app/sessions/[id]/page.tsx` chama `getSubagentBreakdown(db, id)` e renderiza `<SubagentBreakdown items={...} />` ANTES do `<TranscriptViewer />`. O componente cuida de hide quando aplicável.
  - files: app/sessions/[id]/page.tsx
  - depends: TASK-4, TASK-5

- [x] **TASK-7**: Atualizar seed E2E — `tests/e2e/global-setup.ts` ganha uma nova sessão `e2e-subagent` com (a) 1 turn inserido direto via SQL com `subagent_type='Explore'` e cost ≠ 0, (b) 1 turn com `subagent_type='code-reviewer'`, (c) 1 turn plain main (`subagent_type=NULL`). Seed insere direto na tabela `turns` (sem passar pelo parser), então só depende do schema da TASK-2. Manter seed existente (e2e-1 main-only) pra TC-E2E-02.
  - files: tests/e2e/global-setup.ts
  - depends: TASK-2

- [x] **TASK-SMOKE**: E2E. Criar `tests/e2e/subagent.spec.ts` cobrindo TC-E2E-01 (seção presente com ≥2 linhas e Main primeiro), TC-E2E-02 (seção ausente em main-only como e2e-1), TC-E2E-03 (breakdown renderiza ANTES do `<ol>` do TranscriptViewer no DOM — testar via `locator.evaluate(el => el.compareDocumentPosition(...))` ou by sequential matchers). Rodar `pnpm test:e2e`.
  - files: tests/e2e/subagent.spec.ts
  - depends: TASK-6, TASK-7
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]               — foundation (files disjuntos: lib/analytics/ vs lib/db/)
Batch 2: [TASK-3, TASK-4, TASK-7]       — paralelo (ingestão vs query vs seed; disjuntos após schema pronto)
Batch 3: [TASK-5]                       — componente isolado, depende só da query
Batch 4: [TASK-6]                       — integração na página
Batch 5: [TASK-SMOKE]                   — E2E final
```

File overlap analysis:

- `lib/analytics/subagent.ts` + `.test.ts`: exclusivo TASK-1
- `lib/db/schema.sql`, `lib/db/migrate.ts`, `lib/db/migrate.test.ts`: exclusivos TASK-2
- `lib/ingest/transcript/types.ts`, `parser.ts`, `lib/ingest/writer.ts` + `.test.ts`: exclusivos TASK-3
- `lib/queries/subagent.ts` + `.test.ts`: exclusivos TASK-4
- `components/subagent-breakdown.tsx`: exclusivo TASK-5
- `app/sessions/[id]/page.tsx`: exclusivo TASK-6
- `tests/e2e/global-setup.ts`: compartilhado com futuros specs (shared-additive histórico; hoje exclusivo TASK-7)
- `tests/e2e/subagent.spec.ts`: exclusivo TASK-SMOKE

Batch 1 pode rodar em worktrees paralelos (disjuntos). Batch 2 roda 3 worktrees em paralelo (ingest vs query vs seed — files completamente separados) após schema aplicado. TASK-6 foi movido pro Batch 4 solo porque depende do componente (TASK-5) da page.tsx.

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos os TC-U + TC-I verdes)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-01, 02, 03)
- [ ] `pnpm dev` → abrir uma sessão real com sub-agents (ex: devtools-observability se re-ingerida) mostra o breakdown; abrir uma sessão main-only não mostra
- [ ] Após `rm data/dashboard.db* && pnpm ingest` numa instalação usada, verificar que turns antigos ganham subagent_type correto quando eram Agent tool_use
- [ ] Auditar: warn emitido em turns malformados (subagent_type não-string) sem explodir o parser
- [ ] Índice `idx_turns_subagent` presente (via `sqlite3 data/dashboard.db '.schema turns'`)

## Open Questions

- **REQ-16 (KPI global em /effectiveness)**: entra nessa spec ou fica como spec separada Fase 2? [NEEDS CLARIFICATION] — sugiro deixar fora por enquanto (menor surface area), adicionar quando esta estiver green.
- **Custom sub-agents por projeto** (ex: `security-reviewer`, `data-reviewer` vistos neste projeto): o extrator os trata como strings arbitrárias — seu nome aparece direto na UI. OK ou queremos agrupar sob "Custom" / mostrar tooltip de descrição? Proposta: strings arbitrárias por enquanto, sem agrupar.
- **Coloring determinístico de sub-agents**: 4 cores fixas (Explore, Plan, code-reviewer, general-purpose) + fallback pros demais? Proposta: 1 cor (amber) pra todos, diferenciação por label + %. Evita explosão de paleta.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1 (TASK-1 + TASK-2 paralelos) — 2026-04-18 22:11

Paralelizado via worktree agents (files disjuntos: `lib/analytics/` vs `lib/db/`).

**TASK-1** — `lib/analytics/subagent.ts` (`extractSubagentType`, `MAX_SUBAGENT_TYPE_LEN=64`) + `lib/analytics/subagent.test.ts` (26 TCs cobrindo TC-U-01..19 + bonus TC-U-20 `input:null`, TC-U-21 non-array defensivo, MAX constant, no-callback safety).
TDD: RED(module-not-found) → GREEN(26/26) → REFACTOR(clean).

**TASK-2** — `lib/db/schema.sql` ganhou `subagent_type TEXT` em CREATE TABLE turns. `lib/db/migrate.ts` ganhou `backfillTurnsSubagentType(db)` com detecção via `PRAGMA table_info(turns)` + ALTER TABLE idempotente, chamado no tx existente entre `backfillOtelScrapesUnique` e `reconcileAllSessions`. `lib/db/migrate.test.ts` ganhou TC-I-01 (fresh DB tem coluna + índice) e TC-I-02 (legacy DB rebuild idempotente, sem perda de dados).
**Desvio documentado**: índice `idx_turns_subagent` foi movido de `schema.sql` pra dentro de `backfillTurnsSubagentType` — schema.sql re-roda em todo migrate; em legacy DB o CREATE TABLE IF NOT EXISTS turns é no-op, a coluna não existe ainda na hora do CREATE INDEX, e SQLite daria erro. Criando depois do ALTER garante comportamento correto em ambos os caminhos. Comentário no schema.sql documenta a razão.
TDD: RED(2 failing — coluna/índice undefined) → GREEN(9 passing no arquivo) → REFACTOR(clean).

**Merge + validação**: worktrees limpos. `pnpm typecheck` + `pnpm lint` limpos. Full suite: **339/339** (+60 vs pré-batch).
