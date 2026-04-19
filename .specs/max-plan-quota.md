# Spec: Max Plan Quota — tracking uso vs quota em janelas deslizantes

## Status: DONE

## Context

No plano Claude Max, o limitante real não é $ mas **rate limit**: a Anthropic reseta quota em janelas de 5h e tem um cap agregado semanal. Ao bater o teto, o Claude Code trava. A feature "Budget mensal" do roadmap não se aplica (plano fixo), mas a mesma UI — barra de progresso + KPI mudando de cor — serve pra "quanto da minha janela de 5h eu já queimei?" e "tô chegando no cap semanal?".

Como a Anthropic **não publica** os limites exatos do Max, a calibração é empírica: o usuário define o threshold baseado em quando já bateu rate-limit. Depois disso, a UI mostra consumo corrente vs threshold definido. Se o usuário nunca definir threshold, a feature é discreta — widget do nav fica escondido, nenhum KPI de quota aparece.

### Decisões já travadas (não pedir clarificação)

1. **Métrica primária**: tokens input + output (sem cache). Cache tem peso menor nos rate limits da Anthropic; excluí-lo dá um número mais honesto.
2. **Métrica secundária**: contagem de **sessões** iniciadas na janela (proxy pra "quantas conversas novas abri"). Escolha do usuário — turns seria mais preciso como proxy de "mensagens", mas a preferência registrada foi sessões.
3. **Janelas**: **rolling** de 5h e 7d. Cutoff = `now - N ms`. Nota de UI: o Max reseta em janela fixa começando da primeira mensagem do período, então rolling é aproximação — documentado em tooltip.
4. **Thresholds user-configurable** em tabela `user_settings` (singleton). Todos os 4 campos nullable. `null` = sem threshold definido = sem barra/KPI correspondente na UI.
5. **Color bands**: verde `pct < 0.70`; amber `0.70 <= pct < 0.90`; vermelho `pct >= 0.90`. Overflow (`pct > 1.0`) mostra valor real no texto (ex: "108%") mantendo barra saturada em 100% visual.
6. **Persistência via Server Action + revalidate** — sem API route. Form em `/quota` submete, Zod valida, upsert, `revalidatePath('/', 'layout')` pra atualizar o widget do nav em todas as rotas.
7. **Heatmap**: weekday × hora, agregando `input_tokens + output_tokens` das últimas 4 semanas. Intensidade de cor por percentil (mesma paleta dos outros heatmaps do projeto). Propósito: identificar padrões ("sempre travo nas segundas de manhã").
8. **Nav link** `/quota` adicionado ao array de links em `components/nav.tsx`.
9. **Widget do nav**: Server Component dentro do slot do `Nav`. Query fresca a cada render (Next cacheia a layout, mas o `dynamic = 'force-dynamic'` implícito via `getDb()` garante leitura atualizada).
10. **Fora de escopo** (explicitamente): detecção automática de rate-limit errors no transcript; auto-calibração de threshold baseada em histórico de erros; notificação via system/desktop; configuração por família de modelo.

### Esta spec supersede

A entrada "Budget mensal com alerta visual" do `roadmap.md`. Razão: em plano fixo (Max) não existe "gasto monetário crescendo contra um teto" — o custo real é sunk. O teto real é rate limit. Mesma UX, denominador diferente.

## Requirements

- [ ] **REQ-1**: GIVEN `migrate()` executa em DB sem a tabela `user_settings` WHEN completa THEN a tabela existe com schema: `id INTEGER PRIMARY KEY CHECK (id = 1)`, `quota_tokens_5h INTEGER`, `quota_tokens_7d INTEGER`, `quota_sessions_5h INTEGER`, `quota_sessions_7d INTEGER`, `updated_at INTEGER NOT NULL`. Constraint `CHECK (id = 1)` garante singleton.

- [ ] **REQ-2**: GIVEN `migrate()` executa em DB que já tem a tabela WHEN completa THEN nenhum erro é lançado e nenhuma linha é alterada (idempotente).

- [ ] **REQ-3**: GIVEN DB fresco (sem row em `user_settings`) WHEN `getUserSettings(db)` é chamado THEN retorna `{ quotaTokens5h: null, quotaTokens7d: null, quotaSessions5h: null, quotaSessions7d: null, updatedAt: null }`.

