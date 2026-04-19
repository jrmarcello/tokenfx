# Spec: Session Share — export session view as read-only markdown/PDF

## Status: DONE

## Context

A página de sessão (`/sessions/[id]`) agrega muita evidência útil pra incidente/PR/Confluence: KPIs de custo (com anotação de fonte), tempo ativo OTEL, breakdown de sub-agents, transcript completo com ratings. Hoje, a única forma de compartilhar isso é **print screen** ou copiar manualmente pedaço por pedaço — ambos perdem estrutura, perdem anotações, e não são citáveis em issues.

O objetivo desta spec é permitir "exportar essa view como markdown/PDF read-only pra colar em issue ou doc". Dois artefatos:

1. **Markdown** (primário) — o artefato canônico. Server gera, cliente copia pro clipboard ou baixa como `.md`. Perfeito pra colar em issue GitHub/Linear, Notion, Google Doc (importa markdown), Confluence (cola de markdown).
2. **PDF** (secundário) — via **browser print** (`window.print()`) + CSS `@media print`. Usuário escolhe "Save as PDF" no diálogo nativo do sistema. Zero dependências nativas (sem `puppeteer`, sem `pdfkit`), em troca de exigir 1 clique extra no diálogo.

Motivação pra não gerar PDF server-side: `puppeteer` pesa ~180MB e exige Chromium empacotado; `pdfkit`/`jspdf` exigem reimplementar layout. Pra uma ferramenta localhost pessoal, o print-to-PDF do browser resolve 100% dos casos reais e mantém o repo magro.

### Decisões já travadas (não pedir clarificação)

1. **Markdown é first-class, PDF é print-driven.** Não vamos instalar lib de PDF server-side nesta spec. Trade-off aceito: PDF precisa do clique "Save as PDF" do browser.
2. **Endpoint único**: `GET /api/sessions/[id]/share` retorna `text/markdown; charset=utf-8`. Query param `?download=1` adiciona `Content-Disposition: attachment; filename=...`. Query param `?redact=1` substitui conteúdo sensível por `[REDIGIDO]`. Parâmetros combináveis.
3. **Modo redact é session-wide**, não por turno. Substitui: user prompts, assistant text, tool call inputs, tool call results, rating notes. Mantém: KPIs, nomes de modelo/ferramenta/sub-agent, timestamps, valores numéricos de rating.
4. **Assistente render as-is** (pode conter markdown legítimo — headings, code blocks, listas). User prompts + tool inputs vão dentro de fenced code block (texto cru) pra não interpretar `#` ou `*` como markdown. Cerca tem largura adaptativa quando conteúdo contém backticks.
5. **Tool call truncation**: input e result truncados em 200 chars com `…` no final. Full JSON explode o markdown e não cabe em issue. Redact mode substitui inteiro.
6. **Nome de arquivo**: `tokenfx-session-<id>-<YYYYMMDD>.md`. Data no timezone do sistema (mesma convenção das outras features).
7. **Botões na página de sessão**: 3 ações no header — "Copiar markdown", "Baixar .md", "Imprimir (PDF)". Cada um em botão distinto. Sem dropdown pra manter óbvio.
8. **Copy e Download batem o mesmo endpoint**. Copy usa `fetch()` + `navigator.clipboard.writeText()`. Download usa `<a href=".?download=1" download>`. Uma única fonte de verdade.
9. **Print view reaproveita a página de sessão** com `@media print` escondendo ShareActions, RatingWidget (botões), TurnScrollTo, e forçando paleta clara. Sem rota dedicada `/print` — menos código, menos surface de erro.
10. **Sem revalidation** — endpoint é read-only, não altera DB.

## Requirements

- [ ] **REQ-1**: GIVEN a página `/sessions/[id]` WHEN renderiza com sessão válida THEN um grupo "Compartilhar" aparece no header contendo 3 botões com `aria-label` estáveis: "Copiar markdown", "Baixar markdown", "Imprimir como PDF".

