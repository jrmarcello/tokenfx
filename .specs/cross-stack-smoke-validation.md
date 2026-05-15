# Spec: cross-stack-smoke-validation

## Status: DONE

## Context

Origem: último item ativo de `roadmap.md` — "teste final GERAL" pós review-fixes (`.specs/review-report-2026-05-14-fixes.md` DONE em `1ce4a76`/`ed6d44a`). O usuário escreveu literalmente:

> "Quero testar TUDO. TUDO TEM QUE ESTAR FUNCIONAL. TODAS as partes do sistemas devem ser testadas: tecnologas, libs e ect atualizados, infra funcional (docker e etc) e app completamente funicional. Reseta o DB, sobe TODOS os serviços e testa se tudo funciona."

Checklist explícito do roadmap:

- (a) Sem duplicações de dados/sessões em re-ingest.
- (b) Métricas + componentes dos dashboards das 2 apps funcionando.
- (c) Números corretos e realistas nas 2 apps.
- (d) Integração entre os 2 serviços (root tokenfx → apps/server via reporter) funcional.
- (e) Auditoria de rigor dos testes — melhorar substancialmente se cenários de erro+sucesso não cobrirem.

**Por que esta spec existe:** o sistema tem 3 superfícies deployáveis (root tokenfx Next.js + SQLite, apps/server Next.js + Postgres + SSO, apps/idp-stub OIDC stub) MAS hoje só o root tokenfx é dockerizado; `apps/server` e `apps/idp-stub` não têm Dockerfile nem entrada em `docker-compose.yaml`; não há Postgres no compose; não há script de reset cross-stack; não há runbook reprodutível; a integração reporter → central server nunca foi exercitada end-to-end via Docker.

Esta spec resolve isso: produz a infra (Dockerfiles + compose extendido), scripts de reset+seed cross-stack, runbook executável, e automated cross-stack integration test que prova reporter → central server funciona contra containers reais. A auditoria de rigor de testes do roadmap §(e) é tratada como descoberta DURANTE o smoke + apêndice no runbook + fix in-place se trivial.

**Decisões já travadas:**

1. **Uma spec única.** Scope é grande (15 tasks) mas coeso. Splittar atrasaria valor.
2. **Postgres no compose, NÃO testcontainers em runtime.** Testcontainers continua mecanismo dos testes; pro smoke ao vivo + dev local, compose levanta um Postgres 16-alpine persistente.
3. **idp-stub fica sob profile `smoke`** (`docker compose --profile smoke up`). Default `docker compose up` continua subindo só o root tokenfx.
4. **Reset bilingue:** `pnpm smoke:reset` (root) shells em containers via dependency-injected executor (testável com stub).
5. **Seed determinístico:** valores hard-coded para assertions exatas no runbook. Tradeoff explícito: seed direto via INSERT bypassa o parser → REQ-8 idempotency testa o parser separadamente via JSONL fixture em `tests/fixtures/`.
6. **Reporter cross-stack test:** testcontainers (PG) + child-process (idp-stub) — **não** in-process. ESM/CJS interop entre root tokenfx (CJS) e idp-stub (ESM `"type": "module"`) é frágil; spawn binary via `execa` + healthcheck await é mais robusto. Test NÃO usa o docker-compose externo (evita dependência circular de CI).
7. **Runbook em `docs/smoke-runbook.md`** com checklist numerado + comandos copy-pasteable. Manual mas reprodutível.
8. **Auditoria de rigor (§e):** "discover during smoke". Cada gap concreto vira (i) bug fix com TC inline se trivial, OU (ii) line item em follow-up `improve-test-rigor.md`. REQ-14 exige populate explícito da seção `#test-gaps-found` no runbook (não vazio).
9. **`idp-stub` Dockerfile precisa override do hostname bind.** `apps/idp-stub/src/index.ts` faz `serve({ hostname: '127.0.0.1' })` (security hardening). Em container, `127.0.0.1` é apenas o container — DNS interno docker (`tokenfx-idp-stub:3001`) resolve pra bridge IP, conexão recusada. Fix: index.ts lê `IDP_STUB_HOSTNAME` env (default `127.0.0.1`); compose seta `IDP_STUB_HOSTNAME=0.0.0.0`. Threat Model §2 documenta que a defesa de loopback é substituída pela camada `profiles: [smoke]` + boot guard + published-port-host-only.
10. **`apps/server` Dockerfile estratégia migrate:** opção escolhida é compilar `lib/db/migrate.ts` → JS no builder stage (`tsc lib/db/migrate.ts --outDir dist`) e COPY o output pro runner stage. Roda via `node dist/migrate.js`. Mais simple que sidecar tsx, sem dependência de toolchain Python no runner.
11. **bcrypt native binding:** builder stage instala toolchain (`apt-get install -y python3 make g++ --no-install-recommends`) ANTES de `pnpm install`. `pnpm-workspace.yaml` já lista `bcrypt` em `onlyBuiltDependencies` mas a rebuild precisa do toolchain disponível.

**Prior art relevante:** [Dockerfile](../Dockerfile), [docker-compose.yaml](../docker-compose.yaml), [scripts/seed-dev.ts](../scripts/seed-dev.ts), [apps/server/scripts/seed-server.ts](../apps/server/scripts/seed-server.ts), [apps/server/tests/integration/setup-pg.ts](../apps/server/tests/integration/setup-pg.ts), [scripts/reporter-config-init.ts](../scripts/reporter-config-init.ts) (gera `project_secret`).

## Requirements

