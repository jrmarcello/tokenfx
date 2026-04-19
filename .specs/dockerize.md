# Spec: Dockerize TokenFx — container single-service com SQLite persistido

## Status: DONE

## Context

TokenFx ainda depende de clone + `pnpm install` + `pnpm build`/`dev` no host. Pra facilitar rodar em outra máquina (ou em servidor local dedicado) sem preparar o Node/pnpm/better-sqlite3 nativo manualmente, queremos packaging via Docker.

Mantemos SQLite — é single-user localhost, volume mount resolve persistência. Postgres migration é descartado explicitamente (ver CLAUDE.md, "localhost-only, SQLite-backed" como princípio). O único "serviço externo" é o OTEL exporter do Claude Code rodando no host, acessível via `host.docker.internal:9464`.

### Decisões já travadas

1. **Keep SQLite** (sem Postgres/MySQL).
2. **Single service no compose** — `watch` / `ingest` rodam via `docker compose exec app pnpm ingest`, não como sidecars.
3. **Node 22 slim** (Debian) — better-sqlite3 + musl (Alpine) tem histórico de bugs; glibc é mais seguro.
4. **Non-root user** `nextjs` UID 1001 no runtime, `chown /app/data`. Host volume mount precisa ser compatível — documentar caveat.
5. **Multi-stage**: `deps` (install + native compile) → `builder` (`pnpm build` com Next standalone) → `runner` (slim, só runtime).
6. **Sem CI/CD, sem multi-arch, sem publicar em registry.** Build local via compose.
7. **OTEL via `host.docker.internal`** — Docker Desktop (Mac/Win) suporta nativo; Linux precisa `extra_hosts: host.docker.internal:host-gateway` explícito (incluído).
8. **Healthcheck via novo endpoint `/api/health`** — retorna JSON `{ ok: true }` em 200. Minimalista, não toca DB (evita falso-positivo em DB write-lock).
9. **DB path configurável via `DASHBOARD_DB_PATH`** — já existe em `lib/db/client.ts` (linha 10). Container aponta pra `/app/data/dashboard.db`.
10. **Claude projects path configurável via `CLAUDE_PROJECTS_ROOT`** (NOVO) — `lib/fs-paths.ts` hoje hardcoda `os.homedir() + '.claude/projects'`. Refactor pra honrar env com fallback pro `~/.claude/projects`. Path traversal guard continua operante.

### Fora de escopo

- Postgres / MySQL / DuckDB migration
- Kubernetes / Helm / cloud deploy
- CI/CD pipeline (GitHub Actions build/push)
- Multi-arch images (linux/arm64 + amd64 simultâneo)
- Backup automático (volume mount cobre)
- HTTPS / reverse proxy (localhost, sem TLS)
- Dev container / Dockerfile.dev com hot-reload (follow-up separado se fizer sentido)

## Requirements

### Build

- [ ] **REQ-1**: GIVEN `next.config.ts` WHEN carregado THEN tem `output: 'standalone'`. `pnpm build` gera `.next/standalone/` contendo server.js + node_modules mínimo.

- [ ] **REQ-2**: GIVEN um `Dockerfile` multi-stage WHEN `docker build` roda THEN:
  - Stage `deps`: `pnpm install --frozen-lockfile` + `pnpm approve-builds better-sqlite3` (ou `pnpm rebuild better-sqlite3`) pra garantir native binding compilado pra arquitetura do container.
  - Stage `builder`: herda `deps`, copia código, roda `pnpm build`.
  - Stage `runner`: imagem `node:22-slim`, non-root user `nextjs` (UID 1001, GID 1001), copia `.next/standalone`, `.next/static`, `public/`, `lib/db/schema.sql`, `scripts/` (pra exec de ingest/watch), `package.json`, `pnpm-lock.yaml`, e instala **apenas** `better-sqlite3` com build scripts (precisa em runtime). `CMD ["node", "server.js"]`. `EXPOSE 3131`. `ENV PORT=3131 NODE_ENV=production`.

- [ ] **REQ-3**: GIVEN `.dockerignore` na raiz WHEN `docker build` roda THEN o build context NÃO inclui: `node_modules/`, `.next/`, `.git/`, `.claude/`, `.specs/`, `data/`, `tests/`, `playwright-report/`, `test-results/`, `.env*`, `README.md` (bloat), `*.log`.