- [ ] **REQ-2**: GIVEN o botão "Copiar markdown" WHEN clicado THEN `fetch('/api/sessions/<id>/share')` é chamado, o corpo é escrito em `navigator.clipboard` via `writeText`, e um feedback visual ("Copiado!") aparece por ~2s. Erros de clipboard (permissão negada, `navigator.clipboard` undefined) mostram "Falha ao copiar" com link fallback pro botão de download.

- [ ] **REQ-3**: GIVEN o botão "Baixar markdown" WHEN clicado THEN o navegador baixa `tokenfx-session-<id>-<YYYYMMDD>.md` contendo o markdown da sessão. `YYYYMMDD` é a data atual no timezone do sistema.

- [ ] **REQ-4**: GIVEN o botão "Imprimir como PDF" WHEN clicado THEN `window.print()` é chamado e o diálogo nativo de impressão abre. O usuário escolhe "Save as PDF" no destino pra gerar o PDF.

- [ ] **REQ-5**: GIVEN `GET /api/sessions/<id>/share` com id válido WHEN chamado THEN retorna 200 com `Content-Type: text/markdown; charset=utf-8` e body começando com `# Sessão: <project>`.

- [ ] **REQ-6**: GIVEN `GET /api/sessions/<id>/share?download=1` WHEN chamado THEN retorna 200 com header `Content-Disposition: attachment; filename="tokenfx-session-<id>-<YYYYMMDD>.md"`. Sem o query param, `Content-Disposition` é omitido (browser exibe inline).

- [ ] **REQ-7**: GIVEN `GET /api/sessions/<id>/share` com id inexistente WHEN chamado THEN retorna 404 com body JSON `{"error":{"message":"Session not found","code":"SESSION_NOT_FOUND"}}` e `Content-Type: application/json`.

- [ ] **REQ-8**: GIVEN o markdown gerado WHEN renderizado THEN a estrutura é exatamente:
  1. H1: `# Sessão: <project>`
  2. Parágrafo de metadata: `**ID**: <id>` · `**Início**: <ISO>` · `**Fim**: <ISO>` · `**Branch**: <git_branch ou —>`
  3. H2 `## KPIs` com lista `- **Custo**: <usd> <cost_source_tag>`, `- **Turnos**: <n>`, `- **Cache hit**: <pct ou —>`, `- **Avaliação média**: <rating ou —>`
  4. H2 `## OTEL` — presente somente quando `otel.hasData === true`; contém `- **Accept rate**: <pct>`, `- **Linhas +**: <n>`, `- **Linhas −**: <n>`, e `- **Active time**: <dur>` (somente se `activeSeconds > 0`)
  5. H2 `## Sub-agentes` — presente somente quando `subagentBreakdown.length > 0`; tabela markdown com cols `| Tipo | Turnos | Custo | % custo |`
  6. H2 `## Transcript` — H3 por turno `### Turno <n> — <model> — <HH:MM:SS>`; cada turno contém os blocos opcionais descritos nos REQs 11–14

- [ ] **REQ-9**: GIVEN o KPI de custo WHEN renderizado no markdown THEN a anotação de fonte acompanha o valor: `[otel]` quando `costSource==='otel'`, `[calibrado, ratio <r>]` quando `costSource==='calibrated'` (r formatado com 2 casas decimais, ex: `0.20`), `[list]` quando `costSource==='list'`. Quando `calibrated` mas global rate indisponível no momento do render (edge case), usa `[calibrado]` sem ratio.

- [ ] **REQ-10**: GIVEN a seção `## Sub-agentes` WHEN gerada THEN as linhas são ordenadas por `costUsd DESC`, `Tipo` do bucket `null` é renderizado como literal `Main`, `Custo` formatado como `$1.23`, `% custo` como `45.2%`.

- [ ] **REQ-11**: GIVEN um turno com `userPrompt` não-null e não-vazio WHEN renderizado THEN inclui o label `**Usuário:**` em linha própria, seguido de um fenced code block com info string `text` contendo o prompt cru. A cerca tem comprimento mínimo de 3 backticks, estendido conforme REQ-15.

- [ ] **REQ-12**: GIVEN um turno com `assistantText` não-null e não-vazio WHEN renderizado THEN inclui o label `**Assistente:**` em linha própria seguido de linha em branco e o texto do assistant as-is — **sem fence**, preservando markdown nativo. Quando `userPrompt` também existe, aparece depois do bloco de usuário.

