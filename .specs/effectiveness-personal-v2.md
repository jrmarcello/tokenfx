# Spec: Personal Effectiveness v2 — métricas de uso de IA, não só consumo

## Status: DONE

## Context

O dashboard hoje (`/`) responde "quanto eu gastei?" e tem sinais finos de efetividade
(`cache_hit_ratio`, `output_input_ratio`, rating manual, scoring composto via
`effectivenessScore`). O que falta é responder **"estou usando bem? estou
melhorando?"**. As perguntas concretas que viram requirements:

1. Qual é o meu padrão de exploração antes de agir? (`tokens_until_first_edit`)
2. Estou desperdiçando contexto re-lendo arquivos que já estão em cache? (`reread_count`)
3. Quanto de retrabalho via tools quebradas? (`tool_error_rate` por sessão)
4. Estou explorando demais e editando de menos? (`reads_to_edits_ratio`)
5. Compactação está sendo gatilhada? (sessão estourou contexto)
6. O quanto eu delego pra sub-agents? (`subagent_usage_ratio`)
7. Quanto custo correlaciona com rating? (scatter cost × rating)
8. Como minhas sessões "boas" diferem das "ruins"? (insight panel)

### O que já existe que NÃO duplicamos

| Já temos                                                              | Onde                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `effectivenessScore` (cache, output/input, rating, corrections, errors, accept) | `lib/analytics/scoring.ts`                                            |
| `getSessionScores`, `getSessionScoreDistribution`, `getEffectivenessKpis` | `lib/queries/effectiveness.ts`                                        |
| `getToolErrorTrend` semanal por tool                                   | `lib/queries/effectiveness.ts` + `lib/analytics/tool-trend.ts`        |
| `getSubagentUsage` (sessions com Agent / total)                        | `lib/queries/effectiveness.ts`                                        |
| `getSubagentBreakdown` (cost por subagent na sessão)                   | `lib/queries/subagent.ts`                                             |
| Calendar heatmap por **spend** (52×7)                                  | `components/overview/activity-heatmap.tsx` + `lib/analytics/heatmap.ts` |
| `correctionPenalties` (regex de "no/erro/issue" no user prompt)        | `lib/analytics/scoring.ts`                                            |
| Schema com `tool_calls.input_json` (Read/Edit args incluem `file_path`) | `lib/db/schema.sql`                                                   |

### O que **não** existe (decisões locked)

- **Compaction não é capturada hoje.** `parser.ts:37` define
  `CONSUMED_TYPES = Set(['user','assistant'])` — entradas `system/compact_boundary`
  são ignoradas silenciosamente. Confirmado em transcrito real
  (`562f31db-…jsonl`): linhas com `"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":968559,"postTokens":16672,…}`.
  **Esta spec adiciona ingestão**: tabela nova `compaction_events` com PK composta
  `(session_id, source_file, sequence_in_file)`, populada por parser/writer. Cada
  evento vira uma row carregando `trigger`, `pre_tokens`, `post_tokens`, `ts` —
  habilita não só count agregado mas markers no timeline futuramente. Decisão
  de tabela vs coluna acumulativa no Design §2 (a coluna foi rejeitada por bug
  de double-count em re-ingest após rotation).
- **Rota `/effectiveness` não existe**: componentes estão em `/` (unified dashboard).
  Mantemos isso e criamos uma **nova rota `/effectiveness`** dedicada, segregando
  análise profunda do overview (consumo). Decisão deliberada: o overview já está
  denso; adicionar 4 visualizações novas lá vira muito barulho.
- **Re-reads / tokens-até-primeiro-edit / reads-to-edits**: query-time only via
  `json_extract(input_json, '$.file_path')` em `tool_calls`. SQLite suporta
  `json_extract` nativo (já usado em `lib/queries/otel.ts`). Sessões de ~5k turns
  têm tipicamente <500 tool_calls; a query é I/O bound, não CPU.
- **Calendar heatmap colorido por effectiveness**: variante do componente
  existente. NÃO substitui — coexiste com o de spend (`/` continua spend-color,
  `/effectiveness` ganha o effectiveness-color). Reuso máximo de
  `lib/analytics/heatmap.ts` (`computeLevels`, `arrangeWeeks`, `monthLabels`,
  `parseDateParam`).

### Coerência com outras specs

- `outcome-integration-git` (mencionada no input do usuário) **não é dependência**.
  Quando ela ship, o funnel pode adicionar estágios "→ commit → merge → not-reverted";
  hoje fica "started → ≥1 Edit → cache_hit > median → low tool_error_rate".
- `session-timeline-heatmap` (DONE): reusamos os helpers e adicionamos uma
  segunda instância colorida por score, sem mexer na primeira.

## Requirements

### Ingestão — compaction

> **Decisão arquitetural [LOCKED 2026-04-28]**: eventos de compaction viram **rows** numa tabela nova `compaction_events`, NÃO uma coluna acumulativa em `sessions`. Razão: a coluna acumulativa (proposta inicial) tem bug de double-count em re-ingest de arquivo após rotation (`sessions.source_file` é a "última seen", então `excluded.source_file != sessions.source_file` dispara soma indevida quando se re-ingere um arquivo antigo). Tabela própria com PK `(session_id, source_file, sequence_in_file)` torna re-ingest idempotente naturalmente, multi-file vira múltiplas rows somáveis, e abre porta para surfaces futuras (timeline marker, etc) sem refactor.

- [ ] **REQ-1**: GIVEN um JSONL contém ≥1 entrada `{"type":"system","subtype":"compact_boundary","compactMetadata":{…},"timestamp":…}` WHEN `parseTranscriptString` processa o arquivo THEN o `ParsedSession` retornado expõe `compactionEvents: Array<CompactionEvent>`, onde cada item tem `{ sequence_in_file: number, trigger: string | null, pre_tokens: number | null, post_tokens: number | null, ts: number }`. `sequence_in_file` é o índice 0-based do compact_boundary no arquivo (entre os compact_boundary, não entre todas as linhas). `trigger`, `pre_tokens`, `post_tokens` saem de `compactMetadata` quando presente; null caso contrário. `ts` é `Date.parse(timestamp) || Date.now()` (fallback). Para JSONL sem nenhuma entrada: `compactionEvents = []`.

- [ ] **REQ-2**: GIVEN uma entrada com `type:"system"` mas `subtype` diferente de `"compact_boundary"` (ex: `"info"`, ausente, número) WHEN parseada THEN NÃO produz item em `compactionEvents`. Outros subtypes do canal `system` continuam ignorados pelo parser (status quo). O coletor observa estritamente `subtype === "compact_boundary"` antes do filtro `CONSUMED_TYPES`.

- [ ] **REQ-3**: GIVEN o schema SQLite WHEN `migrate()` roda em DB novo THEN a tabela `compaction_events` existe via `CREATE TABLE IF NOT EXISTS`:

  ```sql
  CREATE TABLE IF NOT EXISTS compaction_events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_file TEXT NOT NULL,
    sequence_in_file INTEGER NOT NULL,
    trigger TEXT,
    pre_tokens INTEGER,
    post_tokens INTEGER,
    ts INTEGER NOT NULL,
    PRIMARY KEY (session_id, source_file, sequence_in_file)
  );
  CREATE INDEX IF NOT EXISTS idx_compaction_events_session ON compaction_events(session_id);
  ```

  Idempotente — `CREATE TABLE IF NOT EXISTS` cobre fresh DB e legacy DB. Não há ALTER a fazer (tabela é nova; nada precisa ser refeito em `sessions`). Nenhum `backfill*` adicional necessário além de incluir o DDL no `schema.sql`. **Sessions table NÃO ganha coluna nova.**

- [ ] **REQ-4**: GIVEN `writeSession` recebe um `ParsedSession` com `compactionEvents: CompactionEvent[]` WHEN persiste THEN cada item é INSERTado em `compaction_events` com `(session_id, source_file, sequence_in_file)` como PK natural, usando `ON CONFLICT(session_id, source_file, sequence_in_file) DO UPDATE SET trigger=excluded.trigger, pre_tokens=excluded.pre_tokens, post_tokens=excluded.post_tokens, ts=excluded.ts`. Re-ingest do mesmo source_file substitui as rows (idempotente). Re-ingest de outro source_file insere rows novas (multi-file = múltiplas rows naturalmente). Tudo dentro da mesma transação do `writeSession`.