### Env + paths

- [ ] **REQ-4**: GIVEN env `DASHBOARD_DB_PATH` setada (ex: `/app/data/dashboard.db`) WHEN `lib/db/client.ts::openDatabase()` é chamada sem arg THEN abre DB nesse path; cria o diretório pai se não existir (já implementado em HEAD).

- [ ] **REQ-5**: GIVEN env `CLAUDE_PROJECTS_ROOT` setada (ex: `/claude-projects`) WHEN `lib/fs-paths.ts::claudeProjectsRoot()` é chamada THEN retorna esse valor (resolvido com `path.resolve`).

- [ ] **REQ-6**: GIVEN env `CLAUDE_PROJECTS_ROOT` não setada (unset ou string vazia) WHEN `claudeProjectsRoot()` é chamada THEN retorna `path.join(os.homedir(), '.claude', 'projects')` (comportamento atual preservado).

- [ ] **REQ-7**: GIVEN `resolveWithinClaudeProjects(p)` com `CLAUDE_PROJECTS_ROOT` setado pra um root custom WHEN `p` tenta escapar (ex: via `..`) THEN lança erro — path traversal guard continua operante independente do root.

- [ ] **REQ-8**: GIVEN mensagens de erro do `lib/fs-paths.ts` hoje dizem "path escapes ~/.claude/projects" WHEN refactor entra THEN mensagens continuam legíveis. Aceitável trocar pra "path escapes the Claude projects root" (genérico, compatível com env custom) OU manter "~/.claude/projects" (usuário-comum vê isso). Decisão: trocar pra **"path escapes the Claude projects root"** — mais honesto com env custom.

### Healthcheck

- [ ] **REQ-9**: GIVEN `GET /api/health` WHEN chamado THEN retorna 200 com body JSON `{ "ok": true }` e `Content-Type: application/json`. Não abre DB (evita falso-negativo em momento de write-lock). Sub-10ms de latência (sem I/O).

- [ ] **REQ-10**: GIVEN qualquer método HTTP ≠ GET em `/api/health` WHEN chamado THEN retorna 405 com `Allow: GET`.

### Docker Compose

- [ ] **REQ-11**: GIVEN `docker-compose.yaml` (ou `compose.yaml`) WHEN `docker compose up --build` roda THEN:
  - Service `app` builda do `./Dockerfile`
  - Porta `3131:3131` (host:container)
  - Volume `./data:/app/data` (persistência do SQLite, read-write)
  - Volume `${CLAUDE_PROJECTS_ROOT:-$HOME/.claude/projects}:/claude-projects:ro` (read-only)
  - Env vars: `DASHBOARD_DB_PATH=/app/data/dashboard.db`, `CLAUDE_PROJECTS_ROOT=/claude-projects`, `NODE_ENV=production`, `PORT=3131`
  - `extra_hosts: ["host.docker.internal:host-gateway"]`
  - Healthcheck: `test: ["CMD", "wget", "-qO-", "http://localhost:3131/api/health"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 30s`
  - `restart: unless-stopped`

- [ ] **REQ-12**: GIVEN o container subiu WHEN o usuário roda `docker compose exec app pnpm ingest` THEN o script roda dentro do container, enxerga `/claude-projects` (read-only) como source de transcripts, escreve em `/app/data/dashboard.db`, sem erros.

- [ ] **REQ-13**: GIVEN o container é parado e reiniciado (`docker compose down && up`) WHEN o usuário abre o dashboard THEN todas as sessões ingeridas anteriormente continuam visíveis (DB persistiu via volume mount `./data`).

### Documentação

- [ ] **REQ-14**: GIVEN `README.md` WHEN lido THEN tem uma sub-seção sobre Docker (dentro do bloco "1. COMEÇO AQUI" do REQ-17) contendo:
  - Pré-requisitos (Docker Desktop no Mac/Win, Docker Engine no Linux)
  - Build + run: `docker compose up --build -d`
  - Acessar: `http://localhost:3131`
  - Ingerir transcripts: `docker compose exec app pnpm ingest`
  - Parar: `docker compose down`
  - Onde fica o DB: `./data/dashboard.db` (host path)
  - Caveat de permissão: se o user host não for UID 1001, o volume `./data` pode precisar de `chown` ou o container vai falhar ao escrever
  - Linux-specific: `extra_hosts` já está configurado, mas se OTEL não funcionar, verificar firewall/iptables
  - Limitação: E2E Playwright NÃO roda dentro do container — é pra dev local via `pnpm test:e2e`