- [ ] **REQ-13**: GIVEN um turno com `toolCalls.length > 0` WHEN renderizado THEN inclui o label `**Ferramentas:**` em linha própria seguido de um bullet por tool call no formato `- {status} **{toolName}** — input: {inputCode}` quando `resultJson === null`, OU `- {status} **{toolName}** — input: {inputCode} — result: {resultCode}` quando `resultJson !== null`. `{status}` = `✓` (resultIsError false) OU `✗` (true). `{inputCode}` e `{resultCode}` são inline code spans contendo o JSON truncado em 200 chars via `truncate()` (mantém até 200 chars, substitui excedente por `…`).

- [ ] **REQ-14**: GIVEN um turno com `rating` não-null WHEN renderizado THEN inclui linha `**Avaliação:** {emoji} {label}` onde `{emoji} {label}` é `👍 Bom` (value=1), `😐 Neutro` (value=0), ou `👎 Ruim` (value=-1). Se `rating.note` não-null e não-vazio, anexa o separador `—` seguido do `note`. Se `rating` é null, linha omitida.

- [ ] **REQ-15**: GIVEN conteúdo de `userPrompt` ou `toolCall.inputJson`/`resultJson` WHEN renderizado dentro de fenced code block THEN o comprimento da cerca é `max(3, 1 + maxBacktickRun)` onde `maxBacktickRun` é o comprimento da maior sequência consecutiva de backticks no conteúdo. Isso garante que conteúdo com triple backtick é preservado — cerca vira 4 backticks; conteúdo com 4 backticks consecutivos força cerca de 5 backticks.

- [ ] **REQ-16**: GIVEN `GET /api/sessions/{id}/share?redact=1` WHEN chamado THEN o markdown retornado substitui pelos literais `[REDIGIDO]`: `userPrompt`, `assistantText`, cada `toolCall.inputJson`, cada `toolCall.resultJson`, cada `rating.note`. Preservam-se intactos: todos os KPIs, `model`, `toolName`, `subagent_type`, `timestamp`, `rating.value`, e a estrutura geral.

- [ ] **REQ-17**: GIVEN um turno sem user prompt E sem assistant text E sem tool calls (edge — turn "vazio" pós-erro) WHEN renderizado THEN o H3 do turno aparece com 1 linha em itálico `_(sem conteúdo)_` pra manter a sequência visível.

- [ ] **REQ-18**: GIVEN uma sessão com `turns.length === 0` WHEN markdown gerado THEN a seção `## Transcript` contém uma linha em itálico `_Sem turnos nesta sessão._` (sem lista numerada vazia).

- [ ] **REQ-19**: GIVEN a página de sessão WHEN o browser está em `@media print` THEN os elementos com a classe Tailwind `print:hidden` ficam `display: none`. Especificamente: o grupo ShareActions, cada `RatingWidget`, e `TurnScrollTo` desaparecem. Background fica branco (`html, body { background: white !important; color: black !important }` em `globals.css`). Nenhum conteúdo de turno é escondido — prompts, assistant text e tool calls permanecem visíveis e legíveis.

- [ ] **REQ-20**: GIVEN um id de sessão que não é UUID mas existe no DB (ids legados) WHEN usado na URL THEN o endpoint aceita e responde normalmente. O id é tratado como opaque string, passado via prepared statement — sem validação de formato que rejeite ids válidos do DB.

- [ ] **REQ-21**: GIVEN o botão "Imprimir como PDF" WHEN clicado THEN `window.print()` é invocado exatamente uma vez. Não há navegação, não há alteração de URL, não há toast.

- [ ] **REQ-22**: GIVEN o botão "Copiar markdown" WHEN o fetch ao endpoint falha (status != 200) OU `navigator.clipboard.writeText` rejeita OU `navigator.clipboard` está indefinido WHEN clicado THEN o botão entra no estado `error` exibindo "Falha ao copiar" por ~3s. Nenhum erro é propagado pro console além de um `logger.warn` opcional.

## Test Plan

### Unit Tests