- [ ] **REQ-1 (infra build):** GIVEN `pnpm install` rodado + Docker daemon up, WHEN `docker compose --profile smoke build` executa, THEN as 3 imagens buildam sem erro fatal — stdout livre de `gyp ERR!`, `npm ERR!`, `ERROR [...]`.
- [ ] **REQ-2 (compose up):** GIVEN imagens buildadas, WHEN `docker compose --profile smoke up -d` executa, THEN 4 containers (`postgres-smoke`, `tokenfx-server`, `tokenfx-idp-stub`, `tokenfx`) atingem status `healthy` em ≤90s. Se algum não atingir, `docker compose ps` mostra `unhealthy` + smoke aborta.
- [ ] **REQ-3 (healthchecks):** cada container expõe `/api/health` (ou `/.well-known/openid-configuration` pro stub) + healthcheck declarado retorna HEALTHY em ≤30s pós-start_period.
- [ ] **REQ-4 (docker network connectivity):** GIVEN stack `smoke` up, WHEN container `tokenfx` (root, joined a `smoke-net`) chama `http://tokenfx-server:3232/api/health`, THEN obtém 200. Prova DNS interno docker funciona e `app` está corretamente em ambas as redes (default + smoke-net).
- [ ] **REQ-5 (SSO config):** GIVEN stack up, `apps/server` configurado com `OKTA_ISSUER=http://tokenfx-idp-stub:3001`. WHEN signin live iniciado via `/api/auth/signin`, THEN OAuth completa contra stub, user `smoke-user-1@example.com` é provisionado/encontrado, `/me/dashboard` renderiza autenticado.
- [ ] **REQ-6 (reset cross-stack):** GIVEN stack up + dados, WHEN `pnpm smoke:reset` executa do host, THEN: (i) `data/dashboard.db*` deletado; (ii) Postgres TRUNCATE-RESTART-IDENTITY-CASCADE em todas tabelas; (iii) idp-stub scenario reset via POST. Script falha fast (exit 1) se docker exec retorna erro OU se idp-stub POST retorna non-2xx (errors propagam, não silenciosos).
- [ ] **REQ-7 (seed determinístico):** GIVEN reset feito, WHEN `pnpm smoke:seed` executa, THEN: (i) SQLite root recebe 3 sessões fixtured com costs **`10.00 + 15.00 + 17.50 = 42.50`** USD, turn_counts `5/8/12`, tool_call_counts `10/15/25`, 1 com `total_cost_usd_otel=0.40`; (ii) Postgres recebe 1 org `Smoke Co` + 2 users (`smoke-user-1@example.com` manager + `smoke-user-2@example.com` member) + 1 machine + 1 invite ativo + role `tokenfx` criado se não existir; (iii) `.env.smoke` (gitignored) gerado com `bearer secret` + `project_secret` (32 random bytes hex, mesmo pattern de `reporter-config-init.ts`).
- [ ] **REQ-8 (re-ingest idempotency):** GIVEN JSONL fixture em `tests/fixtures/ingest-idempotency/*.jsonl` (existente ou novo), WHEN `pnpm ingest` executa 2× consecutivos, THEN `SELECT COUNT(*) FROM sessions/turns/tool_calls` é byte-idêntico entre run-1 e run-2. **NOTA:** este REQ usa JSONL fixture (não a seed direta) para exercitar o parser.
- [ ] **REQ-9 (reporter cross-stack):** GIVEN stack up + seeded + `.env.smoke` carregado, WHEN `pnpm reporter:once` executa, THEN: (i) `/api/ingest` retorna 200; (ii) `sessions_agg` no Postgres tem 3 rows mapeadas dos sessions root; (iii) `ingestion_log` tem 1 row com `accepted_count=3`; (iv) `SUM(total_cost_usd) FROM sessions_agg = 42.50` (assertion exata, prova mapping correto da coluna `total_cost_usd` — não `total_cost_usd_otel`); (v) re-run resulta em `pushed=0` (idempotency via payload_hash).
- [ ] **REQ-10 (root dashboard render):** GIVEN seed, WHEN GET `http://localhost:3131/` responde, THEN status 200, body contém literal `$42.50` (or formatted equivalent) + session count `3`. Adicionalmente: GET `/sessions`, `/effectiveness` retornam 200 (não 5xx).
- [ ] **REQ-11 (server dashboard render):** GIVEN seed + reporter push completed, WHEN GET `http://localhost:3232/manager/teams` (auth via `E2E_AUTH_BYPASS=1`) responde, THEN status 200, body contém custo agregado `$42.50` derivado de `SUM(sessions_agg.total_cost_usd)` + user_count `2`. Rotas `/manager/teams`, `/manager/activity`, `/me/dashboard` retornam 200.
- [ ] **REQ-12 (runbook):** existe `docs/smoke-runbook.md` com (i) preconditions, (ii) sequência numerada de comandos copy-pasteable, (iii) checklist de validação manual com expected values, (iv) seção `#test-gaps-found`, (v) troubleshooting.
- [ ] **REQ-13 (automated reporter integration):** GIVEN `RUN_CROSS_STACK_SMOKE=1`, WHEN `pnpm test --run tests/integration/cross-stack-reporter.test.ts` executa, THEN: (i) Postgres testcontainer sobe; (ii) idp-stub spawnado como child_process (executa `pnpm --filter @tokenfx/idp-stub start`) + healthcheck await; (iii) reporter pusha contra apps/server invocado in-process (route handler import); (iv) assertions de TC-I-09..11. **Failure modes:** se testcontainer não inicia em 60s → fail fast com diagnóstico; se idp-stub child timeout 30s → fail fast.
- [ ] **REQ-14 (test rigor — discover during smoke):** durante execução manual do runbook, gaps concretos de cobertura são documentados em `docs/smoke-runbook.md#test-gaps-found` com (i) descrição do gap, (ii) classificação trivial/non-trivial, (iii) decisão fix-in-spec OU defer-to-follow-up. A seção deve ter ≥1 entrada não-comentário (mesmo que seja `"no gaps found"` explícito); placeholder HTML-comment vazio não satisfaz.

