# Spec: quota-improvements

## Status: DRAFT

## Context

Depois de calibrar os thresholds de Tokens 5h/7d contra o painel
`Account & Usage` do Claude.ai, três ajustes ficam evidentes na tela
`/quota`:

1. **Campos de Sessões 5h/7d são ruído.** Anthropic não publica limite
   de sessões no plano Max — são soft rate-limits auto-impostos. Na
   prática, nenhum usuário de TokenFx vai usar, e o form de 4 campos
   infla a UI. Remover.

2. **Reset countdown ausente.** O painel do Claude.ai mostra "Resets
   in 43m" (sessão 5h) e "Resets in 3d" (semana 7d) — sinal forte que
   ajuda a planejar. TokenFx hoje mostra só `used/limit`. Falta o
   tempo.

3. **Hierarquia visual errada.** Hoje a tela é:
   `header → KPI cards (ocupam pouco) → form de thresholds enorme →
   heatmap pequeno embaixo`. O form rouba atenção do que importa
   (consumo atual + padrão histórico). Reorganizar:
   - Tokens 5h + 7d **em destaque** (grid 2-col, cards grandes, reset
     countdown visível)
   - Form de thresholds **removido da página** — cada card ganha um
     ícone de lápis que abre dialog modal pra editar o valor dele
   - Heatmap "Padrão de consumo (últimas 4 semanas)" **full-width**
     embaixo, com espaço vertical pra respirar

### Decisões já travadas

- **Sessões 5h/7d**: remover do Zod schema, do form (que será
  deletado), do KpiCard, e do `QuotaNavWidget`. **Colunas do DB
  permanecem** (`quota_sessions_5h`, `quota_sessions_7d`) — zero
  migração, zero risco de perda de dados, se alguém no futuro quiser
  ressuscitar a feature os dados antigos estão lá. Zod schema ignora
  os campos.
- **Dialog primitive**: elemento HTML nativo `<dialog>` com
  `showModal()` — zero dependência nova, acessível por default
  (focus trap + `Esc`), combina com a postura minimalista do
  projeto (`components/ui/` hoje só tem card, dropdown-menu,
  skeleton). Sem adicionar Radix Dialog.
- **Reset 5h — algoritmo "bloco detectado por gap"**: Claude Max usa
  bloco fixo de 5h a partir da primeira mensagem da sessão, não
  rolling window. Aproximação: ordenar turns últimas 10h DESC; walk
  backwards achando o primeiro par (newer, older) onde
  `newer - older > 5h` — esse é o início do bloco atual. Reset =
  `block_start + 5h`. Se `now - newerTurn > 5h`, bloco expirou (reset
  = null → próxima mensagem inicia novo bloco).
- **Reset 7d — aproximação rolling simples**: reset estimado em
  `oldest_turn_in_last_7d + 7d`. Anthropic não expõe o calendário da
  semana exata; esta é a aproximação honesta (documentada como tal).
- **Dialog edita UM campo por vez**: card de Tokens 5h abre dialog
  só pra `quotaTokens5h`. Ao salvar, Server Action recebe payload
  completo (merge com settings atuais) pra não quebrar o contrato
  existente de `updateQuotaSettings`.
- **Copy do header da página atualizado** pra explicar que o Max tem
  duas janelas distintas (sessão 5h baseada na primeira msg +
  semana 7d), esclarecendo por que precisamos das duas
  calibrações.

### Fora de escopo

- Auto-descobrir thresholds do Claude.ai via scraping — impossível
  sem auth, não vale.
- Detectar sessão 5h por gap curto (<30min) — complicação sem
  retorno claro; algoritmo usa o gap que a própria Anthropic define
  (>5h entre mensagens = bloco anterior expirou).
- Substituir o `<dialog>` por Radix Dialog — só se precisarmos de
  empilhamento de modais ou animação complexa; não é o caso.
- Backfill histórico de resets — mostramos só o reset futuro.
- Mudar o `QuotaBar` — componente reutilizado, mantém API.

## Requirements

### Remove Sessões