Testes do renderer puro em [lib/share/session-markdown.test.ts](lib/share/session-markdown.test.ts).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-8 | happy | Sessão completa (KPIs + OTEL + 2 sub-agents + 3 turns) | markdown tem H1, metadata line, ## KPIs, ## OTEL, ## Sub-agentes, ## Transcript nessa ordem |
| TC-U-02 | REQ-8 | edge | Sessão sem OTEL (`otel.hasData=false`) | seção `## OTEL` ausente |
| TC-U-03 | REQ-8 | edge | Sessão sem sub-agents (`breakdown=[]`) | seção `## Sub-agentes` ausente |
| TC-U-04 | REQ-8 | edge | Sessão sem branch (`gitBranch=null`) | metadata tem `**Branch**: —` |
| TC-U-05 | REQ-9 | business | `costSource='otel'` | linha custo termina com o sufixo `[otel]` (precedido de espaço) |
| TC-U-06 | REQ-9 | business | `costSource='calibrated'` com ratio 0.2 | linha custo termina com `[calibrado, ratio 0.20]` |
| TC-U-07 | REQ-9 | business | `costSource='calibrated'` com ratio null | linha custo termina com `[calibrado]` (sem ratio) |
| TC-U-08 | REQ-9 | business | `costSource='list'` | linha custo termina com `[list]` |
| TC-U-09 | REQ-10 | happy | 3 sub-agents com custos 5/3/2 | tabela ordenada por custo desc; primeira linha é 5 |
| TC-U-10 | REQ-10 | edge | Sub-agent bucket com `subagentType=null` | tabela mostra literal `Main` |
| TC-U-11 | REQ-10 | business | Formatação custo `$12.34` e pct `45.2%` | match exato |
| TC-U-12 | REQ-11 | happy | Turn com userPrompt "oi" | bloco `**Usuário:**` seguido de fence 3-backticks com `oi` |
| TC-U-13 | REQ-12 | happy | Turn com assistantText `"# Header"` | assistant text aparece as-is (sem fence), preservando `#` |
| TC-U-14 | REQ-11, REQ-12 | happy | Turn com ambos user + assistant | user bloco aparece antes de assistant |
| TC-U-15 | REQ-13 | happy | Turn com 1 toolCall success | bullet com `✓`, toolName negrito, input em backtick inline |
| TC-U-16 | REQ-13 | happy | Turn com 1 toolCall error (`resultIsError=true`) | bullet com `✗` |
| TC-U-17 | REQ-13 | edge | toolCall com `resultJson=null` | bullet omite `— result:` |
| TC-U-18 | REQ-13 | edge | toolCall com `inputJson` > 200 chars | input truncado, termina com `…` |
| TC-U-19 | REQ-14 | happy | rating +1 | linha `**Avaliação:** 👍 Bom` |
| TC-U-20 | REQ-14 | happy | rating 0 | linha `**Avaliação:** 😐 Neutro` |
| TC-U-21 | REQ-14 | happy | rating -1 | linha `**Avaliação:** 👎 Ruim` |
| TC-U-22 | REQ-14 | edge | rating com note "great" | linha contém o separador `—` seguido de `great` |
| TC-U-23 | REQ-14 | edge | rating=null | linha Avaliação omitida |
| TC-U-24 | REQ-15 | edge | userPrompt contém triple backtick | fence vira 4 backticks |
| TC-U-25 | REQ-15 | edge | userPrompt contém 4 backticks consecutivos | fence vira 5 backticks |
| TC-U-26 | REQ-15 | edge | userPrompt sem backticks | fence fica 3 backticks |
| TC-U-27 | REQ-16 | happy | `redact=true`, turn com user/assistant/tool/rating-note | prompts, assistant text, tool input/result, rating note = `[REDIGIDO]` |
| TC-U-28 | REQ-16 | business | `redact=true` | toolName, model, timestamp, rating.value preservados |
| TC-U-29 | REQ-17 | edge | Turn sem user, sem assistant, sem toolcalls | H3 presente, linha `_(sem conteúdo)_` abaixo |
| TC-U-30 | REQ-18 | edge | Sessão com 0 turnos | seção Transcript tem `_Sem turnos nesta sessão._` |

### Integration Tests

