# Spec: UI Audit Fixes — atacar achados da curadoria frontend

## Status: DONE

## Context

Audit completo (agente frontend-sênior em 2026-04-19) identificou ~30 achados ao longo de 6 rotas × 2 temas × 2 viewports. Esta spec cobre **todos os achados P0, P1, P2 e os P3 mais baratos**. Deixamos de fora só aquilo que exige decisão de design aberta (ex: "migrar InfoTooltip pra Radix", "atalhos de teclado no rating").

### Heuristica de escopo

- **IN**: qualquer finding com fix concreto e < 30 min, agrupado em tasks temáticas.
- **OUT**: reescritas arquiteturais, mudanças de design aberto, dependências novas (excepto as que já discutimos).

### Decisões já travadas

1. **Paleta de status saturada**: padronizar `text-<cor>-600 dark:text-<cor>-400` pra tudo que era `text-red-400/text-emerald-300/text-amber-300/text-emerald-400` isolado (fora de estados com fundo colorido tipo `bg-emerald-950/40`). 4 cores afetadas: red, emerald, amber, yellow.
2. **Recharts theme-aware**: via CSS vars `--chart-grid`, `--chart-axis`, `--chart-tooltip-bg`, `--chart-tooltip-text`, `--chart-pie-stroke` em `globals.css`. Componentes leem via `getComputedStyle(document.documentElement).getPropertyValue('--chart-grid')` (client-side), evitando hydration mismatch pulando `mounted` state via `useEffect` + local state. Alternativa mais simples: usar `currentColor` onde faz sentido (labels texto).
3. **Error pages**: criar `app/error.tsx` global + `app/not-found.tsx` global. Sem duplicar pra `sessions/[id]` (o `notFound()` bubble pro raiz). Copy em pt-BR, botão "Tentar novamente" + link pra home.
4. **Empty state transcript ambíguo**: passar `session.turnCount` pro `TranscriptViewer` → quando `turns.length === 0 && turnCount > 0`, renderizar mensagem explicativa ("N turnos declarados mas nenhum ingerido — rode `pnpm ingest`"); quando ambos `=== 0`, mensagem atual ("Sem turnos nesta sessão").
5. **Mobile responsiveness**: nav com `overflow-x-auto` e `whitespace-nowrap`, OtelStatusBadge esconde label em xs (só dot), /sessions list ganha `flex-col md:flex-row` pra empilhar custo/turnos abaixo do projeto, ActivityHeatmap envolve em `overflow-x-auto` + remove `h-auto w-full` do SVG interno.
6. **Copy normalização**: "aval" → "Avaliação"; "ingira transcripts" → "rode `pnpm ingest`"; `{error.message}` cru do RatingWidget vira "Falha ao salvar avaliação"; surface mensagem de Zod do QuotaForm prefixada com "Erro: ".
7. **Quota heatmap palette**: criar CSS vars `--quota-heatmap-{empty,low,mid-low,mid-high,high}` (5 níveis) em `globals.css`, espelhando padrão do activity-heatmap. Células vazias viram cinza claro visível em light.
8. **Recharts Tooltip + Legend**: migrar `contentStyle.background/border/color` pros CSS vars. Pie stroke: `var(--chart-pie-stroke)`.
9. **A11y**: `aria-pressed` nos 3 toggles do RatingWidget; `<h2 className="sr-only">Transcript</h2>` antes do `<ol>` em `TranscriptViewer`; remover `autoFocus` do SearchForm ou condicionar a `pathname === '/search'` sem query param (fica focada só em primeira carga).
10. **ShareActions com sessão vazia**: esconder o grupo inteiro quando `turnCount === 0` (não faz sentido exportar session sem conteúdo). Passa `turnCount` via prop.

## Requirements

### Tema — paletas e classes

- [ ] **REQ-1**: GIVEN `/search` em light mode WHEN renderizada THEN form + hits usam paleta dual (`bg-white dark:bg-neutral-900`, `border-neutral-200 dark:border-neutral-800`, `text-neutral-900 dark:text-neutral-100`, etc). Zero `neutral-XXX` bare sem `dark:` prefix (exceto `text-neutral-500`).

- [ ] **REQ-2**: GIVEN qualquer componente que use `text-red-400`, `text-emerald-300`, `text-emerald-400`, `text-amber-300`, `text-amber-400`, `text-yellow-200` isolado (fora de contextos com fundo saturado) WHEN refactorado THEN vira `text-<cor>-600 dark:text-<cor>-400` (ou equivalente) e contraste ≥4.5:1 em ambos os temas.

- [ ] **REQ-3**: GIVEN banner "data inválida" em `app/sessions/page.tsx:121` WHEN renderizado em light mode THEN fundo amarelo claro (`bg-yellow-50 border-yellow-300 text-yellow-800`) com par `dark:bg-yellow-900/20 dark:border-yellow-700/50 dark:text-yellow-200`.