- [ ] **REQ-4**: GIVEN `upsertUserSettings(db, { quotaTokens5h: 50000, quotaTokens7d: 500000, quotaSessions5h: null, quotaSessions7d: null })` seguido de `getUserSettings(db)` WHEN chamado THEN retorna exatamente os valores passados (incluindo os nulls) e `updatedAt` = `Date.now()` (ou timestamp injetado).

- [ ] **REQ-5**: GIVEN a Server Action `updateQuotaSettings` WHEN invocada com qualquer campo negativo, não-inteiro, ou `> 1_000_000_000` (tokens) / `> 10_000` (sessões) THEN retorna `{ ok: false, error: { message: string, field: keyof QuotaSettings } }` e nenhum write acontece.

- [ ] **REQ-6**: GIVEN a Server Action `updateQuotaSettings` WHEN invocada com valores válidos (positivos, integers, dentro dos bounds, ou `null`) THEN faz upsert, chama `revalidatePath('/', 'layout')` e retorna `{ ok: true }`.

- [ ] **REQ-7**: GIVEN turns em `turns` com timestamps WHEN `getQuotaUsage(db, now)` é chamado THEN retorna `{ tokens5h, tokens7d, sessions5h, sessions7d }` onde:
  - `tokens5h = SUM(input_tokens + output_tokens)` de turns com `timestamp >= now - 5*3600*1000`
  - `tokens7d = SUM(input_tokens + output_tokens)` de turns com `timestamp >= now - 7*24*3600*1000`
  - `sessions5h = COUNT(*)` de sessions com `started_at >= now - 5*3600*1000`
  - `sessions7d = COUNT(*)` de sessions com `started_at >= now - 7*24*3600*1000`
  Todos os campos são `number` (nunca null). Window vazia retorna 0.

- [ ] **REQ-8**: GIVEN `getQuotaUsage` com DB vazio WHEN chamado THEN retorna `{ tokens5h: 0, tokens7d: 0, sessions5h: 0, sessions7d: 0 }`.

- [ ] **REQ-9**: GIVEN `user_settings` com todos os thresholds `null` WHEN `QuotaNavWidget` renderiza THEN não renderiza nada (retorna `null`). Ninguém vê quota até definir ao menos 1 threshold.

- [ ] **REQ-10**: GIVEN `user_settings` com `quotaTokens5h = 50000` e usage de 35000 tokens nas últimas 5h WHEN `QuotaNavWidget` renderiza THEN mostra 1 barra compacta (largura fixa ~80px) com label "5h: 70%" (ou valor calculado) e cor verde/amber/red conforme REQ-12.

- [ ] **REQ-11**: GIVEN 2+ thresholds definidos WHEN `QuotaNavWidget` renderiza THEN mostra 1 barra por threshold, lado a lado com gap pequeno. Ordem: `tokens5h`, `tokens7d`, `sessions5h`, `sessions7d`. Barras com threshold `null` omitidas.

- [ ] **REQ-12**: GIVEN um `pct = used / threshold` WHEN determinando a cor THEN verde se `pct < 0.70`, amber se `0.70 <= pct < 0.90`, vermelho se `pct >= 0.90`. Bounds inclusivos-na-esquerda.

- [ ] **REQ-13**: GIVEN `pct > 1.0` (overflow — usuário já passou do threshold) WHEN renderiza a barra THEN o preenchimento visual fica em 100% (não estoura a barra) mas o texto mostra o valor real (ex: "108%") e a cor é vermelha.

- [ ] **REQ-14**: GIVEN `/quota` é acessado pela primeira vez (sem settings) WHEN renderiza THEN mostra: H1 "Quota do Max" + parágrafo explicativo (rolling window, calibração manual) + form com 4 inputs nullable vazios + botão "Salvar" + CTA "Defina seu primeiro threshold pra ver consumo".

- [ ] **REQ-15**: GIVEN `/quota` com thresholds definidos e turns no DB WHEN renderiza THEN mostra 1 KpiCard por threshold com: label, `used / threshold` em números absolutos, pct, cor correspondente. Thresholds `null` não geram card.

- [ ] **REQ-16**: GIVEN `/quota` com turns nos últimos 28 dias WHEN renderiza THEN mostra heatmap 7×24 (dia-da-semana × hora, timezone local do sistema) com intensidade de cor proporcional aos tokens consumidos em cada célula. Título: "Padrão de consumo (últimas 4 semanas)". Células vazias com cor neutra/cinza. Eixo X = horas (0-23), eixo Y = dias (seg, ter, ... dom).