- [ ] **REQ-5**: GIVEN um JSONL spans múltiplos arquivos (rotation) WHEN ingestados sequencialmente THEN `COUNT(*)` em `compaction_events WHERE session_id=?` é a soma natural dos eventos em todos os source_files da mesma sessão. Re-ingest de qualquer arquivo individual não altera as rows dos outros arquivos — isolamento via PK composta `(session_id, source_file, …)`. O reconcile (`lib/ingest/reconcile.ts`) não precisa tocar a tabela `compaction_events`; o count é sempre derivável e nunca diverge.

### Métricas derivadas (query-time)

- [ ] **REQ-6**: GIVEN uma sessão com ≥1 turn cuja lista de `tool_calls` inclui `tool_name = 'Edit' OR 'MultiEdit' OR 'Write'` WHEN `getPersonalEffectivenessSession(db, sessionId)` é chamada THEN retorna `tokensUntilFirstEdit: number` igual à soma de `inputTokens + outputTokens + cacheCreationTokens` dos turns com `sequence < S`, onde `S` é o menor `sequence` de turn com pelo menos um Edit/MultiEdit/Write tool_call. Para sessão sem nenhum Edit/MultiEdit/Write: `tokensUntilFirstEdit: null` (sinal "exploração pura").

- [ ] **REQ-7**: GIVEN uma sessão com 0 turns OU 1 turn com Edit logo no primeiro WHEN a query executa THEN: zero turns → `tokensUntilFirstEdit: null`; primeiro turn já edita → `tokensUntilFirstEdit: 0`. Boundary obrigatório.

- [ ] **REQ-8**: GIVEN uma sessão com tool_calls onde `tool_name = 'Read'` WHEN `getPersonalEffectivenessSession` executa THEN retorna `rereadCount: number` igual à quantidade de `(file_path)` que aparece >1× nos `tool_calls` Read da sessão (contado como `total_reads_dos_arquivos_repetidos - n_arquivos_repetidos`). Exemplo: arquivos lidos 3×, 2×, 1× → `rereadCount = (3-1) + (2-1) + 0 = 3`. Path null/ausente é ignorado (não conta como leitura).

- [ ] **REQ-9**: GIVEN um Read tool_call cujo `input_json` NÃO contém `file_path` (ex: `{}` por argumento truncado, JSON malformado) WHEN parseado por `json_extract` THEN o tool_call é ignorado (não conta no denominador). `json_extract` retorna NULL → filtramos antes de agregar. Não throw.

- [ ] **REQ-10**: GIVEN uma sessão com tool_calls em que `result_is_error = 1` WHEN `getPersonalEffectivenessSession` executa THEN retorna `toolErrorRate: number | null` = `SUM(result_is_error) / COUNT(*)`, ∈ `[0, 1]`. Para sessão sem tool_calls: `null`. Coerente com a fórmula já usada em `topSessions` (`lib/queries/effectiveness.ts:163`).

- [ ] **REQ-11**: GIVEN uma sessão com tool_calls Read ≥ 0 e Edit ≥ 0 WHEN a query executa THEN retorna `readsToEditsRatio: number | null` = `count(Read) / count(Edit+MultiEdit+Write)`. Edits = 0 → `null` (não emite Infinity nem -1). Reads = 0 → `0`. Edge: ambos zero → `null`.

- [ ] **REQ-12**: GIVEN uma sessão WHEN `getPersonalEffectivenessSession(db, sessionId)` executa THEN retorna `compactionEventCount: number` via `SELECT COUNT(*) FROM compaction_events WHERE session_id = ?`. Sessão sem nenhum evento → `0`. Sessão inexistente → tratada por REQ-14 (`null`). O índice `idx_compaction_events_session` garante O(log n + k) para o lookup.

- [ ] **REQ-13**: GIVEN uma sessão com `turn_count > 0` WHEN a query executa THEN retorna `subagentUsageRatio: number | null` = `(turns com subagent_type IS NOT NULL) / turn_count`, ∈ `[0, 1]`. Sessão sem turns → `null`.

- [ ] **REQ-14**: GIVEN um `sessionId` inexistente WHEN `getPersonalEffectivenessSession` é chamada THEN retorna `null` (não throw). Coerente com `getSubagentBreakdown(invalid)` que retorna `[]`.

### Métricas agregadas (window-based)

- [ ] **REQ-15**: GIVEN `getPersonalEffectivenessAggregates(db, days)` é chamada com `days > 0` WHEN executa THEN retorna `{ avgRereadCount, avgTokensUntilFirstEdit, avgReadsToEditsRatio, avgToolErrorRate, sessionsWithCompaction, totalSessions }` agregando sobre as sessões com `started_at >= now - days*86400000`. Sessões sem o sinal (null) são EXCLUÍDAS do numerador e denominador da respectiva média (não viram zero). `sessionsWithCompaction` = `SELECT COUNT(DISTINCT session_id) FROM compaction_events ce JOIN sessions s ON s.id = ce.session_id WHERE s.started_at >= ?`. `totalSessions` = COUNT sessões na janela. Janela vazia → todos os campos `null`/`0` apropriadamente.

- [ ] **REQ-16**: GIVEN `getCostRatingScatter(db, days)` é chamada WHEN executa THEN retorna `Array<{ sessionId: string; cost: number; rating: number }>` cobrindo apenas sessões com pelo menos um rating na janela. `cost` é computado em **JS** via `effectiveCostForSession` (de `lib/analytics/cost-calibration.ts`) — a query SELECT retorna as colunas brutas (`total_cost_usd`, `total_cost_usd_otel`, `model` ou `family` derivada) + `avg_rating` da view existente, e o JS aplica a cascata. NÃO duplicar a cascata em SQL — manter `effectiveCostForSession` como fonte única de verdade pra evitar drift quando a calibração evolui. Calibração carregada uma vez por chamada via `getCostCalibration(db)` (de `lib/queries/calibration.ts`). Padrão de referência: `app/api/sessions/[id]/share/route.ts:54`.

- [ ] **REQ-17**: GIVEN o scatter retorna `n >= 3` pontos WHEN o componente `<CostRatingScatter />` renderiza THEN exibe um `ScatterChart` (Recharts) com X = cost (USD, log scale opcional para outliers), Y = rating ∈ `[-1, 1]`, e uma linha de regressão linear (β e α calculados em JS via `linearRegression(points)` em `lib/analytics/regression.ts` — helper novo, puro). A regressão devolve `{ slope, intercept, r2 }`; renderizamos a reta entre `min(cost)` e `max(cost)`. `n < 3` → componente retorna `null` (regressão sobre 2 pontos é trivial e enganosa).

- [ ] **REQ-18**: GIVEN `getQuartileComparison(db, days)` é chamada WHEN executa THEN classifica as sessões da janela por `effectivenessScore` (já existe via `getSessionScores`) em quartis e retorna `{ topQuartile: AvgMetrics, bottomQuartile: AvgMetrics }` onde `AvgMetrics = { avgCacheHitRatio, avgTokensUntilFirstEdit, avgToolErrorRate, avgReadsToEditsRatio, sampleSize }`. Janela com < 4 sessões → `null` (não há quartis significativos). `sampleSize >= 1` em cada quartil para resultado não-`null`.

- [ ] **REQ-19**: GIVEN o quartile-comparison retorna não-`null` WHEN o componente `<EffectivenessInsightPanel />` renderiza THEN mostra para cada métrica (cache, tokens-until-first-edit, reads-to-edits, tool-errors): label + valor top-quartile + valor bottom-quartile + delta + microcopy actionable (ex: "Suas melhores sessões leem **3** arquivos antes do 1º Edit; suas piores leem **12**"). Microcopy é determinístico — função `formatInsightLine(metric, top, bottom)` que escolhe verbo ("leem", "erram", "reaproveitam") por métrica. Quartile null → componente retorna `null`.

### Funnel

- [ ] **REQ-20**: GIVEN `getEffectivenessFunnel(db, days)` é chamada WHEN executa THEN retorna `[{ stage: 'Started', count }, { stage: 'WithEdit', count }, { stage: 'CacheAboveMedian', count }, { stage: 'LowToolErrors', count }]` onde os estágios são **inclusivos cumulativos** (cada estágio pressupõe os anteriores). Definições: `WithEdit` = sessão tem ≥1 tool_call em `('Edit','MultiEdit','Write')`. `CacheAboveMedian` = `cache_hit_ratio` da sessão > mediana das sessões `WithEdit` na janela. `LowToolErrors` = `toolErrorRate < 0.1` (constante locked, exportada de `lib/analytics/effectiveness-v2.ts`).