## Threat Model

Esta spec toca infra de auth (SSO contra idp-stub via Docker network) e secret management (env vars com AUTH_SECRET, OKTA_*, project_secret, bearer secret) — Threat Model relevante.

1. **Trust boundary** — Três fronteiras:
   - Container network → containers (Docker bridge `smoke-net`). Confiança alta dentro do `smoke`; nenhum container expõe portas extras pra host além do mínimo (3131, 3232, 3001 — todos loopback host).
   - Host → container (published ports). Limita superfície ao runbook smoke.
   - Container → external internet. Bloqueado por design — nenhum container precisa de saída pra internet no smoke.
2. **Identidade autenticada:** idp-stub emite tokens sem validação (é stub). **Risco crítico:** stack `smoke` em produção = qualquer login aceito. Mitigação multi-camada:
   - `apps/idp-stub` boot guard (`checkBootEnv`) refuse `NODE_ENV=production` (L6 da spec anterior — em vigor).
   - Compose declara `NODE_ENV=development` explícito.
   - Profile `smoke` precisa ser opted-in explicitamente (não fire em `docker compose up`).
   - **NOTA:** dentro do container o stub bind em `0.0.0.0` (necessário pra Docker network DNS) — a defesa de loopback é substituída pela camada de profile + boot guard + published port host-only (3001 mapeia só pra `127.0.0.1` no host, não `0.0.0.0`).
3. **Credenciais em jogo:**
   - `AUTH_SECRET` — env stub `smoke-dev-secret-do-not-use-in-prod-0123456789abcdef`.
   - `OKTA_CLIENT_SECRET` — env stub.
   - `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET` — env stubs (apps/server `auth.config.ts` requer ambos no boot do Google provider).
   - `INTERNAL_CRON_SECRET` — env stub.
   - `ONBOARDING_EMAIL_HASH_PEPPER` — env stub.
   - `TOKENFX_APP_RUNTIME_ROLE` — `tokenfx` (custom role criado pelo seed).
   - Postgres password — `smoke-pg-password` (interno).
   - **Reporter bearer secret** — bcrypt-hash via seed script, plaintext em `.env.smoke` gitignored.
   - **`project_secret`** — 32-byte hex random, gerado por seed script via `crypto.randomBytes(32).toString('hex')` (mirror `reporter-config-init.ts`), escrito em `.env.smoke`. Reporter exige esse campo via `ReporterConfigSchema` (`lib/reporter/config.ts`).
4. **Replay & idempotency:**
   - SSO replay já protegido (nonce, state, PKCE, cookies pinned — spec anterior).
   - Re-ingest idempotency = REQ-8 + TC-I-08.
   - Reporter idempotency via `payload_hash` = REQ-9 + TC-I-10/11.
5. **Authorization scope:** sem mudança vs spec anterior. SSO middleware continua gating `/manager/*` por role.
6. **PII / audit trail:**
   - Seed determinístico usa emails sintéticos (`smoke-user-1@example.com`, `smoke-user-2@example.com`).
   - Runbook NÃO instrui copiar transcripts reais; seed sintético via `scripts/smoke-seed.ts`.
   - Audit log writes seguem peppered-hash existente.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-6 | happy | `scripts/smoke-reset.ts` reset SQLite — `data/dashboard.db*` deletado, db re-created vazio | `existsSync(db)` true, `SELECT COUNT(*) FROM sessions` = 0 |