- [ ] **REQ-1**: GIVEN `lib/quota/schema.ts` (`QuotaSettingsSchema`)
  WHEN refatorado THEN o schema tem apenas `quotaTokens5h` e
  `quotaTokens7d` (cada um: `z.number().int().positive().max(1_000_000_000).nullable()`).
  Os campos `quotaSessions5h` e `quotaSessions7d` são **removidos** do
  schema. O tipo `QuotaSettingsInput` reflete a nova forma (2
  fields).

- [ ] **REQ-2**: GIVEN `lib/quota/actions.core.ts` WHEN recebe um
  input válido THEN propaga `quotaSessions5h: null` e
  `quotaSessions7d: null` ao chamar `upsertUserSettings` (valores
  fixos — sem mais sessões rastreadas). `getUserSettings` **não muda
  API** — `UserSettings` type ainda exporta os 4 campos pra compat
  com callers restantes; os 2 de sessions virão sempre `null` após
  o primeiro save pós-spec.

- [ ] **REQ-3**: GIVEN `components/quota/quota-nav-widget.tsx` WHEN
  renderizado THEN só considera `quotaTokens5h` e `quotaTokens7d`
  para decidir exibição e renderizar bars. As duas `if` de
  `quotaSessions5h/7d` **removidas**. `anyThresholdSet` checa só
  os 2 fields de tokens.

- [ ] **REQ-4**: GIVEN `app/quota/page.tsx` WHEN renderizado THEN
  **não** cria KpiCards pra `sessions5h` / `sessions7d`. Os 2 cards
  correspondentes (`s5h`, `s7d`) removidos.

### Dialog + edição inline

- [ ] **REQ-5**: GIVEN `components/quota/quota-token-card.tsx` (novo)
  WHEN renderizado com props `{ window: '5h' | '7d'; used: number;
  limit: number | null; resetInMs: number | null;
  currentSettings: { quotaTokens5h: number | null; quotaTokens7d: number | null } }`
  THEN:
  - Client Component (`'use client'`)
  - Sem threshold (`limit === null`): mostra valor `used` formatado +
    label "sem threshold · clique pra definir" + ícone de lápis no
    canto superior direito. Card inteiro é clicável + Enter/Space
    abrem o dialog.
  - Com threshold: mostra `fmtCompact(used) / fmtCompact(limit)`,
    `QuotaBar`, reset countdown (REQ-8), ícone de lápis no canto
    superior direito que abre dialog.

- [ ] **REQ-6**: GIVEN o dialog de edição WHEN aberto THEN exibe:
  - Título: "Threshold · Tokens — janela 5h" ou "...7d" (deriva
    de `window`)
  - 1 `<input type="number">` com valor atual preenchido, `min={1}`,
    `max={1_000_000_000}`, `step={1}`, `aria-label="Valor em tokens"`
  - Helper text curto: "Ex: 500000. Input+output combinados. Vazio =
    remover threshold."
  - Botões: "Cancelar" (fecha) e "Salvar" (dispara Server Action)
  - Implementação com elemento nativo `<dialog>` + `ref.showModal()`
    pra abrir, `dialog.close()` pra fechar. Click no backdrop fecha
    (padrão do browser com `::backdrop`). `Esc` fecha (padrão do
    browser). Focus trap automático.

- [ ] **REQ-7**: GIVEN o dialog WHEN o usuário clica Salvar THEN
  chama `updateQuotaSettings` com payload `{ quotaTokens5h, quotaTokens7d }`
  — só dois campos (REQ-1). O valor do campo atual vem do dialog;
  o outro vem de `currentSettings` (passa inalterado). Zod valida;
  se erro, exibe inline no dialog (aria-invalid + `<p role="alert">`);
  se sucesso, fecha dialog e `router.refresh()` pra re-query os
  dados do servidor.

### Reset countdown