- [ ] **REQ-21**: GIVEN a janela tem < 5 sessões WHEN o funnel executa THEN retorna `[]` (mediana com amostra insuficiente é ruído). Componente decide se mostra placeholder. Limite locked = 5 (mesmo ânimo de `MIN_CALLS_PER_BUCKET` em tool-trend).

- [ ] **REQ-22**: GIVEN o funnel retorna `n >= 4` linhas WHEN `<EffectivenessFunnel />` renderiza THEN exibe barras horizontais (decrescentes) com label do estágio + count + % do estágio anterior. Server Component (sem Recharts; CSS puro/Tailwind w-X/N).

### Calendar heatmap por effectiveness

- [ ] **REQ-23**: GIVEN `getDailyEffectivenessHeatmap(db, days)` é chamada WHEN executa THEN retorna `Array<{ date: string; score: number | null; sessionCount: number }>` cobrindo `days` dias contínuos terminando em hoje (zero-fill incluso). `score` = média do `effectivenessScore` das sessões com `started_at` no dia (em local-time, mesmo bucketing de `getDailySpend`). Dia sem sessões → `score: null, sessionCount: 0`.

- [ ] **REQ-24**: GIVEN o componente `<EffectivenessHeatmap />` renderiza com `data` retornado pela query WHEN há ≥1 dia com `score != null` THEN cores escalonam do nível 1 (vermelho-300) ao 4 (emerald-300) via `level = score === null ? 0 : Math.min(4, Math.ceil(4 * score / 100))`. Score em `[0,100]` (já garantido pelo scorer). Comparado ao spend-heatmap (paleta única emerald), aqui usamos GRADIENTE BIPOLAR — `score < 25` é vermelho/rose, `score 25-75` é amber/neutral, `score >= 75` é emerald. Justificativa: efetividade tem polaridade (ruim/bom), spend tem só intensidade. Paleta locked (5 swatches) em `lib/analytics/heatmap.ts` exportada como `EFFECTIVENESS_PALETTE`.

- [ ] **REQ-25**: GIVEN um dia com `score = null` (sem sessões) WHEN o tooltip é mostrado THEN exibe `YYYY-MM-DD — sem atividade`. Dia com sessões: `YYYY-MM-DD — score N/100 (M sessões)`. Reaproveita o mecanismo de `<title>` do heatmap atual (zero JS extra).

### UI / página

- [ ] **REQ-26**: GIVEN o usuário navega para `/effectiveness` WHEN a página renderiza THEN exibe, na ordem: (1) heading "Efetividade pessoal" + KPIs já existentes (`getEffectivenessKpis`), (2) `<EffectivenessHeatmap />`, (3) `<EffectivenessFunnel />`, (4) `<CostRatingScatter />`, (5) `<EffectivenessInsightPanel />`, (6) `<ScoreDistribution />` (reusado), (7) `<ToolSuccessTrend />` (reusado), (8) `<SubagentUsageCard />` (reusado se existir, ou nova mini-card baseada em `getSubagentUsage`). Cada seção decide se renderiza ou retorna `null` em estado vazio (já garantido pelos REQs anteriores).

- [ ] **REQ-27**: GIVEN o DB está vazio (sem sessões) WHEN `/effectiveness` renderiza THEN exibe um `<OverviewEmptyState />` (componente já existente reusado) com microcopy específico "Sem sessões ainda — execute `pnpm ingest` ou abra o Claude Code para começar". Não exibe seções vazias intercaladas — empty-state global ganha.

- [ ] **REQ-28**: GIVEN o usuário acessa `/` (home) WHEN a página renderiza THEN um link discreto no header da seção de KPIs ("Ver análise profunda →") aponta para `/effectiveness`. Não duplica conteúdo.

- [ ] **REQ-29**: Acessibilidade — cada seção de `/effectiveness` tem `<h2>` semântico; tabelas (insight panel) usam `<th scope="col">` + `<caption class="sr-only">`; charts (scatter, heatmap) têm wrapper com `role="img"` + `aria-label` descritivo (mesma convenção dos charts existentes). Cores não são o único canal de informação (heatmap tem tooltip; scatter tem tooltip).

### Performance / convenções

- [ ] **REQ-30**: Toda query nova usa **prepared statement memoizado via WeakMap** (padrão `getPrepared(db)` de `effectiveness.ts`). Zero `db.prepare(...)` per-call. Aplica para `getPersonalEffectivenessSession`, `getPersonalEffectivenessAggregates`, `getCostRatingScatter`, `getQuartileComparison`, `getEffectivenessFunnel`, `getDailyEffectivenessHeatmap`.

- [ ] **REQ-31**: Path traversal — esta spec **não** lê arquivos (tudo é DB queries). Não toca `lib/fs-paths.ts`.

- [ ] **REQ-32**: Zod boundary — `parseTranscriptString` é o único boundary de entrada nova; o schema `TranscriptLineSchema` em `types.ts` já é `passthrough` no `type` field, então as linhas `system/compact_boundary` passam por ele sem alteração. NENHUMA mudança em zod schemas — basta o parser observar `subtype === 'compact_boundary'` antes do filtro `CONSUMED_TYPES`. Decisão locked: contagem é feita ANTES do filtro current; o filtro segue inalterado para os outros types.

## Test Plan

### Unit Tests — `lib/analytics/regression.ts`

| TC      | REQ    | Category   | Description                                                                                | Expected                                              |
| ------- | ------ | ---------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| TC-U-01 | REQ-17 | happy      | `linearRegression([{x:1,y:1},{x:2,y:2},{x:3,y:3}])`                                        | `{ slope: 1, intercept: 0, r2: 1 }`                   |
| TC-U-02 | REQ-17 | edge       | n=1 → não é regressão                                                                      | `{ slope: 0, intercept: y, r2: 0 }` (sentinel)        |
| TC-U-03 | REQ-17 | edge       | n=2 → degenerado                                                                           | `null` (caller não chama com n<3, mas helper protege) |
| TC-U-04 | REQ-17 | edge       | Todos `x` iguais (vertical) → divisão por zero                                             | `null`                                                |
| TC-U-05 | REQ-17 | happy      | Conjunto de 5 pontos com correlação inversa                                                | `slope < 0, r2 ∈ (0,1]`                               |
| TC-U-06 | REQ-17 | edge       | Pontos NaN/Infinity filtrados                                                              | ignorados, regressão sobre os finitos                 |

### Unit Tests — `lib/analytics/effectiveness-v2.ts`

| TC      | REQ    | Category   | Description                                                                                | Expected                                                  |
| ------- | ------ | ---------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| TC-U-07 | REQ-19 | happy      | `formatInsightLine('readsToEdits', top:3, bottom:12)`                                       | `"Suas melhores sessões leem 3 arquivos antes do 1º Edit; suas piores leem 12"` |
| TC-U-08 | REQ-19 | happy      | `formatInsightLine('toolErrorRate', top:0.02, bottom:0.18)`                                 | mensagem com "erram" e %                                   |
| TC-U-09 | REQ-19 | edge       | top === bottom → "padrão consistente"                                                      | mensagem neutra, sem comparativo                          |
| TC-U-10 | REQ-19 | edge       | top OR bottom null                                                                          | mensagem omite o lado nulo                                |
| TC-U-11 | REQ-21 | happy      | `LOW_TOOL_ERROR_RATE_THRESHOLD === 0.1`                                                     | constante exportada                                       |
| TC-U-12 | REQ-21 | happy      | `MIN_FUNNEL_SESSIONS === 5`                                                                 | constante exportada                                       |
| TC-U-13 | REQ-24 | happy      | `EFFECTIVENESS_PALETTE` tem 5 entradas hex válidas em ordem rose→amber→emerald             | array de 5 strings                                        |
| TC-U-14 | REQ-24 | edge       | `effectivenessLevelFor(null)` → 0; `effectivenessLevelFor(0)` → 1; `(50)` → 3; `(100)` → 4 | mapping verificado                                        |

### Unit Tests — parser (compaction)

| TC      | REQ   | Category   | Description                                                                  | Expected                                          |
| ------- | ----- | ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| TC-U-15 | REQ-1 | happy      | JSONL com 2 linhas `system/compact_boundary` + 5 user/assistant             | `compactionEventCount === 2`                      |
| TC-U-16 | REQ-1 | edge       | JSONL sem nenhum compact_boundary                                           | `compactionEventCount === 0`                      |
| TC-U-17 | REQ-2 | validation | Linha `type:"system"` sem `subtype`                                          | não conta                                         |
| TC-U-18 | REQ-2 | validation | Linha `type:"system"` com `subtype:"info"`                                   | não conta                                         |
| TC-U-19 | REQ-2 | validation | Linha `type:"system"` com `subtype:42` (número)                              | não conta                                         |
| TC-U-20 | REQ-1 | edge       | JSONL malformado (JSON inválido) na linha do compact_boundary               | warn emitido, contador não incrementa             |