Testes do API route + DB real em [app/api/sessions/[id]/share/route.test.ts](app/api/sessions/[id]/share/route.test.ts). Inserem sessão sintética via writer, chamam o handler com um `NextRequest`, asseveram response.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-5 | happy | GET `/api/sessions/<id>/share` com id existente | 200, `text/markdown; charset=utf-8`, body começa com `# Sessão:` |
| TC-I-02 | REQ-6 | happy | GET com `?download=1` | `Content-Disposition: attachment; filename="tokenfx-session-<id>-<YYYYMMDD>.md"` |
| TC-I-03 | REQ-6 | business | GET sem `?download=1` | header `Content-Disposition` ausente |
| TC-I-04 | REQ-16 | happy | GET com `?redact=1` | body contém `[REDIGIDO]` e NÃO contém o texto do user prompt original |
| TC-I-05 | REQ-16 | business | GET com `?redact=1` | body contém o `toolName` (ex: `Bash`) e o `model` (ex: `claude-opus-4-7`) |
| TC-I-06 | REQ-7 | validation | GET com id inexistente `does-not-exist` | 404, `application/json`, body `{error:{message:"Session not found",code:"SESSION_NOT_FOUND"}}` |
| TC-I-07 | REQ-7 | security | GET com id malformado `../etc/passwd` | 404 (SQL parametrizado trata como lookup normal, id não existe no DB) |
| TC-I-08 | REQ-6 | business | Filename usa data local em format YYYYMMDD | stub `Date.now()` retornando 2026-04-19 → filename contém `20260419` |
| TC-I-09 | REQ-5, REQ-7 | idempotency | GET 2× seguidos com mesmo id | ambas retornam 200 com body idêntico byte-a-byte |
| TC-I-10 | REQ-5 | edge | GET em sessão real com 0 turnos | 200, body inclui `_Sem turnos nesta sessão._` |
| TC-I-11 | REQ-20 | edge | GET com id legado não-UUID (ex: `legacy-2024-001`) inserido via writer | 200, body começa com `# Sessão:`; filename em `?download=1` contém o id encoded |

### E2E Tests

Em [tests/e2e/session-share.spec.ts](tests/e2e/session-share.spec.ts), executado pelo TASK-SMOKE.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1 | happy | Página de sessão renderiza | 3 botões com aria-labels "Copiar markdown", "Baixar markdown", "Imprimir como PDF" presentes |
| TC-E2E-02 | REQ-2 | happy | Clica "Copiar markdown" | clipboard contém texto começando com `# Sessão:` (Playwright clipboard grant) |
| TC-E2E-03 | REQ-3 | happy | Clica "Baixar markdown" | download dispara, filename matches `/^tokenfx-session-.+-\d{8}\.md$/` |
| TC-E2E-04 | REQ-19 | happy | `page.emulateMedia({ media: 'print' })` | ShareActions invisível (`display: none`); RatingWidget invisível |
| TC-E2E-05 | REQ-4, REQ-21 | happy | Clica "Imprimir como PDF" com `page.exposeFunction` ou `window.print` stub | `window.print()` é chamado exatamente 1 vez; URL não muda |
| TC-E2E-06 | REQ-22 | edge | Clica "Copiar markdown" com clipboard permission negada (`context.grantPermissions([])`) | botão entra em estado `error` exibindo "Falha ao copiar"; volta a `idle` após ~3s |

## Design

### Architecture Decisions

- **Renderer puro**: toda lógica de markdown em `lib/share/session-markdown.ts` exportando `renderSessionMarkdown(input: SessionShareInput, opts: { redact: boolean }): string`. Sem side effects, sem I/O. Assinatura recebe os mesmos shapes já retornados pelas queries existentes (`SessionDetail`, `TurnDetail[]`, `OtelSessionStats`, `SubagentBreakdownRow[]`) + `calibrationRate: number | null` (pego via `getCostCalibration(db).get('global')?.rate`). Isso mantém o renderer testável sem DB.