- [ ] **REQ-17**: GIVEN form de thresholds submetido com valores válidos WHEN Server Action completa THEN a página `/quota` atualiza (nova leitura) e o nav widget em qualquer rota reflete os novos thresholds imediatamente (via `revalidatePath('/', 'layout')`).

- [ ] **REQ-18**: GIVEN form com valor inválido (ex: `-1` em tokens) WHEN submetido THEN Server Action retorna erro sem persistir; form mostra mensagem do erro próximo ao campo inválido.

- [ ] **REQ-19**: GIVEN `components/nav.tsx` WHEN renderizado THEN contém link `/quota` com label "Quota" entre "Efetividade" e "Busca" no array de links.

- [ ] **REQ-20**: GIVEN qualquer KpiCard de quota em `/quota` WHEN hover no ícone de info THEN tooltip explica: "Janela rolling — o Max reseta a cada 5h contadas da primeira mensagem do período. Este número pode estar levemente à frente do real se você começou recentemente." Tooltip usa o slot `info` existente em `KpiCard`.

## Test Plan

### Unit Tests

Em [lib/quota/color.test.ts](lib/quota/color.test.ts) (pura, color logic) e [lib/quota/schema.test.ts](lib/quota/schema.test.ts) (Zod validation).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-12 | happy | `quotaBand(0.0)` | `'green'` |
| TC-U-02 | REQ-12 | edge | `quotaBand(0.69)` | `'green'` |
| TC-U-03 | REQ-12 | edge | `quotaBand(0.70)` | `'amber'` |
| TC-U-04 | REQ-12 | happy | `quotaBand(0.80)` | `'amber'` |
| TC-U-05 | REQ-12 | edge | `quotaBand(0.89)` | `'amber'` |
| TC-U-06 | REQ-12 | edge | `quotaBand(0.90)` | `'red'` |
| TC-U-07 | REQ-12 | happy | `quotaBand(1.00)` | `'red'` |
| TC-U-08 | REQ-13 | edge | `quotaBand(1.50)` | `'red'` (overflow stays red) |
| TC-U-09 | REQ-13 | happy | `computeFillPct(1.50)` | `1.0` (capped visually) |
| TC-U-10 | REQ-13 | happy | `computeFillPct(0.62)` | `0.62` |
| TC-U-11 | REQ-13 | edge | `computeFillPct(0)` | `0` |
| TC-U-12 | REQ-5 | validation | Zod schema: `quotaTokens5h = -1` | rejeita |
| TC-U-13 | REQ-5 | validation | Zod schema: `quotaTokens5h = 0` | rejeita (threshold de 0 é inútil — use null) |
| TC-U-14 | REQ-5 | validation | Zod schema: `quotaTokens5h = 1` | aceita (lower bound) |
| TC-U-15 | REQ-5 | validation | Zod schema: `quotaTokens5h = 1_000_000_000` | aceita (upper bound) |
| TC-U-16 | REQ-5 | validation | Zod schema: `quotaTokens5h = 1_000_000_001` | rejeita (> upper bound) |
| TC-U-17 | REQ-5 | validation | Zod schema: `quotaTokens5h = 1.5` | rejeita (non-integer) |
| TC-U-18 | REQ-5 | validation | Zod schema: `quotaTokens5h = null` | aceita (null é válido) |
| TC-U-19 | REQ-5 | validation | Zod schema: `quotaSessions5h = 10_001` | rejeita (> upper bound de sessões) |
| TC-U-20 | REQ-5 | validation | Zod schema: `quotaSessions5h = 10_000` | aceita (upper bound de sessões) |
| TC-U-21 | REQ-5 | validation | Zod schema: todos os 4 campos null | aceita (resetar tudo é válido) |

### Integration Tests