- [ ] **REQ-17**: GIVEN `README.md` WHEN reorganizado THEN segue estrutura dev-journey "fazer → entender → aprofundar → referência" com 5 blocos de nível H2 nessa ordem:

  1. **`## Começo aqui`** (fazer) — agrupa: intro curta ("Pra que serve"), Quick Start ("5 minutos pra ver rodando"), **Comandos**, **Variáveis de ambiente**, **Running via Docker** (nova — REQ-14).

  2. **`## O que vem dentro`** (entender) — agrupa: "Como funciona" (problema + abordagem + onde dados vivem), "Na prática" com features-de-uso (OTEL opcional, modo watch, como a ingestão é idempotente, rating de turno).

  3. **`## Como é organizado`** (aprofundar estrutura) — agrupa: estrutura do repo, schema SQLite, rotas API.

  4. **`## Ferramentas`** (aprofundar operação) — agrupa: heurística de correção, heurística de efetividade, atualizar tabela de preços, customizar, troubleshooting.

  5. **`## Referência`** (consulta) — agrupa: matriz de testes, convenções, contribuindo.

  Sub-seções dentro dos blocos são `###`. Nenhum conteúdo existente é deletado; só reordenado e re-agrupado com cabeçalhos reclassificados.

- [ ] **REQ-18**: GIVEN `CLAUDE.md` WHEN lido após a reorganização do README THEN permanece consistente — nenhuma referência quebrada pra seção antiga do README. Similarmente pra `CONTRIBUTING.md` (se mencionar estrutura do README). Verificar com grep e ajustar apenas se houver menção literal a `#` heading antigo.

### Smoke

- [ ] **REQ-15**: GIVEN `docker build .` é executado WHEN o build completa THEN imagem final tem tamanho < 500MB (sanity check — standalone + runtime deps comprimidos devem caber).

- [ ] **REQ-16**: GIVEN o container subido via compose WHEN `curl http://localhost:3131/api/health` é chamado THEN retorna 200 `{"ok":true}` em < 2s após o `start_period`.

## Test Plan

### Unit Tests

Em [lib/fs-paths.test.ts](lib/fs-paths.test.ts) — adiciona cobertura pra o env var.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-5 | happy | `CLAUDE_PROJECTS_ROOT=/tmp/cp` + `claudeProjectsRoot()` | retorna `/tmp/cp` |
| TC-U-02 | REQ-6 | edge | `CLAUDE_PROJECTS_ROOT` unset + `claudeProjectsRoot()` | retorna `path.join(os.homedir(), '.claude', 'projects')` |
| TC-U-03 | REQ-6 | edge | `CLAUDE_PROJECTS_ROOT=''` (string vazia) + `claudeProjectsRoot()` | retorna fallback (não `''`) |
| TC-U-04 | REQ-5 | happy | `CLAUDE_PROJECTS_ROOT=./relative/path` + chamada | retorna path absoluto via `path.resolve` |
| TC-U-05 | REQ-7 | security | `CLAUDE_PROJECTS_ROOT=/tmp/cp` + `resolveWithinClaudeProjects('../../../etc/passwd')` | lança erro (contém "escapes") |
| TC-U-06 | REQ-7 | happy | `CLAUDE_PROJECTS_ROOT=/tmp/cp` + `resolveWithinClaudeProjects('/tmp/cp/project-a/file.jsonl')` | retorna path resolvido sem lançar |
| TC-U-07 | REQ-8 | business | mensagem de erro do path traversal | contém "Claude projects root" (não mais literal "~/.claude/projects") |

### Integration Tests

Em [tests/integration/health-route.test.ts](tests/integration/health-route.test.ts) — testa o endpoint `/api/health` via Next handler direto (sem HTTP server).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-9 | happy | `GET /api/health` | 200, body `{ok: true}`, `content-type: application/json` |
| TC-I-02 | REQ-10 | validation | `POST /api/health` | 405, header `Allow: GET` |
| TC-I-03 | REQ-10 | validation | `DELETE /api/health` | 405, header `Allow: GET` |
| TC-I-04 | REQ-9 | business | Handler não abre DB | sem chamadas a `getDb()` (verificar via import inspection OU rodar com DB path inválido e verificar que não falha) |