### Integration Tests — `lib/db/migrate.test.ts`

| TC      | REQ   | Category | Description                                                                  | Expected                                       |
| ------- | ----- | -------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| TC-I-01 | REQ-3 | infra    | DB novo → tabela `compaction_events` existe com schema esperado e índice `idx_compaction_events_session` | PRAGMA table_info + index_list confirmam       |
| TC-I-02 | REQ-3 | infra    | DB legacy sem a tabela → `migrate()` cria; segunda execução é no-op (CREATE TABLE IF NOT EXISTS)         | tabela criada 1×; sem alteração na 2ª chamada  |

### Integration Tests — `lib/ingest/writer.test.ts`

| TC      | REQ   | Category    | Description                                                                                                                                                                | Expected                                              |
| ------- | ----- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| TC-I-03 | REQ-4 | happy       | `writeSession` com `compactionEvents: [3 items]` → `SELECT COUNT(*) FROM compaction_events WHERE session_id=?` devolve 3; rows preservam `trigger`/`pre_tokens`/`post_tokens` | 3 rows com campos esperados                           |
| TC-I-04 | REQ-5 | idempotency | Re-ingest do MESMO source_file (mesmo path, mtime alterado, events idênticos) → `COUNT(*)` permanece igual; ON CONFLICT substitui campos                                  | count inalterado; trigger/tokens refletem último ingest |
| TC-I-05 | REQ-5 | happy       | Ingest sequencial de 2 source_files DIFERENTES da mesma session (2 events + 1 event respectivamente)                                                                       | `COUNT(*) === 3`; rows separadas por `source_file`    |
| TC-I-06 | REQ-5 | idempotency | Sequência: ingest A (2 events) → ingest B (1 event) → re-ingest A (2 events) → final count                                                                                 | `COUNT(*) === 3` (re-ingest de A não duplica nem afeta rows de B) — **regressão crítica do bug que motivou a tabela** |
| TC-I-07a | REQ-4 | happy       | Pipeline end-to-end com fixture `sample-with-compaction.jsonl` → rows populadas com `trigger`, `pre_tokens`, `post_tokens` do fixture                                     | rows refletem fixture                                 |
| TC-I-07b | REQ-4 | edge        | `compactionEvents = []` (sessão sem nenhum evento) → nenhuma row inserida                                                                                                  | `COUNT(*) === 0`                                      |
| TC-I-07c | REQ-3 | infra       | DELETE de uma session → ON DELETE CASCADE remove suas rows em `compaction_events`                                                                                          | rows da session removidas                             |

### Integration Tests — `lib/queries/effectiveness-v2.test.ts` (novo)

| TC      | REQ        | Category    | Description                                                                                                                                                                                                | Expected                                                                                                                            |
| ------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TC-I-07 | REQ-6      | happy       | Sessão com 5 turns; turns 1-3 sem Edit; turn 4 tem Edit. tokens dos turns 1-3 = 100, 200, 300                                                                                                              | `tokensUntilFirstEdit === 600`                                                                                                      |
| TC-I-08 | REQ-7      | edge        | Sessão sem nenhum Edit/MultiEdit/Write tool                                                                                                                                                                | `null`                                                                                                                              |
| TC-I-09 | REQ-7      | edge        | Sessão cujo PRIMEIRO turn já tem Edit                                                                                                                                                                      | `0`                                                                                                                                 |
| TC-I-10 | REQ-7      | edge        | Sessão sem turns                                                                                                                                                                                           | `null`                                                                                                                              |
| TC-I-11 | REQ-6      | happy       | Sessão com `Write` no turn 2 (não Edit) → conta como edit                                                                                                                                                  | `tokensUntilFirstEdit` igual aos tokens do turn 1                                                                                   |
| TC-I-12 | REQ-6      | happy       | Sessão com `MultiEdit` no turn 2 → conta                                                                                                                                                                   | mesmo idem                                                                                                                          |
| TC-I-13 | REQ-8      | happy       | Sessão com Reads de `/a` 3×, `/b` 2×, `/c` 1×                                                                                                                                                              | `rereadCount === (3-1) + (2-1) + 0 === 3`                                                                                           |
| TC-I-14 | REQ-9      | validation  | Read tool_call com `input_json: '{}'` (sem `file_path`)                                                                                                                                                    | ignorado, não conta no rereadCount                                                                                                  |
| TC-I-15 | REQ-9      | validation  | Read tool_call com `input_json` JSON inválido `'not-json'`                                                                                                                                                 | `json_extract` retorna null → ignorado                                                                                              |
| TC-I-16 | REQ-8      | edge        | Sessão sem Reads                                                                                                                                                                                           | `rereadCount === 0`                                                                                                                 |
| TC-I-17 | REQ-10     | happy       | Sessão com 10 tool_calls, 2 errors                                                                                                                                                                         | `toolErrorRate === 0.2`                                                                                                             |
| TC-I-18 | REQ-10     | edge        | Sessão sem tool_calls                                                                                                                                                                                      | `toolErrorRate === null`                                                                                                            |
| TC-I-19 | REQ-11     | happy       | Sessão com 6 Reads + 2 Edits + 1 Write                                                                                                                                                                     | `readsToEditsRatio === 6 / 3 === 2.0`                                                                                               |
| TC-I-20 | REQ-11     | edge        | Sessão com Reads mas sem Edits                                                                                                                                                                             | `readsToEditsRatio === null`                                                                                                        |
| TC-I-21 | REQ-11     | edge        | Sessão com Edits mas sem Reads                                                                                                                                                                             | `readsToEditsRatio === 0`                                                                                                           |
| TC-I-22 | REQ-12     | happy       | Sessão com 2 rows em `compaction_events` (mesmo source_file ou source_files distintos) → `getPersonalEffectivenessSession` retorna `compactionEventCount: 2`                                              | 2 (count via subselect)                                                                                                              |
| TC-I-23 | REQ-13     | happy       | Sessão com 4 turns, 2 com `subagent_type != null`                                                                                                                                                          | `subagentUsageRatio === 0.5`                                                                                                        |
| TC-I-24 | REQ-13     | edge        | Sessão com `turn_count === 0`                                                                                                                                                                              | `subagentUsageRatio === null`                                                                                                       |
| TC-I-25 | REQ-14     | edge        | `getPersonalEffectivenessSession(db, 'inexistente')`                                                                                                                                                       | `null`                                                                                                                              |
| TC-I-26 | REQ-15     | happy       | Janela de 30d com 4 sessões: tokensUntilFirstEdit = [100,200,null,300]                                                                                                                                     | `avgTokensUntilFirstEdit === (100+200+300)/3 === 200` (null excluído)                                                               |
| TC-I-27 | REQ-15     | edge        | Janela vazia                                                                                                                                                                                               | todos campos null/0                                                                                                                 |
| TC-I-28 | REQ-15     | happy       | `sessionsWithCompaction` = `COUNT(DISTINCT session_id)` da JOIN `compaction_events` × `sessions` na janela; sessão sem nenhuma row em `compaction_events` NÃO entra                                       | apenas sessões com ≥1 row contam                                                                                                    |
| TC-I-29 | REQ-16     | happy       | 3 sessões na janela com rating, 1 sem → scatter retorna 3 pontos com `cost` via cascata OTEL→calibrated→list                                                                                              | 3 pontos, todos com `rating ∈ [-1,1]`                                                                                               |
| TC-I-30 | REQ-16     | edge        | Janela sem nenhuma rating                                                                                                                                                                                  | `[]`                                                                                                                                |
| TC-I-31 | REQ-18     | happy       | 8 sessões com scores `[10,20,30,40,60,70,80,90]` → quartis: bottom=`[10,20]`, top=`[80,90]`. cache_hit médio do bottom < top                                                                              | `topQuartile.avgCacheHitRatio > bottomQuartile.avgCacheHitRatio`; `sampleSize === 2` em cada                                        |
| TC-I-32 | REQ-18     | edge        | Janela com 3 sessões                                                                                                                                                                                       | `null`                                                                                                                              |
| TC-I-33 | REQ-18     | edge        | Janela com 4 sessões idênticas                                                                                                                                                                             | top e bottom devolvem mesmas médias; `sampleSize === 1` em cada (quartis Q1=Q3 com n=4)                                             |
| TC-I-34 | REQ-20     | happy       | 10 sessões: 8 têm Edit, 5 dessas têm cache_hit > median, 3 dessas têm errorRate < 0.1                                                                                                                      | `[{Started:10},{WithEdit:8},{CacheAboveMedian:5},{LowToolErrors:3}]`                                                                |
| TC-I-35 | REQ-21     | edge        | 4 sessões na janela                                                                                                                                                                                        | `[]`                                                                                                                                |
| TC-I-36 | REQ-20     | edge        | 5 sessões mas nenhuma com Edit → estágio 2 = 0; estágios subsequentes = 0 (não recompõe mediana sobre vazio)                                                                                              | `[{Started:5},{WithEdit:0},{CacheAboveMedian:0},{LowToolErrors:0}]`                                                                 |
| TC-I-37 | REQ-23     | happy       | `getDailyEffectivenessHeatmap(db, 30)` com 3 sessões em 2 dias diferentes                                                                                                                                  | array de 30 dias; 2 dias com `score != null` (média), demais `null`                                                                  |
| TC-I-38 | REQ-23     | edge        | DB vazio                                                                                                                                                                                                   | array de 30 dias todos `score: null, sessionCount: 0`                                                                               |
| TC-I-39 | REQ-30     | infra       | 50 chamadas consecutivas a cada query reusam o prepared statement                                                                                                                                          | resultado idêntico, sem `db.prepare` extra                                                                                          |