| TC-U-02 | REQ-6 | edge | `smoke-reset.ts` lida com SQLite ausente (idempotente) | no-throw |
| TC-U-03 | REQ-6 | infra | `smoke-reset.ts` quando `docker compose exec` retorna exit-code não-zero (server container down) | falha fast com mensagem descritiva |
| TC-U-04 | REQ-6 | infra | `smoke-reset.ts` quando POST `/admin/scenario/reset` retorna 500 | falha fast + propaga erro |
| TC-U-05 | REQ-7 | happy | `scripts/smoke-seed.ts` produz dataset SQLite com counts exatos (3 sessions, costs 10/15/17.5) | counts match, SUM(cost) = 42.50 |
| TC-U-06 | REQ-7 | idempotency | `smoke-seed.ts` rodado 2× → counts inalterados | idempotent |
| TC-U-07 | REQ-7 | business | Seed inclui ≥1 session com `total_cost_usd_otel` non-null + ≥1 sem | both paths exist |
| TC-U-08 | REQ-7 | security | `.env.smoke` gerado contém ambos `REPORTER_BEARER_SECRET` e `REPORTER_PROJECT_SECRET` (32-byte hex cada) | both present, valid lengths |
| TC-U-09 | REQ-13 | infra | `cross-stack-reporter.test.ts` skip quando `RUN_CROSS_STACK_SMOKE != 1` | skipDescribe |
| TC-U-10 | REQ-12+14 | infra | `docs/smoke-runbook.md` existe com seções obrigatórias + `#test-gaps-found` populated (não-comment-only) | grep matches |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | infra | `docker build apps/server` succeed sem `ERROR`, `gyp ERR!`, `npm ERR!` em stdout | exit 0 + clean stdout |
| TC-I-02 | REQ-1 | infra | `docker build apps/idp-stub` succeed sem ERROR | exit 0 + clean stdout |
| TC-I-03 | REQ-2 | infra | `docker compose --profile smoke up -d` + wait 90s + `docker compose ps` mostra todos 4 services com status `healthy` | all healthy ≤90s |
| TC-I-04 | REQ-2 | edge | Se postgres-smoke não fica healthy em 90s, smoke-reset.ts (downstream) detecta + falha com diagnóstico | clear error message |
| TC-I-05 | REQ-3 | happy | apps/server `/api/health` 200 + shape correto | 200 + shape |
| TC-I-06 | REQ-3 | happy | apps/idp-stub `/.well-known/openid-configuration` 200 + JSON válido | 200 + valid OIDC discovery |
| TC-I-07 | REQ-4 | infra | `docker compose --profile smoke exec tokenfx wget -q -O- http://tokenfx-server:3232/api/health` retorna 200 | proves docker DNS works + app on smoke-net |
| TC-I-08 | REQ-6 | happy | `apps/server/scripts/smoke-reset.ts` contra PG testcontainer, todas as tabelas count 0 post-run | counts = 0 |
| TC-I-09 | REQ-6 | idempotency | Reset 2× → mesmo resultado | idempotent |
| TC-I-10 | REQ-7 | business | `apps/server/scripts/smoke-seed.ts`: 1 org + 2 users + 1 machine + 1 invite + role `tokenfx` criado + 0 ingestion_log | counts exatos |
| TC-I-11 | REQ-7 | infra | `smoke-seed.ts` quando `DATABASE_URL` aponta pra PG unreachable (`ECONNREFUSED`) | falha fast + mensagem clara |
| TC-I-12 | REQ-8 | idempotency | `pnpm ingest` 2× contra `tests/fixtures/ingest-idempotency/*.jsonl` → session/turn/tool_call counts byte-idênticos | no duplicates |
| TC-I-13 | REQ-9 | happy | Reporter contra apps/server testcontainer + 3 sessions seedadas: `pushed=3`, `sessions_agg` tem 3 rows com SUM(total_cost_usd)=42.50 | exact match |
| TC-I-14 | REQ-9 | idempotency | Reporter rodado 2× → 2ª `pushed=0`, sessions_agg ainda 3 rows | no dup |
| TC-I-15 | REQ-9 | edge | Reporter rodado APÓS uma session mutate (novo turn): `pushed=1` pra essa session, `payload_hash` diferente | upsert + new hash |
| TC-I-16 | REQ-9 | infra | Reporter quando server retorna 401 (bearer secret errado): exit non-zero + log "unauthorized" | fail loud |
| TC-I-17 | REQ-9 | infra | Reporter quando server unreachable (ECONNREFUSED): exit non-zero + log connection error | fail loud |
| TC-I-18 | REQ-13 | infra | Quando PG testcontainer não inicia em 60s, cross-stack-reporter.test.ts falha com diagnóstico (não hang) | fail fast |
| TC-I-19 | REQ-13 | infra | Quando idp-stub child spawn timeout 30s, test falha com diagnóstico | fail fast |
| TC-I-20 | REQ-9+13 | business | Full cross-stack flow: PG testcontainer + idp-stub child + reporter push 3 sessions → assert sessions_agg state E ingestion_log row written E payload_hash dedup on re-run | all assertions green |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-5 | happy | Stack docker `smoke` up, navegar `/api/auth/signin` apps/server, fluxo OIDC contra idp-stub completa, `/me/dashboard` renderiza autenticado | dashboard 200 com user info |
| TC-E2E-02 | REQ-10 | happy | Root dashboard `/` renderiza pós-seed, contém `$42.50` + session count `3` | values match |
| TC-E2E-03 | REQ-11 | happy | Server `/manager/teams` renderiza pós-reporter-push, KPIs presentes, custo agregado matching | KPIs visible + match |
| TC-E2E-04 | REQ-10+11 | infra | Rotas root (`/`, `/sessions`, `/effectiveness`) e server (`/manager/teams`, `/manager/activity`, `/me/dashboard`) retornam todas 200 (nenhum 5xx) | all 200 |
| TC-E2E-05 | REQ-9+11 | business | **Cross-service data flow proof**: reset PG (NÃO seed-server) + root seed + reporter push → `/manager/teams` exibe custo correto. Proves display vem do reporter, não de seed direto | display === seed value |

### Coverage rigor check

Counts:
- Unit: 10 TCs — 2 happy + 4 infra + 1 idempotency + 1 business + 1 edge + 1 security
- Integration: 20 TCs — 4 happy + 11 infra + 3 idempotency + 1 business + 1 edge
- E2E: 5 TCs — 3 happy + 1 infra + 1 business

**Happy:** TC-U-01, TC-U-05, TC-I-05, TC-I-06, TC-I-08, TC-I-13, TC-E2E-01, TC-E2E-02, TC-E2E-03 = **9 happy**
**Non-happy (infra+edge+idempotency+business+security):** all others = **26 non-happy**

Ratio = **9 : 26 ≈ 1:2.9** — comfortably exceeds the 1:1 threshold required by sdd.md.

## Design

### Architecture Decisions

#### 1. Dockerfiles (TASK-DOCKERFILE-SERVER, TASK-DOCKERFILE-IDP)

**`apps/server/Dockerfile`** — 2-stage, replica pattern de [Dockerfile](../Dockerfile):