- [ ] **REQ-4**: GIVEN `globals.css` WHEN carregado THEN define CSS vars de Recharts: `--chart-grid`, `--chart-axis`, `--chart-tooltip-bg`, `--chart-tooltip-border`, `--chart-tooltip-text`, `--chart-pie-stroke`, `--chart-line-primary`, `--chart-line-secondary`, `--chart-positive`, `--chart-negative`. Duas paletas (`:root` light, `.dark` override).

- [ ] **REQ-5**: GIVEN todos os 5 componentes Recharts (`overview/trend-chart.tsx`, `effectiveness/ratio-trend.tsx`, `effectiveness/cost-per-turn-histogram.tsx`, `effectiveness/accept-rate-trend.tsx`, `effectiveness/tool-success-trend.tsx`, `effectiveness/model-breakdown.tsx`) WHEN refactorados THEN lêem as CSS vars via helper `readChartColors()` (`'use client'` + `useEffect`/`useState`) ou via `var(...)` direto quando possível. Strokes, fills, tooltip styles, legend colors — todos dinâmicos. Em dark mode visual permanece idêntico ao atual; em light mode fica legível.

- [ ] **REQ-6**: GIVEN `QuotaHeatmap` WHEN renderizado em light mode THEN intensidades low/mid/high usam paleta amber clara e células vazias visíveis (`bg-neutral-100` ou CSS var `--quota-heatmap-empty`). Dark mode permanece como estava.

- [ ] **REQ-7**: GIVEN `ModelBreakdown` com 2+ famílias WHEN pie chart renderiza THEN `<Pie stroke="var(--chart-pie-stroke)">`. Light: stroke ~ `#ffffff` (combina com card); dark: stroke ~ `#171717`.

### Páginas ausentes

- [ ] **REQ-8**: GIVEN um throw em qualquer Server Component WHEN a UI falha THEN `app/error.tsx` (Client Component com `reset`) renderiza mensagem em pt-BR ("Algo deu errado ao carregar esta página"), botão "Tentar novamente" (chama `reset()`), e link pra home.

- [ ] **REQ-9**: GIVEN navegação pra rota inexistente OU `notFound()` chamado WHEN Next executa THEN `app/not-found.tsx` renderiza "Página não encontrada", com contexto pra quem chegou via link quebrado, e link pra home.

- [ ] **REQ-10**: GIVEN `/quota` carregando WHEN Server Component resolve queries THEN `app/quota/loading.tsx` mostra skeleton apropriado (H1, 4 KPI skeletons, form skeleton, heatmap skeleton).

### Dados ambíguos

- [ ] **REQ-11**: GIVEN uma sessão com `turnCount > 0` mas `turns.length === 0` (transcript não ingerido) WHEN `/sessions/[id]` renderiza THEN mensagem clara: "Esta sessão declara N turnos mas nenhum foi ingerido. Rode `pnpm ingest` pra carregar o transcript." Distinto da mensagem "Sem turnos nesta sessão" (que fica para `turnCount === 0`).

- [ ] **REQ-12**: GIVEN `/sessions/[id]` com `turnCount === 0` WHEN renderiza THEN `<ShareActions />` NÃO é renderizado (exportar markdown de sessão vazia não faz sentido).

### Mobile / Responsive

- [ ] **REQ-13**: GIVEN viewport ≤640px WHEN `/` renderiza THEN nav tem `overflow-x-auto` no `<ul>` dos links, links com `whitespace-nowrap`; labels + dot do OtelStatusBadge: label vira `sr-only` em `<640px`, só o dot visível com `InfoTooltip` cobrindo contexto.

- [ ] **REQ-14**: GIVEN viewport ≤640px WHEN `/sessions` renderiza THEN cada item da lista empilha: linha 1 = projeto + data, linha 2 = custo + turnos + avaliação + chevron. Sem truncamento de projeto pra 1-2 letras.

- [ ] **REQ-15**: GIVEN viewport ≤640px WHEN `/` renderiza THEN `ActivityHeatmap` é envolvido em `<div className="overflow-x-auto">`, SVG mantém tamanho natural (sem `w-full h-auto` forçando shrink).

### Accessibility

- [ ] **REQ-16**: GIVEN `RatingWidget` WHEN renderizado THEN cada um dos 3 botões (Bom/Neutro/Ruim) tem `aria-pressed` refletindo seleção atual (`true` se `value === N`, `false` caso contrário).

- [ ] **REQ-17**: GIVEN `TranscriptViewer` WHEN `turns.length > 0` THEN inclui `<h2 className="sr-only">Transcript</h2>` antes do `<ol>`, pra landmark target de skip nav + screen reader.

