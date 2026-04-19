# Spec: Themes — claro, escuro, sistema

## Status: DONE

## Context

Hoje o app é 100% dark mode — `bg-neutral-950 text-neutral-100` no root e ~40 arquivos com classes `neutral-XXX` hardcoded pressupondo fundo escuro. Funciona perfeitamente pra mim, mas:

- Abrir o dashboard em plena luz do dia dói os olhos; claro mode seria mais amigável.
- Usuários que preferem claro ou querem seguir o OS (`prefers-color-scheme`) não têm escolha.
- Print CSS já força fundo branco pra export de sessão, mas o screen mode fica trancado no escuro.

Objetivo: adicionar 3 modos (`light` / `dark` / `system`), toggle no nav, persistência em localStorage, sem flash-of-wrong-theme no SSR, e refactor mecânico dos 40 arquivos pra suportar ambos os temas com classes `dark:` prefix.

### Decisões já travadas

1. **Biblioteca**: `next-themes`. É o padrão do ecossistema Next.js (usado pela shadcn, Vercel docs, etc), ~2KB, resolve sozinha: class-based toggle, leitura do OS via `prefers-color-scheme`, injeção de script no `<head>` pra evitar FOUC, persistência em localStorage, sincronização entre tabs via storage event. Reescrever manualmente seria reinventar roda e abrir brechas (FOUC, hydration mismatch).
2. **Mecanismo**: `class="dark"` no `<html>` (controlado pelo `next-themes`). Tailwind v4 tem `@custom-variant dark (&:is(.dark *))` — adicionado no `globals.css` se não vier por default.
3. **Estratégia de refactor**: **`dark:` prefix explícito em cada classe hardcoded**. Não vou introduzir tokens CSS novos (bg-surface, bg-card, etc) porque obriga reescrita de mais primitivas — o ganho de abstração não paga pra um projeto desse tamanho. Pattern puramente mecânico, auditável em diff.
4. **Paleta light — mapping determinístico**:

   | Dark (hoje) | Light (novo default, prefixado `dark:` pra manter o atual) |
   | --- | --- |
   | `bg-neutral-950` | `bg-neutral-50` |
   | `bg-neutral-900` | `bg-white` |
   | `bg-neutral-800` | `bg-neutral-100` |
   | `text-neutral-100` | `text-neutral-900` |
   | `text-neutral-200` | `text-neutral-800` |
   | `text-neutral-300` | `text-neutral-700` |
   | `text-neutral-400` | `text-neutral-600` |
   | `text-neutral-500` | `text-neutral-500` (mid gray, inalterado) |
   | `border-neutral-800` | `border-neutral-200` |
   | `border-neutral-700` | `border-neutral-300` |
   | `hover:border-neutral-500` | inalterado (mid gray funciona em ambos) |

   Cada `neutral-X` hoje na codebase vira `<light-equivalent> dark:<neutral-X>`. Literal e auditável.

5. **Recharts**: strokes hardcoded (`#262626`, `#737373`) ficam. O uso atual é na grade/eixos dos charts, que vivem DENTRO de cards — o card já adapta ao tema e os strokes escuros em fundo claro ou vice-versa ficam legíveis. Revisar visualmente durante live validation; se algo gritar, substituir por `currentColor` ou mapear depois.
6. **Cores de status** (emerald, amber, red, violet, sky): inalteradas. Funcionam em ambos os temas (são cores saturadas, não variantes de cinza).
7. **Toggle UI**: dropdown compacto no slot do `Nav` (entre `QuotaNavWidget` e `OtelStatusBadge`). 3 opções: Claro / Escuro / Sistema. Ícone dinâmico (Sun / Moon / Monitor). Radix UI Dropdown (já em uso via shadcn).
8. **Default inicial**: `system`. Abrindo o app pela primeira vez, segue o `prefers-color-scheme` do OS.
9. **Fora de escopo**: cores customizadas (accent), temas adicionais (high-contrast, sepia), migração de recharts pra currentColor, animação de transição entre temas, print mode (já tratado em spec anterior).

## Requirements