- **Stage `builder`**: `node:22-slim`. Instala toolchain nativo PRIMEIRO (`apt-get install -y python3 make g++ --no-install-recommends`) — necessário pro `bcrypt` rebuild. Copia `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (workspace-aware install com `--filter @tokenfx/server...` + dependencies das libs). `pnpm install --frozen-lockfile`. `pnpm rebuild bcrypt` (explicit). Copia o resto. `pnpm --filter @tokenfx/server build`. **Compila migrate**: `pnpm exec tsc lib/db/migrate.ts --module commonjs --target es2022 --outDir dist --esModuleInterop` → emite `dist/migrate.js` standalone (sem tsx em runtime).
- **Stage `runner`**: `node:22-slim`. Cria user `tokenfx-server` (UID 1001) — non-root (security best practice). Copia `.next/standalone`, `.next/static`, `public/`, `lib/db/migrations/`, `dist/migrate.js`, `package.json`. ENTRYPOINT: `sh -c "node dist/migrate.js && node server.js"`. Migrate falha-fast se Postgres não disponível.
- **ENV runtime**: `DATABASE_URL`, `AUTH_SECRET`, `OKTA_*`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INTERNAL_CRON_SECRET`, `TOKENFX_APP_RUNTIME_ROLE`, `NODE_ENV=development`, `E2E_AUTH_BYPASS=1`, `ONBOARDING_EMAIL_HASH_PEPPER`, `NEXTAUTH_URL`.
- **Healthcheck**: node oneliner contra `/api/health`.

**`apps/idp-stub/Dockerfile`** — single-stage simples:

- `node:22-slim`. Cria user `idp-stub` (UID 1001) non-root.
- `pnpm install --frozen-lockfile --filter @tokenfx/idp-stub...` (inclui deps das workspaces).
- ENV: `NODE_ENV=development` (refuse production via boot guard), `IDP_STUB_HOSTNAME=0.0.0.0` (override loopback bind pra Docker DNS), `IDP_STUB_PORT=3001`, `IDP_STUB_BASE_URL=http://tokenfx-idp-stub:3001`.
- **REQUIRES SOURCE CHANGE em `apps/idp-stub/src/index.ts`:** `serve({ hostname: process.env.IDP_STUB_HOSTNAME ?? '127.0.0.1', ... })`. Default mantém loopback (preserva security em uso fora-container); container override via env. **Esta mudança é parte do TASK-DOCKERFILE-IDP.**
- Healthcheck: node oneliner contra `/.well-known/openid-configuration`.
- CMD: `pnpm start` (= `tsx src/index.ts`).

#### 2. docker-compose.yaml extensão (TASK-COMPOSE)

Modificações ao `docker-compose.yaml` existente:

**(a) Adicionar a service `app` (root tokenfx) — `networks:` stanza:**

```yaml
services:
  app:
    # ... existing config preserved ...
    networks:
      - default
      - smoke-net
```

**(b) Adicionar 3 novos services com `profiles: ["smoke"]`:**

```yaml
  postgres-smoke:
    image: postgres:16-alpine
    container_name: tokenfx-postgres-smoke
    profiles: ["smoke"]
    environment:
      POSTGRES_USER: tokenfx
      POSTGRES_PASSWORD: smoke-pg-password
      POSTGRES_DB: tokenfx_smoke
    volumes:
      - tokenfx-pg-smoke-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "tokenfx", "-d", "tokenfx_smoke"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks:
      - smoke-net

  tokenfx-idp-stub:
    build:
      context: ./apps/idp-stub
      dockerfile: Dockerfile
    image: tokenfx-idp-stub:local
    container_name: tokenfx-idp-stub
    profiles: ["smoke"]
    ports:
      - "127.0.0.1:3001:3001"     # bind host loopback only — published port not routable from LAN
    environment:
      NODE_ENV: development
      IDP_STUB_HOSTNAME: 0.0.0.0   # override loopback bind for Docker DNS reachability
      IDP_STUB_PORT: "3001"
      IDP_STUB_BASE_URL: http://tokenfx-idp-stub:3001
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - |
          require('http').get('http://localhost:3001/.well-known/openid-configuration', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))
      interval: 10s
      timeout: 5s
      start_period: 15s
    networks:
      - smoke-net

  tokenfx-server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    image: tokenfx-server:local
    container_name: tokenfx-server
    profiles: ["smoke"]
    depends_on:
      postgres-smoke: { condition: service_healthy }
      tokenfx-idp-stub: { condition: service_healthy }
    ports:
      - "127.0.0.1:3232:3232"     # host loopback only
    environment:
      NODE_ENV: development
      DATABASE_URL: postgres://tokenfx:smoke-pg-password@postgres-smoke:5432/tokenfx_smoke
      AUTH_SECRET: smoke-dev-secret-do-not-use-in-prod-0123456789abcdef
      OKTA_ISSUER: http://tokenfx-idp-stub:3001
      OKTA_CLIENT_ID: smoke-okta-client-id
      OKTA_CLIENT_SECRET: smoke-okta-client-secret-stub
      GOOGLE_CLIENT_ID: smoke-google-client-id
      GOOGLE_CLIENT_SECRET: smoke-google-client-secret-stub
      NEXTAUTH_URL: http://localhost:3232
      INTERNAL_CRON_SECRET: smoke-cron-secret
      TOKENFX_APP_RUNTIME_ROLE: tokenfx
      E2E_AUTH_BYPASS: "1"
      ONBOARDING_EMAIL_HASH_PEPPER: smoke-email-hash-pepper
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - |
          require('http').get('http://localhost:3232/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))
      interval: 30s
      timeout: 5s
      start_period: 45s
    networks:
      - smoke-net

volumes:
  tokenfx-data:
  tokenfx-pg-smoke-data:

networks:
  default:
  smoke-net:
    driver: bridge
```

**OIDC issuer mismatch:** `NEXTAUTH_URL=http://localhost:3232` (host-facing) vs `OKTA_ISSUER=http://tokenfx-idp-stub:3001` (Docker DNS) — NextAuth pode rejeitar tokens com `iss` differing. Runbook §troubleshooting documenta isso. Workaround se necessário: configurar NextAuth com `trustHost: true` ou custom issuer validation.