- [ ] **REQ-8**: GIVEN `lib/queries/quota.ts` WHEN carregado THEN
  exporta `getQuotaResetEstimates(db: DB, now: number): { reset5hMs: number | null; reset7dMs: number | null }`.
  Algoritmo **5h**:
  1. `SELECT timestamp FROM turns WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 1000` com cutoff `now - 10h`
  2. Se lista vazia: retorna `reset5hMs: null`
  3. Se turn mais recente `> 5h` atrás: `reset5hMs: null` (bloco
     expirou)
  4. Walk through pairs consecutivos DESC procurando
     `newer.ts - older.ts > 5h * 1000`; primeiro encontrado → `blockStart = newer.ts`
  5. Se nenhum gap: `blockStart = oldest turn na lista`
  6. `reset5hMs = blockStart + 5h * 1000`

  Algoritmo **7d**:
  1. `SELECT MIN(timestamp) FROM turns WHERE timestamp >= ?` com cutoff `now - 7d`
  2. Se `null`: `reset7dMs: null`
  3. `reset7dMs = min + 7d * 1000`

- [ ] **REQ-9**: GIVEN o card de Tokens 5h/7d WHEN `resetInMs !== null`
  THEN exibe linha de hint: `Reseta em ~{fmtDuration(resetInMs - now)}`
  onde `fmtDuration` é helper novo (`lib/fmt.ts`) retornando:
  - `< 60s`: `"agora"`
  - `< 60min`: `"Xm"` (e.g., `"43m"`)
  - `< 24h`: `"XhYm"` (e.g., `"2h15m"`, ou `"2h"` quando minutos==0)
  - `< 7d`: `"Xd"` com fração quando relevante (e.g., `"3d"`, `"5d12h"`)
  - `>= 7d`: `"7d+"` (cap pra não mentir precisão)
  Texto final exato: `"Reseta em ~43m"`, `"Reseta em ~3d"`. Se
  `resetInMs === null`: exibe `"Sem atividade recente — próxima
  mensagem inicia bloco"` pra 5h ou `"Sem atividade nos últimos 7
  dias"` pra 7d.

- [ ] **REQ-10**: GIVEN `fmtDuration(ms: number)` WHEN `ms <= 0` THEN
  retorna `"agora"` (reset já passou — UI não deve mostrar negativo).

### Layout reorganization

- [ ] **REQ-11**: GIVEN `app/quota/page.tsx` WHEN renderizado THEN
  a estrutura vertical é:
  1. `<header>` (h1 "Quota do Max" + parágrafo de contexto
     atualizado — REQ-15)
  2. `<section>` com grid `grid-cols-1 md:grid-cols-2 gap-6` dos 2
     `QuotaTokenCard` (5h + 7d), **sempre renderizado** (mesmo sem
     threshold — empty state no card)
  3. `<QuotaHeatmap>` em contexto full-width (sem wrapper de
     largura máxima adicional além do layout padrão), com label
     "Padrão de consumo (últimas 4 semanas)" já existente
  4. **Sem** `<section>Thresholds` (form deletado — REQ-12)
  5. **Sem** o `<div role="status">` "Defina seu primeiro threshold
     abaixo pra ver consumo" — substituído pelo empty-state por
     card (REQ-5)

- [ ] **REQ-12**: GIVEN `components/quota/quota-form.tsx` WHEN esta
  spec completa THEN o arquivo é **deletado**. Import em
  `app/quota/page.tsx` removido.

- [ ] **REQ-13**: GIVEN o `QuotaHeatmap` WHEN renderizado no novo
  layout THEN tem espaço vertical adequado — ajuste de margem top
  (`mt-10` na section wrapper) pra separar visualmente do grid dos
  cards. Heading interno do heatmap preservado.

- [ ] **REQ-14**: GIVEN os 2 `QuotaTokenCard` WHEN vistos em
  viewport ≥md THEN ocupam 50% da largura cada (grid 2-col). Em
  `<md`, stack vertical 1-col. Cards são visivelmente maiores que
  `KpiCard` padrão: font do valor `text-4xl` (vs `text-3xl` do
  KpiCard), padding maior (`p-6`), hover state sutil (border color
  mudança).