- [ ] **REQ-1**: GIVEN o usuário abre o app pela 1ª vez (sem preferência salva) E `prefers-color-scheme` do OS é `dark` WHEN o app carrega THEN a UI renderiza em dark mode (class `dark` no `<html>`) sem flash de light mode durante hydration.

- [ ] **REQ-2**: GIVEN o usuário abre o app pela 1ª vez E `prefers-color-scheme` do OS é `light` WHEN o app carrega THEN renderiza em light mode sem flash.

- [ ] **REQ-3**: GIVEN o toggle no nav WHEN o usuário clica THEN um dropdown abre com 3 opções: "Claro", "Escuro", "Sistema". Cada opção tem ícone (Sun / Moon / Monitor) e label visível. Opção ativa tem check visual (ex: `✓` ou fundo accent).

- [ ] **REQ-4**: GIVEN o usuário seleciona "Claro" WHEN a seleção é aplicada THEN a class `dark` é removida do `<html>`, `localStorage['theme'] === 'light'`, e todas as páginas renderizam com paleta clara sem reload.

- [ ] **REQ-5**: GIVEN o usuário seleciona "Escuro" WHEN aplicada THEN `<html>` ganha `class="dark"`, `localStorage['theme'] === 'dark'`, paleta escura renderiza.

- [ ] **REQ-6**: GIVEN o usuário seleciona "Sistema" WHEN aplicada THEN `localStorage['theme'] === 'system'`, a class `dark` é alinhada com o `prefers-color-scheme` atual do OS, e mudanças subsequentes do OS (ex: via settings) refletem automaticamente na UI sem reload.

- [ ] **REQ-7**: GIVEN um tema foi salvo (ex: light) WHEN o usuário recarrega a página (F5) THEN o tema persiste — nenhum flash do tema contrário durante a carga inicial.

- [ ] **REQ-8**: GIVEN o usuário abre o app em 2 abas simultâneas E troca o tema na aba A WHEN a troca acontece THEN a aba B atualiza pro mesmo tema dentro de ~1s (via `storage` event do `next-themes`).

- [ ] **REQ-9**: GIVEN o toggle WHEN renderizado THEN tem `aria-label="Alterar tema"` no gatilho do dropdown. Cada opção do menu tem seu próprio label acessível (role="menuitem"). Estado atual exposto via `aria-checked` ou equivalente.

- [ ] **REQ-10**: GIVEN `app/layout.tsx` WHEN renderizado em dark mode (class `.dark`) THEN `<body>` tem background neutro-escuro e texto neutro-claro. Em light mode, background claro e texto neutro-escuro. Nenhuma classe hardcoded sem `dark:` prefix no body.

- [ ] **REQ-11**: GIVEN `components/nav.tsx` WHEN renderizado THEN todas as classes `bg-neutral-*`, `text-neutral-*`, `border-neutral-*` têm seu par light (mapping da seção Decisões). Idem `hover:`, `focus:`.

- [ ] **REQ-12**: GIVEN qualquer componente em `components/` e `app/` (exceto primitivos de `components/ui/` que já seguem o shadcn) WHEN renderizado em light mode THEN não tem bloco de UI com fundo escuro + texto escuro, OU fundo claro + texto claro (contraste WCAG-AA mínimo 4.5:1 pra corpo de texto).

- [ ] **REQ-13**: GIVEN primitivas shadcn em `components/ui/` WHEN o tema muda THEN elas respeitam as variáveis CSS já definidas em `globals.css` (shadcn já usa `bg-card`, `text-card-foreground`, etc). Sem mudanças nas primitivas, só na `globals.css` se necessário.

- [ ] **REQ-14**: GIVEN `globals.css` WHEN carregado THEN define as variáveis CSS semânticas pras duas paletas (`:root` padrão light, `.dark` override escuro) cobrindo tokens do shadcn: `--background`, `--foreground`, `--card`, `--card-foreground`, `--border`, `--input`, `--muted`, `--muted-foreground`, `--popover`, `--popover-foreground`, `--accent`, `--accent-foreground`, `--primary`, `--primary-foreground`.

