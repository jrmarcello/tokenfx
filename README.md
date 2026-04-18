# Token Effectiveness Dashboard

Personal dashboard that ingests your Claude Code transcripts (`~/.claude/projects/*.jsonl`) and optional OpenTelemetry metrics into a local SQLite database, surfacing consumption KPIs, effectiveness heuristics, and manual ratings. Localhost-only.

## Features

- **Overview KPIs** — spend (today / 7d / 30d), tokens, cache hit ratio, session count
- **Daily spend trend** — 30-day chart
- **Top sessions** — ranked by cost
- **Session drill-down** — full transcript viewer with tool call details
- **Manual ratings** — Good / Neutral / Bad per turn (optimistic UI)
- **Effectiveness page** — composite score combining cache reuse, rating average, correction detection, and tool-error rate
- **Ingestion** — parses JSONL transcripts + optional Prometheus OTEL endpoint

## Quick start

```bash
pnpm install
pnpm seed-dev     # optional — populate with synthetic data
pnpm dev          # http://localhost:3000
```

To ingest your real Claude Code history:

```bash
pnpm ingest
```

To also scrape OpenTelemetry metrics from a locally-running Claude Code instance:

```bash
# In the shell that runs Claude Code:
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=prometheus
# Prometheus endpoint defaults to http://localhost:9464/metrics

# In this project:
OTEL_SCRAPE_URL=http://localhost:9464/metrics pnpm ingest
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server |
| `pnpm build` | Production build |
| `pnpm ingest` | Read transcripts + (optional) OTEL, populate SQLite |
| `pnpm seed-dev` | Seed DB with deterministic synthetic data |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest (watch mode) |
| `pnpm test --run` | Vitest single run |
| `pnpm test:e2e` | Playwright smoke tests |

## Architecture (short)

- `app/` — Next.js App Router (Server Components by default; Client only where needed)
- `lib/db/` — better-sqlite3 client + schema + migrations
- `lib/ingest/` — JSONL parser + OTEL parser + idempotent writer
- `lib/analytics/` — pricing + effectiveness scoring
- `lib/queries/` — SQL queries grouped by page
- `components/` — UI (shadcn-style Card primitive + KPI + charts + transcript viewer)
- `scripts/` — `ingest.ts`, `seed-dev.ts` (run via `tsx`)
- `tests/` — Vitest unit/integration + Playwright e2e

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_DB_PATH` | `./data/dashboard.db` | SQLite file location |
| `OTEL_SCRAPE_URL` | _unset_ | When set, ingest also scrapes Prometheus metrics from this URL |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Troubleshooting

- **better-sqlite3 native build issues**: on first install, run `pnpm approve-builds` and allow `better-sqlite3` to run its postinstall.
- **No data on home page**: run `pnpm seed-dev` (synthetic) or `pnpm ingest` (your real history).
- **Playwright**: first run requires `pnpm exec playwright install chromium`.
- **Port already in use**: the dev server defaults to `3000`; the e2e suite uses `3123` — pass `--port` to change.