#### 3. Reset scripts (TASK-RESET-ROOT, TASK-RESET-SERVER)

**`scripts/smoke-reset.ts`** — entry host:

```ts
// Pseudo-code shape
import type { ExecaChildProcess } from 'execa';
type Executor = (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;

export const smokeReset = async (opts?: { executor?: Executor }): Promise<Result<void, Error>> => {
  const exec = opts?.executor ?? defaultExeca;
  // 1. SQLite root
  for (const f of ['data/dashboard.db', 'data/dashboard.db-wal', 'data/dashboard.db-shm']) {
    if (existsSync(f)) unlinkSync(f);
  }
  // 2. Server reset via docker exec — DI seam for testing
  const serverReset = await exec('docker', ['compose', '--profile', 'smoke', 'exec', '-T',
    'tokenfx-server', 'node', 'dist/scripts/smoke-reset.js']);
  if (serverReset.exitCode !== 0) {
    return { ok: false, error: new Error(`server reset failed: ${serverReset.stdout}`) };
  }
  // 3. idp-stub scenario reset
  const stubReset = await fetch('http://localhost:3001/admin/scenario/reset',
    { method: 'POST', headers: { origin: 'http://localhost' } });
  if (!stubReset.ok) {
    return { ok: false, error: new Error(`idp-stub reset HTTP ${stubReset.status}`) };
  }
  return { ok: true, value: undefined };
};
```

**Unit tests (TC-U-01..04)** injetam hand-written `executor` stub para exercitar todos os branches (happy SQLite, SQLite-absent, docker-exec-fail, idp-stub-fail) sem dependência real de Docker.

**`apps/server/scripts/smoke-reset.ts`** — runs INSIDE container:
- Pool connect via `DATABASE_URL`.
- TRUNCATE deterministic table list with RESTART IDENTITY CASCADE.
- Re-roda migrate (idempotent via `IF NOT EXISTS`).
- Compilado via tsc para `dist/scripts/smoke-reset.js` no Dockerfile builder stage.

#### 4. Seed scripts (TASK-SEED-ROOT, TASK-SEED-SERVER)

**`scripts/smoke-seed.ts`** (root):
- Direct SQLite inserts (bypass parser para controle exato).
- IDs `seed-smoke-1`, `seed-smoke-2`, `seed-smoke-3`.
- Costs `10.00`, `15.00`, `17.50` → SUM = **42.50** USD.
- Turn counts `5, 8, 12`. Tool call counts `10, 15, 25`.
- session-2 com `total_cost_usd_otel=0.40` (calibration path); outras sem.
- Header comment documenta `// SEED VALUES (assert in runbook):` com os números.

**Re: parser vs direct insert trade-off:** seed direto é intencional (controle exato). **REQ-8 / TC-I-12 testa o parser separadamente** usando `tests/fixtures/ingest-idempotency/*.jsonl` (criar ou reusar fixture existente — verificar `tests/fixtures/`).

**`apps/server/scripts/smoke-seed.ts`** (server):
- Conecta via `DATABASE_URL`.
- 1 org `Smoke Co` (UUID fixed).
- 2 users: `smoke-user-1@example.com` role=`manager`, `smoke-user-2@example.com` role=`member`.
- 1 machine pro user-1 com `machineId=00000000-0000-4000-8000-00000000aaaa`, `keyId=key-smoke-001`.
- Bcrypt-hash do bearer secret. Plaintext secret gerado via `crypto.randomBytes(32).toString('hex')`.
- **`project_secret`** gerado via `crypto.randomBytes(32).toString('hex')` (mirror `reporter-config-init.ts`).
- 1 invite ativo email_pattern `smoke-user-3@example.com`.
- Cria role `tokenfx` se não existe: `CREATE ROLE IF NOT EXISTS tokenfx WITH LOGIN PASSWORD 'smoke-pg-password';` (em transação separada do data seed).
- **Escreve `.env.smoke`** (host-side) com:
  ```
  REPORTER_BEARER_SECRET=<plaintext>
  REPORTER_PROJECT_SECRET=<hex>
  REPORTER_KEY_ID=key-smoke-001
  REPORTER_TARGET_URL=http://localhost:3232/api/ingest
  ```

#### 5. Reporter cross-stack integration (TASK-REPORTER-INTEGRATION-TEST)

**`tests/integration/cross-stack-reporter.test.ts`** (root):
- `skipDescribe` gated por `RUN_CROSS_STACK_SMOKE=1`.
- `beforeAll`:
  - Spin Postgres via `@testcontainers/postgresql` (add to root devDeps).
  - Run `apps/server` migrate against PG.
  - Spawn idp-stub via `execa('pnpm', ['--filter', '@tokenfx/idp-stub', 'start'], { env: {...IDP_STUB_PORT:'0'} })` (random port). Await healthcheck endpoint with 30s timeout. **Razão**: in-process ESM/CJS interop frágil; child_process é robusto e isolated.
- `beforeEach`: POST `/admin/scenario/reset` no idp-stub (closes shared-state risk).
- `afterAll`: teardown PG + kill idp-stub child + cleanup port.
- Tests TC-I-13/14/15/16/17 cover the matrix.
- **Adicionar `@tokenfx/idp-stub` em root `package.json` devDependencies como `"workspace:*"`** pra workspace-relative spawn funcionar.

#### 6. Runbook (TASK-RUNBOOK)

`docs/smoke-runbook.md` — markdown estruturado (ver shape no spec original; resumindo os passos):