### Docker smoke (manual, Checkpoint 2)

Não automatizados via Vitest/Playwright (build de imagem + boot de container são pesados pro loop de teste unitário). Validação obrigatória no Checkpoint 2.

| TC | REQ | Description |
| --- | --- | --- |
| TC-SMOKE-01 | REQ-2, REQ-15 | `docker compose build` completa sem erro; imagem final listada em `docker images` tem menos de 500MB |
| TC-SMOKE-02 | REQ-11, REQ-16 | `docker compose up -d`; aguardar 30s; `curl http://localhost:3131/api/health` retorna `{"ok":true}` com status 200 |
| TC-SMOKE-03 | REQ-12 | `docker compose exec app pnpm ingest` roda sem erro; conta de sessões no DB aumenta ou igual (idempotente) |
| TC-SMOKE-04 | REQ-13 | `docker compose down && docker compose up -d`; `curl /` depois do warmup; sessões anteriores visíveis (DB persistiu) |
| TC-SMOKE-05 | REQ-11 (healthcheck) | `docker compose ps` mostra status `(healthy)` depois do start_period |
| TC-SMOKE-06 | REQ-17 | `grep -n "^## " README.md` mostra exatamente 5 blocos H2 na ordem: Começo aqui, O que vem dentro, Como é organizado, Ferramentas, Referência |
| TC-SMOKE-07 | REQ-14 | README contém sub-seção sobre Docker dentro de "Começo aqui" com comandos `docker compose up --build`, `docker compose exec app pnpm ingest`, e caveat de permissão UID 1001 |
| TC-SMOKE-08 | REQ-18 | `grep -nF "$(<heading-antigo>)" CLAUDE.md CONTRIBUTING.md` não retorna match pra nenhum heading H3 que foi movido/renomeado (ou, se retornar, foi ajustado) |

## Design

### Architecture Decisions

- **Multi-stage build** tem 3 stages porque cada um tem papel distinto:
  - `deps`: cache layer pra `pnpm install`. Invalidado só quando `package.json`/`pnpm-lock.yaml` mudam.
  - `builder`: roda `pnpm build` copiando código em cima do `deps` cached.
  - `runner`: copia apenas o output do Next standalone + deps runtime. Imagem final enxuta.

- **Next.js `output: 'standalone'`**: gera `.next/standalone/server.js` + `.next/standalone/node_modules/` com só o que precisa em runtime. Dockerfile copia isso em vez de `node_modules/` inteiro. Reduz imagem em 80%+. **Caveat**: não copia `.next/static` nem `public/` — Dockerfile precisa copiar esses explicitamente.

- **better-sqlite3 native binding**: o pacote tem um pós-install que compila bindings C. `pnpm` 10+ bloqueia por default (mostra `Ignored build scripts`). Precisamos `pnpm approve-builds better-sqlite3` ou `pnpm install --strict-peer-dependencies=false --shamefully-hoist` — mais simples: executar `pnpm rebuild better-sqlite3` explicitamente depois do install pra forçar a compilação. Runtime stage precisa das mesmas bindings — OU copia `node_modules/better-sqlite3` do deps stage, OU reinstala apenas `better-sqlite3` na runtime stage.