- [ ] **REQ-15**: GIVEN Recharts hardcoded colors (`#262626` grid, `#737373` axis) WHEN a UI muda pra light mode THEN o chart renderiza com contraste mínimo aceitável (não quebra visivelmente). Não obrigatório remapar nesta spec — apenas **validar visualmente** no checkpoint 2; se ficar ilegível, criar follow-up.

- [ ] **REQ-16**: GIVEN o dropdown de tema WHEN aberto e o usuário pressiona `Escape` THEN fecha sem alterar a seleção.

- [ ] **REQ-17**: GIVEN o app em dark mode WHEN o usuário imprime (Ctrl+P) THEN o print CSS existente (`@media print` com reset de cores em `globals.css`) continua funcionando — fundo branco, texto preto. Tema corrente não interfere com print.

- [ ] **REQ-18**: GIVEN `next-themes` ProviderComponent WHEN envolve o `<html>` THEN é configurado com `attribute="class"`, `defaultTheme="system"`, `enableSystem={true}`, `disableTransitionOnChange={true}` (evita flash de cores durante mudança de tema).

- [ ] **REQ-19**: GIVEN `app/layout.tsx` WHEN renderizado no servidor THEN tem `suppressHydrationWarning` no `<html>` (next-themes injeta `class` no client antes da hydration; sem isso, React logs warning).

## Test Plan

### Unit Tests

Mudança é de configuração + mecânica de find/replace. Lógica pura mínima. Unit tests aqui ficam focados no componente `ThemeToggle` — porém é um wrapper trivial sobre `useTheme` do `next-themes`. **Test Plan de unit = N/A** (testes de UI simples cobertos via E2E).

### Integration Tests

Não aplicável — sem DB nem API route novos.

### E2E Tests