- [ ] **REQ-18**: GIVEN `SearchForm` WHEN renderizado THEN input não tem `autoFocus`. Focus é aplicado programaticamente apenas se pathname for `/search` e `q` query param vazio (primeira entrada na rota sem query). Implementado via `useEffect` + `useSearchParams`.

### Copy / texto

- [ ] **REQ-19**: GIVEN `/sessions` lista WHEN renderizada THEN coluna que hoje se chama "aval" passa a "Avaliação" (ou mais curta consistente). Verificar também session detail + effectiveness que usam "Avaliação média" — mantém esse label.

- [ ] **REQ-20**: GIVEN empty state de `QuotaHeatmap` WHEN renderizado sem dados THEN texto é "Sem dados nos últimos 28 dias — rode `pnpm ingest` pra ver o padrão." (substituir "ingira transcripts").

- [ ] **REQ-21**: GIVEN `RatingWidget` falha ao salvar WHEN captura erro THEN mensagem surfaced é "Falha ao salvar avaliação" (não `{err.message}` cru).

- [ ] **REQ-22**: GIVEN `QuotaForm` Server Action retorna erro de Zod WHEN renderizado inline THEN prefixado com "Erro: " (ex: "Erro: Number must be positive"). Mensagens muito técnicas (ex: `"Invalid input"`) substituídas por "Valor inválido — verifique o campo.".

### Polish

- [ ] **REQ-23**: GIVEN `QuotaForm` 4 inputs number WHEN renderizados THEN cada um tem `placeholder="vazio = não rastrear"`.

- [ ] **REQ-24**: GIVEN `QuotaHeatmap` células vazias WHEN `tokens <= 0` THEN background é CSS var `--quota-heatmap-empty` resolvendo a `#e5e5e5` (light) e `#262626` (dark, mantém original). Garante contraste com o card.

- [ ] **REQ-25**: GIVEN `TurnScrollTo` WHEN renderizado THEN retorna `null` (não `<span aria-hidden="true" className="hidden print:hidden" />` — `hidden` já cobre ambos os modos, span é redundante).

- [ ] **REQ-26**: GIVEN `KpiCard` com rating médio null WHEN renderizado THEN `fmtRating(null)` retorna literal "Sem avaliação" (ou "—" com title explicativo). Hoje retorna `"—"` ambíguo.

## Test Plan

### Unit Tests

A maior parte do trabalho é refactor de classes/CSS. Unit tests focados em:

- Helper de cores de chart (se criado)
- `fmtRating(null)` se mudar
- Zod error messages remapeadas

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-26 | business | `fmtRating(null)` | retorna "Sem avaliação" |
| TC-U-02 | REQ-26 | happy | `fmtRating(0.75)` | formato atual mantido |
| TC-U-03 | REQ-26 | edge | `fmtRating(0)` | retorna formato não-null (não "Sem avaliação") |

### Integration Tests

Não aplicável — sem queries novas, sem API routes novas.

### E2E Tests