Em [lib/queries/quota.test.ts](lib/queries/quota.test.ts) (queries) e [lib/db/migrate.test.ts](lib/db/migrate.test.ts) (migração idempotente). Usam real better-sqlite3 em memória.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `migrate()` em DB fresh | tabela `user_settings` existe, schema conforme spec |
| TC-I-02 | REQ-2 | idempotency | `migrate()` 2× seguidos | sem erro, sem linha duplicada |
| TC-I-03 | REQ-1 | business | `INSERT INTO user_settings (id, ...) VALUES (2, ...)` | rejeitado pelo CHECK constraint |
| TC-I-04 | REQ-3 | happy | `getUserSettings(db)` em DB fresh | retorna todos null + `updatedAt: null` |
| TC-I-05 | REQ-4 | happy | `upsertUserSettings` + `getUserSettings` | retorna valores passados, `updatedAt` preenchido |
| TC-I-06 | REQ-4 | idempotency | `upsertUserSettings` 2× com valores diferentes | a 2ª execução sobrescreve a 1ª; `updatedAt` atualiza |
| TC-I-07 | REQ-7 | happy | `getQuotaUsage` com 3 turns nos últimos 5h e 1 turn há 2 dias | `tokens5h = soma(3 turns)`, `tokens7d = soma(4 turns)` |
| TC-I-08 | REQ-7 | edge | `getQuotaUsage` com 1 turn exatamente em `now - 5h` | tokens5h inclui esse turn (inclusivo no lower bound) |
| TC-I-09 | REQ-7 | edge | `getQuotaUsage` com 1 turn em `now - 5h - 1ms` | tokens5h NÃO inclui esse turn |
| TC-I-10 | REQ-7 | business | `getQuotaUsage`: soma exclui cache (`cache_read_tokens`, `cache_creation_tokens`) | apenas `input_tokens + output_tokens` contam |
| TC-I-11 | REQ-7 | happy | `getQuotaUsage` com 2 sessions em 5h, 5 sessions em 7d | `sessions5h = 2`, `sessions7d = 5` |
| TC-I-12 | REQ-8 | edge | `getQuotaUsage` em DB vazio | todos zero, nunca null |
| TC-I-13 | REQ-6 | happy | Server Action com payload válido | upsert acontece, `revalidatePath` chamado, retorna `{ ok: true }` |
| TC-I-14 | REQ-5 | validation | Server Action com `quotaTokens5h = -1` | `{ ok: false, error }`, sem write |
| TC-I-15 | REQ-16 | happy | `getQuotaHeatmap(db, now)` com turns em ~15 células distintas | retorna array de `{ dow, hour, tokens }` com 15+ entries; sum por célula correto |
| TC-I-16 | REQ-16 | edge | `getQuotaHeatmap` com DB vazio | retorna array vazio `[]` (não 168 células com zero) |
| TC-I-17 | REQ-16 | business | `getQuotaHeatmap` usa timestamp em **local time** (weekday/hour calculados no TZ do sistema) | turn à meia-noite UTC em TZ GMT-3 → dow = dia anterior, hour = 21 |

### E2E Tests

