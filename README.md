# Token Effectiveness Dashboard

**Quanto o Claude Code te cobra é fácil. Saber se a conta valeu — não.**

Esse dashboard ingere os transcripts locais do Claude Code (`~/.claude/projects/*.jsonl`) + métricas OTEL opcionais, guarda tudo num SQLite na sua máquina e te dá a foto completa: quanto você gastou, em qual projeto, em qual sessão, em qual turno — e quão efetivo foi cada um. Roda 100% local, sem cloud, sem telemetria pra fora.

Stack: Next.js 16 · TypeScript estrito · better-sqlite3 · Recharts · Vitest · Playwright.

---

## Pra que serve

- **Você paga por token; ninguém te paga por resultado.** `claude /cost` te diz o gasto da sessão aberta. Grafana mostra consumo ao longo do tempo. Nenhum dos dois responde *"essa sessão cara valeu o preço?"*. Aqui você clica na sessão mais cara da semana, lê o transcript, avalia turno a turno — e o score composto te aponta onde o dinheiro virou trabalho entregue.
- **Efetividade não é opinião.** Quatro sinais alimentam o score (0..100): razão output/input, taxa de cache hit, avaliação manual (Bom/Neutro/Ruim por turno) e densidade de correção — detectada via regex no próximo prompt do usuário. Se você respondeu *"não, isso tá errado"*, o turno anterior perde pontos automaticamente.
- **Zero infra pra manter.** SQLite em arquivo único, Next.js local, porta 3000. Nada pra subir, nada pra derrubar, nada saindo da sua máquina.

## 5 minutos pra ver rodando

```bash
pnpm install
pnpm seed-dev          # popula com dados sintéticos pra ver a UI
pnpm dev               # http://localhost:3000
```

Abriu? Você vê KPIs, tendência de 30 dias, top sessões. Clica numa → transcript completo com botões de avaliação em cada turno.

Pronto pra ver seus dados reais?

```bash
pnpm ingest            # lê ~/.claude/projects/*.jsonl, popula data/dashboard.db
```

Idempotente — pode rodar quantas vezes quiser. **Mais importante**: você nem precisa. O dashboard auto-ingere a cada page load quando detecta transcripts novos. Ou seja: abriu a página, viu os dados atualizados. Sem cron, sem daemon.

---

## Entender

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
|---|---|---|
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

## Aprofundar

### Ativar OTEL do Claude Code (opcional, mas vale)

Métricas OTEL trazem contexto que o JSONL não carrega: **accept/reject de Edit/Write** (sinal direto de qualidade), `lines_of_code` alteradas, commits, PRs e `active_time`. No shell que roda o Claude Code:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
# endpoint padrão: http://localhost:9464/metrics
```

Pronto. O dashboard detecta automaticamente na próxima ingestão (timeout de 1s — se o endpoint não tá lá, segue em frente com transcripts). Se você usar porta custom:

```bash
OTEL_SCRAPE_URL=http://localhost:XXXX/metrics pnpm ingest
```

### Como a ingestão permanece idempotente

Chave natural: `session_id` (UUID da sessão do Claude Code). Writer usa `INSERT ... ON CONFLICT(id) DO UPDATE` em sessions/turns/tool_calls, tudo dentro de `db.transaction(...)`. Re-ingerir o mesmo arquivo — ou a mesma sessão vinda de arquivos diferentes — merge sem duplicar. Ratings nunca são tocadas pelo writer.

### A heurística de correção

[`lib/analytics/scoring.ts`](lib/analytics/scoring.ts) roda duas regex bilíngues no *próximo* prompt do usuário:

- **Forte (penalidade 1.0)** — `não`, `errou`, `errado`, `na verdade`, `don't`, `stop`, `wrong`, `revert`, `undo`
- **Média (penalidade 0.5)** — `actually`, `hmm`, `wait`, `uhh`, `na real`, `reconsidera`, `reconsider`

A penalidade cai no turno do assistente **anterior** à correção. Sessões com muitas correções acumulam densidade alta, e o score composto cai.

### Atualizar a tabela de preços

Quando a Anthropic lançar modelos novos ou ajustar preço, edita [`lib/analytics/pricing.ts`](lib/analytics/pricing.ts). Lookups normalizam sufixos de janela de contexto (`[1m]`) e carimbos de data — o que está gravado como `model` nos transcripts resolve corretamente.

### Watch mode

`pnpm ingest --watch` tá stub (roda uma passada só e loga warning). Se quiser ingestão contínua, enfie sob `watchexec` ou um LaunchAgent. Na prática **você não precisa**: o auto-ingest on-page-load já resolve pro caso comum, e a ingest bruta é rápida (segundos pra centenas de sessões).

### Customizar

- **Nova primitive de UI?** Cai em `components/ui/`. Mantém a API drop-in (Card/Button/etc.) pra que possa ser trocada por uma lib externa depois sem mexer nos call sites.
- **Novo KPI?** Adiciona uma query em `lib/queries/<page>.ts`, expõe um tipo, renderiza na página. Queries usam prepared statements em WeakMap (olha os exemplos existentes).
- **Nova heurística de efetividade?** Função pura em `lib/analytics/scoring.ts`, entra na composição de `effectivenessScore`, ajusta pesos — a redistribuição automática quando sinais são nulos te livra de código defensivo.

### Troubleshooting

| Sintoma | Resolução |
|---|---|
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
|---|---|
| `pnpm dev` | Sobe o Next.js dev em `:3000` |
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

### Variáveis de ambiente

| Env | Default | Pra quê |
|---|---|---|
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
|---|---|---|---|
| `POST /api/ratings` | `{ turnId, rating: -1\|0\|1, note? }` | `{ ok: true }` ou `400` | Faz lookup do `session_id` via prepared statement, aí chama `revalidatePath('/sessions/${sessionId}')` + `revalidatePath('/')`. |
| `POST /api/ingest` | — | `{ ok: true, summary }` ou `403` | Allowlist de Host loopback (`localhost` / `127.0.0.1` / `::1`). Revalida `/` e `/effectiveness`. |

### Matriz de testes

| Camada | Runner | Padrão | Cobertura |
|---|---|---|---|
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

### Specs

Specs ativas em `.specs/`. O MVP completo está capturado em [.specs/dashboard-mvp.md](.specs/dashboard-mvp.md) (status: DONE). Pra qualquer mudança não-trivial, comece copiando [.specs/TEMPLATE.md](.specs/TEMPLATE.md).