- **Dockerfile esqueleto** (inline pra referência concreta; o arquivo real vai ser escrito em TASK-5):

  ```dockerfile
  # syntax=docker/dockerfile:1.7
  ARG NODE_VERSION=22

  FROM node:${NODE_VERSION}-slim AS deps
  RUN corepack enable
  WORKDIR /app
  COPY package.json pnpm-lock.yaml ./
  RUN pnpm install --frozen-lockfile \
   && pnpm rebuild better-sqlite3

  FROM node:${NODE_VERSION}-slim AS builder
  RUN corepack enable
  WORKDIR /app
  COPY --from=deps /app/node_modules ./node_modules
  COPY . .
  RUN pnpm build

  FROM node:${NODE_VERSION}-slim AS runner
  RUN groupadd -r -g 1001 nextjs \
   && useradd -r -u 1001 -g 1001 -m nextjs
  WORKDIR /app
  ENV NODE_ENV=production \
      PORT=3131
  # Standalone server + static assets + DB schema (runtime needs it to migrate)
  COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
  COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
  COPY --from=builder --chown=nextjs:nextjs /app/public ./public
  COPY --from=builder --chown=nextjs:nextjs /app/lib/db/schema.sql ./lib/db/schema.sql
  # Scripts usable via `docker compose exec app pnpm ingest`
  COPY --from=builder --chown=nextjs:nextjs /app/scripts ./scripts
  COPY --from=builder --chown=nextjs:nextjs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
  COPY --from=builder --chown=nextjs:nextjs /app/node_modules/.pnpm ./node_modules/.pnpm
  # Runtime-only deps pra tsx (ingest/watch scripts)
  COPY --from=deps --chown=nextjs:nextjs /app/node_modules/tsx ./node_modules/tsx
  COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json
  RUN mkdir -p /app/data && chown -R nextjs:nextjs /app/data
  USER nextjs
  EXPOSE 3131
  CMD ["node", "server.js"]
  ```

  **Nota sobre `pnpm exec`**: o runner NÃO tem `pnpm` instalado. `docker compose exec app pnpm ingest` vai falhar. Alternativa: adicionar `RUN corepack enable && corepack prepare pnpm@latest --activate` no runner (overhead pequeno). Ou fornecer comando alternativo: `docker compose exec app node --import tsx scripts/ingest.ts`. Decisão: **habilitar pnpm via corepack no runner** — mantém ergonomia `docker compose exec app pnpm ingest`.

- **docker-compose** (inline pra referência concreta):

  ```yaml
  services:
    app:
      build:
        context: .
        dockerfile: Dockerfile
      image: tokenfx:local
      ports:
        - "3131:3131"
      volumes:
        - ./data:/app/data
        - ${CLAUDE_PROJECTS_ROOT:-$HOME/.claude/projects}:/claude-projects:ro
      environment:
        NODE_ENV: production
        PORT: "3131"
        DASHBOARD_DB_PATH: /app/data/dashboard.db
        CLAUDE_PROJECTS_ROOT: /claude-projects
      extra_hosts:
        - "host.docker.internal:host-gateway"
      healthcheck:
        test: ["CMD", "wget", "-qO-", "http://localhost:3131/api/health"]
        interval: 30s
        timeout: 5s
        retries: 3
        start_period: 30s
      restart: unless-stopped
  ```

- **`/api/health` route** (Server route handler em `app/api/health/route.ts`):

  ```ts
  export const dynamic = 'force-dynamic';
  export const runtime = 'nodejs';

  export async function GET(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  export async function OPTIONS(): Promise<Response> {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET' },
    });
  }
  ```

  Outros métodos (POST, DELETE, etc) são gerados automaticamente pelo Next App Router como 405 quando não exportados — **check behavior**: Next 16 retorna 405 automaticamente pra métodos não-exportados, OU 404? Precisa verificar. Se retornar 404, adicionar handler genérico pra POST/DELETE/PUT/PATCH que retorne 405. **Decisão**: exportar explicitamente `POST`, `PUT`, `PATCH`, `DELETE` retornando 405 pra garantir comportamento previsível.

- **`lib/fs-paths.ts` refactor** (REQ-5/6/7/8):

  ```ts
  import os from 'node:os';
  import path from 'node:path';
  import fs from 'node:fs';

  export function claudeProjectsRoot(): string {
    const fromEnv = process.env.CLAUDE_PROJECTS_ROOT?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return path.resolve(fromEnv);
    }
    return path.join(os.homedir(), '.claude', 'projects');
  }

  export function resolveWithinClaudeProjects(p: string): string {
    const segments = p.split(/[\\/]/);
    if (segments.includes('..')) {
      throw new Error('path escapes the Claude projects root');
    }
    const root = claudeProjectsRoot();
    // ... (rest unchanged)
    if (
      realResolved !== realRoot &&
      !realResolved.startsWith(realRoot + path.sep)
    ) {
      throw new Error('path escapes the Claude projects root');
    }
    return realResolved;
  }
  ```

  **Backward compat**: `claudeProjectsRoot()` é chamado em múltiplos lugares (`ingest/auto.ts`, `ingest/watcher.ts`, `ingest/transcript/parser.ts`, etc). Resultado muda **só quando** env var é setada. Em dev local sem env, resultado é idêntico ao atual. Zero quebra esperada.