### E2E Tests — `tests/e2e/effectiveness-v2.spec.ts`

| TC         | REQ    | Category   | Description                                                                                                                | Expected                                                  |
| ---------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| TC-E2E-01  | REQ-26 | happy      | `/effectiveness` com seed → todas as seções listadas em REQ-26 visíveis (heading + cards)                                  | 7+ seções com headings esperados                          |
| TC-E2E-02  | REQ-19 | happy      | `<EffectivenessInsightPanel />` renderiza linha "Suas melhores sessões leem N arquivos…"                                   | string presente; números ≠ "NaN"                          |
| TC-E2E-03  | REQ-17 | happy      | `<CostRatingScatter />` renderiza um `<svg>` Recharts com `<line>` (regressão) E ≥3 `<circle>` (pontos)                    | `svg + line + circles`                                    |
| TC-E2E-04  | REQ-22 | happy      | `<EffectivenessFunnel />` renderiza 4 estágios em ordem decrescente                                                        | 4 elementos, `count[i] >= count[i+1]`                     |
| TC-E2E-05  | REQ-24 | happy      | `<EffectivenessHeatmap />` renderiza 52×7 cells com paleta bipolar; ≥1 cell vermelha + ≥1 verde quando seed é misto         | `data-level` em cells; cores ok                           |
| TC-E2E-06  | REQ-27 | edge       | DB vazio (drop & migrate sem seed) → `/effectiveness` mostra `<OverviewEmptyState />` e nenhuma das seções                  | empty state visível                                       |
| TC-E2E-07  | REQ-28 | happy      | `/` (home) tem link "Ver análise profunda →" para `/effectiveness`; clicar navega                                          | link visível, navegação funciona                          |

## Design

### Architecture Decisions

1. **Query-time computation por padrão.** `tokens_until_first_edit`, `reread_count`,
   `reads_to_edits_ratio`, `tool_error_rate`, `subagent_usage_ratio` são todos
   computáveis com agregação SQL (alguns com `json_extract`). Nenhuma coluna nova
   em `sessions` para essas métricas. Justificativa: 5k sessões × 500 tool_calls
   = 2.5M rows worst-case; com índices existentes (`idx_tool_calls_turn`,
   `idx_turns_session`, `idx_sessions_started_at`) cada query agregada é < 50ms
   no SQLite local. Pre-otimização aqui seria desperdício.

2. **Compaction events viram rows em tabela própria `compaction_events`**, NÃO coluna em `sessions`. PK composta `(session_id, source_file, sequence_in_file)` torna re-ingest idempotente naturalmente: re-ingerir o mesmo source_file substitui as rows daquele arquivo via ON CONFLICT; multi-file rotation = múltiplas rows somáveis com `COUNT(*)`. **A coluna `compaction_event_count` em sessions foi REJEITADA** porque `sessions.source_file` (a "última seen") torna ambígua a regra "acumular vs substituir" no ON CONFLICT — re-ingest de arquivo antigo após rotation dispararia soma indevida. Bônus do design por-row: cada evento carrega `trigger`, `pre_tokens`, `post_tokens`, `ts` — habilita marker no timeline da sessão sem refactor futuro. Reconcile não toca a tabela (count sempre derivável; sem divergência possível).

3. **`json_extract(input_json, '$.file_path')` para Reads/Edits.** Padrão já em
   uso em `lib/queries/otel.ts`. Tool_calls com `input_json` malformado retornam
   NULL (json_extract é tolerante) — filtramos com `WHERE file_path IS NOT NULL`.

4. **SQL concreta — `tokensUntilFirstEdit`:**

   ```sql
   WITH first_edit AS (
     SELECT MIN(t.sequence) AS seq
     FROM turns t
     JOIN tool_calls tc ON tc.turn_id = t.id
     WHERE t.session_id = ?
       AND tc.tool_name IN ('Edit','MultiEdit','Write')
   )
   SELECT
     COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_creation_tokens), 0) AS tokens
   FROM turns t
   WHERE t.session_id = ?
     AND t.sequence < (SELECT seq FROM first_edit)
   ```

   `first_edit.seq IS NULL` (sessão sem Edit) → `t.sequence < NULL` é sempre
   falso → SUM retorna 0. **Mas precisamos distinguir "0 porque primeiro turn já
   editou" de "null porque nunca editou"**. Implementação concreta: **2 prepared statements** —
   (a) `getFirstEditSeq(sessionId)` retorna `{ seq: number | null }` (uma row sempre, com seq null se não há Edit);
   (b) `getTokensBeforeSeq(sessionId, seq)` retorna `{ sum: number }` somando turns com `sequence < seq`.
   No JS: se `seq === null` → devolve `null`; senão → executa (b) e devolve o sum (que pode ser 0 quando `seq === 1`).
   Padrão idêntico ao `PreparedSet` de `lib/queries/effectiveness.ts` — ambos os stmts memoizados via WeakMap.

5. **SQL concreta — `rereadCount`:**

   ```sql
   SELECT COALESCE(SUM(reads - 1), 0) AS rereadCount
   FROM (
     SELECT json_extract(tc.input_json, '$.file_path') AS path,
            COUNT(*) AS reads
     FROM tool_calls tc
     JOIN turns t ON t.id = tc.turn_id
     WHERE t.session_id = ?
       AND tc.tool_name = 'Read'
       AND json_extract(tc.input_json, '$.file_path') IS NOT NULL
     GROUP BY path
     HAVING reads > 1
   )
   ```

   `HAVING reads > 1` filtra paths lidos só uma vez. `SUM(reads - 1)` produz o
   total de re-reads.

6. **SQL concreta — `readsToEditsRatio`:**

   ```sql
   SELECT
     SUM(CASE WHEN tc.tool_name = 'Read' THEN 1 ELSE 0 END) AS reads,
     SUM(CASE WHEN tc.tool_name IN ('Edit','MultiEdit','Write') THEN 1 ELSE 0 END) AS edits
   FROM tool_calls tc
   JOIN turns t ON t.id = tc.turn_id
   WHERE t.session_id = ?
   ```

   JS calcula a razão com `null` quando `edits === 0`.

7. **Funnel — mediana via SQLite.** SQLite não tem `MEDIAN()` nativo, mas com 5
   sessões `WithEdit` o cálculo é trivial em JS após `ORDER BY cache_hit_ratio
   ASC LIMIT 1 OFFSET (n/2)` ou simplesmente fetchar os ratios e calcular no JS.
   Decidido **JS** (n é pequeno; legibilidade > micro-perf). Helper
   `computeMedian(values: number[])` em `lib/analytics/effectiveness-v2.ts`.

8. **Quartis — `getQuartileComparison`.** Reusa `getSessionScores(db, days)` —
   já calcula score composto com pricing real. Ordena por score, fatia top 25% e
   bottom 25%, calcula avg de cada métrica em JS. **Não duplicar SQL** de scoring;
   o scorer é a fonte de verdade.