Em [tests/e2e/ui-audit.spec.ts](tests/e2e/ui-audit.spec.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1 | happy | `/search?q=test` em light mode | form input tem `color` resolvido light (não preto sobre preto); hits tem borders visíveis |
| TC-E2E-02 | REQ-9 | happy | `/rota-inexistente` | HTML contém "Página não encontrada" + link pra home |
| TC-E2E-03 | REQ-9 | edge | `/sessions/nonexistent-id` (força `notFound()`) | HTML contém "Página não encontrada" |
| TC-E2E-04 | REQ-11 | happy | Sessão com `turnCount > 0` e `turns` vazio (seed sintética) | HTML contém "N turnos declarados mas nenhum foi ingerido" |
| TC-E2E-05 | REQ-12 | edge | Sessão com `turnCount === 0` | HTML NÃO contém `aria-label="Compartilhar"` (ShareActions oculto) |
| TC-E2E-06 | REQ-13 | happy | Viewport 375×667 em `/` | nav tem scroll horizontal (clientWidth > offsetWidth do viewport) |
| TC-E2E-07 | REQ-16 | happy | RatingWidget — clicar "Bom" | botão Bom tem `aria-pressed="true"`, outros `false` |
| TC-E2E-08 | REQ-18 | a11y | Abrir `/` (não `/search`) | focus ativo NÃO está no input do SearchForm |
| TC-E2E-09 | REQ-18 | a11y | Abrir `/search` sem `?q=` | focus ativo está no input do SearchForm |
| TC-E2E-10 | REQ-18 | a11y | Abrir `/search?q=test` | focus NÃO está no input (usuário já tem query) |
| TC-E2E-11 | REQ-1 | happy | `/search?q=test` em dark mode | permanece idêntico ao comportamento anterior; zero regressão visual |

### Validação visual (Checkpoint 2 manual)

Sem TC automatizado pra contraste WCAG — validação manual com Chrome DevTools contrast checker em ≥5 pontos:

1. Rating "Bom" (verde) em light mode
2. Subagent "general-purpose" (amber) em light
3. Banner "data inválida" em light
4. Recharts grid/tooltip em light
5. Quota heatmap empty cell em light

## Design

### Architecture Decisions

- **Paleta de status**: mapping mecânico em 1 pass via Python regex (similar ao que fiz pra neutrals). Target: todos os `text-<cor>-300/400` que não estejam prefixados com `dark:` viram `text-<cor>-600 dark:text-<cor>-300/400`.

- **CSS vars de chart**: adicionar em `app/globals.css` no `:root` + `.dark`:

  ```css
  :root {
    /* ... existing vars ... */
    /* Chart palette — Recharts-facing */
    --chart-grid: #e5e5e5;          /* neutral-200 */
    --chart-axis: #737373;          /* neutral-500, readable both themes */
    --chart-tooltip-bg: #ffffff;
    --chart-tooltip-border: #e5e5e5;
    --chart-tooltip-text: #171717;
    --chart-pie-stroke: #ffffff;
    --chart-line-primary: #10b981;  /* emerald-500 */
    --chart-line-secondary: #a78bfa; /* violet-400 */
    --chart-positive: #10b981;
    --chart-negative: #ef4444;      /* red-500 */
    /* Quota heatmap 5-level ramp (light) */
    --quota-heatmap-empty: #e5e5e5;
    --quota-heatmap-low: #fef3c7;   /* amber-100 */
    --quota-heatmap-mid-low: #fde68a;
    --quota-heatmap-mid-high: #f59e0b;
    --quota-heatmap-high: #d97706;
  }
  .dark {
    /* ... existing overrides ... */
    --chart-grid: #262626;
    --chart-axis: #737373;
    --chart-tooltip-bg: #171717;
    --chart-tooltip-border: #262626;
    --chart-tooltip-text: #e5e5e5;
    --chart-pie-stroke: #171717;
    /* Quota heatmap 5-level ramp (dark) */
    --quota-heatmap-empty: #262626;
    --quota-heatmap-low: rgba(180,83,9,0.4);        /* amber-900/40 */
    --quota-heatmap-mid-low: rgba(146,64,14,0.6);   /* amber-800/60 */
    --quota-heatmap-mid-high: rgba(202,138,4,0.8);  /* amber-600/80 */
    --quota-heatmap-high: #f59e0b;                  /* amber-500 */
  }
  ```

- **Recharts theme-aware strokes**: Recharts aceita string em `stroke`/`fill`/`color`. CSS `var()` funciona em `stroke`/`fill` attrs no SVG. Porém, `contentStyle` é um JS object prop — precisa do valor resolvido. Solução:

  ```tsx
  'use client';
  import { useEffect, useState } from 'react';

  function useChartColors() {
    const [colors, setColors] = useState<{
      grid: string; axis: string; tooltipBg: string;
      tooltipBorder: string; tooltipText: string;
    }>(() => ({
      grid: '#262626', axis: '#737373',
      tooltipBg: '#171717', tooltipBorder: '#262626',
      tooltipText: '#e5e5e5',
    }));
    useEffect(() => {
      const read = () => {
        const s = getComputedStyle(document.documentElement);
        setColors({
          grid: s.getPropertyValue('--chart-grid').trim(),
          axis: s.getPropertyValue('--chart-axis').trim(),
          tooltipBg: s.getPropertyValue('--chart-tooltip-bg').trim(),
          tooltipBorder: s.getPropertyValue('--chart-tooltip-border').trim(),
          tooltipText: s.getPropertyValue('--chart-tooltip-text').trim(),
        });
      };
      read();
      // Re-read on theme toggle (class mutation on <html>)
      const obs = new MutationObserver(read);
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => obs.disconnect();
    }, []);
    return colors;
  }
  ```

  Útil para `contentStyle`, `stroke` direto se preferir var. Centralizar em `lib/chart-colors.ts`.

- **`app/error.tsx`** (Client Component obrigatório):

  ```tsx
  'use client';
  import { useEffect } from 'react';
  import Link from 'next/link';

  export default function Error({
    error,
    reset,
  }: {
    error: Error & { digest?: string };
    reset: () => void;
  }) {
    useEffect(() => {
      console.error(error);
    }, [error]);
    return (
      <div className="mx-auto max-w-2xl py-16 text-center space-y-4">
        <h1 className="text-2xl font-semibold">Algo deu errado ao carregar esta página</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          O servidor devolveu um erro inesperado. Você pode tentar novamente ou voltar pra home.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button onClick={reset} className="...">Tentar novamente</button>
          <Link href="/" className="...">Voltar pra home</Link>
        </div>
      </div>
    );
  }
  ```

- **`app/not-found.tsx`** (Server Component):

  ```tsx
  import Link from 'next/link';

  export default function NotFound() {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center space-y-4">
        <h1 className="text-2xl font-semibold">Página não encontrada</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          O link pode estar quebrado ou a sessão foi removida.
        </p>
        <Link href="/" className="...">Voltar pra home</Link>
      </div>
    );
  }
  ```

- **`app/quota/loading.tsx`**: replicar o pattern do `app/effectiveness/loading.tsx` (Skeletons com shape parecido: H1 + 4 KpiCard + heatmap placeholder).

- **TranscriptViewer prop change**: API atual `{ turns: TurnDetail[] }` vira `{ turns: TurnDetail[]; turnCount: number }`. Caller (`app/sessions/[id]/page.tsx`) passa `session.turnCount`. Dentro do viewer, branch:

  ```tsx
  if (turns.length === 0) {
    if (turnCount > 0) {
      return (
        <div role="alert" className="...">
          Esta sessão declara {turnCount} {turnCount === 1 ? 'turno' : 'turnos'} mas nenhum foi ingerido.
          Rode <code>pnpm ingest</code> pra carregar o transcript.
        </div>
      );
    }
    return <p className="...">Sem turnos nesta sessão.</p>;
  }
  ```

- **ShareActions conditional**: `app/sessions/[id]/page.tsx` atualmente renderiza `<ShareActions sessionId={id} />` incondicional. Trocar pra `{turns.length > 0 && <ShareActions sessionId={id} />}`. Ou passar `hasTurns` prop pra ShareActions (preferir lift — manter ShareActions puro).

- **Nav mobile**: `components/nav.tsx` recebe `overflow-x-auto` no `<ul>` + `whitespace-nowrap` nos Links. OtelStatusBadge label wrap:

  ```tsx
  <span className="hidden sm:inline">{status}</span>
  ```

  Manter `<span className="sr-only">{status}</span>` em mobile pra acessibilidade.

- **Sessions list mobile**: pode ser stack trivial via `flex-col md:flex-row` na `<li>` interna. Atual `flex items-center justify-between` vira `flex flex-col md:flex-row md:items-center md:justify-between`. Custo + turnos + chevron num `<div>` separado com `mt-2 md:mt-0`.

- **Activity heatmap mobile**: trocar `className="block h-auto w-full"` por `className="block"` + envolver parent em `<div className="w-full overflow-x-auto">`. SVG mantém dimensões naturais; scroll horizontal em mobile.

- **RatingWidget aria-pressed**: cada botão ganha:

  ```tsx
  aria-pressed={value === 1}
  aria-pressed={value === 0}
  aria-pressed={value === -1}
  ```

- **SearchForm focus conditional**:

  ```tsx
  'use client';
  import { useEffect, useRef } from 'react';
  import { useSearchParams } from 'next/navigation';

  export function SearchForm(...) {
    const ref = useRef<HTMLInputElement>(null);
    const params = useSearchParams();
    useEffect(() => {
      if (!params.get('q') && ref.current) ref.current.focus();
    }, [params]);
    return <input ref={ref} ... />;  // sem autoFocus
  }
  ```

- **Copy normalização**: `app/sessions/page.tsx` search text "aval" → "Avaliação"; `components/quota/quota-heatmap.tsx` "ingira transcripts" → "rode `pnpm ingest`"; `components/rating-widget.tsx` `{error}` → "Falha ao salvar avaliação"; `components/quota/quota-form.tsx` `status.message` → `"Erro: " + status.message` (ou remapping pra pt-BR se mensagem for do Zod em inglês).

- **TurnScrollTo return null**: `hidden` class já esconde. Span é dead weight.

- **fmtRating(null)**: hoje provavelmente retorna `"—"`. Alterar pra `"Sem avaliação"`.

### Files to Create

- `app/error.tsx`
- `app/not-found.tsx`
- `app/quota/loading.tsx`
- `lib/chart-colors.ts` (helper + hook `useChartColors`)
- `tests/e2e/ui-audit.spec.ts`

### Files to Modify

**Theme / palette bulk**:

- `app/globals.css` (novos CSS vars de chart + quota heatmap)
- `components/search/search-form.tsx`, `components/search/search-hit.tsx`, `app/search/page.tsx`
- `components/rating-widget.tsx`, `components/transcript-viewer.tsx`, `components/kpi-card.tsx`, `components/subagent-breakdown.tsx`, `components/quota/quota-form.tsx`, `components/effectiveness/tool-leaderboard.tsx`, `components/session/share-actions.tsx`
- `app/sessions/page.tsx` (banner yellow)
- `components/overview/trend-chart.tsx`, `components/effectiveness/ratio-trend.tsx`, `components/effectiveness/cost-per-turn-histogram.tsx`, `components/effectiveness/accept-rate-trend.tsx`, `components/effectiveness/tool-success-trend.tsx`, `components/effectiveness/model-breakdown.tsx`
- `components/quota/quota-heatmap.tsx` (palette)

**Data ambiguity**:

- `components/transcript-viewer.tsx` (signature change + empty branch)
- `app/sessions/[id]/page.tsx` (pass turnCount, conditional ShareActions)

**Mobile**:

- `components/nav.tsx`, `components/otel-status-badge.tsx`, `app/sessions/page.tsx` (list item layout), `components/overview/activity-heatmap.tsx`

**A11y**:

- `components/rating-widget.tsx` (aria-pressed — same file as above)
- `components/transcript-viewer.tsx` (h2 sr-only — same file)
- `components/search/search-form.tsx` (autoFocus conditional — same file)

**Copy**:

- `components/rating-widget.tsx`, `components/quota/quota-form.tsx`, `components/quota/quota-heatmap.tsx`, `app/sessions/page.tsx`, `lib/fmt.ts` (fmtRating)

**Polish**:

- `components/quota/quota-form.tsx` (placeholder — same)
- `components/turn-scroll-to.tsx` (return null)

### Dependencies

- Nenhuma nova dep.

## Tasks

- [x] TASK-1: `app/globals.css` — adicionar CSS vars de chart + quota heatmap pra light/dark
  - files: app/globals.css

- [x] TASK-2: `lib/chart-colors.ts` + hook `useChartColors` (client-side, observa class change no `<html>`)
  - files: lib/chart-colors.ts

- [x] TASK-3: Refactor `/search` (P0) — search-form, search-hit, app/search/page.tsx com paleta dual
  - files: components/search/search-form.tsx, components/search/search-hit.tsx, app/search/page.tsx

- [x] TASK-4: Bulk refactor cores saturadas de status (P1) — aplicar mapping `text-<cor>-400/300 → text-<cor>-600 dark:text-<cor>-400/300` em todos os pontos listados
  - files: components/rating-widget.tsx, components/transcript-viewer.tsx, components/kpi-card.tsx, components/subagent-breakdown.tsx, components/quota/quota-form.tsx, components/effectiveness/tool-leaderboard.tsx, components/session/share-actions.tsx

- [x] TASK-5: Banner "data inválida" em `/sessions` — palette dual
  - files: app/sessions/page.tsx

- [x] TASK-6: Refactor Recharts pra temas via `useChartColors` hook — 6 componentes
  - files: components/overview/trend-chart.tsx, components/effectiveness/ratio-trend.tsx, components/effectiveness/cost-per-turn-histogram.tsx, components/effectiveness/accept-rate-trend.tsx, components/effectiveness/tool-success-trend.tsx, components/effectiveness/model-breakdown.tsx
  - depends: TASK-1, TASK-2

- [x] TASK-7: `QuotaHeatmap` usa CSS vars (empty + intensity) — células vazias visíveis em light
  - files: components/quota/quota-heatmap.tsx
  - depends: TASK-1

- [x] TASK-8: `app/error.tsx` global
  - files: app/error.tsx

- [x] TASK-9: `app/not-found.tsx` global
  - files: app/not-found.tsx

- [x] TASK-10: `app/quota/loading.tsx` skeleton
  - files: app/quota/loading.tsx

- [x] TASK-11: `TranscriptViewer` ganha `turnCount` prop + empty-state ambíguo tratado; `ShareActions` condicional em session page
  - files: components/transcript-viewer.tsx, app/sessions/[id]/page.tsx

- [x] TASK-12: Nav mobile responsivo — `overflow-x-auto` + OtelStatusBadge label condicional
  - files: components/nav.tsx, components/otel-status-badge.tsx

- [x] TASK-13: `/sessions` list mobile layout — stack colunas
  - files: app/sessions/page.tsx

- [x] TASK-14: `ActivityHeatmap` mobile scroll horizontal
  - files: components/overview/activity-heatmap.tsx

- [x] TASK-15: A11y + copy consolidado — `RatingWidget` (aria-pressed + error copy), `TranscriptViewer` (h2 sr-only), `SearchForm` (autoFocus condicional), `QuotaForm` (placeholder + error copy), `QuotaHeatmap` (copy), `fmtRating` (null → "Sem avaliação"), `fmt.test.ts` ajuste, "aval" → "Avaliação" em sessions list
  - files: components/rating-widget.tsx, components/transcript-viewer.tsx, components/search/search-form.tsx, components/quota/quota-form.tsx, components/quota/quota-heatmap.tsx, lib/fmt.ts, lib/fmt.test.ts, app/sessions/page.tsx
  - tests: TC-U-01, TC-U-02, TC-U-03

- [x] TASK-16: `TurnScrollTo` retorna `null` (remover span inerte)
  - files: components/turn-scroll-to.tsx

- [x] TASK-SMOKE: E2E em `tests/e2e/ui-audit.spec.ts`
  - files: tests/e2e/ui-audit.spec.ts
  - depends: TASK-3, TASK-8, TASK-9, TASK-11, TASK-12, TASK-15
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07, TC-E2E-08, TC-E2E-09, TC-E2E-10, TC-E2E-11

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-8, TASK-9, TASK-10, TASK-12, TASK-14, TASK-16]
         — paralelo (arquivos totalmente exclusivos: globals.css, chart-colors, error, not-found, loading, nav+otel, activity-heatmap, turn-scroll-to)