Em [tests/e2e/quota.spec.ts](tests/e2e/quota.spec.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-19 | happy | Abrir `/` | nav contém link "Quota" entre "Efetividade" e "Busca" |
| TC-E2E-02 | REQ-14 | happy | Abrir `/quota` em DB sem settings | H1 "Quota do Max" visível, CTA "Defina seu primeiro threshold" visível, form com 4 inputs vazios visível |
| TC-E2E-03 | REQ-17 | happy | Preencher `quotaTokens5h = 50000`, submit | página recarrega com o valor persistido; nav widget aparece com 1 barra; label contém "5h" |
| TC-E2E-04 | REQ-9 | edge | DB com todos thresholds null | nav widget NÃO aparece em nenhuma rota |
| TC-E2E-05 | REQ-18 | validation | Submeter form com `-1` no campo tokens5h | mensagem de erro visível; valor anterior persistido (não foi alterado) |
| TC-E2E-06 | REQ-16 | happy | Com turns seeded nos últimos 28d, abrir `/quota` com threshold setado | heatmap visível com título "Padrão de consumo (últimas 4 semanas)"; ao menos 1 célula colorida |
| TC-E2E-07 | REQ-15 | edge | Settings com só `quotaTokens5h` set, outros null; abrir `/quota` | exatamente 1 KpiCard de quota renderizado (não 4); label bate com `tokens5h` |
| TC-E2E-08 | REQ-20 | happy | Hover no ícone de info de um KpiCard de quota em `/quota` | tooltip contém a string "Janela rolling — o Max reseta a cada 5h" |

## Design

### Architecture Decisions

- **Tabela singleton**: `user_settings` tem `id INTEGER PRIMARY KEY CHECK (id = 1)`. Toda operação usa `id = 1` literal. O CHECK garante que ninguém insere um id diferente por acidente. Primary key dispensa index adicional.

- **Schema** (a ser adicionado em `lib/db/schema.sql`):

  ```sql
  CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    quota_tokens_5h INTEGER,
    quota_tokens_7d INTEGER,
    quota_sessions_5h INTEGER,
    quota_sessions_7d INTEGER,
    updated_at INTEGER NOT NULL
  );
  ```

  Nenhum backfill function needed — `CREATE TABLE IF NOT EXISTS` é suficiente (tabela nova em toda linha do tempo).

- **Upsert pattern**:

  ```sql
  INSERT INTO user_settings (id, quota_tokens_5h, quota_tokens_7d, quota_sessions_5h, quota_sessions_7d, updated_at)
  VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    quota_tokens_5h = excluded.quota_tokens_5h,
    quota_tokens_7d = excluded.quota_tokens_7d,
    quota_sessions_5h = excluded.quota_sessions_5h,
    quota_sessions_7d = excluded.quota_sessions_7d,
    updated_at = excluded.updated_at;
  ```

- **Queries** (em `lib/queries/quota.ts`):
  - `getUserSettings(db): UserSettings` — `SELECT ... WHERE id = 1`; se empty, retorna shape all-null.
  - `upsertUserSettings(db, input: UserSettings, now: number): void` — executa upsert acima.
  - `getQuotaUsage(db, now: number): QuotaUsage` — roda 4 sub-queries em sequência (tokens5h, tokens7d, sessions5h, sessions7d). Prepared statements cacheadas via WeakMap.
  - `getQuotaHeatmap(db, now: number): QuotaHeatmapCell[]` — `SELECT strftime('%w', timestamp/1000, 'unixepoch', 'localtime') AS dow, strftime('%H', ...) AS hour, SUM(input_tokens + output_tokens) AS tokens FROM turns WHERE timestamp >= now - 28*86400000 GROUP BY dow, hour`. Retorna só células não-vazias.

- **Pure helper** (em `lib/quota/color.ts`):

  ```ts
  export type QuotaBand = 'green' | 'amber' | 'red';
  export function quotaBand(pct: number): QuotaBand {
    if (pct < 0.70) return 'green';
    if (pct < 0.90) return 'amber';
    return 'red';
  }
  export function computeFillPct(pct: number): number {
    return Math.min(1, Math.max(0, pct));
  }
  ```

- **Zod schema** (em `lib/quota/schema.ts`):

  ```ts
  import { z } from 'zod';
  const tokenField = z.number().int().positive().max(1_000_000_000).nullable();
  const sessionField = z.number().int().positive().max(10_000).nullable();
  export const QuotaSettingsSchema = z.object({
    quotaTokens5h: tokenField,
    quotaTokens7d: tokenField,
    quotaSessions5h: sessionField,
    quotaSessions7d: sessionField,
  });
  export type QuotaSettings = z.infer<typeof QuotaSettingsSchema>;
  ```

  Note: `positive()` exclui zero — threshold 0 é inútil (usuário quer usar `null`).

- **Server Action** (em `lib/quota/actions.ts`):

  ```ts
  'use server';
  import { revalidatePath } from 'next/cache';
  import { getDb } from '@/lib/db/client';
  import { upsertUserSettings } from '@/lib/queries/quota';
  import { QuotaSettingsSchema } from './schema';

  export async function updateQuotaSettings(
    input: unknown,
  ): Promise<{ ok: true } | { ok: false; error: { message: string; field?: string } }> {
    const parsed = QuotaSettingsSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, error: { message: first.message, field: first.path.join('.') } };
    }
    upsertUserSettings(getDb(), parsed.data, Date.now());
    revalidatePath('/', 'layout');
    return { ok: true };
  }
  ```

- **QuotaBar component** (em `components/quota/quota-bar.tsx`, Server Component, puro):

  ```tsx
  export function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
    const pct = used / limit;
    const band = quotaBand(pct);
    const fill = computeFillPct(pct);
    const bandClasses = {
      green: 'bg-emerald-500',
      amber: 'bg-amber-500',
      red: 'bg-red-500',
    } as const;
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-neutral-400">{label}</span>
        <div className="h-1.5 w-16 rounded-full bg-neutral-800">
          <div className={cn('h-full rounded-full', bandClasses[band])} style={{ width: `${fill * 100}%` }} />
        </div>
        <span className="tabular-nums font-medium">{Math.round(pct * 100)}%</span>
      </div>
    );
  }
  ```

- **QuotaNavWidget** (em `components/quota/quota-nav-widget.tsx`, async Server Component):
  - Query `getUserSettings` + `getQuotaUsage`
  - Se todos thresholds null → retorna `null`
  - Senão, map filtrado de `(threshold, usage)` → array de `<QuotaBar />` lado a lado

- **/quota page** (em `app/quota/page.tsx`, Server Component):
  - Layout: H1 + parágrafo + KpiCards grid (condicional) + QuotaForm + QuotaHeatmap (condicional)
  - Queries: `getUserSettings`, `getQuotaUsage`, `getQuotaHeatmap`

- **QuotaForm** (em `components/quota/quota-form.tsx`, `'use client'`):
  - 4 `<input type="number">` nullables
  - Submit chama Server Action via `useFormStatus` ou `useFormState`
  - Renderiza erros inline

- **QuotaHeatmap** (em `components/quota/quota-heatmap.tsx`, Server Component, puro):
  - 7×24 grid
  - Células coloridas por intensidade (5 níveis via percentil)
  - Labels: Seg-Dom vertical, 0-23 horizontal
  - Reusar paleta neutra/amber do session-timeline-heatmap

- **Nav link** (em `components/nav.tsx`):
  - Adicionar `{ href: '/quota', label: 'Quota' }` entre efetividade e busca.

- **Layout integration** (em `app/layout.tsx`):

  ```tsx
  <Nav slot={
    <div className="flex items-center gap-3">
      <QuotaNavWidget />
      <OtelStatusBadge />
    </div>
  } />
  ```

### Files to Create

- `lib/db/user-settings.sql.ts` — (se usar SQL literal centralizado, não obrigatório; SQL inline nas queries já atende)
- `lib/quota/color.ts`
- `lib/quota/color.test.ts`
- `lib/quota/schema.ts`
- `lib/quota/schema.test.ts`
- `lib/quota/actions.ts`
- `lib/queries/quota.ts`
- `lib/queries/quota.test.ts`
- `app/quota/page.tsx`
- `components/quota/quota-bar.tsx`
- `components/quota/quota-nav-widget.tsx`
- `components/quota/quota-form.tsx`
- `components/quota/quota-heatmap.tsx`
- `tests/e2e/quota.spec.ts`

### Files to Modify

- `lib/db/schema.sql` — adicionar `user_settings` (additive)
- `lib/db/migrate.test.ts` — adicionar TC-I-01, TC-I-02, TC-I-03
- `components/nav.tsx` — adicionar link `/quota`
- `app/layout.tsx` — wrap slot com `<QuotaNavWidget /> + <OtelStatusBadge />`

### Dependencies

- Nenhuma nova dep. Zod, better-sqlite3, Next.js Server Actions já em uso.

## Tasks

- [x] TASK-1: Schema + migração `user_settings` + test de migração idempotente
  - files: lib/db/schema.sql, lib/db/migrate.test.ts
  - tests: TC-I-01, TC-I-02, TC-I-03

- [x] TASK-2: Queries `getUserSettings`, `upsertUserSettings`, `getQuotaUsage`, `getQuotaHeatmap`
  - files: lib/queries/quota.ts, lib/queries/quota.test.ts
  - depends: TASK-1
  - tests: TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11, TC-I-12, TC-I-15, TC-I-16, TC-I-17

- [x] TASK-3: Zod schema + Server Action `updateQuotaSettings`
  - files: lib/quota/schema.ts, lib/quota/schema.test.ts, lib/quota/actions.ts
  - depends: TASK-2
  - tests: TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-I-13, TC-I-14

- [x] TASK-4: Pure helpers `quotaBand` + `computeFillPct`
  - files: lib/quota/color.ts, lib/quota/color.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11

- [x] TASK-5: Componente `QuotaBar` (puro)
  - files: components/quota/quota-bar.tsx
  - depends: TASK-4

- [x] TASK-6: Componente `QuotaNavWidget` (async Server Component)
  - files: components/quota/quota-nav-widget.tsx
  - depends: TASK-2, TASK-5

- [x] TASK-7: Componente `QuotaForm` (`'use client'` + Server Action)
  - files: components/quota/quota-form.tsx
  - depends: TASK-3

- [x] TASK-8: Componente `QuotaHeatmap`
  - files: components/quota/quota-heatmap.tsx
  - depends: TASK-2

- [x] TASK-9: Página `/quota` agregando form + KPIs + heatmap
  - files: app/quota/page.tsx
  - depends: TASK-2, TASK-3, TASK-7, TASK-8

- [x] TASK-10: Nav link `/quota` + integração do widget no layout
  - files: components/nav.tsx, app/layout.tsx
  - depends: TASK-6

- [x] TASK-SMOKE: Testes E2E
  - files: tests/e2e/quota.spec.ts
  - depends: TASK-9, TASK-10
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07, TC-E2E-08

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-4]                    — paralelo (schema.sql/migrate.test.ts vs color.ts/color.test.ts — exclusive files)
Batch 2: [TASK-2, TASK-5]                    — paralelo (queries/quota.ts vs components/quota/quota-bar.tsx; TASK-2 depends TASK-1, TASK-5 depends TASK-4)
Batch 3: [TASK-3, TASK-6, TASK-8]            — paralelo (schema+actions vs nav-widget vs heatmap; TASK-3 depends TASK-2, TASK-6 depends TASK-2+TASK-5, TASK-8 depends TASK-2)
Batch 4: [TASK-7, TASK-10]                   — paralelo (quota-form.tsx vs nav.tsx+layout.tsx; TASK-7 depends TASK-3, TASK-10 depends TASK-6)
Batch 5: [TASK-9]                            — sequencial (page.tsx precisa de form+heatmap pronto; depends TASK-7, TASK-8)
Batch 6: [TASK-SMOKE]                        — E2E depois de tudo integrado
```

File overlap analysis:

- `lib/db/schema.sql`, `lib/db/migrate.test.ts`: exclusive TASK-1
- `lib/quota/color.ts`, `.test.ts`: exclusive TASK-4
- `lib/queries/quota.ts`, `.test.ts`: exclusive TASK-2
- `lib/quota/schema.ts`, `.test.ts`, `lib/quota/actions.ts`: exclusive TASK-3
- `components/quota/quota-bar.tsx`: exclusive TASK-5
- `components/quota/quota-nav-widget.tsx`: exclusive TASK-6
- `components/quota/quota-form.tsx`: exclusive TASK-7
- `components/quota/quota-heatmap.tsx`: exclusive TASK-8
- `app/quota/page.tsx`: exclusive TASK-9
- `components/nav.tsx`, `app/layout.tsx`: exclusive TASK-10
- `tests/e2e/quota.spec.ts`: exclusive TASK-SMOKE

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (∼30 novos TCs unit/integration)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (6 novos TC-E2E)

### Discipline Checkpoints (mandatory before reporting DONE)

**Checkpoint 1 — Self-review REQ-by-REQ**: walk REQ-1..REQ-20 com evidência concreta.

**Checkpoint 2 — Live validation com dados reais**:

- `pnpm dev` em background.
- `curl http://localhost:3000/quota` → HTTP 200, HTML contém H1 "Quota do Max".
- Com DB real (sem settings): curl `/quota` mostra CTA "Defina seu primeiro threshold"; curl `/` NÃO contém a classe do QuotaBar (widget oculto).
- Via UI: acessar `/quota`, setar `quotaTokens5h = 50000`, salvar; depois:
  - Recarregar `/quota` → valor persistido, card de KPI aparece.
  - Abrir `/` → nav widget visível com barra.