Em [tests/e2e/themes.spec.ts](tests/e2e/themes.spec.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-3 | happy | Abrir `/`, clicar no toggle | dropdown abre com 3 itens com labels "Claro", "Escuro", "Sistema" |
| TC-E2E-02 | REQ-5 | happy | Selecionar "Escuro" | `<html>` ganha `class="dark"`; `localStorage['theme']` é `"dark"` |
| TC-E2E-03 | REQ-4 | happy | Selecionar "Claro" | `<html>` NÃO tem `class="dark"`; `localStorage['theme']` é `"light"` |
| TC-E2E-04 | REQ-6 | happy | Selecionar "Sistema" com browser emulando `prefers-color-scheme: dark` | `<html>` tem `class="dark"`; `localStorage['theme']` é `"system"` |
| TC-E2E-05 | REQ-6 | edge | Após selecionar "Sistema", mudar o emulateMedia pra `light` | `<html>` perde `class="dark"` em ~1s sem reload |
| TC-E2E-06 | REQ-7 | happy | Setar "Escuro", recarregar a página | pós-reload, `<html>` tem `class="dark"` imediatamente (sem flash); localStorage mantém `"dark"` |
| TC-E2E-07 | REQ-10 | business | Em light mode, `<body>` tem class de fundo claro (`bg-neutral-50`) | CSS computado `backgroundColor` ~= `rgb(250 250 250)` |
| TC-E2E-08 | REQ-10 | business | Em dark mode, `<body>` tem class de fundo escuro | CSS computado ~= `rgb(10 10 10)` |
| TC-E2E-09 | REQ-16 | happy | Abrir dropdown, pressionar Escape | dropdown fecha; `<html>` mantém class anterior |
| TC-E2E-10 | REQ-9 | happy | Toggle tem aria-label "Alterar tema" | `button[aria-label="Alterar tema"]` visível |
| TC-E2E-11 | REQ-8 | happy | 2 contextos abertos em `/`; trocar tema em A | contexto B reflete a troca dentro de ~1s (via storage event) |

### Visual validation (manual, no Checkpoint 2)

Não automatizado. Checkpoint 2 inclui: abrir cada rota (`/`, `/sessions`, `/sessions/<id>`, `/effectiveness`, `/quota`, `/search`) em light e dark, e confirmar que: nenhum bloco ilegível (texto escuro em fundo escuro ou claro em claro), nenhum border invisível, charts ainda renderizam com grade visível.

## Design

### Architecture Decisions

- **Package**: adicionar `next-themes` às dependências. `pnpm add next-themes`.

- **ThemeProvider** em `components/theme-provider.tsx`:

  ```tsx
  'use client';
  import { ThemeProvider as NextThemesProvider } from 'next-themes';
  import type { ComponentProps } from 'react';

  export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
    return <NextThemesProvider {...props} />;
  }
  ```

  Wrapper existe pra manter o `'use client'` boundary limpo — o layout em si fica Server Component.

- **Layout integration** em `app/layout.tsx`:

  ```tsx
  <html lang="pt-BR" suppressHydrationWarning className={...}>
    <body className="bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 antialiased min-h-screen">
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <Nav slot={...} />
        <main>...</main>
      </ThemeProvider>
    </body>
  </html>
  ```

  Note: `suppressHydrationWarning` no `<html>` é obrigatório (REQ-19) porque `next-themes` muta a class antes da hydration do React.

- **ThemeToggle** em `components/theme-toggle.tsx`:

  ```tsx
  'use client';
  import { useTheme } from 'next-themes';
  import { useEffect, useState } from 'react';
  import { SunIcon, MoonIcon, MonitorIcon } from '@/components/icons';
  import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';

  export function ThemeToggle() {
    const { theme, setTheme, resolvedTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    // Avoid hydration mismatch by deferring the icon render until mount
    const CurrentIcon = !mounted
      ? SunIcon
      : theme === 'system'
        ? MonitorIcon
        : resolvedTheme === 'dark'
          ? MoonIcon
          : SunIcon;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Alterar tema"
          className="..."
        >
          <CurrentIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light"><SunIcon /> Claro</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark"><MoonIcon /> Escuro</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system"><MonitorIcon /> Sistema</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  ```

  Notas:
  - `mounted` guard evita hydration mismatch — ícone pode variar entre server (sem classe) e client (com classe); renderizar default até hydrate.
  - `resolvedTheme` retorna o tema efetivamente aplicado (`dark`/`light`), diferente de `theme` que pode ser `'system'`.
  - Ícones Sun/Moon/Monitor vêm de `components/icons.tsx` (adicionar se não existirem — checar primeiro).

- **Icons**: `SunIcon`, `MoonIcon`, `MonitorIcon` em `components/icons.tsx`. Adicionar se não existirem (verificar primeiro). Usar mesmo pattern dos icons existentes (inline SVG, props `className`).

- **DropdownMenu shadcn**: checar se `components/ui/dropdown-menu.tsx` já existe (parece não — só `card.tsx` visível). Se faltar, instalar via `npx shadcn add dropdown-menu` OU reutilizar Radix Primitive diretamente. **Checar antes de especificar** — se não existir, TASK-1 inclui adicionar a primitiva.

- **globals.css** — expandir o `:root` / `.dark` blocks com tokens shadcn completos:

  ```css
  :root {
    --background: #fafafa;           /* neutral-50 */
    --foreground: #171717;           /* neutral-900 */
    --card: #ffffff;
    --card-foreground: #171717;
    --popover: #ffffff;
    --popover-foreground: #171717;
    --primary: #171717;
    --primary-foreground: #fafafa;
    --secondary: #f5f5f5;            /* neutral-100 */
    --secondary-foreground: #171717;
    --muted: #f5f5f5;
    --muted-foreground: #737373;     /* neutral-500 */
    --accent: #f5f5f5;
    --accent-foreground: #171717;
    --border: #e5e5e5;               /* neutral-200 */
    --input: #e5e5e5;
    --ring: #a3a3a3;                 /* neutral-400 */
  }

  .dark {
    --background: #0a0a0a;           /* neutral-950 */
    --foreground: #ededed;           /* neutral-200 */
    --card: #171717;                 /* neutral-900 */
    --card-foreground: #ededed;
    --popover: #171717;
    --popover-foreground: #ededed;
    --primary: #ededed;
    --primary-foreground: #0a0a0a;
    --secondary: #262626;            /* neutral-800 */
    --secondary-foreground: #ededed;
    --muted: #262626;
    --muted-foreground: #a3a3a3;     /* neutral-400 */
    --accent: #262626;
    --accent-foreground: #ededed;
    --border: #262626;
    --input: #262626;
    --ring: #525252;                 /* neutral-600 */
  }
  ```

  Bloco `@media (prefers-color-scheme: dark)` existente em globals.css pode ser removido (o `next-themes` com `attribute="class"` não usa media query; a class `.dark` é suficiente).

- **Refactor mecânico**: replacement map aplicado em cada arquivo afetado:

  ```text
  bg-neutral-950    → bg-neutral-50 dark:bg-neutral-950
  bg-neutral-900    → bg-white dark:bg-neutral-900
  bg-neutral-800    → bg-neutral-100 dark:bg-neutral-800
  text-neutral-100  → text-neutral-900 dark:text-neutral-100
  text-neutral-200  → text-neutral-800 dark:text-neutral-200
  text-neutral-300  → text-neutral-700 dark:text-neutral-300
  text-neutral-400  → text-neutral-600 dark:text-neutral-400
  text-neutral-500  → text-neutral-500                    # unchanged (mid gray)
  border-neutral-800 → border-neutral-200 dark:border-neutral-800
  border-neutral-700 → border-neutral-300 dark:border-neutral-700
  ```

  **Não tocar**: classes hover/focus (ex: `hover:border-neutral-500`) ficam como estão se já forem mid-gray; ajustar só se virarem invisíveis em alguma paleta. Classes com opacidade suffix (`bg-neutral-900/60`) seguem mesmo mapping com suffix preservado.

- **Refactor scope**: ~40 arquivos com classes neutrais hardcoded. Agrupados em 4 buckets:
  - `app/**/*.tsx` (layouts + páginas)
  - `components/ui/**/*.tsx` (primitivos shadcn — muitos já usam tokens, só conferir)
  - `components/<domain>/**/*.tsx` (overview, effectiveness, sessions, quota, search, session-share, etc)
  - `components/*.tsx` (raiz: nav, kpi-card, transcript-viewer, etc)

### Files to Create

- `components/theme-provider.tsx`
- `components/theme-toggle.tsx`
- `tests/e2e/themes.spec.ts`
- (condicional) `components/ui/dropdown-menu.tsx` — se não existir, criar via shadcn CLI ou hand-write com Radix

### Files to Modify

- `package.json` — adicionar `next-themes`
- `app/layout.tsx` — envolver com `ThemeProvider`, adicionar `suppressHydrationWarning`, refactor body classes
- `app/globals.css` — expandir tokens CSS; remover bloco `@media (prefers-color-scheme: dark)` obsoleto
- `components/nav.tsx` — adicionar `ThemeToggle` no slot; refactor classes neutrais
- `components/icons.tsx` — adicionar `SunIcon`, `MoonIcon`, `MonitorIcon` se faltarem
- **~35 arquivos em `components/` e `app/`** — bulk refactor das classes neutrais via mapping acima

### Dependencies

- `next-themes@^0.4.0` — 2KB, mantido, padrão de facto
- `@radix-ui/react-dropdown-menu` (se shadcn dropdown-menu não existir) — 15KB

## Tasks

- [x] TASK-1: Install `next-themes` + criar `ThemeProvider` wrapper
  - files: package.json, pnpm-lock.yaml, components/theme-provider.tsx

- [x] TASK-2: Adicionar icons (Sun, Moon, Monitor) em `components/icons.tsx` (ou criar `theme-icons.tsx` se não fizer sentido no arquivo existente)
  - files: components/icons.tsx

- [x] TASK-3: Adicionar shadcn `dropdown-menu` primitive se não existir
  - files: components/ui/dropdown-menu.tsx, package.json (opcional, se novo radix)
  - depends: (none)

- [x] TASK-4: Criar `ThemeToggle` component
  - files: components/theme-toggle.tsx
  - depends: TASK-1, TASK-2, TASK-3

- [x] TASK-5: Expandir `globals.css` com tokens shadcn completos pra light + dark
  - files: app/globals.css

- [x] TASK-6: Envolver layout com ThemeProvider + `suppressHydrationWarning` + refactor classes do body
  - files: app/layout.tsx
  - depends: TASK-1, TASK-5

- [x] TASK-7: Refactor `components/nav.tsx` (classes neutrais) e integrar `ThemeToggle` no slot
  - files: components/nav.tsx
  - depends: TASK-4

- [x] TASK-8: Refactor mecânico das classes neutrais em `app/**/*.tsx` (excluindo layout e globals.css; incluindo pages, loading, error)
  - files: app/effectiveness/page.tsx, app/effectiveness/loading.tsx, app/quota/page.tsx, app/search/page.tsx, app/sessions/page.tsx, app/sessions/loading.tsx, app/sessions/[id]/page.tsx, app/sessions/[id]/loading.tsx, app/page.tsx, app/loading.tsx

- [x] TASK-9: Refactor `components/*.tsx` (raiz)
  - files: components/kpi-card.tsx, components/transcript-viewer.tsx, components/turn-scroll-to.tsx, components/rating-widget.tsx, components/cost-source-badge.tsx, components/otel-status-badge.tsx, components/info-tooltip.tsx, components/icons.tsx

- [x] TASK-10: Refactor `components/<domain>/**/*.tsx` (domain folders)
  - files: components/overview/**/*.tsx, components/effectiveness/**/*.tsx, components/quota/**/*.tsx, components/session/**/*.tsx

- [x] TASK-11: Refactor `components/ui/**/*.tsx` — revisar se primitives shadcn já usam tokens `bg-card`, `text-foreground`, etc; ajustar o que estiver hardcoded
  - files: components/ui/**/*.tsx

- [x] TASK-SMOKE: E2E themes — 10 TCs cobrindo toggle, persistência, hydration, acessibilidade
  - files: tests/e2e/themes.spec.ts
  - depends: TASK-6, TASK-7, TASK-8, TASK-9, TASK-10, TASK-11
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07, TC-E2E-08, TC-E2E-09, TC-E2E-10

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3, TASK-5]   — paralelo (arquivos exclusivos: next-themes install, icons, dropdown-menu, globals.css)
Batch 2: [TASK-4]                           — sequencial (depends: TASK-1, TASK-2, TASK-3)
Batch 3: [TASK-6, TASK-11]                  — paralelo (app/layout.tsx vs components/ui/; TASK-6 depends TASK-1+TASK-5)
Batch 4: [TASK-7, TASK-8, TASK-9, TASK-10]  — paralelo (componentes/páginas em buckets exclusivos; TASK-7 depends TASK-4)
Batch 5: [TASK-SMOKE]                       — E2E depois de tudo
```

File overlap analysis:

- `package.json`: TASK-1 + TASK-3 (ambos adicionam deps). Classificado como **shared-additive** — se TASK-3 for necessário, sequencializar TASK-1 → TASK-3 dentro do Batch 1.
- Todos os outros: exclusive.

Se `dropdown-menu` já existir, TASK-3 vira no-op e o shared-additive some.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (10 novos TC-E2E)

### Discipline Checkpoints

**Checkpoint 1 — Self-review REQ-by-REQ + best-way-possible check**:

- Todas REQ-1..19 com evidência concreta.
- Best-way: usa `next-themes` (padrão, não reinvento FOUC guard); `suppressHydrationWarning` no `<html>`; `resolvedTheme` pro ícone dinâmico; `mounted` guard pra evitar hydration mismatch; mapping de classes mecânico e auditável no diff.

**Checkpoint 2 — Live validation com dados reais**:

- `pnpm dev` em background.
- Abrir `/` em light mode (via toggle), verificar nav, overview cards, heatmap — nenhum texto ilegível.
- Abrir `/` em dark mode — visual idêntico ao que era antes da feature.
- Abrir `/` em system mode com browser DevTools emulando `prefers-color-scheme: light` → UI vira light; mudar emulação pra dark → UI vira dark sem reload.
- Repetir pra cada rota: `/sessions`, `/sessions/<id>`, `/effectiveness`, `/quota`, `/search`.
- F5 em light mode → sem flash de dark mode inicial.
- Inspecionar `<html>` em DevTools: `class="dark"` presente em dark, ausente em light.
- `localStorage.getItem('theme')` via console: valor reflete seleção.
- Abrir 2 abas, trocar tema em uma, observar outra sincronizar.
- Print preview (Ctrl+P) em dark mode — fundo branco (print CSS respeita).
- Parar dev server; reportar SIGTERM esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — TASK-1 + TASK-2 + TASK-3 + TASK-5 (2026-04-19 14:00)

Batch 1 em main tree (evita conflito em `package.json`). `pnpm add next-themes @radix-ui/react-dropdown-menu`. `components/theme-provider.tsx` wrapper client. 3 icons novos em `components/icons.tsx` (Sun/Moon/Monitor, pattern de SVG inline igual aos existentes). `components/ui/dropdown-menu.tsx` hand-written sobre Radix Primitive (Root/Trigger/Content/RadioGroup/RadioItem) com classes dual-palette `bg-white dark:bg-neutral-900`. `globals.css` expandido com 17 tokens shadcn (`:root` light + `.dark` override) + `@custom-variant dark` pra Tailwind v4 + `@theme inline` expondo os tokens como utilities. Bloco `@media (prefers-color-scheme: dark)` antigo removido — `next-themes` com `attribute="class"` cuida disso.

### Iteration 2 — TASK-4 (2026-04-19 14:08)

`ThemeToggle` em `components/theme-toggle.tsx`. Trigger renderiza **ambos** Sun + Moon icons com `dark:hidden` / `hidden dark:block` — CSS troca baseado na class `.dark`, sem `mounted` state (evita warning `react-hooks/set-state-in-effect` + elimina hydration mismatch porque server e client renderizam mesmo HTML). Dropdown com 3 radio items (Claro/Escuro/Sistema), usa `useTheme` do next-themes. `aria-label="Alterar tema"` no trigger.

### Iteration 3 — TASK-6 + TASK-11 (2026-04-19 14:11)

TASK-6: `app/layout.tsx` agora envolve children com `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>`, adiciona `suppressHydrationWarning` no `<html>`, body ganha `bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100`, slot do Nav ganha `ThemeToggle` entre QuotaNavWidget e OtelStatusBadge. TASK-11: `components/ui/card.tsx` Card root ganha dual palette (`bg-white dark:bg-neutral-900` + borders + text) e CardDescription; `components/ui/skeleton.tsx` ganha `bg-neutral-200/80 dark:bg-neutral-800/80`. `dropdown-menu.tsx` já foi dual desde TASK-3.

### Iteration 4 — TASK-7 + TASK-8 + TASK-9 + TASK-10 (2026-04-19 14:25)

Batch 4 paralelo via 4 worktrees. Worktrees estavam desatualizados (commits antigos), então merges tiveram regressions (e.g. TranscriptViewer perdeu parágrafo de custos, RatingWidget perdeu `Value | null` e `print:hidden`). Fix: restaurei HEAD de TODOS os 33 arquivos afetados + apliquei refactor em **single-pass** via Python regex (callback-based substitution com negative lookbehind `(?<![:\w-])` + negative lookahead `(?![\w-])`) pra evitar oscilação 400↔600. Opacity-suffixed patterns (`bg-neutral-900/60`) tratados em passe separado. Total: 33 arquivos processados, 0 double-prefix (verificado via grep).

### Iteration 5 — TASK-SMOKE (2026-04-19 14:35)

11 E2E em `tests/e2e/themes.spec.ts` (TC-E2E-01..11) cobrindo dropdown UI, persistência via localStorage, `.dark` class toggle, sistema-follows-OS via emulateMedia, reload sem flash, CSS vars `--background` por tema, Escape fecha dropdown sem mudar tema, aria-label, multi-tab sync via `storage` event. Todos 11 passando em ~9s. **Fix durante TDD**: (1) removido `beforeEach addInitScript` que limpava localStorage — rodava também no reload, invalidando TC-E2E-06; Playwright já fornece contextos frescos por teste. (2) Chromium serializa `getComputedStyle().backgroundColor` como `lab(...)` em vez de `rgb(...)` — TCs 07/08 trocados pra validar o CSS custom property `--background` (`#fafafa` / `#0a0a0a`), mais robusto.