- **Next.js standalone** (REQ-1): editar `next.config.ts`:

  ```ts
  const nextConfig: NextConfig = {
    output: 'standalone',
    allowedDevOrigins: ['127.0.0.1', 'localhost'],
  };
  ```

  Impacto em dev: nenhum. `pnpm build` adiciona passo de copiar arquivos pra `.next/standalone/`; `pnpm dev` ignora.

- **`.dockerignore`**:

  ```gitignore
  # Build artifacts
  .next
  node_modules
  dist
  # Runtime data
  data
  # Dev-only
  .git
  .gitignore
  .claude
  .specs
  # Tests
  tests
  playwright.config.ts
  playwright-report
  test-results
  # Docs (README is needed, but the rest is bloat)
  .ralph
  # Env files (security)
  .env
  .env.*
  !.env.example
  # Logs
  *.log
  ```

- **README reorganização** (REQ-17 + REQ-14): a reordenação adota 5 blocos H2 seguindo a jornada do dev. Mapeamento do conteúdo existente (`README.md` hoje tem ~17 sub-seções em ordem frouxa) pra nova estrutura:

  | Bloco H2 | Sub-seções H3 (nova ordem) | Origem (seções atuais) |
  | --- | --- | --- |
  | `## Começo aqui` | Pra que serve, 5 minutos pra ver rodando, Comandos, Variáveis de ambiente, **Running via Docker (NOVO)** | mover Comandos + Env de Referência pra cá; Docker é conteúdo novo (REQ-14) |
  | `## O que vem dentro` | Como funciona (problema + abordagem + onde dados vivem), OTEL opcional, Modo watch, Idempotência da ingestão, Avaliação de turno | "Como funciona" + "Na prática" parcial |
  | `## Como é organizado` | Estrutura do repo, Schema SQLite, Rotas API | Referência (partes estruturais) |
  | `## Ferramentas` | Heurística de correção, Heurística de efetividade, Atualizar pricing, Customizar, Troubleshooting | "Na prática" parcial (cobre operação/tuning) |
  | `## Referência` | Matriz de testes, Convenções, Contribuindo | resto da "Referência" atual |

  A nova sub-seção **Running via Docker** entra no bloco 1 (`Começo aqui`) porque é parte da jornada "clonei o repo, como rodo?". Conteúdo dela está descrito em REQ-14.

  `CLAUDE.md` + `CONTRIBUTING.md` ficam fora do refactor estrutural — só recebem ajuste pontual SE mencionarem um heading literal do README antigo (grep valida).

### Files to Create

- `Dockerfile`
- `docker-compose.yaml`
- `.dockerignore`
- `app/api/health/route.ts`
- `tests/integration/health-route.test.ts`

### Files to Modify

- `next.config.ts` — adicionar `output: 'standalone'`
- `lib/fs-paths.ts` — honra env `CLAUDE_PROJECTS_ROOT`
- `lib/fs-paths.test.ts` — adicionar TC-U-01..07
- `README.md` — reorganização completa em 5 blocos H2 (REQ-17) + sub-seção Running via Docker (REQ-14)
- `CLAUDE.md` — ajuste pontual se grep encontrar referência a heading antigo do README (REQ-18)
- `CONTRIBUTING.md` — ajuste pontual se grep encontrar referência a heading antigo do README (REQ-18)

### Dependencies

- Nenhuma nova dep npm. Nenhuma mudança em `package.json`.
- Docker Engine 24+ com Compose v2 (required pra `${VAR:-default}` substitution em volumes).

## Tasks

- [x] TASK-1: Next.js `output: 'standalone'` em `next.config.ts`
  - files: next.config.ts

- [x] TASK-2: `lib/fs-paths.ts` respeita `CLAUDE_PROJECTS_ROOT` + testes
  - files: lib/fs-paths.ts, lib/fs-paths.test.ts
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07

- [x] TASK-3: `app/api/health/route.ts` + testes integration
  - files: app/api/health/route.ts, tests/integration/health-route.test.ts
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04

- [x] TASK-4: `.dockerignore`
  - files: .dockerignore

- [x] TASK-5: `Dockerfile` multi-stage
  - files: Dockerfile
  - depends: TASK-1, TASK-4

- [x] TASK-6: `docker-compose.yaml`
  - files: docker-compose.yaml
  - depends: TASK-5