9. **Scatter regression — `linearRegression(points)`.** Helper puro em
   `lib/analytics/regression.ts`. Implementação clássica least-squares; protege
   contra `n<3`, divisão por zero, NaN. Retorna `null` em casos degenerados —
   componente checa e omite a linha.

10. **Heatmap bipolar.** Paleta:
    `EFFECTIVENESS_PALETTE = ['#525252' /*L0 sem dado*/, '#fb7185' /*L1 ruim — rose-400*/, '#fbbf24' /*L2 médio — amber-400*/, '#a3e635' /*L3 bom — lime-400*/, '#34d399' /*L4 ótimo — emerald-400*/]`.
    L0 = sem atividade (cinza neutro), L1-L4 = score crescente. Levels 1-4 mapeiam
    de quartis fixos do score `[0,25)`, `[25,50)`, `[50,75)`, `[75,100]`.
    Determinístico, não depende de distribuição amostral.

11. **`linearRegression` puro vs Recharts plug-in.** Recharts não tem regression
    nativa — escrevemos a reta manualmente como `<ReferenceLine>` ou um
    `<Line>` com 2 pontos `[(minX, mx+b), (maxX, mx+b)]`. `<Line>` em scatter é
    suportado via composto.

12. **Microcopy do insight panel.** Função `formatInsightLine(metric, top, bottom)`
    em `lib/analytics/effectiveness-v2.ts`. Tabela:

    | metric              | template (pt-BR)                                                                                |
    | ------------------- | ----------------------------------------------------------------------------------------------- |
    | `tokensUntilFirstEdit` | "Suas melhores sessões exploram **{top}** tokens antes do 1º Edit; suas piores exploram **{bottom}**" |
    | `readsToEditsRatio` | "Suas melhores sessões leem **{top}** arquivos por Edit; suas piores leem **{bottom}**"          |
    | `toolErrorRate`     | "Suas melhores sessões erram **{top%}** das tool calls; suas piores erram **{bottom%}**"        |
    | `cacheHitRatio`     | "Suas melhores sessões reaproveitam **{top%}** do contexto; suas piores reaproveitam **{bottom%}**" |

    Top === bottom → "Padrão consistente em **{value}**".

13. **Funnel sem Recharts.** Server Component CSS-only. Cada estágio é uma `<div>`
    com largura proporcional ao count máximo. Tooltip via `<title>`. Justificativa:
    Recharts pra 4 barras é overkill; reduz JS shipado.

14. **Coexistência de dois heatmaps.** O heatmap de spend continua em `/`. O
    novo (effectiveness) vive em `/effectiveness`. NÃO substituir nenhum. O
    componente `<ActivityHeatmap />` ganha uma prop `colorScheme: 'spend' |
    'effectiveness'` (default `'spend'`) — o mesmo `<svg>` renderiza ambas as
    paletas conforme prop. Reusa `arrangeWeeks`, `monthLabels`, `parseDateParam`.
    Decisão: **um único componente parametrizado** > dois componentes 95% iguais.

15. **Testes de boundary REQ-7 (tokens_until_first_edit).** TC-I-08 (sem Edit →
    null), TC-I-09 (Edit no primeiro turn → 0), TC-I-10 (sem turns → null) são
    obrigatórios e cobrem os 3 estados.

16. **Linguagem de microcopy.** PT-BR (preferência do usuário registrada em
    memory). Comentários técnicos no código permanecem em EN (convenção do
    projeto).

### Files to Create

- `lib/analytics/regression.ts` — `linearRegression(points)`, `LinearFit` type
- `lib/analytics/regression.test.ts` — TC-U-01..06
- `lib/analytics/effectiveness-v2.ts` — constantes (`LOW_TOOL_ERROR_RATE_THRESHOLD`,
  `MIN_FUNNEL_SESSIONS`, `EFFECTIVENESS_PALETTE`), helpers (`computeMedian`,
  `effectivenessLevelFor`, `formatInsightLine`)
- `lib/analytics/effectiveness-v2.test.ts` — TC-U-07..14
- `lib/queries/effectiveness-v2.ts` — `getPersonalEffectivenessSession`,
  `getPersonalEffectivenessAggregates`, `getCostRatingScatter`,
  `getQuartileComparison`, `getEffectivenessFunnel`, `getDailyEffectivenessHeatmap`
- `lib/queries/effectiveness-v2.test.ts` — TC-I-07..39
- `app/effectiveness/page.tsx` — Server Component, layout descrito em REQ-26
- `app/effectiveness/loading.tsx` — boundary
- `components/effectiveness-v2/cost-rating-scatter.tsx` — Client (Recharts)
- `components/effectiveness-v2/effectiveness-funnel.tsx` — Server (CSS bars)
- `components/effectiveness-v2/effectiveness-insight-panel.tsx` — Server (table)
- `components/effectiveness-v2/effectiveness-heatmap.tsx` — wrapper que reusa
  `<ActivityHeatmap colorScheme="effectiveness" />` (componente refatorado)
- `tests/e2e/effectiveness-v2.spec.ts` — TC-E2E-01..07
- `tests/fixtures/sample-with-compaction.jsonl` — fixture para TC-I-06 e TC-U-15..20

### Files to Modify

- `lib/db/schema.sql` — adicionar `CREATE TABLE IF NOT EXISTS compaction_events (…)` + índice (DDL completo em REQ-3). NENHUMA mudança em `CREATE TABLE sessions`.
- `lib/db/migrate.test.ts` — TC-I-01 (tabela existe em fresh DB), TC-I-02 (legacy DB ganha tabela; idempotente). Sem `backfill*` novo necessário.
- `lib/ingest/transcript/types.ts` — adicionar tipo `CompactionEvent` e campo `compactionEvents: CompactionEvent[]` em `ParsedSession`
- `lib/ingest/transcript/parser.ts` — coletar entradas `system/compact_boundary` ANTES do filtro `CONSUMED_TYPES` em array `compactionEvents`; populá-lo no `value` retornado.
- `lib/ingest/transcript/parser.test.ts` — TC-U-15..20
- `lib/ingest/writer.ts` — adicionar prepared stmt `insertCompactionEvent` + iteração sobre `parsed.compactionEvents` dentro da transação de `writeSession`. ON CONFLICT(`session_id, source_file, sequence_in_file`) DO UPDATE substitui campos. NENHUMA mudança no INSERT de `sessions`.
- `lib/ingest/writer.test.ts` — TC-I-03..06, TC-I-07a..c
- `components/overview/activity-heatmap.tsx` — adicionar prop `colorScheme: 'spend' | 'effectiveness'` (default `'spend'`); refatorar palette selection. Spend mantém `EMERALD_PALETTE` atual; effectiveness usa `EFFECTIVENESS_PALETTE` exportada de `lib/analytics/effectiveness-v2.ts`. Tooltip text também adapta ("$X" vs "score N/100"). Empty state mantém.
- `lib/analytics/heatmap.ts` — exportar `EMERALD_PALETTE` (atual hardcoded vira constante nomeada). Sem mudança comportamental para spend.
- `lib/analytics/heatmap.test.ts` — adicionar TC para `effectivenessLevelFor` se preferir manter colocalizado (alternativa: fica em effectiveness-v2.test.ts; **decisão**: vai pra effectiveness-v2 porque a constante mora lá)
- `app/page.tsx` — link discreto "Ver análise profunda →" para `/effectiveness` (REQ-28)

### Dependencies

Nenhuma nova. Recharts (já), Tailwind (já), better-sqlite3 (já),
SQLite `json_extract` (já em uso em `lib/queries/otel.ts`).

## Tasks

- [x] **TASK-1**: Helper puro `lib/analytics/regression.ts` — `linearRegression(points: Array<{x:number,y:number}>): LinearFit | null` com least-squares, proteção contra `n<3`, `Σ(x - x̄)² === 0` (vertical), NaN/Infinity. Testes TC-U-01..06.
  - files: lib/analytics/regression.ts, lib/analytics/regression.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06

- [x] **TASK-2**: Helpers e constantes em `lib/analytics/effectiveness-v2.ts` — `LOW_TOOL_ERROR_RATE_THRESHOLD = 0.1`, `MIN_FUNNEL_SESSIONS = 5`, `EFFECTIVENESS_PALETTE` (5 cores hex em ordem L0..L4), `effectivenessLevelFor(score: number | null): 0 | 1 | 2 | 3 | 4`, `computeMedian(values: number[]): number | null`, `formatInsightLine(metric: 'tokensUntilFirstEdit'|'readsToEditsRatio'|'toolErrorRate'|'cacheHitRatio', top: number | null, bottom: number | null): string`. Testes TC-U-07..14.
  - files: lib/analytics/effectiveness-v2.ts, lib/analytics/effectiveness-v2.test.ts
  - tests: TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14

