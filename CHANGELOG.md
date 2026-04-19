# Changelog

Todas as mudanças notáveis deste projeto estão documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Commits seguem [Conventional Commits](https://www.conventionalcommits.org/).

---

## [0.2.0] - 2026-04-19

### Correções

- **metrics**: Audit findings — pricing fallback, ratio formulas, UX labels

### Documentação

- Rename README sections to Como funciona / Na prática

### Funcionalidades

- **docker**: Containerizar TokenFx + reorganizar README (spec dockerize)
- **ui**: Light/dark/system themes + audit fixes (2 specs consolidated)
- **sessions**: Pagination com ?offset + overflow CTA
- **quota**: Max plan quota tracking — usage vs threshold em janelas rolling
- **ingest**: Watch mode — chokidar-based push ingestion
- **sessions**: Share as markdown + PDF — endpoint, UI, print CSS
- **effectiveness**: Tool success trends — weekly error-rate per tool
- **pricing**: Cost calibration — learned plan multiplier from OTEL samples
- **pricing**: Hybrid OTEL + local cost, metric name audit, UI polish
- **sessions**: Sub-agent cost attribution per session
- **overview**: Session timeline heatmap + /sessions date filter
- **search**: Transcript full-text search via SQLite FTS5
- **effectiveness**: Model breakdown pie chart by family (30d)

### Manutenção

- **sdd**: Add best-way-possible check to spec + ralph-loop checkpoints
- **dev**: Bind dev/start to port 3131
- **sdd**: Codify discipline checkpoints in skills + rules + CLAUDE
- Address full-review-team findings (code + security + data)
- **release**: V0.1.0 [skip ci]

### Performance

- **docker**: Reduce image from 1.2GB to 484MB via standalone-strict

## [0.1.0] - 2026-04-18

### Correções

- **ui**: Tooltip placement props to avoid viewport overflow
- **ingest**: Reconcile per-session sequences + rollups after each write
- **e2e**: Inline openDatabase in global-setup

### Documentação

- OTEL activation covers VSCode via ~/.claude/settings.json
- Atualizar critérios de avaliação manual no README
- README com linguagem direta para devs, em pt-BR
- Restructure README as fazer \xe2\x86\x92 entender \xe2\x86\x92 aprofundar \xe2\x86\x92 refer\xc3\xaancia

### Funcionalidades

- **otel**: 5 OTEL-derived features with graceful degradation
- Expand scoring + OTEL badge + pricing staleness + docs
- **ux**: Skeleton loading states + explanatory tooltips on KPIs
- Auto-ingest on page load + auto-detect OTEL + package scripts
- Add project state and threat model documentation; include user language preference
- **batch-5**: E2E smoke tests + seed-dev + README
- **batch-4**: Effectiveness page with composite scoring
- **batch-3**: Ingestion pipeline + overview + session drill-down
- **batch-2**: SQLite schema + parsers + pricing + UI shell

### Manutenção

- **brand**: Rename project to TokenFx
- **dx**: CONTRIBUTING + CHANGELOG tooling via git-cliff
- Bootstrap Next.js 15 + pnpm + Claude Code DX config

### Performance

- **effectiveness**: Collapse N+1 turns fetch into single json_each query

### Refatoração

- **effectiveness**: Drop redundant comment on MAX_SCORED_SESSIONS
- **pipeline**: Address 6 findings from pipeline review
- **ui**: Polish visual hierarchy + fix 2 style bugs
- **review**: Apply MUST FIX findings from full review team

### Testes

- Add fs-paths, fmt, logger, api-routes integration + getSessionIdForTurn coverage

### I18n

- Translate dashboard UI to pt-BR

---

> Gerado automaticamente com [git-cliff](https://github.com/orhun/git-cliff).
> Para entradas manuais, edite `CHANGELOG.md` após `pnpm release`.