- [x] TASK-7: README reorganização completa (5 blocos H2 dev-journey) + seção Docker embutida + verificação de referências em CLAUDE.md / CONTRIBUTING.md
  - files: README.md, CLAUDE.md, CONTRIBUTING.md
  - depends: TASK-6

- [x] TASK-SMOKE: Validação docker smoke manual (TC-SMOKE-01..05) + grep do README pra confirmar 5 blocos H2 e mapeamento de conteúdo
  - files: (nenhum — validação manual, executado no Checkpoint 2)
  - depends: TASK-7

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2, TASK-3, TASK-4]   — paralelo (arquivos totalmente exclusivos)
Batch 2: [TASK-5]                           — depends TASK-1, TASK-4
Batch 3: [TASK-6]                           — depends TASK-5
Batch 4: [TASK-7]                           — depends TASK-6 (documenta comandos refletindo a compose)
Batch 5: [TASK-SMOKE]                       — validação manual pós-tudo
```

File overlap: **nenhum**. Todo TASK toca arquivos únicos.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (+7 TC-U + 4 TC-I)
- [ ] `pnpm build` passes (Next standalone gera `.next/standalone/server.js`)
- [ ] `pnpm test:e2e` passes (nenhuma regressão — specs existentes)

### Discipline Checkpoints

**Checkpoint 1 — Self-review REQ-by-REQ + best-way-possible check**:

- Walk REQ-1..16 com evidência concreta.
- Best-way: `output: 'standalone'` é o padrão oficial do Next pra containerização (não reinvento bundler custom); `CLAUDE_PROJECTS_ROOT` env var respeita o padrão do projeto (config via env, não config file); healthcheck puro sem tocar DB evita false-negative; multi-stage com cache layer preserva rebuild incremental; non-root user é recomendação de segurança básica; `pnpm rebuild better-sqlite3` no deps stage garante bindings nativos; volume mount `./data` é o padrão pra SQLite em container.

**Checkpoint 2 — Live validation com dados reais**:

- `docker compose build` no diretório — build completa em <5min, imagem < 500MB (`docker images | grep tokenfx`).
- `docker compose up -d`; aguardar 30s.
- `curl http://localhost:3131/api/health` → `{"ok":true}` 200.
- `curl http://localhost:3131/` → HTML 200 com "TokenFx" visível.
- `docker compose exec app pnpm ingest` → roda, lê `/claude-projects`, escreve em `/app/data/dashboard.db`. Cross-check: `sqlite3 ./data/dashboard.db "SELECT COUNT(*) FROM sessions"` no host mostra count coerente.
- `docker compose down && docker compose up -d`; após warmup, `curl /sessions` mostra sessões do DB anterior (persistência via volume OK).
- `docker compose ps` → status do service é `(healthy)` após `start_period + interval`.
- Parar: `docker compose down`. SIGTERM esperado.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Iteration 1 — Batch 1 (TASK-1, 2, 3, 4) (2026-04-19 18:13)

4 tasks pequenas em main tree. TASK-1: `next.config.ts` ganha `output: 'standalone'` (sem impacto em dev). TASK-2: `lib/fs-paths.ts` `claudeProjectsRoot()` honra `CLAUDE_PROJECTS_ROOT` env com fallback pra `~/.claude/projects`; mensagens de erro de path traversal trocaram pra "Claude projects root" genérico; +7 TCs em `fs-paths.test.ts` (18 passing total). TASK-3: `app/api/health/route.ts` com GET `{ok:true}` + handlers 405 explícitos pra POST/PUT/PATCH/DELETE; 6 TCs integration (inclui verificação de que NÃO abre DB mesmo com `DASHBOARD_DB_PATH` inválido). TASK-4: `.dockerignore` exclui build artifacts, data, .git, .claude, tests, env files. typecheck + lint limpos.
TDD (TASK-2): RED(4 failing) → GREEN(18 passing) → REFACTOR(clean). TDD (TASK-3): RED(import failed) → GREEN(6 passing) → REFACTOR(clean).

### Iteration 2 — TASK-5 (2026-04-19 18:20)