- **Reuso de formatters**: valores numéricos no markdown usam os helpers já existentes em `lib/fmt.ts` — `fmtUsd` (custo), `fmtUsdFine` (custo por turn quando precisar), `fmtPct` (cache hit, accept rate, % custo), `fmtRating` (rating média), `fmtCompact` (linhas ±), `fmtDateTime` (ISO timestamps). Nada de reimplementar formatação. Data do filename usa um novo helper `formatYyyymmdd(date: Date): string` (6 linhas) pra não depender do locale.

- **Fence width helper** (`computeFenceWidth(content: string): number`) extrai o maior run de backticks no conteúdo e retorna `max(3, maior+1)`. Implementação: regex `/`+/g` agregando `Math.max` sobre `match.length`.

- **Tool-call truncation helper** (`truncate(s: string, n: number): string`) retorna `s.length <= n ? s : s.slice(0, n) + '…'`. Usado em input e result (que chegam como JSON string crua).

- **Redaction helper** (`redact(s: string | null): string` quando `opts.redact === true`): null → null (linha some), string não-vazia → `[REDIGIDO]`, string vazia → null (sem bloco).

- **API route shape**: App Router handler em `app/api/sessions/[id]/share/route.ts`:

  ```ts
  export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse | Response> {
    const { id } = await params;
    const url = new URL(req.url);
    const download = url.searchParams.get('download') === '1';
    const redactFlag = url.searchParams.get('redact') === '1';
    const db = getDb();
    const session = getSession(db, id);
    if (!session) {
      return NextResponse.json(
        { error: { message: 'Session not found', code: 'SESSION_NOT_FOUND' } },
        { status: 404 }
      );
    }
    const turns = getTurns(db, id);
    const otel = getSessionOtelStats(db, id);
    const breakdown = getSubagentBreakdown(db, id);
    const calibration = getCostCalibration(db);
    const globalRate = calibration.get('global')?.rate ?? null;
    const body = renderSessionMarkdown(
      { session, turns, otel, breakdown, globalRate },
      { redact: redactFlag }
    );
    const headers: Record<string, string> = {
      'Content-Type': 'text/markdown; charset=utf-8',
    };
    if (download) {
      const dateStr = formatYyyymmdd(new Date());
      headers['Content-Disposition'] =
        `attachment; filename="tokenfx-session-${encodeURIComponent(id)}-${dateStr}.md"`;
    }
    return new Response(body, { status: 200, headers });
  }
  ```

  Notas: usa `getSession` existente (já aplica a cascata OTEL → calibrated → list e expõe `costSource`). Usa `encodeURIComponent` no id pra filename, prevenindo injeção de header via id com `"` ou `\r\n` (defense-in-depth — ids do DB são seguros mas o encoding é barato).