1. Preconditions: Docker, pnpm 9+, Node 22+, no port conflicts.
2. `pnpm install`.
3. `docker compose --profile smoke build`.
4. `docker compose --profile smoke up -d`, wait healthy.
5. `pnpm smoke:reset`.
6. `pnpm smoke:seed` (gera `.env.smoke`).
7. Re-ingest idempotency: `pnpm ingest && pnpm ingest`, verify count.
8. Reporter push: `source .env.smoke && pnpm reporter:once`, verify `sessions_agg`.
9. Re-push idempotency: verify `pushed=0`.
10. Root dashboard validation (curl/manual).
11. Server dashboard validation (curl/manual).
12. SSO live (optional): via Playwright OR manual browser flow.
13. Tear down: `docker compose --profile smoke down`.
14. `#test-gaps-found` section: populate with findings or "no gaps found".
15. Troubleshooting section: common issues (port conflict, OIDC issuer mismatch, bcrypt rebuild failure, etc).

**NOTA**: Step 12 SSO usa Playwright `smoke` project (não `docker compose exec curl` — slim image sem curl). Manual browser flow é fallback.

#### 7. Playwright smoke project (TASK-PLAYWRIGHT-SMOKE-PROJECT)

`playwright.config.ts` extendido com second project `smoke`:
- baseURL: `http://localhost:3131` (root) — testes do root usam-no.
- testDir: `./tests/e2e` mas com `grep: /@smoke/` tag.
- Sem `webServer` (assume stack docker já up via runbook).

`tests/e2e/review-fixes-smoke.spec.ts` (existente) — ativar os TCs DEFERRED (TC-E2E-01/02/04/05 — renumber para alinhar com este spec). Os 5 TCs aqui (TC-E2E-01..05) movem pra spec atual.

### Files to Create

- `apps/server/Dockerfile`, `apps/server/.dockerignore`
- `apps/idp-stub/Dockerfile`, `apps/idp-stub/.dockerignore`
- `scripts/smoke-reset.ts`, `scripts/smoke-reset.test.ts`
- `scripts/smoke-seed.ts`, `scripts/smoke-seed.test.ts`
- `apps/server/scripts/smoke-reset.ts`, `apps/server/scripts/smoke-reset.test.ts`
- `apps/server/scripts/smoke-seed.ts`, `apps/server/scripts/smoke-seed.test.ts`
- `tests/integration/cross-stack-reporter.test.ts`
- `tests/integration/ingest-idempotency.test.ts` (or extend existing)
- `tests/fixtures/ingest-idempotency/*.jsonl` (if not exists)
- `docs/smoke-runbook.md`
- `.env.smoke.example`

### Files to Modify

- `apps/idp-stub/src/index.ts` (read `IDP_STUB_HOSTNAME` env)
- `docker-compose.yaml` (add 3 services + smoke-net + smoke-net stanza on `app`)
- `package.json` (root: `smoke:reset`, `smoke:seed`, `smoke:up`, `smoke:down` scripts + `@tokenfx/idp-stub` workspace dep + `@testcontainers/postgresql` devDep)
- `apps/server/package.json` (smoke scripts)
- `playwright.config.ts` (smoke project)
- `tests/e2e/review-fixes-smoke.spec.ts` (renumber TCs + activate)
- `.gitignore` (`.env.smoke`)

### Dependencies

- `@testcontainers/postgresql` — adicionar a root `devDependencies` (já está em `apps/server/devDependencies`).
- `@tokenfx/idp-stub` — adicionar a root `devDependencies` como `"workspace:*"`.
- `execa` — provavelmente já existe; verificar.

## Tasks

- [x] **TASK-DOCKERFILE-SERVER**: Criar `apps/server/Dockerfile` 2-stage com toolchain nativo + tsc compile do migrate + non-root user.
  - files: `apps/server/Dockerfile`, `apps/server/.dockerignore`
  - tests: TC-I-01

- [x] **TASK-DOCKERFILE-IDP**: Criar `apps/idp-stub/Dockerfile` + modificar `apps/idp-stub/src/index.ts` pra ler `IDP_STUB_HOSTNAME` env.
  - files: `apps/idp-stub/Dockerfile`, `apps/idp-stub/.dockerignore`, `apps/idp-stub/src/index.ts`
  - tests: TC-I-02, TC-I-06

- [x] **TASK-COMPOSE**: Estender `docker-compose.yaml` (3 services + network + adicionar smoke-net ao `app`).
  - files: `docker-compose.yaml`
  - depends: TASK-DOCKERFILE-SERVER, TASK-DOCKERFILE-IDP
  - tests: TC-I-03, TC-I-04, TC-I-05, TC-I-07

- [x] **TASK-RESET-ROOT**: `scripts/smoke-reset.ts` com DI executor + tests.
  - files: `scripts/smoke-reset.ts`, `scripts/smoke-reset.test.ts`
  - tests: TC-U-01..04

- [x] **TASK-RESET-SERVER**: `apps/server/scripts/smoke-reset.ts` + test contra PG testcontainer.
  - files: `apps/server/scripts/smoke-reset.ts`, `apps/server/scripts/smoke-reset.test.ts`
  - tests: TC-I-08, TC-I-09

- [x] **TASK-SEED-ROOT**: `scripts/smoke-seed.ts` + test.
  - files: `scripts/smoke-seed.ts`, `scripts/smoke-seed.test.ts`
  - tests: TC-U-05, TC-U-06, TC-U-07

- [x] **TASK-SEED-SERVER**: `apps/server/scripts/smoke-seed.ts` com `project_secret` gen + .env.smoke write.
  - files: `apps/server/scripts/smoke-seed.ts`, `apps/server/scripts/smoke-seed.test.ts`
  - tests: TC-U-08, TC-I-10, TC-I-11