Batch 2: [TASK-3, TASK-4, TASK-5, TASK-6, TASK-7]
         — paralelo (Batch 1 deps satisfeitas; arquivos exclusivos entre si: search, cores saturadas, banner, charts, quota-heatmap)
Batch 3: [TASK-11, TASK-13]
         — paralelo (TASK-11 precisa de TASK-4 pronto em transcript-viewer; TASK-13 precisa de TASK-5 pronto em sessions/page.tsx)
Batch 4: [TASK-15]
         — consolida aria/copy/placeholder nos arquivos de TASK-3/4/7/11/13 (shared-mutative → sequencial)
Batch 5: [TASK-SMOKE]
```

File overlap (shared-mutative — exige serialização):

- `components/rating-widget.tsx`: TASK-4 (cores) → TASK-15 (aria-pressed + copy)
- `components/transcript-viewer.tsx`: TASK-4 (cores) → TASK-11 (turnCount) → TASK-15 (h2 sr-only)
- `components/quota/quota-form.tsx`: TASK-4 (cores) → TASK-15 (placeholder + copy)
- `components/quota/quota-heatmap.tsx`: TASK-7 (palette) → TASK-15 (copy)
- `components/search/search-form.tsx`: TASK-3 (cores) → TASK-15 (autoFocus)
- `app/sessions/page.tsx`: TASK-5 (banner) → TASK-13 (mobile) → TASK-15 ("aval")

Demais arquivos: exclusive.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (+3 TC-U de fmtRating)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (+11 TC-E2E)

### Discipline Checkpoints

**Checkpoint 1 — Self-review REQ-by-REQ + best-way-possible**:

- Walk REQ-1..26 com evidência concreta.
- Best-way: CSS vars pra charts (não reinvento theme detection; MutationObserver só pra atualizar quando class muda); Recharts continua usando `contentStyle` object-prop (padrão do Recharts, não forço workaround); error/not-found usando pattern canônico do Next App Router; `aria-pressed` é o atributo ARIA padrão pra toggle buttons (não invento `role=switch` onde não faz sentido); empty-state com texto claro e `role="alert"`.

**Checkpoint 2 — Live validation com dados reais**:

- `pnpm dev` em background.
- Light mode: abrir cada rota (`/`, `/sessions`, `/sessions/<real-id>`, `/effectiveness`, `/quota`, `/search?q=ingest`) e verificar via screenshot Playwright OU curl+grep.
- Em `/search?q=ingest` light: inspecionar `color` do input via `getComputedStyle` — deve ser escuro sobre claro, NÃO claro sobre escuro.
- Forçar 404: `curl -i http://localhost:3131/rota-inexistente` — deve retornar HTML de not-found com "Página não encontrada".
- Forçar erro: inserir dummy `throw new Error('test')` temporariamente em `/effectiveness/page.tsx` (e reverter depois) pra ver error.tsx renderizando. **Alternativa menos invasiva**: validar pela presença do componente `app/error.tsx` no build + unit test manual.
- Em `/sessions/[id]` de uma sessão com `turnCount > 0` mas `turns.length === 0`: verificar mensagem "turnos não ingeridos". Usar uma das 55 sessões do DB real nesse estado.
- Em mobile 375×667 via Chrome DevTools: nav não quebra em 2 linhas, lista de /sessions empilha em 2 linhas por item.
- `RatingWidget`: clicar "Bom" → elemento tem `aria-pressed="true"`.
- Todas as charts em light: tooltip tem fundo claro, grid cinza claro (não preto).
- Quota heatmap em light: células vazias visíveis como `#e5e5e5`.
- Parar dev server; SIGTERM esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1 (TASK-1, 2, 8, 9, 10, 12, 14, 16) (2026-04-19 15:45)