- **ShareActions client component** (`components/session/share-actions.tsx`):

  ```tsx
  'use client';
  export function ShareActions({ sessionId }: { sessionId: string }) {
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
    const onCopy = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`);
        if (!res.ok) throw new Error('fetch failed');
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        setCopyStatus('copied');
        setTimeout(() => setCopyStatus('idle'), 2000);
      } catch {
        setCopyStatus('error');
        setTimeout(() => setCopyStatus('idle'), 3000);
      }
    };
    const onPrint = () => window.print();
    return (
      <div className="share-actions flex items-center gap-2 print:hidden" aria-label="Compartilhar">
        <button onClick={onCopy} aria-label="Copiar markdown">...</button>
        <a
          href={`/api/sessions/${encodeURIComponent(sessionId)}/share?download=1`}
          aria-label="Baixar markdown"
          download
        >...</a>
        <button onClick={onPrint} aria-label="Imprimir como PDF">...</button>
      </div>
    );
  }
  ```

  Classe `share-actions` permite hook do CSS de print.

- **Print CSS**: adicionar em `app/globals.css` bloco:

  ```css
  @media print {
    html, body { background: white !important; color: black !important; }
    .share-actions, .rating-widget, .turn-scroll-to { display: none !important; }
    /* expande todos os turnos; desativa truncate/line-clamp */
    [data-turn-block] { max-height: none !important; -webkit-line-clamp: unset !important; }
  }
  ```

  `RatingWidget` e `TurnScrollTo` já existem — só precisamos adicionar `className="rating-widget"` / `"turn-scroll-to"` a eles (Tailwind `print:hidden` serve mas a classe explícita também funciona e é mais portátil).

  **Caminho mais limpo**: usar Tailwind `print:hidden` direto nos componentes existentes, evitando classes novas. Único bloco em `globals.css` é o reset de cores:

  ```css
  @media print {
    html, body { background: white !important; color: black !important; }
  }
  ```

  E nos componentes: `className="... print:hidden"`.

- **Error response shape**: segue o padrão documentado em `.claude/rules/security.md` — `{ error: { message: string, code?: string } }`.

- **Revalidation**: não aplicável (endpoint GET read-only).

### Files to Create

- `lib/share/session-markdown.ts` — renderer puro
- `lib/share/session-markdown.test.ts` — 30 TC-Us
- `app/api/sessions/[id]/share/route.ts` — handler GET
- `app/api/sessions/[id]/share/route.test.ts` — 10 TC-Is (via real SQLite + writer)
- `components/session/share-actions.tsx` — client component com 3 botões
- `tests/e2e/session-share.spec.ts` — 4 TC-E2Es

### Files to Modify

- `app/sessions/[id]/page.tsx` — renderizar `<ShareActions sessionId={session.id} />` no header
- `app/globals.css` — adicionar bloco `@media print` com reset de cores
- `components/rating-widget.tsx` — adicionar `print:hidden` (Tailwind)
- `components/turn-scroll-to.tsx` — adicionar `print:hidden`

### Dependencies

- Nenhuma nova dep. `window.print()` é built-in, `navigator.clipboard.writeText` idem. `NextResponse` + `NextRequest` do `next/server` já em uso.

## Tasks

- [x] TASK-1: Implementar renderer puro `renderSessionMarkdown`
  - files: lib/share/session-markdown.ts, lib/share/session-markdown.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11, TC-U-12, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-U-22, TC-U-23, TC-U-24, TC-U-25, TC-U-26, TC-U-27, TC-U-28, TC-U-29, TC-U-30

- [x] TASK-2: Implementar API route `GET /api/sessions/[id]/share`
  - files: app/api/sessions/[id]/share/route.ts, app/api/sessions/[id]/share/route.test.ts
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09, TC-I-10, TC-I-11

- [x] TASK-3: Implementar `ShareActions` client component
  - files: components/session/share-actions.tsx
  - depends: TASK-2

- [x] TASK-4: Integrar ShareActions na página de sessão
  - files: app/sessions/[id]/page.tsx
  - depends: TASK-3

- [x] TASK-5: Adicionar print CSS + `print:hidden` em componentes interativos
  - files: app/globals.css, components/rating-widget.tsx, components/turn-scroll-to.tsx

- [x] TASK-SMOKE: Executar testes E2E Playwright
  - files: tests/e2e/session-share.spec.ts
  - depends: TASK-4, TASK-5
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-5]             — parallel (files exclusive: lib/share/* vs app/globals.css + components/rating-widget.tsx + components/turn-scroll-to.tsx)
Batch 2: [TASK-2]                     — sequential (depends: TASK-1; needs renderer shape)
Batch 3: [TASK-3]                     — sequential (depends: TASK-2; fetches the endpoint)
Batch 4: [TASK-4]                     — sequential (depends: TASK-3; integrates component into page)
Batch 5: [TASK-SMOKE]                 — sequential (depends: TASK-4 + TASK-5; needs UI + print CSS live)
```

File overlap analysis:

- `lib/share/session-markdown.ts`, `lib/share/session-markdown.test.ts`: exclusive to TASK-1
- `app/api/sessions/[id]/share/route.ts`, `.test.ts`: exclusive to TASK-2
- `components/session/share-actions.tsx`: exclusive to TASK-3
- `app/sessions/[id]/page.tsx`: exclusive to TASK-4
- `app/globals.css`, `components/rating-widget.tsx`, `components/turn-scroll-to.tsx`: exclusive to TASK-5
- `tests/e2e/session-share.spec.ts`: exclusive to TASK-SMOKE

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (including 30 new TC-U + 10 new TC-I)
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (4 new TC-E2E)

### Discipline Checkpoints (mandatory before reporting DONE)