- [ ] **REQ-15**: GIVEN o `<header>` da `/quota` WHEN renderizado
  THEN o parágrafo de contexto é reescrito pra explicar as 2
  janelas distintas do Max:

  ```text
  O plano Claude Max tem duas janelas de consumo: sessão de 5h
  (começa na sua primeira mensagem, reseta 5h depois) e semana
  rolling de 7 dias. Calibre cada threshold baseado no painel
  Account & Usage do Claude.ai — nós não temos como descobrir os
  números oficiais.
  ```

### Backward-compat

- [ ] **REQ-16**: GIVEN o schema SQLite `sessions` e `user_settings`
  WHEN migração roda em DB existente THEN nenhuma coluna é
  alterada/dropada. `quota_sessions_5h` e `quota_sessions_7d` ficam
  como colunas órfãs (reads ignorados, writes sempre null pós-REQ-2).

## Test Plan

> **Nota**: REQ-12, REQ-15 são mudanças declarativas (delete + copy)
> cobertas via TC-E2E-07 (form ausente) e TC-E2E-08 (novo copy). Sem
> TC dedicado.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | validation | `QuotaSettingsSchema.parse({ quotaTokens5h: 500000, quotaTokens7d: 3000000 })` | aceita, retorna objeto com 2 fields |
| TC-U-02 | REQ-1 | validation | Schema recebe input com extra `quotaSessions5h: 100` | Zod strip (sem erro) — `.parse()` não tem `.strict()`; campo ignorado |
| TC-U-03 | REQ-1 | validation | Schema com `quotaTokens5h: 0` | rejeita (positive) |
| TC-U-04 | REQ-1 | validation | Schema com `quotaTokens5h: -5` | rejeita |
| TC-U-05 | REQ-1 | validation | Schema com `quotaTokens5h: 1_000_000_001` | rejeita (max 1B) |
| TC-U-06 | REQ-1 | validation | Schema com `quotaTokens5h: null, quotaTokens7d: null` | aceita (ambos nullable) |
| TC-U-07 | REQ-1 | validation | Schema com `quotaTokens5h: 1.5` (não-inteiro) | rejeita (int) |
| TC-U-08 | REQ-9 | happy | `fmtDuration(43 * 60_000)` | `"43m"` |
| TC-U-09 | REQ-9 | happy | `fmtDuration(2 * 3600_000 + 15 * 60_000)` | `"2h15m"` |
| TC-U-10 | REQ-9 | happy | `fmtDuration(2 * 3600_000)` | `"2h"` (minutos omitidos quando 0) |
| TC-U-11 | REQ-9 | happy | `fmtDuration(3 * 86_400_000)` | `"3d"` |
| TC-U-12 | REQ-9 | happy | `fmtDuration(5 * 86_400_000 + 12 * 3600_000)` | `"5d12h"` |
| TC-U-13 | REQ-9 | edge | `fmtDuration(30_000)` (30s) | `"agora"` |
| TC-U-14 | REQ-10 | edge | `fmtDuration(0)` | `"agora"` |
| TC-U-15 | REQ-10 | edge | `fmtDuration(-100_000)` (negativo) | `"agora"` |
| TC-U-16 | REQ-9 | edge | `fmtDuration(8 * 86_400_000)` | `"7d+"` (cap) |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | `executeQuotaSettingsUpdate` com payload `{ quotaTokens5h: 500000, quotaTokens7d: null }` | salva; `getUserSettings` retorna `{ ..., quotaSessions5h: null, quotaSessions7d: null }` |
| TC-I-02 | REQ-2 | business | DB pré-existente com `quota_sessions_5h = 100` (seed) → `executeQuotaSettingsUpdate` com novo payload | row atualizada; `quota_sessions_5h` vira `null` (REQ-2 força null) |
| TC-I-03 | REQ-8 | happy | `getQuotaResetEstimates` com 5 turns: oldest há 3h, demais nos últimos 3h | `reset5hMs ≈ (oldest_ts + 5h)`; `reset7dMs ≈ (oldest_ts + 7d)` |
| TC-I-04 | REQ-8 | edge | `getQuotaResetEstimates` em DB sem turns | `{ reset5hMs: null, reset7dMs: null }` |
| TC-I-05 | REQ-8 | edge | `getQuotaResetEstimates` com turn mais recente há 6h (fora da 5h window) | `reset5hMs: null`; `reset7dMs` pode estar setado se turn >= 7d atrás |
| TC-I-06 | REQ-8 | business | `getQuotaResetEstimates` com 2 turns: T1 há 6h, T2 há 2h (gap de 4h entre eles) | gap < 5h → block começa em T1 seria; mas T1 é > 5h atrás → walk continua; oldest turn dentro de 5h window é T2 → `reset5hMs = T2.ts + 5h` |
| TC-I-07 | REQ-8 | business | `getQuotaResetEstimates` com 3 turns: T1 há 8h, T2 há 2h, T3 há 30min (gap T2-T1 = 6h, detectado) | `blockStart = T2` (primeira após gap); `reset5hMs = T2.ts + 5h` |
| TC-I-08 | REQ-8 | edge | `getQuotaResetEstimates` com 1 turn sozinho há 1h | sem pairs — `blockStart = oldest (=only) turn`; `reset5hMs = turn.ts + 5h` |