8 tasks sequenciais em main tree (mais rápido que worktrees pra scope pequeno). TASK-1: `globals.css` ganha tokens de Recharts (`--chart-*`) e quota heatmap (`--quota-heatmap-*`) nos 2 temas. TASK-2: `lib/chart-colors.ts` com `useSyncExternalStore` + `MutationObserver` na class do `<html>` (evita warning `react-hooks/set-state-in-effect`). TASK-8: `app/error.tsx` Client com `reset` + link pra home. TASK-9: `app/not-found.tsx` Server com link pra home. TASK-10: `app/quota/loading.tsx` skeleton (H1, 4 KPIs, form, heatmap). TASK-12: `nav.tsx` ganha `overflow-x-auto` + `whitespace-nowrap` nos Links; `otel-status-badge.tsx` esconde label em <640px mantendo sr-only. TASK-14: `activity-heatmap.tsx` envolve SVG em `overflow-x-auto` + SVG mantém `min-w-[720px]` pra não comprimir em mobile. TASK-16: `turn-scroll-to.tsx` retorna `null` + **drive-by fix**: `classList.add(...)` recebia string com espaço (`'ring-offset-neutral-50 dark:ring-offset-neutral-950'`) — bug silencioso do refactor anterior. Consertado pra spread de array de tokens.

