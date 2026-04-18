# Token Effectiveness Dashboard

A personal, localhost-only dashboard that ingests your Claude Code transcripts (`~/.claude/projects/*.jsonl`) and optional OTEL metrics, stores everything in a local SQLite file, and surfaces consumption KPIs + effectiveness heuristics + manual ratings. Next.js 16 · TypeScript · better-sqlite3 · Recharts · Vitest · Playwright.

> This README follows a **do → understand → deepen → reference** structure. Start at the top; stop when you have what you need.

---

## 1. Fazer — five minutes to something useful

```bash
pnpm install                            # prod + dev deps
pnpm seed-dev                           # populate with deterministic synthetic data
pnpm dev                                # http://localhost:3000
```

Open the browser. You should see KPI cards, a 30-day spend trend, and a top-sessions list. Click a session → transcript viewer with Good/Neutral/Bad rating buttons on each turn.

When you're ready to see your **real** Claude Code history:

```bash
pnpm ingest                             # reads ~/.claude/projects/*.jsonl, writes data/dashboard.db
```

Ingestion is idempotent — run it as often as you like.

---

## 2. Entender — the mental model

### The problem this solves

`claude /cost` tells you the current session's spend. That's reactive. Grafana time-series dashboards show *consumption* but not *whether the spend produced value*. The killer feature missing from both is **drill-down**: "this session cost me $8 — was it worth it?" Answering that needs the transcript alongside the numbers, plus a way to rate individual turns.

### Data flow

```text
~/.claude/projects/*.jsonl  ─┐
                             ├──►  parsers  ──►  writer  ──►  data/dashboard.db
optional OTEL Prometheus ────┘                                        │
  (http://localhost:9464/metrics)                                     ▼
                                                          Next.js (Server Components)
                                                                      │
                                                                      ▼
                                                           http://localhost:3000
```

Everything after the arrow runs locally. Nothing is sent anywhere else.

### The three views

- **`/` — Overview.** Spend (today / 7d / 30d), total tokens, cache-hit %, session count, a 30-day spend sparkline, and the top-5 most expensive sessions with direct links.
- **`/sessions` · `/sessions/[id]` — Drill-down.** The transcript with user prompts, assistant text, and tool calls (native `<details>` so no JS needed to expand). Each turn has a rating widget that persists to SQLite via `POST /api/ratings`.
- **`/effectiveness` — How well is this spend landing?** A composite score (0–100) combining four signals, plus a cost-per-turn histogram, weekly output/input ratio, and a tool leaderboard.

### The effectiveness score (what makes a turn "good")

Four signals, weighted:

| Signal | Weight | Source |
| --- | --- | --- |
| Output/input token ratio (clipped at 2.0) | 40% | Session aggregate |
| Cache hit ratio | 20% | Session aggregate |
| Manual avg rating | 30% | `ratings` table |
| 1 − correction density | 10% | Regex-detected corrections in the *next* user turn |

Missing signals (null) are dropped and the remaining weights redistribute proportionally. See `lib/analytics/scoring.ts` for the math.

### Where your data lives

- `data/dashboard.db` — SQLite, gitignored. Back this up if you want your ratings to survive a `rm -rf`.
- `~/.claude/projects/` — owned by Claude Code, read-only from this app's perspective.
- No cloud. No telemetry. No network calls out.

---

## 3. Aprofundar — when you want more

### Enable OTEL metrics from Claude Code

Claude Code natively speaks Prometheus. In the shell where you run Claude Code:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
# Metrics endpoint defaults to http://localhost:9464/metrics
```

Then ingest with the scrape URL set:

```bash
OTEL_SCRAPE_URL=http://localhost:9464/metrics pnpm ingest
```

Snapshots land in the `otel_scrapes` table (append-only). The UI currently surfaces consumption via the JSONL transcripts — OTEL is there for when you want to add alerts or point a real Prometheus at the same endpoint in parallel.

### How ingestion stays idempotent

The natural key is `session_id` (from the JSONL line). The writer uses `INSERT ... ON CONFLICT(id) DO UPDATE` across sessions/turns/tool_calls, wrapped in a single `db.transaction(...)`. Re-ingesting the same file — or ingesting the same session from a different source file — merges without duplication. Ratings are never touched by the writer.

### The correction heuristic

`lib/analytics/scoring.ts` applies two bilingual regexes to each turn's *next* user prompt:

- **Strong (1.0 penalty)** — `não`, `errou`, `errado`, `na verdade`, `don't`, `stop`, `wrong`, `revert`, `undo`
- **Mild (0.5 penalty)** — `actually`, `hmm`, `wait`, `uhh`, `na real`, `reconsidera`, `reconsider`

The penalty attaches to the assistant turn **preceding** the correction. A session with many penalized turns ends up with a high `correctionDensity`, which lowers its composite score.

### Update the pricing table

When Anthropic ships new models or adjusts per-token pricing, edit `lib/analytics/pricing.ts`. Model lookups normalize `[1m]` context-window suffixes and trailing date stamps, so the stored `model` strings from raw transcripts resolve correctly.

### Watch mode

`pnpm ingest --watch` is stubbed (runs a single pass and logs a warning). If you want continuous ingestion today, run it under `watchexec` or a LaunchAgent. The ingest is fast enough (~seconds for hundreds of sessions) that you likely don't need it.

### Editing in place