- Definir threshold absurdamente baixo (ex: `quotaTokens5h = 1000`) pra forçar overflow → verificar texto mostrando pct > 100% e cor vermelha.
- Inspecionar heatmap: células coloridas batem com SQL: `sqlite3 data/dashboard.db "SELECT strftime('%w', datetime(timestamp/1000, 'unixepoch', 'localtime')), strftime('%H', ...), SUM(input_tokens + output_tokens) FROM turns GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5"`.
- Parar dev server. Mencionar SIGTERM esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — TASK-1 + TASK-4 (2026-04-19 13:00)

Batch 1 paralelo via 2 worktrees. TASK-1: `user_settings` singleton table com `CHECK (id = 1)` em `schema.sql` + 3 TCs em `migrate.test.ts`. TASK-4: helpers puros `quotaBand`/`computeFillPct` em `lib/quota/color.ts` + 11 TC-Us. Drive-by fix pós-merge: `migrate.test.ts` TC-I-17 (pre-existente) faltava `cacheCreation5m/1h/serviceTier` no fixture — adicionado.
TDD (TASK-1): RED(3 failing) → GREEN(10 passing) → REFACTOR(clean). TDD (TASK-4): RED(import failed) → GREEN(11 passing) → REFACTOR(clean).

### Iteration 2 — TASK-2 + TASK-5 (2026-04-19 13:06)