`Dockerfile` 2-stage (builder + runner) em Node 22-slim. Builder: `pnpm install --frozen-lockfile` + `pnpm rebuild better-sqlite3` (garante native binding pra arch do container) + `pnpm build`. Runner: `corepack enable` + non-root user `nextjs:1001` + `npm install -g tsx@^4` (pra `docker compose exec app pnpm ingest`) + copia standalone + static + public + schema.sql + scripts + package.json + `mkdir -p /app/data` com chown. CMD `node server.js`, EXPOSE 3131. `pnpm build` local valida o standalone emit (`.next/standalone/server.js` gerado).

### Iteration 3 — TASK-6 (2026-04-19 18:25)

`docker-compose.yaml` single service `app` com: build do Dockerfile local, image `tokenfx:local`, porta `3131:3131`, volumes `./data:/app/data` + `${CLAUDE_PROJECTS_ROOT:-$HOME/.claude/projects}:/claude-projects:ro`, env (`NODE_ENV=production`, `DASHBOARD_DB_PATH`, `CLAUDE_PROJECTS_ROOT=/claude-projects`, `HOSTNAME=0.0.0.0`), `extra_hosts: host.docker.internal:host-gateway` pro OTEL do host, healthcheck via wget no `/api/health` (interval 30s, start_period 30s), `restart: unless-stopped`. `docker compose config` valida YAML.

### Iteration 5 — TASK-SMOKE (2026-04-19 18:45)

Validação manual do pipeline completo. TC-SMOKE-01 **parcial**: build OK, tamanho final **1.2GB** (não <500MB como REQ-15 projetava — Next + React + Recharts + Radix + prod node_modules + better-sqlite3 native binding somam além do estimado; decidi manter prod-only install + standalone sem trimming agressivo pra não sacrificar ergonomia dos scripts). TC-SMOKE-02 ✓: boot em ~6s, curl `/api/health` → 200 `{"ok":true}`. TC-SMOKE-03 ✓: `docker compose exec app pnpm ingest` processou 483 upserts (45k turnos, 29k tool_calls) do DB real. TC-SMOKE-04 ✓: `down && up` preservou 62 sessões (volume mount OK). TC-SMOKE-05 ✓: status `(healthy)` em <10s após start. TC-SMOKE-06/07/08 ✓: já verificados em TASK-7.

**Fixes descobertos e aplicados durante smoke** (documentados acima em TASK-5/Dockerfile):

1. `/_not-found` prerender quebrava o `pnpm build` em container porque o layout carrega `QuotaNavWidget` (DB read) — fix: `export const dynamic = 'force-dynamic'` em `app/not-found.tsx`.
2. pnpm 10 bloqueia build scripts por default, então `pnpm rebuild better-sqlite3` não compilava o native binding — fix: `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }` em `package.json`.
3. Standalone's trimmed `node_modules` faltava `zod`/`chokidar` que scripts importam — fix: COPY `node_modules` do stage `deps` (prod-only) em vez de deixar o standalone limitado.
4. `wget` não existe em `node:22-slim` — healthcheck trocado pra `node -e` one-liner usando http nativo.

**REQ-15 status: 🟡 PARTIAL** — image builda e funciona, mas 1.2GB > 500MB. Follow-up possível: standalone-strict com install seletivo de `zod`/`chokidar` no runner (não `pnpm install --prod` full), ou alpine com workaround pra better-sqlite3/glibc. Decisão: aceitar 1.2GB pra localhost tool.

### Iteration 4 — TASK-7 (2026-04-19 18:35)

README reorganizado em 5 blocos H2 seguindo jornada dev: **Começo aqui** (intro, Quick Start, **Running via Docker** novo, Comandos, Env vars — agora inclui `CLAUDE_PROJECTS_ROOT`, `TOKENFX_WATCH_MODE`, `TOKENFX_DISABLE_AUTO_INGEST`) / **O que vem dentro** (Como funciona + sub-tópicos operacionais: OTEL, watch, idempotência, rating) / **Como é organizado** (Estrutura, Schema, Rotas — inclui `GET /api/health`) / **Ferramentas** (heurísticas, pricing, customize, troubleshooting — +2 linhas Docker) / **Referência** (testes, convenções, contribuindo). Drive-by: port 3131 corrigido em 2 lugares (intro + troubleshooting) onde ainda estava 3000; linha sobre `pnpm watch` adicionada à tabela Comandos; `Dockerfile` + `docker-compose.yaml` listados no diagrama de estrutura. CLAUDE.md e CONTRIBUTING.md sem referências cruzadas a headings antigos — zero ajustes necessários.
