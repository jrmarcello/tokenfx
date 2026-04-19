# TokenFx

![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-06b6d4?logo=tailwindcss&logoColor=white)
![better-sqlite3](https://img.shields.io/badge/SQLite-better--sqlite3-003b57?logo=sqlite&logoColor=white)
![Vitest 4](https://img.shields.io/badge/Vitest-4-6e9f18?logo=vitest&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.59-2ead33?logo=playwright&logoColor=white)
![Localhost only](https://img.shields.io/badge/deployment-localhost--only-222)

**Quanto o Claude Code te cobra é fácil. Saber se a conta valeu — não.**

Esse dashboard ingere os transcripts locais do Claude Code (`~/.claude/projects/*.jsonl`) + métricas OTEL opcionais, guarda tudo num SQLite na sua máquina e te dá a foto completa: quanto você gastou, em qual projeto, em qual sessão, em qual turno — e quão efetivo foi cada um. Roda 100% local, sem cloud, sem telemetria pra fora.

---

## Pra que serve

- **Você paga por token; ninguém te paga por resultado.** `claude /cost` te diz o gasto da sessão aberta. Grafana mostra consumo ao longo do tempo. Nenhum dos dois responde *"essa sessão cara valeu o preço?"*. Aqui você clica na sessão mais cara da semana, lê o transcript, avalia turno a turno — e o score composto te aponta onde o dinheiro virou trabalho entregue.
- **Efetividade não é opinião.** Quatro sinais alimentam o score (0..100): razão output/input, taxa de cache hit, avaliação manual (Bom/Neutro/Ruim por turno) e densidade de correção — detectada via regex no próximo prompt do usuário. Se você respondeu *"não, isso tá errado"*, o turno anterior perde pontos automaticamente.
- **Zero infra pra manter.** SQLite em arquivo único, Next.js local, porta 3000. Nada pra subir, nada pra derrubar, nada saindo da sua máquina.

## 5 minutos pra ver rodando

```bash
pnpm install
pnpm seed-dev          # popula com dados sintéticos pra ver a UI
pnpm dev               # http://localhost:3131
```

Abriu? Você vê KPIs, tendência de 30 dias, top sessões. Clica numa → transcript completo com botões de avaliação em cada turno.

Pronto pra ver seus dados reais?

```bash
pnpm ingest            # lê ~/.claude/projects/*.jsonl, popula data/dashboard.db
```

Idempotente — pode rodar quantas vezes quiser. **Mais importante**: você nem precisa. O dashboard auto-ingere a cada page load quando detecta transcripts novos. Ou seja: abriu a página, viu os dados atualizados. Sem cron, sem daemon.

---

## Como funciona

### O problema

Você abre `/cost` no meio de uma task, vê `$0.47`, fecha e continua. Terminou o dia com $12, a semana com $60, o mês com $240. **Nenhum desses números diz onde o gasto foi trabalho entregue e onde foi retrabalho.** Sessões de refactor que deram certo têm o mesmo preço de sessões em que você ficou corrigindo o assistente três vezes. Grafana agrega no tempo, não na intenção. Cost-per-PR é bruto demais — uma PR pode ter saído de uma sessão boa e duas ruins.

### Como esse dashboard ataca isso

Três camadas:

1. **Ingestão local**: parser JSONL tolerante + scraper OTEL Prometheus → SQLite idempotente. Sem rede.
2. **Três views complementares**:
   - `/` — Visão geral: quanto gastou hoje/7d/30d, cache hit, tokens, top sessões, tendência.
   - `/sessions/[id]` — Drill-down: metadata + lista de turnos + transcript completo com user prompt, assistant text e tool calls colapsáveis. Cada turno tem rating manual.
   - `/effectiveness` — Heurísticas: score composto, distribuição de custo por turno, razão output/input semanal, ferramentas mais usadas.
3. **Score composto de efetividade**: um número (0..100) por sessão, ponderando:

| Sinal | Peso | Fonte |
| --- | --- | --- |
| Razão output/input (clipped a 2.0) | 40% | Agregado da sessão |
| Taxa de cache hit | 20% | Agregado da sessão |
| Avaliação manual média | 30% | Tabela `ratings` |
| 1 − densidade de correção | 10% | Regex no próximo prompt |

Sinais ausentes (nulos) são descartados e os pesos se redistribuem proporcionalmente. Matemática completa em [`lib/analytics/scoring.ts`](lib/analytics/scoring.ts).

### Onde seus dados vivem

- `data/dashboard.db` — SQLite, gitignored. **Back up esse arquivo** se quiser preservar suas avaliações manuais.
- `~/.claude/projects/` — owned pelo Claude Code, read-only daqui.
- Nenhuma conexão externa. Nenhum analytics. Nenhum header `User-Agent` curioso saindo da sua máquina.

---

## Na prática

### Ativar OTEL do Claude Code (opcional, mas vale)

Métricas OTEL trazem contexto que o JSONL não carrega: **accept/reject de Edit/Write** (sinal direto de qualidade), `lines_of_code` alteradas, commits, PRs e `active_time`. Duas formas de ativar, dependendo de como você roda o Claude Code:

**Via `~/.claude/settings.json` — recomendado (funciona em qualquer contexto, inclusive VSCode):**

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "prometheus"
  }
  // ... outros settings
}
```

Aplica em toda instância do Claude Code (CLI, extensão VSCode, qualquer lançador). Requer **restart do processo** pra pegar — fecha e abre o VSCode (⌘Q + relaunch), ou mata/reabre o `claude` no terminal.

**Via env vars do shell — só funciona se você lança `claude` direto do terminal:**

```bash
# ~/.zshrc (ou export ad-hoc antes de rodar claude)
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
```

> ⚠️ **Atenção com VSCode**: apps GUI no macOS **não lêem** `~/.zshrc`. Se você usa a extensão Claude Code do VSCode, a única forma que funciona de fato é o `settings.json` acima.

**Endpoint padrão**: `http://localhost:9464/metrics`. Se usar porta custom, aponta o dashboard com:

```bash
OTEL_SCRAPE_URL=http://localhost:XXXX/metrics pnpm ingest
```

**Verificar que subiu:**

```bash
curl -s http://localhost:9464/metrics | head -5
# deve cuspir "# HELP claude_code_..."
```

**No dashboard**, o badge no canto superior direito reflete o estado (cache de 60s): **● OTEL on** (verde) = métricas sendo ingeridas; **● OTEL off** (cinza) = só transcripts.

### Modo watch (ingestão push-based)

Por padrão o dashboard roda em modo pull: a cada page load ele confere se há JSONL novo em `~/.claude/projects/` e ingere o que faltar. Funciona bem pra quem abre o dashboard de vez em quando — mas se você quer ver a sessão ativa aparecer em tempo real, tem um watcher opt-in (chokidar) que ingere os arquivos conforme o Claude Code escreve neles, sem depender de refresh manual.

Pra ativar junto do dev server:

```bash
TOKENFX_WATCH_MODE=1 pnpm dev
```

O watcher sobe como processo background no boot do Next, observa `~/.claude/projects/**/*.jsonl`, e chama a mesma pipeline de ingestão assim que detecta arquivo novo ou modificado. Enquanto ele tá rodando, a auto-ingestão on-page-load vira no-op (evita `stat()` redundante em cada request).

Prefere um daemon standalone, sem UI? Mesma engine, via CLI:

```bash
pnpm watch
```

Útil pra rodar num terminal separado, fazer backfill noturno, ou manter rodando enquanto você desenvolve em outro projeto.

**Latência**: ~500ms–1.5s entre o write do Claude Code e a linha aparecer no dashboard. Isso é o threshold `awaitWriteFinish` do chokidar — ele espera o arquivo parar de crescer antes de ingerir pra não ler JSONL parcial. Refresh do browser depois da ingestão continua necessário (ou deixa a tab com revalidação ativa).

**Desligar**: basta não passar o env, e o comportamento default (pull-based) volta. Se quiser matar as duas rotas de uma vez (ex.: no harness E2E ou durante testes), use `TOKENFX_DISABLE_AUTO_INGEST=1` — isso desativa tanto o watcher quanto a ingestão on-page-load.

**Quando usar**: pra monitorar uma sessão ativa em tempo real sem refresh manual, ou quando você tá revisando efetividade turno a turno enquanto o Claude Code ainda tá respondendo.

### Como a ingestão permanece idempotente

**Sim, `pnpm ingest` é seguro de rodar quantas vezes você quiser.** Três camadas garantem isso:

1. **Chave natural `session_id`** (UUID emitido pelo Claude Code): writer usa `INSERT ... ON CONFLICT(id) DO UPDATE` em sessions/turns/tool_calls. Re-ingerir o mesmo arquivo atualiza em vez de duplicar.
2. **Reconciliação pós-write**: depois de qualquer ingestão, as sequences e rollups da session são recalculados a partir das linhas de turnos reais — então sessões que ficam espalhadas em múltiplos `.jsonl` (sub-agents, rotação de transcript) terminam com `turn_count`, `total_cost_usd` e `started_at/ended_at` sempre coerentes com o estado autoritativo.
3. **Transações atômicas**: writes múltiplos rodam dentro de `db.transaction(fn)` — se algo falhar no meio, nada parcial fica no DB.

Ratings manuais **nunca** são tocadas pela ingestão — é seu dado mais precioso.

Não-idempotente por design: `otel_scrapes` é append-only (é um log temporal; cada scrape é uma nova linha).

### Como avaliar um turno (Bom / Neutro / Ruim)

Avaliação manual é o sinal mais forte do score composto (30% do peso). Critérios objetivos:

**Bom (+1)** — entregou. Use quando:

- O turno produziu o que você pediu e você usou o resultado sem reescrever
- Tool calls foram precisos e sucederam (edits aplicados, comandos OK)
- Resolveu rápido, sem rodeio desnecessário
- O próximo turno seu NÃO começou com correção ("não, isso tá errado")

**Neutro (0)** — meio do caminho. Use quando:

- Tecnicamente correto mas precisou pequeno ajuste no follow-up
- Respondeu parcialmente — cobriu o principal, deixou lacuna
- Verbose demais pra uma task simples
- Cache miss ou ineficiência óbvia mas sem impacto de qualidade

**Ruim (-1)** — atrapalhou. Use quando:

- Alucinou (API que não existe, assinatura errada)
- Tool calls desnecessários ou que falharam em cadeia
- Ignorou instrução explícita do prompt
- Forçou retrabalho ("deixa, eu faço manual")
- Causou regressão (quebrou algo que funcionava)

Regra prática: se você se lembra do turno **com frustração**, é Ruim. Se lembra **feliz de ter economizado tempo**, é Bom. Neutro é tudo no meio.

### A heurística de correção

[`lib/analytics/scoring.ts`](lib/analytics/scoring.ts) roda duas regex bilíngues (pt + en) no *próximo* prompt do usuário. Vocabulário curado pra minimizar falso-positivo:

- **Forte (penalidade 1.0)** — sinais explícitos de erro/undo/retry: `não`, `errou`, `errado`, `refaz`, `apaga`, `quebrou`, `volta atrás`, `não funcionou`, `tá ruim`, `don't`, `wrong`, `broken`, `doesn't work`, `failed`, `try again`, `not what i wanted`, `fix this`, `revert`, `undo` (entre outros).
- **Média (penalidade 0.5)** — hedge/hesitação: `repensa`, `ajusta`, `talvez`, `acho que não`, `hmm`, `actually`, `wait`, `rethink`, `reconsider`, `i'm not sure` (entre outros).

Palavras com alta taxa de falso-positivo (`bug`, `melhora`, `improve`) estão **fora do pool** porque aparecem frequentemente em pedidos legítimos de primeiro turno ("melhora a doc", "there's a bug, fix it").

A penalidade cai no turno do assistente **anterior** à correção. Sessões com muitas correções acumulam densidade alta, e o score composto cai.

### A heurística de efetividade

Score composto (0..100) combina 5 sinais ponderados:

| Sinal | Peso | Tipo | Descrição |
| --- | --- | --- | --- |
| Avaliação manual média | 30% | manual | Média dos ratings (-1..1) mapeada pra 0..1 |
| (1 − densidade de correção) | 20% | auto | Proporção de turnos seguidos por prompt de correção |
| Razão output/input | 20% | auto | Clipped em 2.0; sinal fraco, intencionalmente pouco ponderado |
| (1 − taxa de erro de tool) | 15% | auto | Proporção de tool calls com `is_error=1` |
| Taxa de cache hit | 15% | auto | Reaproveitamento de cache |

Quando algum sinal é nulo (ex.: sessão sem tool calls → sem `toolErrorRate`), os pesos se redistribuem proporcionalmente. Peso manual é o mais alto porque julgamento humano capta o que regex e agregados não pegam.

### Atualizar a tabela de preços

Anthropic **não expõe uma API de pricing**, e scraping da página é frágil (o markup muda sem aviso). O caminho pragmático está em [`lib/analytics/pricing.ts`](lib/analytics/pricing.ts):

1. Constante `PRICING_LAST_UPDATED` registra a última auditoria manual
2. `pnpm ingest` loga warning se a tabela tem mais de 90 dias
3. Lookups normalizam sufixos de janela (`[1m]`) e data (`-YYYYMMDD`)

Cadência recomendada: conferir `https://www.anthropic.com/pricing` a cada 30–60 dias, atualizar a tabela + bump da constante. É 2 minutos de trabalho por auditoria.

### Customizar

- **Nova primitive de UI?** Cai em `components/ui/`. Mantém a API drop-in (Card/Button/etc.) pra que possa ser trocada por uma lib externa depois sem mexer nos call sites.
- **Novo KPI?** Adiciona uma query em `lib/queries/<page>.ts`, expõe um tipo, renderiza na página. Queries usam prepared statements em WeakMap (olha os exemplos existentes).
- **Nova heurística de efetividade?** Função pura em `lib/analytics/scoring.ts`, entra na composição de `effectivenessScore`, ajusta pesos — a redistribuição automática quando sinais são nulos te livra de código defensivo.

### Troubleshooting

| Sintoma | Resolução |
| --- | --- |
| `better-sqlite3` falha no install | `pnpm approve-builds`, depois `pnpm install` — libera o postinstall nativo. |
| Home mostra zeros | `pnpm seed-dev` (sintético) ou `pnpm ingest` (seu histórico). Auto-ingest só roda quando tem JSONL novo. |
| Primeira execução do Playwright trava | `pnpm exec playwright install chromium` (~150 MB, uma vez). |
| Porta 3000 ocupada | `PORT=3001 pnpm dev`. E2E usa `3123`. |
| Rating não persiste no reload | DevTools → Network: `POST /api/ratings` precisa retornar `200`. Payload validado via Zod; body ruim → `400`. |
| `/api/ingest` retorna `403` | É a trava de loopback funcionando. Só aceita `localhost` / `127.0.0.1` / `::1`. |

---

## Referência

### Comandos

| Comando | O que faz |
| --- | --- |
| `pnpm dev` | Sobe o Next.js dev em `:3131` |
| `pnpm build` | Production build |
| `pnpm start` | Serve o build de produção |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest watch |
| `pnpm test --run` | Vitest single pass |
| `pnpm test:e2e` | Smoke Playwright (sobe Next em `:3123`) |
| `pnpm ingest` | Ingestão one-shot (transcripts + OTEL se disponível) |
| `pnpm seed-dev` | Popula SQLite com dados sintéticos deterministicos |
| `pnpm setup` | `install && seed-dev` — primeiro run |
| `pnpm fresh` | Apaga DB e re-ingere do zero |
| `pnpm validate` | `typecheck && lint && test --run` |
| `pnpm changelog` | Preview do CHANGELOG.md a partir dos commits (não sobrescreve arquivo) |
| `pnpm release VERSION=X.Y.Z` | Gera CHANGELOG via `git-cliff`, cria tag anotada e publica GitHub Release |

### Variáveis de ambiente

| Env | Default | Pra quê |
| --- | --- | --- |
| `DASHBOARD_DB_PATH` | `./data/dashboard.db` | Local do SQLite |
| `OTEL_SCRAPE_URL` | `http://localhost:9464/metrics` | URL pro endpoint Prometheus do Claude Code. Set pra custom; deixa em branco pra usar o default |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Estrutura do repo

```text
app/             Next.js App Router routes + api handlers + loading states
components/      UI (Server Components + alguns Client pra interatividade)
lib/
  db/            better-sqlite3 client, schema.sql, migrate, types
  ingest/        JSONL + OTEL parsers, writer idempotente, auto-ingest
  analytics/     tabela de preços + scoring de efetividade
  queries/       queries SQLite server-side agrupadas por página
  fs-paths.ts    guardas de path traversal pra ~/.claude/projects
  logger.ts      wrapper console com níveis (único lugar onde console.* é permitido)
  fmt.ts         formatters Intl centralizados
  result.ts      Result<T,E> discriminated union
scripts/         CLIs ingest + seed-dev (tsx)
tests/           Vitest unit/integration + Playwright E2E
.claude/         hooks, rules, agents, skills pro Claude Code
.specs/          specs SDD (TEMPLATE.md + specs concluídas)
data/            SQLite runtime (gitignored)
```

### Schema SQLite (resumo)

- `sessions` — uma linha por sessão do Claude Code (chave: UUID). Rollups de tokens/custo/turn_count/tool_call_count. Indexes em `started_at` e `(started_at, total_cost_usd DESC)`.
- `turns` — uma linha por resposta do assistente, FK pra `sessions`. Guarda user_prompt + assistant_text + tokens + modelo + custo.
- `tool_calls` — uma linha por tool call, FK pra `turns`.
- `ratings` — única por turno (check constraint `{-1, 0, 1}`).
- `otel_scrapes` — append-only, uma linha por (metric, labels) por scrape.
- `session_effectiveness` — VIEW derivada: cache_hit_ratio / output_input_ratio / avg_rating / cost_per_turn.

### Rotas API

| Método + path | Body | Resposta | Notas |
| --- | --- | --- | --- |
| `POST /api/ratings` | `{ turnId, rating: -1\|0\|1, note? }` | `{ ok: true }` ou `400` | Faz lookup do `session_id` via prepared statement, aí chama `revalidatePath('/sessions/${sessionId}')` + `revalidatePath('/')`. |
| `POST /api/ingest` | — | `{ ok: true, summary }` ou `403` | Allowlist de Host loopback (`localhost` / `127.0.0.1` / `::1`). Revalida `/` e `/effectiveness`. |

### Matriz de testes

| Camada | Runner | Padrão | Cobertura |
| --- | --- | --- | --- |
| Unit | Vitest | `lib/**/*.test.ts` | parsers, pricing, scoring, formatters, guards fs, logger |
| Integration | Vitest + SQLite real | `tests/integration/**/*.test.ts` | migrate, ingestão contra fixtures em tmpdir, handlers de `/api/*` |
| E2E | Playwright | `tests/e2e/**/*.spec.ts` | Next dev com seed determinístico: KPIs home, drill-down, persistência de rating |

Contagem atual: **117** unit+integration, **3** E2E. Rode `pnpm validate && pnpm test:e2e` pra exercer tudo.

### Convenções

- TS strict — sem `any`, `unknown` + narrowing nos boundaries.
- Named exports preferidos; default só onde Next exige (`page.tsx`, `layout.tsx`, `route.ts`).
- Prepared statements reusados (WeakMap-cached por DB).
- `console.*` só em `lib/logger.ts`.
- Testes colocados (`foo.ts` + `foo.test.ts`), com exceção da suíte cross-module em `tests/integration/`.
- Zod em toda fronteira de ingestão/API.

Regras completas em `.claude/rules/` (auto-aplicadas via hooks + referenciadas pelos agentes documentados em `CLAUDE.md`).

### Contribuindo

Guia completo em [CONTRIBUTING.md](CONTRIBUTING.md) — cobre setup, convenções de commit, checklist de PR, fluxo de release e workflow SDD.

Commits seguem **Conventional Commits** e o `cliff.toml` roteia cada tipo pra uma seção do [CHANGELOG.md](CHANGELOG.md):

```text
feat(scope):     Funcionalidades
fix(scope):      Correções
refactor(scope): Refatoração
docs(scope):     Documentação
test(scope):     Testes
chore(scope):    Manutenção
```

Não edite `CHANGELOG.md` à mão — ele é regenerado por `git-cliff` a cada `pnpm release VERSION=X.Y.Z`. Para prever o output a qualquer momento: `pnpm changelog`.