### Iteration 2 — Batch 2 (TASK-3, 4, 5, 6, 7) (2026-04-19 16:58)

5 tasks sequenciais em main tree. TASK-3: `/search` recebe paleta dual em form (input, select, button), hit (card border/bg/texts, snippet marks) e page.tsx (error message). TASK-4: mapping Python regex aplica `text-<cor>-400/300 → text-<cor>-600 dark:text-<cor>-400/300` em 7 arquivos (red, emerald, amber, yellow) — todos estados de status com contraste WCAG-AA válido em ambos temas. TASK-5: banner yellow em sessions/page.tsx ganha dual palette. TASK-6: 6 componentes Recharts (trend-chart, ratio-trend, cost-per-turn-histogram, accept-rate-trend, tool-success-trend, model-breakdown) usam `useChartColors()` hook — grid/axis/tooltip/pie-stroke/line-colors todos dinâmicos. TASK-7: QuotaHeatmap troca Tailwind class por `style={{ backgroundColor: var(--quota-heatmap-*) }}` pra respeitar CSS vars; células vazias ficam `#e5e5e5` em light (visíveis).

### Iteration 3 — Batch 3 (TASK-11, 13) (2026-04-19 17:05)

TASK-11: `TranscriptViewer` API vira `{ turns, turnCount }`; quando `turns.length === 0 && turnCount > 0`, renderiza alerta amber-amarelo explicando "declara N turnos mas nenhum foi ingerido — rode `pnpm ingest`"; quando `turnCount === 0`, mantém "Sem turnos nesta sessão". `ShareActions` só renderiza quando `turns.length > 0`. TASK-13: `/sessions` list item vira `flex-col md:flex-row` — no mobile 375px empilha projeto/id em cima e custo/turnos/avaliação/chevron abaixo; desktop mantém layout original. Preempted copy fix: "aval" → "Avaliação" na coluna de rating.