**Checkpoint 1 — Self-review REQ-by-REQ**: walk REQ-1..REQ-20 with concrete evidence (file:line or test name).

**Checkpoint 2 — Live validation with real data**:

- `pnpm dev` em background; abrir uma sessão real no browser; clicar nos 3 botões:
  - "Copiar markdown" → colar em um editor externo, verificar que começa com `# Sessão:`, tem as seções esperadas, e assistant text preserva markdown.
  - "Baixar markdown" → arquivo baixa com filename `tokenfx-session-<id>-YYYYMMDD.md`, abre em editor, estrutura ok.
  - "Imprimir como PDF" → diálogo de print abre; preview mostra conteúdo sem os 3 botões, sem rating widgets, fundo branco.
- `curl 'http://localhost:3000/api/sessions/<real-id>/share'` → response 200 com markdown.
- `curl 'http://localhost:3000/api/sessions/<real-id>/share?redact=1' | grep -c '\[REDIGIDO\]'` → contagem > 0.
- `curl -I 'http://localhost:3000/api/sessions/<real-id>/share?download=1'` → tem `Content-Disposition: attachment`.
- `curl -i 'http://localhost:3000/api/sessions/nonexistent/share'` → HTTP 404 com body JSON.
- Parar o dev server. Report do SIGTERM esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — TASK-1 + TASK-5 (2026-04-19 12:03)

Batch 1 paralelo via 2 worktrees. TASK-1: `renderSessionMarkdown` puro em `lib/share/session-markdown.ts` + 38 TCs (30 TC-U + 8 helper) em colocated test. TASK-5: `@media print` reset de cores em `globals.css` + `print:hidden` em `RatingWidget` e `TurnScrollTo`. Merged + fix pós-merge: restaurar `Value | null` no `RatingWidget.initial` + realinhar `SubagentBreakdownRow` com fields reais (`turns`/`pct`/`outputTokens`). Suite: 461 → 499 tests (+38).
TDD (TASK-1): RED(import failed) → GREEN(38 passing) → REFACTOR(clean).

### Iteration 2 — TASK-2 (2026-04-19 12:07)

Route handler `GET /api/sessions/[id]/share` com guard `isLocalhost`, query params `download` e `redact`. Resposta `text/markdown; charset=utf-8`; opcional `Content-Disposition: attachment; filename=tokenfx-session-<id>-YYYYMMDD.md` (id URL-encoded). 404 JSON `{error:{message,code:SESSION_NOT_FOUND}}` em lookup miss. Test file inclui setup via `openDatabase`/`writeSession` com `DASHBOARD_DB_PATH` apontando pra tmpfile. Vitest config estendido pra incluir `app/**/*.test.ts`. Suite: 499 → 510 tests (+11).
TDD: RED(import failed) → GREEN(11 passing) → REFACTOR(clean).

### Iteration 3 — TASK-3 (2026-04-19 12:08)

`ShareActions` client component em `components/session/share-actions.tsx` com 3 ações (Copiar markdown / Baixar .md / Imprimir PDF) e feedback inline de estado (idle/copied/error) com timeouts de 2s/3s. `<a download>` pra download direto; `navigator.clipboard.writeText` pra copy com fallback de erro. Class `share-actions print:hidden` pro media query de impressão esconder o grupo.

### Iteration 4 — TASK-4 (2026-04-19 12:09)

Integrado `<ShareActions sessionId={session.id} />` no header da página `/sessions/[id]`. Layout ajustado: `h1` + `ShareActions` agora ficam em `flex ... justify-between` pra ação alinhar à direita do título. Typecheck e lint limpos.

### Iteration 5 — TASK-SMOKE (2026-04-19 12:12)

6 testes E2E em `tests/e2e/session-share.spec.ts` — TC-E2E-01..06. Todos passam (17s total): botões presentes, copy escreve clipboard, download dispara com filename esperado, `emulateMedia({media:'print'})` esconde ShareActions e RatingWidget, print button chama `window.print()` exatamente 1×, clipboard rejeitada cai em estado `error`. 2 falhas na suite full (TC-E2E-08 mixed-badge e TC-E2E-03 rating) são **pré-existentes** (confirmado: falham na `main` sem minhas mudanças).