- [x] **TASK-3**: Schema — adicionar `CREATE TABLE IF NOT EXISTS compaction_events (…)` + índice em `lib/db/schema.sql` (DDL completo no REQ-3). Nenhuma coluna nova em `sessions`. Migração é trivial: `CREATE TABLE IF NOT EXISTS` cobre tanto fresh DB quanto legacy. Sem `backfill*` adicional. Tests: TC-I-01 (tabela existe após migrate em DB fresh), TC-I-02 (legacy DB ganha tabela; segunda execução é no-op).
  - files: lib/db/schema.sql, lib/db/migrate.test.ts
  - tests: TC-I-01, TC-I-02

- [x] **TASK-4**: Parser de compaction — adicionar tipo `CompactionEvent` e campo `compactionEvents: CompactionEvent[]` em `ParsedSession` (`lib/ingest/transcript/types.ts`). Em `lib/ingest/transcript/parser.ts`: ANTES do filtro `CONSUMED_TYPES`, observar linhas com `type === 'system' && subtype === 'compact_boundary'`; manter contador local `let compactionIdx = 0` e push `{ sequence_in_file: compactionIdx++, trigger: line.compactMetadata?.trigger ?? null, pre_tokens: line.compactMetadata?.preTokens ?? null, post_tokens: line.compactMetadata?.postTokens ?? null, ts: Date.parse(line.timestamp) || Date.now() }`. Retornar `compactionEvents` no `value`. Tests TC-U-15..20. Fixture `tests/fixtures/sample-with-compaction.jsonl` com 2 user/assistant + 2 compact_boundary entries (shape real do Context).
  - files: lib/ingest/transcript/types.ts, lib/ingest/transcript/parser.ts, lib/ingest/transcript/parser.test.ts, tests/fixtures/sample-with-compaction.jsonl
  - depends: TASK-3
  - tests: TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20

- [x] **TASK-5**: Writer — em `lib/ingest/writer.ts`, dentro da transação de `writeSession`, iterar `parsed.compactionEvents` e fazer INSERT em `compaction_events` com `ON CONFLICT(session_id, source_file, sequence_in_file) DO UPDATE SET trigger=excluded.trigger, pre_tokens=excluded.pre_tokens, post_tokens=excluded.post_tokens, ts=excluded.ts`. Statement preparado uma vez no construtor de stmts (mesmo padrão dos outros). **Importante**: NENHUMA mudança no INSERT de `sessions` (nada novo lá). Tests TC-I-03..06, TC-I-07a..c.
  - files: lib/ingest/writer.ts, lib/ingest/writer.test.ts
  - depends: TASK-3, TASK-4
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07a, TC-I-07b, TC-I-07c

- [x] **TASK-6**: Query module `lib/queries/effectiveness-v2.ts` — implementar todas as queries derivadas (REQ-6..14, REQ-15, REQ-16, REQ-18, REQ-20, REQ-23). Padrão: `PreparedSet` + WeakMap como em `effectiveness.ts`. SQL concretas no Design §4-6. `getPersonalEffectivenessSession` usa **2 prepared stmts** para tokensUntilFirstEdit (Design §4: `getFirstEditSeq` + `getTokensBeforeSeq`, fast-path JS pra distinguir null vs 0). `compactionEventCount` via `SELECT COUNT(*) FROM compaction_events WHERE session_id=?` (REQ-12). `getCostRatingScatter` retorna colunas brutas + chama `effectiveCostForSession` no JS (REQ-16) — calibração carregada uma vez por chamada via `getCostCalibration(db)` (referência: `app/api/sessions/[id]/share/route.ts:54`); NÃO duplicar a cascata em SQL. Funnel reusa stmt próprio para counts; mediana em JS via `computeMedian` (TASK-2). `getQuartileComparison` reusa `getSessionScores`. `getDailyEffectivenessHeatmap` espelha bucketing local-time de `getDailySpend`. Tests TC-I-07..39.
  - files: lib/queries/effectiveness-v2.ts, lib/queries/effectiveness-v2.test.ts
  - depends: TASK-2, TASK-3, TASK-5
  - tests: TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-13, TC-I-14, TC-I-15, TC-I-16, TC-I-17, TC-I-18, TC-I-19, TC-I-20, TC-I-21, TC-I-22, TC-I-23, TC-I-24, TC-I-25, TC-I-26, TC-I-27, TC-I-28, TC-I-29, TC-I-30, TC-I-31, TC-I-32, TC-I-33, TC-I-34, TC-I-35, TC-I-36, TC-I-37, TC-I-38, TC-I-39

- [x] **TASK-7**: Refatorar `components/overview/activity-heatmap.tsx` — adicionar prop opcional `colorScheme: 'spend' | 'effectiveness'` (default `'spend'`). Importa `EFFECTIVENESS_PALETTE` (TASK-2) e `EMERALD_PALETTE` (extraído de hardcoded para `lib/analytics/heatmap.ts` como named export — backward compatible). Tooltip text também adapta por scheme. Cuidar pra não quebrar uso atual em `app/page.tsx`. Não tem TC dedicado — a integridade é coberta pelos E2E existentes do heatmap (TC-E2E-05/06/07 do session-timeline-heatmap continuam verdes) e novo TC-E2E-05 (effectiveness scheme).
  - files: components/overview/activity-heatmap.tsx, lib/analytics/heatmap.ts
  - depends: TASK-2

- [x] **TASK-8**: Componente `components/effectiveness-v2/cost-rating-scatter.tsx` (Client Component, Recharts `ScatterChart`). Props: `data: Array<{ sessionId, cost, rating }>`. Renderiza `null` quando `data.length < 3`. Usa `linearRegression` (TASK-1) sobre `(cost, rating)` para desenhar a reta. Wrapper `role="img"` + `aria-label`. Tooltip por ponto: sessionId truncado + `$cost` + `rating`.
  - files: components/effectiveness-v2/cost-rating-scatter.tsx
  - depends: TASK-1

- [x] **TASK-9**: Componente `components/effectiveness-v2/effectiveness-funnel.tsx` (Server Component, CSS bars). Props: `data: Array<{stage, count}>`. Retorna `null` em `data.length === 0`. Cada barra com width proporcional ao maior count, label do estágio + count + % do anterior. `<title>` para tooltip.
  - files: components/effectiveness-v2/effectiveness-funnel.tsx

- [x] **TASK-10**: Componente `components/effectiveness-v2/effectiveness-insight-panel.tsx` (Server Component, `<table>`). Props: `quartiles: { topQuartile, bottomQuartile } | null`. Retorna `null` quando `quartiles === null`. Linha por métrica (cache, tokensUntilFirstEdit, readsToEdits, toolErrorRate) usando `formatInsightLine` (TASK-2). `<caption class="sr-only">` + `<th scope="col">`.
  - files: components/effectiveness-v2/effectiveness-insight-panel.tsx
  - depends: TASK-2

- [x] **TASK-11**: Wrapper `components/effectiveness-v2/effectiveness-heatmap.tsx` — passa `colorScheme="effectiveness"` para `<ActivityHeatmap />` (TASK-7). Props simples: `data: Array<{date, score, sessionCount}>`. Recebe a forma da query e converte para o shape que `ActivityHeatmap` consome (talvez precise de `score → spend`-like field para reuso; alternativa documentada no Design §14: o componente já consome um campo "value" abstrato).
  - files: components/effectiveness-v2/effectiveness-heatmap.tsx
  - depends: TASK-6, TASK-7

- [x] **TASK-12**: Página `app/effectiveness/page.tsx` (Server Component) + `app/effectiveness/loading.tsx`. Layout em REQ-26: KPIs (reuso `getEffectivenessKpis`), heatmap, funnel, scatter, insight panel, score distribution (reuso `<ScoreDistribution />` de `components/effectiveness/score-distribution.tsx`), tool success trend (reuso `<ToolSuccessTrend />` de `components/effectiveness/tool-success-trend.tsx`), e **`<SubagentUsageCard />` novo (inline nesta task — Q2 LOCKED)**: arquivo `components/effectiveness-v2/subagent-usage-card.tsx` (Server Component simples), recebe `usage` de `getSubagentUsage(db, days)`, mostra: "Sub-agents usados em **N** de **M** sessões (**P%**)" + mini-tooltip explicando que sub-agents indicam paralelismo / delegação. Empty state global via `<OverviewEmptyState />` quando `totalSessions === 0`. `export const dynamic = 'force-dynamic'`, `runtime = 'nodejs'` (consistente com `/`).
  - files: app/effectiveness/page.tsx, app/effectiveness/loading.tsx, components/effectiveness-v2/subagent-usage-card.tsx
  - depends: TASK-6, TASK-8, TASK-9, TASK-10, TASK-11