Batch 2 paralelo via 2 worktrees. TASK-2: queries `getUserSettings`/`upsertUserSettings`/`getQuotaUsage`/`getQuotaHeatmap` em `lib/queries/quota.ts` + 13 TCs (incluindo 1 extra TC-I-16b pra cutoff de 28d). TASK-5: `QuotaBar` Server Component em `components/quota/quota-bar.tsx` (puro, usa helpers de TASK-4, classes Tailwind explícitas JIT-safe, role=progressbar + aria-values).
TDD (TASK-2): RED(import failed) → GREEN(13 passing) → REFACTOR(clean). TASK-5 sem tests metadata (cobertura via E2E).

### Iteration 3 — TASK-3 + TASK-6 + TASK-8 (2026-04-19 13:11)

Batch 3 paralelo via 3 worktrees. TASK-3: Zod schema `QuotaSettingsSchema` (tokens 1..1B, sessions 1..10k, nullable) + Server Action `updateQuotaSettings` com wrapper `'use server'` + lógica testável em `actions.core.ts`; 12 TCs (10 schema + 2 integration). TASK-6: `QuotaNavWidget` async Server Component que retorna `null` sem thresholds e renderiza 1..4 barras na ordem correta. TASK-8: `QuotaHeatmap` Server Component 7×24 com empty state pt-BR, ordem seg→dom, intensidade por quartis, tooltip por célula.
TDD (TASK-3): RED(imports failed) → GREEN(12 passing) → REFACTOR(clean). TASK-6 e TASK-8 sem tests metadata.