### E2E Tests

Em [tests/e2e/quota-improvements.spec.ts](tests/e2e/quota-improvements.spec.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-11 | happy | Abrir `/quota` em DB seeded com threshold 5h setado | 2 cards (Tokens 5h + Tokens 7d) visíveis em grid 2-col em viewport ≥md |
| TC-E2E-02 | REQ-12 | happy | Abrir `/quota` | `<h2>Thresholds</h2>` **ausente** (`getByRole('heading', { name: 'Thresholds' }).count() === 0`); texto "Sessões — janela" ausente |
| TC-E2E-03 | REQ-5 | happy | `/quota` sem thresholds | 2 cards rendereizados em empty-state; texto "clique pra definir" visível |
| TC-E2E-04 | REQ-6 | happy | `/quota`, clicar ícone de lápis do card Tokens 5h | `<dialog>` abre; input com valor atual; foco no input |
| TC-E2E-05 | REQ-7 | happy | Dialog aberto, digitar 500000, clicar Salvar | dialog fecha; card atualiza pra mostrar `X / 500K`; `QuotaBar` visível |
| TC-E2E-06 | REQ-7 | validation | Dialog aberto, digitar -1 | erro inline visível; dialog **não** fecha |
| TC-E2E-07 | REQ-6 | happy | Dialog aberto, pressionar Esc | dialog fecha sem salvar; valor original preservado |
| TC-E2E-08 | REQ-15 | happy | `/quota` header | parágrafo contém "duas janelas" e "painel Account & Usage" |
| TC-E2E-09 | REQ-9 | happy | `/quota` com threshold + turns recentes (seed) | texto "Reseta em ~" visível em ambos os cards |
| TC-E2E-10 | REQ-9 | edge | `/quota` sem turns recentes, threshold setado | "Sem atividade recente — próxima mensagem inicia bloco" no card 5h |
| TC-E2E-11 | REQ-3 | happy | Setar threshold → abrir `/` | `QuotaNavWidget` no nav com 1-2 bars (só tokens; nunca `S 5h`/`S 7d`) |
| TC-E2E-12 | REQ-11 | happy | `/quota` | `QuotaHeatmap` visível abaixo dos cards (ordem DOM) |

## Design

### Architecture Decisions

**Dialog nativo HTML5** em vez de Radix Dialog/shadcn/ui. Razão:
zero dep, acessível out-of-the-box (focus trap + Esc + backdrop
click via `::backdrop`), matches a linha minimalista do projeto
(`components/ui/` hoje tem 3 primitivos). Se no futuro precisarmos
de animações/portal avançado, migração é reescrita localizada em
1 componente.

**`QuotaTokenCard` novo em vez de estender `KpiCard`**. Razão: o
caso de uso tem muitos requisitos específicos (ícone de lápis,
dialog embutido, empty-state clicável, reset countdown) que não
fazem sentido em cards genéricos. Extensão forçada bagunça a API
do KpiCard.

**Reset estimates em query dedicada** (`getQuotaResetEstimates`) em
vez de adicionar ao `getQuotaUsage`. Razão: usage é `sync + cached
preparado`, reset é walk-through com lógica. Separar mantém cada
função focada (single responsibility). Custo: 1 query extra por
render — negligível (SQLite local).

**`fmtDuration` em `lib/fmt.ts`**. Razão: utility reusável. Pode ser
consumido por outras telas (quanto tempo atrás foi ingest, TTL de
cache, etc.). Regras de formatação centralizadas.

**Remover Sessões**: Zod schema drops os 2 fields. Server Action
faz hard-wire `quotaSessions*: null` via `upsertUserSettings` pra
garantir que reads subsequentes vejam null. Colunas preservadas no
schema.sql → zero migration, zero data loss, reversível.

**Edit dialog edita 1 field mas envia payload completo**. Razão:
não queremos criar uma nova Server Action `updateSingleQuotaField`
(dobra superfície de API). Cliente monta o payload completo com
`{ [fieldBeingEdited]: newValue, [other]: currentSettings[other] }`.
Backwards-compat total.

### Files to Create

- `components/quota/quota-token-card.tsx` — Client Component com
  dialog embutido.
- `lib/fmt-duration.test.ts` — testes do helper (colocalizado com
  `lib/fmt.ts`; novo arquivo porque `lib/fmt.test.ts` pode já
  existir — verificar; se existir, appendar).
- `tests/e2e/quota-improvements.spec.ts` — E2E (12 TCs).

### Files to Modify

- `lib/quota/schema.ts` — remove `quotaSessions5h`/`quotaSessions7d`
  do Zod.
- `lib/quota/actions.core.ts` — wire null nos sessions fields ao
  chamar `upsertUserSettings`.
- `lib/queries/quota.ts` — adiciona `getQuotaResetEstimates`.
- `lib/queries/quota.test.ts` — adiciona TC-I-03..08.
- `lib/quota/actions.core.test.ts` — adiciona TC-I-01..02 (se não
  existir, criar).
- `lib/fmt.ts` — adiciona `fmtDuration`.
- `components/quota/quota-nav-widget.tsx` — remove branches de
  sessions.
- `app/quota/page.tsx` — reescrita completa: header atualizado,
  cards novos, form removido, heatmap ao fim.
- `components/quota/quota-form.tsx` — **deleta**.

### Dependencies

Zero. `<dialog>` é DOM padrão (Baseline 2022, suportado em todos
browsers modernos).

### SQL da query nova

```sql
-- Input: cutoff10h = now - 10 * 3600_000, usado pelo algoritmo 5h
SELECT timestamp
FROM turns
WHERE timestamp >= ?
ORDER BY timestamp DESC
LIMIT 1000;

-- Input: cutoff7d = now - 7 * 86_400_000, usado pelo algoritmo 7d
SELECT MIN(timestamp) AS t
FROM turns
WHERE timestamp >= ?;
```

Limite de 1000 no primeiro é guarda (10h dificilmente tem >1000
turns; cap evita surprise perf hit).

### TypeScript: algoritmo 5h block-start

```ts
const FIVE_H_MS = 5 * 3600_000;

type TimestampRow = { timestamp: number };

const computeReset5h = (
  turnsDesc: readonly TimestampRow[],
  now: number,
): number | null => {
  if (turnsDesc.length === 0) return null;
  const mostRecent = turnsDesc[0].timestamp;
  if (now - mostRecent > FIVE_H_MS) return null; // block expirou

  // Walk DESC procurando gap > 5h entre pares consecutivos
  for (let i = 0; i < turnsDesc.length - 1; i++) {
    const newer = turnsDesc[i].timestamp;
    const older = turnsDesc[i + 1].timestamp;
    if (newer - older > FIVE_H_MS) {
      return newer + FIVE_H_MS; // block começa em `newer`
    }
  }

  // Sem gap: block começa no mais antigo dentro da janela
  const oldest = turnsDesc[turnsDesc.length - 1].timestamp;
  return oldest + FIVE_H_MS;
};
```

## Tasks

- [ ] TASK-1: Helper `fmtDuration` + testes
  - files: lib/fmt.ts, lib/fmt-duration.test.ts
  - tests: TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16

- [ ] TASK-2: Zod schema sem sessões
  - files: lib/quota/schema.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07

- [ ] TASK-3: `executeQuotaSettingsUpdate` force null em sessions
  - files: lib/quota/actions.core.ts, lib/quota/actions.core.test.ts
  - depends: TASK-2
  - tests: TC-I-01, TC-I-02

- [ ] TASK-4: `getQuotaResetEstimates` query + testes
  - files: lib/queries/quota.ts, lib/queries/quota.test.ts
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08

- [ ] TASK-5: `QuotaTokenCard` component + dialog
  - files: components/quota/quota-token-card.tsx
  - depends: TASK-1
  - tests: (E2E via TASK-SMOKE)

- [ ] TASK-6: `QuotaNavWidget` sem sessões
  - files: components/quota/quota-nav-widget.tsx
  - tests: (E2E via TASK-SMOKE)

- [ ] TASK-7: Reescrever `app/quota/page.tsx` + deletar `quota-form.tsx`
  - files: app/quota/page.tsx, components/quota/quota-form.tsx
  - depends: TASK-3, TASK-4, TASK-5, TASK-6
  - tests: (E2E via TASK-SMOKE)

- [ ] TASK-SMOKE: E2E em `tests/e2e/quota-improvements.spec.ts`
  - files: tests/e2e/quota-improvements.spec.ts
  - depends: TASK-7
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07, TC-E2E-08, TC-E2E-09, TC-E2E-10, TC-E2E-11, TC-E2E-12

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-4, TASK-6]    — 4 paralelos (todos files exclusivos)
Batch 2: [TASK-3, TASK-5]                     — 2 paralelos (deps satisfeitos; files exclusivos)
Batch 3: [TASK-7]                             — depends TASK-3 + TASK-4 + TASK-5 + TASK-6
Batch 4: [TASK-SMOKE]                         — depends TASK-7
```

File overlap analysis:

- `lib/fmt.ts` → TASK-1 (exclusivo)
- `lib/fmt-duration.test.ts` → TASK-1 (novo)
- `lib/quota/schema.ts` → TASK-2 (exclusivo)
- `lib/quota/actions.core.ts` → TASK-3 (exclusivo)
- `lib/queries/quota.ts` → TASK-4 (exclusivo)
- `lib/queries/quota.test.ts` → TASK-4 (exclusivo)
- `components/quota/quota-token-card.tsx` → TASK-5 (novo)
- `components/quota/quota-nav-widget.tsx` → TASK-6 (exclusivo)
- `app/quota/page.tsx` → TASK-7 (exclusivo)
- `components/quota/quota-form.tsx` → TASK-7 (delete)
- `tests/e2e/quota-improvements.spec.ts` → TASK-SMOKE (novo)

Nenhum conflito. Batch 1 roda 4 tasks em paralelo via worktrees.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (+ ~26 testes novos: 16 unit + 8 integration)
- [ ] `pnpm test:e2e tests/e2e/quota-improvements.spec.ts` passes (12 TCs)
- [ ] `pnpm build` passes
- [ ] Checkpoint 2 — live validation: dev server contra DB real
  - `curl /quota` HTTP 200
  - grep HTML por "Reseta em" (countdown renderiza)
  - grep HTML por `<dialog>` (presente no DOM)
  - **ausência** de `<h2>Thresholds</h2>` e `<form>` no /quota
  - ausência de texto "Sessões — janela"
  - `sqlite3 data/dashboard.db "SELECT quota_sessions_5h FROM user_settings WHERE id=1"` →
    valor após uma operação de save via dialog deve ser NULL

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