### Iteration 4 — Batch 4 (TASK-15) (2026-04-19 17:07)

Consolidação a11y + copy em 6 arquivos. `RatingWidget`: `aria-pressed={value === N}` nos 3 botões + erro copy vira "Falha ao salvar avaliação" (dropa `err.message` cru). `TranscriptViewer`: `<h2 className="sr-only">Transcript</h2>` antes do `<ol>`. `SearchForm`: remove `autoFocus` estático, `useEffect` com `useRef` foca input só na primeira entrada em `/search` sem query pre-populada. `QuotaForm`: `placeholder="vazio = não rastrear"` nos 4 inputs + mensagens de erro prefixadas com "Erro: ". `QuotaHeatmap`: "ingira transcripts pra ver" → "rode `pnpm ingest` pra ver". `fmtRating(null)`: "—" → "Sem avaliação"; testes ajustados (+1 TC pra `fmtRating(0)`). "aval" → "Avaliação" já foi aplicado em TASK-13.

### Iteration 5 — TASK-SMOKE (2026-04-19 17:15)

11 E2E em `tests/e2e/ui-audit.spec.ts` (TC-E2E-01..11). Seed especial em `beforeAll`: `e2e-unlogged` com `turn_count=7` e 0 linhas em `turns` (empty state ambíguo), `e2e-empty` com `turn_count=0` (ShareActions hidden). Cobertura: /search color, not-found em rota inexistente + sessão inexistente, empty-state "turnos não ingeridos", ShareActions conditional, nav mobile scroll (viewport 375), RatingWidget aria-pressed, SearchForm focus condicional (3 variantes), dark mode regressão. Todos 11 passando em ~8s. **Fix durante TDD**: dev mode do Next retorna 200 mesmo em not-found — troquei assert de status pra presença do heading "Página não encontrada", que é o contrato real.