### Iteration 4 — TASK-7 + TASK-10 (2026-04-19 13:18)

Batch 4 paralelo via 2 worktrees. TASK-7: `QuotaForm` Client Component com `useState` + `useTransition`, 4 inputs number nullable (vazio=null), erro por campo via `aria-invalid`, botão "Salvando…" desabilitado durante transição. TASK-10: link "Quota" no nav.tsx (index 3, entre Efetividade e Busca) + layout.tsx envolve slot com `<div>` contendo `QuotaNavWidget` + `OtelStatusBadge`.
Ambas sem tests metadata (cobertura via E2E).

### Iteration 5 — TASK-9 (2026-04-19 13:24)

Página `/quota` em `app/quota/page.tsx` agrega: H1 "Quota do Max" + parágrafo explicativo (rolling window, calibração manual) + CTA condicional quando zero thresholds + grid de KpiCards (1 por threshold set, com `QuotaBar` embutido + tooltip `QUOTA_INFO`) + `QuotaForm` + `QuotaHeatmap`. `Date.now()` extraído pra helper `readNow` em module scope pra satisfazer `react-hooks/purity`.

### Iteration 6 — TASK-SMOKE (2026-04-19 13:33)

8 testes E2E em `tests/e2e/quota.spec.ts` (TC-E2E-01..08) cobrindo: nav link, empty state + CTA, form submit persistindo + widget aparecendo, widget ausente sem thresholds, erro de validação, heatmap, filtragem de KPIs por threshold set, tooltip de info. Todos 8 passando em 7s.
**Fix crítico pós-merge**: o worktree do TASK-1 partiu de commit antigo e sobrescreveu `lib/db/schema.sql` removendo colunas existentes (`total_cost_usd_otel`, `subagent_type`, cache-5m/1h, service_tier, tabela `cost_calibration`, comentários). Restaurado de HEAD, depois append limpo do bloco `user_settings`.
**Fix do cache de layout**: TC-E2E-04 inicialmente falhava porque `DELETE FROM user_settings` via better-sqlite3 direto não dispara `revalidatePath`, então o nav slot ficava com HTML stale. Solução: TC-E2E-04 agora limpa via form submit (a Server Action já chama `revalidatePath('/', 'layout')`).