- [x] **TASK-PACKAGE-SCRIPTS**: `smoke:*` scripts + workspace deps + `@testcontainers/postgresql` em root.
  - files: `package.json`, `apps/server/package.json`
  - depends: TASK-RESET-ROOT, TASK-RESET-SERVER, TASK-SEED-ROOT, TASK-SEED-SERVER

- [x] **TASK-REINGEST-IDEMPOTENCY-TEST**: Test prova `pnpm ingest` 2× idempotent + fixture JSONL.
  - files: `tests/integration/ingest-idempotency.test.ts`, `tests/fixtures/ingest-idempotency/*.jsonl`
  - tests: TC-I-12

- [x] **TASK-REPORTER-INTEGRATION-TEST**: `cross-stack-reporter.test.ts` com testcontainers PG + child-process idp-stub + scenario reset per-test.
  - files: `tests/integration/cross-stack-reporter.test.ts`
  - depends: TASK-SEED-SERVER, TASK-SEED-ROOT (imports their helpers + `.env.smoke` pattern)
  - tests: TC-U-09, TC-I-13..20

- [x] **TASK-RUNBOOK**: Criar `docs/smoke-runbook.md` com troubleshooting + `#test-gaps-found` placeholder.
  - files: `docs/smoke-runbook.md`
  - tests: TC-U-10 (parcial — completude verificada post-execution)

- [x] **TASK-ENV-EXAMPLE**: `.env.smoke.example` + `.gitignore` update.
  - files: `.env.smoke.example`, `.gitignore`

- [x] **TASK-PLAYWRIGHT-SMOKE-PROJECT**: `smoke` project no `playwright.config.ts` + ativar TC-E2E-01..05 em `review-fixes-smoke.spec.ts`.
  - files: `playwright.config.ts`, `tests/e2e/review-fixes-smoke.spec.ts`
  - tests: TC-E2E-01..05

- [x] **TASK-SMOKE-EXECUTION** (manual + human-in-the-loop): execução do runbook + população de `#test-gaps-found`. Excluído do pipeline automatizado de validação SDD.
  - files: `docs/smoke-runbook.md` (append-only)
  - depends: TASK-COMPOSE, TASK-PACKAGE-SCRIPTS, TASK-PLAYWRIGHT-SMOKE-PROJECT, TASK-RUNBOOK, TASK-ENV-EXAMPLE
  - tests: TC-E2E-01..05 (live), TC-U-10 (final assertion)

- [x] **TASK-AUDIT-FIX** (human-in-the-loop): per-gap, trivial fix in-spec OR file follow-up.
  - depends: TASK-SMOKE-EXECUTION
  - tests: REQ-14 satisfied

## Parallel Batches

**Análise:** dependências mapeadas. TASK-DOCKERFILE-SERVER e TASK-DOCKERFILE-IDP independentes. TASK-COMPOSE precisa dos 2 Dockerfiles. TASK-RESET-ROOT independente. TASK-RESET-SERVER independente. TASK-SEED-ROOT independente. TASK-SEED-SERVER independente. TASK-PACKAGE-SCRIPTS precisa dos 4 scripts. TASK-REINGEST-IDEMPOTENCY-TEST independente. TASK-REPORTER-INTEGRATION-TEST precisa de TASK-SEED-SERVER + TASK-SEED-ROOT (imports helpers). TASK-RUNBOOK, TASK-ENV-EXAMPLE, TASK-PLAYWRIGHT-SMOKE-PROJECT independentes. TASK-SMOKE-EXECUTION + TASK-AUDIT-FIX são human-in-the-loop, manual.

**Batch 1** (paralelo — 10 tasks de infra+scripts+runbook):
TASK-DOCKERFILE-SERVER, TASK-DOCKERFILE-IDP, TASK-RESET-ROOT, TASK-RESET-SERVER, TASK-SEED-ROOT, TASK-SEED-SERVER, TASK-REINGEST-IDEMPOTENCY-TEST, TASK-RUNBOOK, TASK-ENV-EXAMPLE, TASK-PLAYWRIGHT-SMOKE-PROJECT.

**Batch 2** (paralelo — 2 tasks depend Batch 1):
TASK-COMPOSE, TASK-PACKAGE-SCRIPTS.

**Batch 3** (sequencial — depends seeds):
TASK-REPORTER-INTEGRATION-TEST.

**Batch 4** (human-in-the-loop, manual):
TASK-SMOKE-EXECUTION.

**Batch 5** (human-in-the-loop, manual):
TASK-AUDIT-FIX.

## Validation Criteria

- [ ] `pnpm typecheck` clean (root + apps/server + apps/idp-stub)
- [ ] `pnpm lint` clean
- [ ] `pnpm test --run` passes (incl. cross-stack reporter test gated por env)
- [ ] `pnpm build` clean
- [ ] `docker compose --profile smoke build` succeeds (TC-I-01, TC-I-02)
- [ ] `docker compose --profile smoke up -d` → 4 services HEALTHY em ≤90s (TC-I-03)
- [ ] Runbook execução manual completa, checklist 100%
- [ ] Playwright `smoke` project passes (TC-E2E-01..05)
- [ ] `docs/smoke-runbook.md#test-gaps-found` populated (não placeholder)
- [ ] `pnpm exec sqlite3 data/dashboard.db "SELECT SUM(total_cost_usd) FROM sessions;"` returns **`42.50`** post-seed
- [ ] `docker compose --profile smoke exec postgres-smoke psql -U tokenfx -d tokenfx_smoke -c "SELECT SUM(total_cost_usd) FROM sessions_agg;"` returns **`42.50`** post-reporter-push (cross-stack proof)
- [ ] Ratio happy : non-happy TCs = **1 : 2.9** ≥ 1:1 (sdd.md rigor rule)

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