- [x] **TASK-13**: Link discreto em `app/page.tsx` — adicionar "Ver análise profunda →" no header de KPIs (`/` → `/effectiveness`). Sem mudar nada além do link.
  - files: app/page.tsx
  - depends: TASK-12

- [x] **TASK-SMOKE**: E2E `tests/e2e/effectiveness-v2.spec.ts` cobrindo TC-E2E-01..07. Exige que `tests/e2e/global-setup.ts` tenha seed com: ≥4 sessões com ratings (pra scatter), ≥5 sessões com Edit (pra funnel), ≥1 sessão com ≥1 row em `compaction_events`. Auditar setup atual; adicionar seed se faltar (sessão `e2e-effectiveness-v2` com SQL direto + INSERT na nova tabela). Manter outras specs verdes.
  - files: tests/e2e/effectiveness-v2.spec.ts, tests/e2e/global-setup.ts
  - depends: TASK-13
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3, TASK-9]   — foundation paralela (helpers + schema + funnel sem deps)
Batch 2: [TASK-4, TASK-7, TASK-8, TASK-10]  — paralelo (parser depende só de schema; heatmap refactor de helpers; scatter de regressão; insight de helpers)
Batch 3: [TASK-5]                            — writer (depende de schema + parser)
Batch 4: [TASK-6]                            — query module (depende de helpers + writer)
Batch 5: [TASK-11]                           — heatmap wrapper (depende de query + heatmap refactor)
Batch 6: [TASK-12]                           — page (depende de tudo acima)
Batch 7: [TASK-13]                           — link em /
Batch 8: [TASK-SMOKE]                        — E2E final
```

File overlap analysis:

- `lib/analytics/regression.ts` + `.test.ts`: exclusivo TASK-1
- `lib/analytics/effectiveness-v2.ts` + `.test.ts`: exclusivo TASK-2
- `lib/db/schema.sql`, `lib/db/migrate.ts`, `lib/db/migrate.test.ts`: exclusivo TASK-3
- `lib/ingest/transcript/types.ts`, `parser.ts`, `parser.test.ts`, fixture: exclusivo TASK-4
- `lib/ingest/writer.ts` + `.test.ts`: exclusivo TASK-5
- `lib/queries/effectiveness-v2.ts` + `.test.ts`: exclusivo TASK-6
- `components/overview/activity-heatmap.tsx`, `lib/analytics/heatmap.ts`: exclusivo TASK-7 (shared-additive com session-timeline-heatmap concluído — sem outras tasks tocando)
- `components/effectiveness-v2/cost-rating-scatter.tsx`: exclusivo TASK-8
- `components/effectiveness-v2/effectiveness-funnel.tsx`: exclusivo TASK-9
- `components/effectiveness-v2/effectiveness-insight-panel.tsx`: exclusivo TASK-10
- `components/effectiveness-v2/effectiveness-heatmap.tsx`: exclusivo TASK-11
- `app/effectiveness/page.tsx` + `loading.tsx`: exclusivo TASK-12
- `app/page.tsx`: exclusivo TASK-13 (shared-mutative no longo prazo, mas só TASK-13 desta spec toca)
- `tests/e2e/effectiveness-v2.spec.ts`, `tests/e2e/global-setup.ts`: exclusivo TASK-SMOKE (setup é shared-additive histórico)

Batch 1 roda 4 worktrees em paralelo (zero overlap entre helpers/schema/funnel-component). Batch 2 roda 4 worktrees (parser independente; heatmap refactor; scatter + insight components têm files próprios).

## Validation Criteria

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm test --run` passa (todos TC-U + TC-I)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (TC-E2E-01..07)
- [ ] `pnpm dev` + `/effectiveness` com DB real exibe todas as seções com dados plausíveis (não-NaN, não-Infinity, não-0 universal)
- [ ] `rm data/dashboard.db* && pnpm ingest` popula rows em `compaction_events` para pelo menos 1 sessão real (ex: 562f31db-…) — confirmar com `sqlite3 data/dashboard.db 'SELECT session_id, source_file, sequence_in_file, trigger, pre_tokens, post_tokens FROM compaction_events LIMIT 5'`
- [ ] Insight panel mostra microcopy real (não placeholder) com top vs bottom diferentes
- [ ] Scatter mostra reta de regressão visível e ≥3 pontos
- [ ] Heatmap effectiveness usa paleta bipolar (≥1 cell vermelha + ≥1 verde quando dados são mistos)
- [ ] DB vazio → `/effectiveness` mostra `<OverviewEmptyState />` sem crash
- [ ] Link "Ver análise profunda →" em `/` navega para `/effectiveness`
- [ ] Acessibilidade — DevTools > Accessibility tree mostra `role="img"` + `aria-label` em scatter e heatmap; `<table>` com `<caption>` no insight panel

## Open Questions

- **Q1 [LOCKED 2026-04-28]**: Heatmap window = **365 dias**, consistente com spend-heatmap em `/`. Renderizar todas as semanas (mesmo as anteriores à primeira sessão); empty cells com `<title>` "sem atividade" — não esconder.
- **Q2 [LOCKED 2026-04-28]**: `<SubagentUsageCard />` será criado **inline em TASK-12** (1 KPI + ratio simples baseado em `getSubagentUsage`). Não é spec separada.
- **Q3 (REQ-5 acumulativo)**: **RESOLVIDO** pela decisão arquitetural B1 — eventos viram rows em `compaction_events` com PK composta. Não há mais coluna acumulativa em sessions; idempotência é estrutural via PK.
- **Q4 [LOCKED 2026-04-28]**: Funnel mostra **sempre os 4 estágios** quando `data.length === 4`, mesmo com count=0 nos posteriores. Mais informativo ("0 sessões chegaram aqui" é informação útil, não ruído).
- **B1 [LOCKED 2026-04-28]**: Compaction events em tabela própria `compaction_events` (PK `(session_id, source_file, sequence_in_file)`), NÃO coluna acumulativa em `sessions`. Razão: a coluna acumulativa proposta inicialmente tinha bug de double-count em re-ingest após rotation. Fix completo no Design §2 e REQ-1..5.

## Execution Log

- 2026-04-28: **User-review pass — 6 fixes aplicados**:
  - **B1 (correctness, BLOQUEADOR)**: refactor de `compaction_event_count` (coluna acumulativa em `sessions`) para tabela própria `compaction_events` com PK `(session_id, source_file, sequence_in_file)`. Razão: a coluna acumulativa tinha bug de double-count em re-ingest após rotation — `sessions.source_file` é a "última seen", então o discriminador `excluded.source_file != sessions.source_file` dispararia soma indevida quando se re-ingere arquivo antigo. PK composta torna idempotência estrutural. Affected: REQ-1..5, REQ-12, REQ-15 (sessionsWithCompaction via JOIN), Design §2, Files to Modify (sem `backfillSessionsCompactionCount`), TASK-3 (só CREATE TABLE), TASK-4 (parser retorna array), TASK-5 (writer insere rows), TASK-6 (query usa subselect), TC-I-01..07c reescritos (TC-I-06 vira o teste-regressão crítico do bug), Validation Criteria (SQL de verificação atualizada), TASK-SMOKE seed.
  - **M1 (DRY)**: REQ-16 + TASK-6 — `getCostRatingScatter` deixa de duplicar a cascata de cost em SQL e passa a usar `effectiveCostForSession` em JS, mesma estratégia que aplicamos em outcome-integration-git REQ-14. Mantém uma única fonte de verdade para custo calibrado.
  - **Mi3 (clareza)**: Design §4 — fast-path do `tokensUntilFirstEdit` agora explicitamente descrito como **2 prepared statements** (`getFirstEditSeq` retorna seq nullable; `getTokensBeforeSeq` soma) com decisão null vs 0 no JS. Sem ambiguidade na implementação.
  - **Q1 LOCKED**: heatmap window = 365d (consistência com spend-heatmap em `/`).
  - **Q2 LOCKED**: `<SubagentUsageCard />` criado inline em TASK-12 (não é spec separada).
  - **Q4 LOCKED**: funnel mostra sempre os 4 estágios quando `data.length === 4`, mesmo com count=0.