- New shadcn/ui primitive? Drop it into `components/ui/`. Keep the API drop-in so Card/Button/etc. can be swapped for an external lib later.
- New KPI? Add a query to the matching `lib/queries/<page>.ts`, expose a type, render it in the page. Queries use cached prepared statements via a `WeakMap<DB>` (see existing patterns).
- New effectiveness heuristic? Add a pure function to `lib/analytics/scoring.ts`, compose it inside `effectivenessScore`, and update weights — the redistribution logic handles nulls so you don't have to code defensively.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `better-sqlite3` fails to load on install | `pnpm approve-builds`, then `pnpm install` again — allows the native postinstall. |
| Home page shows zeros and an empty-state notice | Run `pnpm seed-dev` or `pnpm ingest`. |
| Playwright first run hangs | `pnpm exec playwright install chromium` (one-time, ~150 MB). |
| Port 3000 already in use | `pnpm dev -- --port 3001` (or use `PORT=3001 pnpm dev`). E2E uses `3123`. |
| Ratings don't persist across reload | Inspect the network tab — `POST /api/ratings` must return `200`. The handler validates via Zod; bad body → `400`. |
| `/api/ingest` returns `403` | That's the loopback-host guard doing its job. Call it from `localhost`/`127.0.0.1`. |

---

## 4. Referência

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Next.js dev server on `:3000` |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest (watch mode) |
| `pnpm test --run` | Vitest single pass |
| `pnpm test:e2e` | Playwright smoke suite (starts Next on `:3123`) |
| `pnpm ingest` | Read transcripts + (optional) OTEL, populate SQLite |
| `pnpm seed-dev` | Seed DB with deterministic synthetic data |

### Environment

| Env var | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_DB_PATH` | `./data/dashboard.db` | SQLite file location |
| `OTEL_SCRAPE_URL` | *unset* | When set, `ingest` also scrapes Prometheus metrics from this URL |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Repository layout

```text
app/             Next.js App Router routes + api handlers
components/      UI (Server Components + a few Client Components for interactivity/charts)
lib/
  db/            better-sqlite3 client, schema.sql, migrate, types
  ingest/        JSONL + OTEL parsers, idempotent writer
  analytics/     pricing table + effectiveness scoring
  queries/       server-side SQLite queries grouped by page
  fs-paths.ts    path-traversal-safe helpers for ~/.claude/projects
  logger.ts      level-gated console wrapper (the one place `console.*` is allowed)
  fmt.ts         centralized Intl formatters
  result.ts      Result<T,E> discriminated union
scripts/         ingest CLI + seed-dev CLI (run via tsx)
tests/           Vitest unit/integration + Playwright E2E
.claude/         hooks, rules, agents, skills for Claude Code DX
.specs/          SDD specs (TEMPLATE.md + completed specs)
data/            runtime SQLite (gitignored)
```

### SQLite schema (summary)

- `sessions` — one row per Claude Code session, keyed by `id` (session UUID). Rollups: tokens, cost, turn_count, tool_call_count. Indexes on `started_at` and `(started_at, total_cost_usd DESC)`.
- `turns` — one per assistant response, FK to `sessions`. Stores user_prompt + assistant_text + tokens + model + cost per turn.
- `tool_calls` — one per tool invocation, FK to `turns`.
- `ratings` — one per turn (unique on `turn_id`), check-constrained to `{-1, 0, 1}`.
- `otel_scrapes` — append-only, one row per (metric, labels) pair per scrape.
- `session_effectiveness` — VIEW computing cache_hit_ratio / output_input_ratio / avg_rating / cost_per_turn.

### API routes

| Method + path | Body | Response | Notes |
| --- | --- | --- | --- |
| `POST /api/ratings` | `{ turnId: string, rating: -1 \| 0 \| 1, note?: string \| null }` | `{ ok: true }` or `400 { ok: false, error: "invalid body" }` | Looks up `session_id` via prepared statement, then `revalidatePath('/sessions/${sessionId}')` + `revalidatePath('/')`. |
| `POST /api/ingest` | (none) | `{ ok: true, summary: IngestSummary }` or `403 { ok: false, error: "forbidden" }` | Loopback Host allowlist (`localhost` / `127.0.0.1` / `::1`, any port). Revalidates `/` and `/effectiveness`. |

### Testing matrix

| Layer | Runner | File pattern | Coverage |
| --- | --- | --- | --- |
| Unit | Vitest | `lib/**/*.test.ts` | parsers, pricing, scoring, formatters, fs guards, logger |
| Integration | Vitest + real SQLite | `tests/integration/**/*.test.ts` | schema migrate, ingestion end-to-end against tmpdir fixtures, `/api/*` route handlers |
| E2E | Playwright | `tests/e2e/**/*.spec.ts` | seeded Next dev server, home KPIs, drill-down, rating persistence |

Current count: **117** unit + integration tests, **3** E2E smokes. Run `pnpm test --run && pnpm test:e2e` to exercise everything.

### Conventions (enforced or aspirational)

- TS strict — no `any`, `unknown` + narrowing at boundaries.
- Named exports preferred; defaults only where Next requires (`page.tsx`, `layout.tsx`, `route.ts`).
- Prepared statements reused (WeakMap-cached per DB).
- `console.*` lives only in `lib/logger.ts`.
- Tests colocated (`foo.ts` + `foo.test.ts`) except the cross-module integration suite under `tests/integration/`.
- Zod at every ingestion/API boundary.

Full ruleset lives in `.claude/rules/` and is referenced by the agents and hooks documented in `CLAUDE.md`.

### Specs

Active SDD specs in `.specs/`. The MVP is captured in [.specs/dashboard-mvp.md](.specs/dashboard-mvp.md) (status: DONE). Use `[.specs/TEMPLATE.md](.specs/TEMPLATE.md)` as the starting point for any non-trivial change.
