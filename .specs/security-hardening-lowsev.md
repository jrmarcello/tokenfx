# Spec: security-hardening-lowsev

## Status: DONE

## Context

Item 3.4 de `docs/execution-plan-2026-07.md` — os 4 achados MED/LOW do security review de 2026-07-11 (nenhum CRITICAL/HIGH). Verificados no código em 2026-07-12; a rodada de self-review descobriu blast-radius adicional (registrado abaixo).

1. **Invite tokens em plaintext at rest (MEDIUM).** `onboarding_invites.token` é o PK e guarda o token 64-hex em claro (`apps/server/lib/db/schema.ts:250`); lookup por igualdade em `apps/server/lib/queries/redeem.ts:209` (`WHERE token = ${token}`). O token É a credencial bearer do `/api/onboarding/redeem-invite` — um vazamento read-only do DB (backup, dump de log) expõe todo convite não-redimido em forma diretamente utilizável. Contraste: secrets de reporter são bcrypt-hasheados. Mitigadores existentes: entropia 256-bit, `expires_at`, `max_uses`, `email_pattern` — defense-in-depth gap, não bypass ativo.
2. **`/api/manager/*` fora do gate de auth (LOW).** `apps/server/middleware.ts:63-68` — `matcher: ['/manager/:path*', '/me/:path*']` não cobre `/api/manager/*`. **E mais fundo:** `apps/server/lib/auth/auth.config.ts:153` — o callback `authorized()` faz `if (!path.startsWith('/manager')) return true`, então `/api/manager/*` (começa com `/api`) é liberado incondicionalmente mesmo se roteado pelo middleware. Em `AUTH_REQUIRED=false`, `auth()` retorna sessão admin sintética para qualquer caller. Só `/api/manager/dismiss-anomaly` está protegido — pelo seu próprio check de org, não pelo gate central. Drive-by via DNS rebinding pode disparar o write (impacto: suprimir card de anomalia); qualquer rota `/api/manager/*` futura sem check próprio nasce desprotegida.
3. **Docstring enganosa em `/api/ingest` (LOW, doc).** `apps/server/app/api/ingest/route.ts:12-19` descreve cache de plaintext + skip de bcrypt que NÃO existe mais (pós-REQ-23 o código roda `bcrypt.compare` em toda chamada e cacheia só `{secretHash, expiresAt}` — ver `apps/server/lib/auth/bearer-auth.ts:16-29`).
4. **`central_url` do reporter aceita `http://` (LOW).** `lib/reporter/config.ts:24` — `z.string().url()`. O `Authorization: Bearer <secret>` viaja em claro se apontado para host não-loopback via `http://`. Cópia duplicada da mesma validação em `scripts/reporter-config-init.ts:35-44`.

**Blast-radius do hash (descoberto no self-review — consumidores de `left(token,8)`/`.token.slice(0,8)`):**

- `apps/server/lib/queries/manager-alerts.ts:138,228` — `loadFirstAutoProvisionAlert` e `acknowledgeAlert` fazem JOIN `onboarding_redemption_log.token_prefix = LEFT(onboarding_invites.token, 8)`. Pós-hash, `LEFT(token,8)` é o prefixo do HASH e nunca casa com o `token_prefix` (derivado do plaintext no redeem) — o banner "auto-onboarded via SSO" silenciosamente zera e o ack nunca insere. **Precisa migrar o JOIN para a coluna física `token_prefix`.**
- `apps/server/lib/auth/sso-auto-provision.ts` (`:295` re-select FOR UPDATE, `:364`, `:642`, `:649`, `:659`) + `apps/server/lib/auth/match-active-invites.ts` (tipo `ActiveInvite` + select) — 5+ pontos derivam prefixo via `.token.slice(0,8)`. Pós-hash gravam prefixo do hash no audit trail, contradizendo o Threat Model §6. **Precisa expor `token_prefix` no select/tipo e trocar os `.slice`.**
- `apps/server/lib/auth/revalidate-invite.ts` — carrega `.token` no tipo mas o predicado não lê; hash serve (verificado, sem mudança).

**Decisões já travadas:**

- **Hash de invite = SHA-256 simples** (não bcrypt), por DOIS motivos: (1) o token tem 256 bits de entropia crypto-random — bcrypt (slow-hash) defende segredos de baixa entropia contra brute-force offline, o que não se aplica aqui; (2) **requisito estrutural**: o lookup é `WHERE token = ?` (igualdade indexada por PK) — bcrypt tem salt por chamada, tornando lookup por igualdade impossível (exigiria full-scan `bcrypt.compare` em toda chamada pública de redeem). Fast deterministic hash é requisito, não preferência de latência. Precedente de doc-comment: `apps/server/lib/auth/email-hash.ts:4-8` e `bearer-auth.ts:16-24`.
- **Rename `token` → `token_hash`** (não manter o nome): o repo já tem a convenção `_hash` (`user_machines.secret_hash`) para "coluna guarda hash de credencial, não a credencial". Manter `token` enquanto guarda hash perpetua exatamente a confusão que esta spec elimina. `ALTER TABLE ... RENAME COLUMN` é metadata-only e preserva o PRIMARY KEY; nenhum FK referencia `onboarding_invites(token)` (grep: zero). Nova coluna `token_prefix` (8 chars do plaintext) para correlação em UI/audit.
- **Migração `0007_invite_token_hash.sql` (SQL puro — pgcrypto, sem hedge de JS):** pgcrypto já está habilitado desde `0000_init.sql:5` (`CREATE EXTENSION IF NOT EXISTS pgcrypto`, usado em `gen_random_uuid()`). O runner (`apps/server/lib/db/migrate.ts`) só executa `.sql` via `drizzle-orm/node-postgres/migrator` — não há hook de JS por linha. Sequência:
  1. `ALTER TABLE onboarding_invites ADD COLUMN token_prefix text;` (nullable — Postgres não permite NOT NULL sem default em tabela não-vazia)
  2. `ALTER TABLE onboarding_invites RENAME COLUMN token TO token_hash;`
  3. **Backfill + hash gateado (idempotente via `token_prefix IS NULL` — único sinal que só existe pré-migração; o formato hash 64-hex é indistinguível de plaintext, então guard por conteúdo é impossível):** `UPDATE onboarding_invites SET token_prefix = left(token_hash, 8), token_hash = encode(digest(token_hash, 'sha256'), 'hex') WHERE token_prefix IS NULL;`
  4. `ALTER TABLE onboarding_invites ALTER COLUMN token_prefix SET NOT NULL;`
  5. `DROP INDEX IF EXISTS idx_onboarding_invites_prefix;` + `CREATE INDEX idx_onboarding_invites_prefix ON onboarding_invites (token_prefix);`
- **Entrada obrigatória no journal:** `apps/server/lib/db/migrations/meta/_journal.json` ganha `{"idx":7,"version":"7","when":<epoch-ms>,"tag":"0007_invite_token_hash","breakpoints":true}`. **Sem isso o runner de produção ignora o `.sql`** — bug que já shipou 2× neste repo (0003 em `fix-e2e-auth-bypass.md:325`; 0004+0005 em `sso-e2e-live-execution.md:602`). O `setup-pg.ts` de teste tem orphan-apply que MASCARA o gap — por isso é obrigatório um TC que verifique o journal, não só os testes.
- **Fix do REQ-3 vai em `auth.config.ts`, não só no middleware:** estender só o matcher é no-op (o `authorized()` libera `/api/*`). Novo branch no `authorized()` cobrindo `/api/manager`, seguindo o padrão existente de retornar `NextResponse` direto (`auth.config.ts:159-164`): sem sessão → `401 {error:{message,code}}`; role ≠ manager/admin → `403 {error:{...}}`; senão `true`. O matcher do middleware TAMBÉM é estendido para `/api/manager/:path*` (roteia a request pro gate). O guard localhost-mode (`localhostMiddleware`, path-agnóstico, já retorna 403) passa a valer para `/api/manager/*` só pela extensão do matcher — MAS o shape do erro dele hoje é `{error:'forbidden',...}` (string), fora do padrão `{error:{message,code}}` de `security.md`; **corrigir junto**.
- **`central_url`:** `.refine()` com `isLoopbackHost(hostname)` local — parse via `new URL(url).hostname`, comparação EXATA contra Set `{localhost, 127.0.0.1, ::1}` (mesma semântica de `apps/server/lib/auth/auth-required.ts:57-82 isLocalhostHost`, que existe justamente para derrotar `localhost.evil.com`; reuso direto inviável — `lib/reporter/` é pacote raiz separado de `apps/server`, extração de `packages/shared` é Fase 4). Exigir `https:` a menos que loopback. **Aplicar nas DUAS cópias** (`lib/reporter/config.ts` + `scripts/reporter-config-init.ts`) — idealmente extraindo um helper compartilhado.
- Plaintext aparece exatamente uma vez: retorno de `createInviteRow` (contrato atual, `invites.ts:82`). Após o fix, nem o DB tem plaintext.

## Requirements

- [x] REQ-1: GIVEN um invite criado, WHEN qualquer leitor inspeciona `onboarding_invites`, THEN a coluna `token_hash` contém apenas `sha256(plaintext)` e `token_prefix` os 8 primeiros chars do plaintext; o plaintext é retornado exatamente uma vez (create). Invites pré-existentes são migrados in-place (rename + backfill de prefix + hash) e permanecem redimíveis pelo plaintext original. A migração é idempotente sob re-execução do SQL cru.
- [x] REQ-2: GIVEN o endpoint de redeem, WHEN o caller envia o plaintext, THEN o lookup por hash resolve e o fluxo é idêntico ao atual (401 uniforme byte-a-byte, rate-limit, transação); WHEN o caller envia o valor armazenado no DB (hash), THEN 401 — o dump do DB não é credencial.
- [x] REQ-3: GIVEN `/api/manager/*`, WHEN a request não tem sessão válida (modo SSO), THEN 401 JSON `{error:{message,code}}` (sem redirect); WHEN sessão válida com role member, THEN 403 JSON; WHEN sessão manager/admin, THEN passa ao handler; WHEN em `AUTH_REQUIRED=false` com Host não-loopback, THEN 403 JSON no shape padrão; WHEN localhost válido, THEN passa ao handler.
- [x] REQ-4: GIVEN `reporter-config.json` (em ambos os validadores — runtime e config-init), WHEN `central_url` usa `http://` com hostname não-loopback, THEN a validação Zod rejeita com mensagem clara; loopback http, https loopback e https não-loopback continuam válidos; sufixos enganosos (`localhost.evil.com`, `127.0.0.1.evil.com`, `[::1].evil.com`) são rejeitados.
- [x] REQ-5: GIVEN o header doc de `apps/server/app/api/ingest/route.ts`, THEN descreve o comportamento real do bearer-auth (bcrypt em toda chamada; cache só de `{secretHash, expiresAt}`; sem menção a cache/skip de plaintext).
- [x] REQ-6: GIVEN o audit trail pós-hash, WHEN um invite é redimido (manual ou SSO-auto) ou um alerta de auto-provision é exibido, THEN `token_prefix` gravado/exibido é `left(plaintext,8)` (não `left(hash,8)`), e o banner/ack de `manager-alerts.ts` continua correlacionando corretamente.

## Threat Model

1. **Trust boundary** — (1) DB Postgres at rest ↔ leitor de DB/backup (hash quebra "ler DB = ter credencial"); (2) rede pública ↔ redeem (inalterado); (3) browser ↔ `/api/manager/*` (gate fechado no `authorized()` + matcher); (4) máquina do dev ↔ servidor central (https obrigatório fora de loopback, nas duas cópias do validador).
2. **Identidade autenticada** — redeem: token no body É a credencial; `/api/manager/*`: sessão NextAuth (role manager/admin) validada no `authorized()` ANTES do handler, ou sessão sintética localhost gated por Host.
3. **Credenciais em jogo** — invite token (plaintext só na criação → URL → body; at rest só sha256). Reporter secret inalterado (bcrypt). Nenhum plaintext novo em log.
4. **Replay & idempotency** — redeem inalterado (`max_uses`/`used_count` + `expires_at` transacional `FOR UPDATE`). Migração idempotente por `token_prefix IS NULL`.
5. **Authorization scope** — `/api/manager/*` exige role manager/admin no gate central (defense-in-depth: `dismiss-anomaly` mantém check de org).
6. **PII / audit trail** — `token_prefix` (8 chars do PLAINTEXT) é o único identificador exibido/logado; hash completo não é PII; REQ-6 garante que os pontos de SSO-auto gravam o prefixo correto.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-07 | REQ-1 | happy | `hashInviteToken('a'.repeat(64))` (novo helper, `tokens.ts`) — IDs 07/08 evitam colisão com TC-U-01/02/03 já usados em `tokens.test.ts` | sha256 hex 64 chars, determinístico |
| TC-U-08 | REQ-1 | edge | `hashInviteToken` de dois tokens distintos | hashes distintos |
| TC-U-04 | REQ-4 | validation | `central_url` válidos (it.each): `https://central.corp`, `https://localhost:3232`, `http://localhost:3232`, `http://127.0.0.1:3232`, `http://[::1]:3232` | todos aceitos |
| TC-U-05 | REQ-4 | security | `http://central.corp`, `http://192.168.1.10:3232` | rejeitados, mensagem "https required for non-loopback" |
| TC-U-06 | REQ-4 | security | sufixos enganosos (it.each): `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://[::1].evil.com` | rejeitados (match exato, não substring) |
| TC-U-09 | REQ-4 | infra | `readConfig` paths de erro (arquivo ausente/JSON inválido/campo faltando) — primeira cobertura própria de `config.ts` | erros no shape esperado |

### Integration Tests — Postgres real (apps/server, testcontainers)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `createInviteRow` → SELECT direto | `token_hash = sha256(plaintext)` ≠ plaintext retornado; `token_prefix = left(plaintext,8)` |
| TC-I-02 | REQ-2 | happy | redeem com plaintext do create | 200 + secret provisionado |
| TC-I-03 | REQ-2 | security | redeem com o HASH (conteúdo da coluna) como token | 401 uniforme |
| TC-I-06 | REQ-1 | business | revoke por prefixo pós-migração | usa `token_prefix`; colisão de prefixo entre ativos → fail loudly (preservado) |
| TC-I-10 | REQ-6 | business | SSO auto-provision pós-hash | fluxo completa E `onboarding_redemption_log.token_prefix = left(plaintext,8)` (não do hash) |
| TC-I-10b | REQ-6 | business | `loadFirstAutoProvisionAlert` pós-migração com row pré-existente (prefix do plaintext) | banner retorna a row (JOIN por `token_prefix` correto) |
| TC-I-12 | REQ-2 | regression | re-rodar o TC de uniformidade 401 existente (`redeem-route.test.ts` TC-I-49) pós-lookup-por-hash | corpos byte-idênticos |

### Integration Tests — migração (scratch-schema, sem depender do orphan-apply do setup-pg)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-04 | REQ-1 | infra | Harness dedicado: segundo `pg.Client` num schema scratch → aplica 0000-0006 → INSERT invite plaintext → aplica 0007 → assert | `token_prefix=left(plaintext,8)`, `token_hash=sha256(plaintext)`, redimível pelo plaintext; drop schema no `afterAll` |
| TC-I-05 | REQ-1 | idempotency | mesmo harness: aplica o SQL cru de 0007 DUAS vezes | 2ª execução não altera `token_hash` (guard `token_prefix IS NULL`) |
| TC-I-13 | REQ-1 | infra | `meta/_journal.json` contém entrada `tag: '0007_invite_token_hash'` (verifica que o runner de PRODUÇÃO aplica, não só o orphan-apply de teste) | entrada presente |

### Integration Tests — auth gate (SEM Postgres; `authorized()` é Edge-safe, NÃO gate por SKIP_PG_TESTS)

Metodologia: chamar `authorized({request, auth})` / `middleware(req)` direto com `NextRequest` + stub de sessão hand-written (precedente: `auth.config.test.ts`, `dismiss-anomaly/route.test.ts`). "Passa ao handler" = `NextResponse.next()` sem 401/403, não a resposta downstream.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-07 | REQ-3 | security | SSO mode, `/api/manager/dismiss-anomaly` sem sessão | `authorized()` retorna 401 JSON `{error:{message,code}}` |
| TC-I-07b | REQ-3 | security | SSO mode, sessão role=member | 403 JSON |
| TC-I-07c | REQ-3 | happy | SSO mode, sessão manager/admin | passa (não short-circuita) |
| TC-I-08 | REQ-3 | security | localhost-mode, `Host: evil.com` | 403 JSON no shape `{error:{message,code}}` (assert do shape) |
| TC-I-09 | REQ-3 | happy | localhost-mode, Host localhost | passa |

### Manual / static-check

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-M-11 | REQ-5 | doc | docstring de `/api/ingest` | descreve `{secretHash, expiresAt}` cache + bcrypt sempre; grep no review confirma ausência de "skip bcrypt"/"plaintext cache" |

### E2E

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1/2 | happy | Onboarding fim-a-fim (`pnpm test:server:e2e`/smoke) com tokens hasheados | verde |

## Design

### Architecture Decisions

- **`apps/server/lib/auth/tokens.ts`** — `export const hashInviteToken = (token: string): string => createHash('sha256').update(token).digest('hex')` (node:crypto). Doc-comment no estilo de `email-hash.ts:4-8` explicando os dois motivos (entropia + lookup determinístico).
- **`apps/server/lib/db/schema.ts`** — renomear `token` → `tokenHash` (`text('token_hash').primaryKey()`), adicionar `tokenPrefix: text('token_prefix').notNull()`, trocar `prefixIdx` para `.on(t.tokenPrefix)`.
- **Migração `0007_invite_token_hash.sql`** (SQL puro, sequência de 5 passos da Context) + entrada em `meta/_journal.json`.
- **`invites.ts`** — create: `token_hash = hashInviteToken(plaintext)` + `token_prefix = plaintext.slice(0,8)`, retorna plaintext (única vez). Revoke: `WHERE token_prefix = ? AND org_id = ?` (fail-loud em colisão preservado).
- **`redeem.ts`** — `lookupInviteForUpdate(tx, hashInviteToken(input.token))`. 401 byte-idêntico preservado.
- **`manager-alerts.ts`** — JOIN `eq(onboardingRedemptionLog.tokenPrefix, onboardingInvites.tokenPrefix)` (drizzle e SQL cru `:228`), em vez de `LEFT(token,8)`.
- **`match-active-invites.ts`** — `ActiveInvite` ganha `tokenPrefix`; select projeta a coluna.
- **`sso-auto-provision.ts`** — re-select FOR UPDATE (`:295`) projeta `token_prefix`; os 5 `.token.slice(0,8)` (`:364,:642,:649,:659` + o re-lock) passam a usar `.tokenPrefix`.
- **`auth.config.ts`** — branch `/api/manager` em `authorized()` (401/403 JSON via `NextResponse`, padrão `:159-164`).
- **`middleware.ts`** — matcher `['/manager/:path*', '/me/:path*', '/api/manager/:path*']`; corrigir shape do erro de `localhostMiddleware` para `{error:{message:'forbidden',code:'localhost-only'}}`.
- **`app/api/ingest/route.ts`** — docstring do header com o texto verdadeiro de `bearer-auth.ts:16-29`.
- **`lib/reporter/config.ts` + `scripts/reporter-config-init.ts`** — helper compartilhado `assertCentralUrl` (ou schema comum) com `.refine()` + `isLoopbackHost`. Preferir extração de um único helper importado pelos dois.

### Files to Create

- `apps/server/lib/db/migrations/0007_invite_token_hash.sql`
- `apps/server/lib/auth/auth.config.test.ts` (estender se já existir; cobre TC-I-07..09)
- `lib/reporter/config.test.ts`

### Files to Modify

- `apps/server/lib/auth/tokens.ts` + `apps/server/lib/auth/tokens.test.ts`
- `apps/server/lib/db/schema.ts`
- `apps/server/lib/db/migrations/meta/_journal.json`
- `apps/server/lib/queries/invites.ts` + `invites.test.ts`
- `apps/server/lib/queries/redeem.ts` + `redeem.test.ts`
- `apps/server/lib/queries/manager-alerts.ts` + `manager-alerts-banner.test.ts`
- `apps/server/lib/auth/match-active-invites.ts`
- `apps/server/lib/auth/sso-auto-provision.ts`
- `apps/server/lib/auth/auth.config.ts`
- `apps/server/middleware.ts`
- `apps/server/app/api/ingest/route.ts`
- `lib/reporter/config.ts`
- `scripts/reporter-config-init.ts`
- `apps/server/README.md`

### Dependencies

Nenhuma nova (node:crypto, pgcrypto já habilitado).

## Tasks

- [x] TASK-1: `hashInviteToken` + schema (rename `token`→`token_hash`, add `token_prefix`, índice) + migração 0007 + journal (TDD nos TCs de migração via scratch-schema)
  - files: apps/server/lib/auth/tokens.ts, apps/server/lib/auth/tokens.test.ts, apps/server/lib/db/schema.ts, apps/server/lib/db/migrations/0007_invite_token_hash.sql, apps/server/lib/db/migrations/meta/_journal.json
  - tests: TC-U-07, TC-U-08, TC-I-04, TC-I-05, TC-I-13
- [x] TASK-2: invites.ts (create hash+prefix; revoke por token_prefix)
  - files: apps/server/lib/queries/invites.ts, apps/server/lib/queries/invites.test.ts
  - depends: TASK-1
  - tests: TC-I-01, TC-I-06
- [x] TASK-3: redeem por hash + consumidores de prefixo (manager-alerts, match-active-invites, sso-auto-provision) + regressão de uniformidade
  - files: apps/server/lib/queries/redeem.ts, apps/server/lib/queries/redeem.test.ts, apps/server/lib/queries/manager-alerts.ts, apps/server/lib/queries/manager-alerts-banner.test.ts, apps/server/lib/auth/match-active-invites.ts, apps/server/lib/auth/sso-auto-provision.ts
  - depends: TASK-1
  - tests: TC-I-02, TC-I-03, TC-I-10, TC-I-10b, TC-I-12
- [x] TASK-4: `/api/manager` gate no `authorized()` + matcher + shape do erro localhost
  - files: apps/server/lib/auth/auth.config.ts, apps/server/lib/auth/auth.config.test.ts, apps/server/middleware.ts
  - tests: TC-I-07, TC-I-07b, TC-I-07c, TC-I-08, TC-I-09
- [x] TASK-5: docstring `/api/ingest`
  - files: apps/server/app/api/ingest/route.ts
  - tests: TC-M-11
- [x] TASK-6: `central_url` https-unless-loopback nas duas cópias (helper compartilhado) + primeira cobertura de config.ts
  - files: lib/reporter/config.ts, lib/reporter/config.test.ts, scripts/reporter-config-init.ts
  - tests: TC-U-04, TC-U-05, TC-U-06, TC-U-09
- [x] TASK-7: README do server — hash-at-rest + nota de migração no runbook de revogação/onboarding
  - files: apps/server/README.md
  - depends: TASK-1, TASK-2
- [x] TASK-SMOKE: `pnpm test:server:e2e` (ou smoke docker) — onboarding fim-a-fim com tokens hasheados; se indisponível, `E2E: DEFERRED` + validação ao vivo via curl (create → redeem → push) documentada
  - files: (nenhum novo)
  - tests: TC-E2E-01
  - depends: TASK-2, TASK-3, TASK-4

## Parallel Batches

Nota: TASK-2 e TASK-3 dependem do rename de schema da TASK-1. Como worktrees partem do último commit, se TASK-1 não estiver commitado a Batch 2 executa inline no main tree (após merge da Batch 1). TASK-4/5/6 são independentes de TASK-1.

```text
Batch 1: [TASK-1, TASK-4, TASK-5, TASK-6]  — arquivos disjuntos, sem deps
Batch 2: [TASK-2, TASK-3]                  — dependem de TASK-1 (schema); executar inline pós-merge da Batch 1
Batch 3: [TASK-7]                          — depende de TASK-1/2
Batch 4: [TASK-SMOKE]
```

## Validation Criteria

- [ ] `pnpm typecheck` + `pnpm lint` (raiz) e `pnpm typecheck:server` + `pnpm lint:server` passam
- [ ] `pnpm test -- --run` (raiz) e `pnpm test:server` (Postgres real) passam
- [ ] **Live validation:** Postgres descartável → migração 0007 sobre fixture com invite plaintext → redeem com o plaintext original retorna 200; SELECT confirma ausência de plaintext (`token_hash` é sha256); `curl -H 'Host: evil.com'` em `/api/manager/dismiss-anomaly` (localhost-mode) → 403; sem sessão (SSO mode) → 401 JSON; role member → 403
- [ ] 401 do redeem permanece byte-idêntico (TC-I-12 verde)
- [ ] `meta/_journal.json` aplicado por `runMigrations()` real (TC-I-13), não só pelo orphan-apply de teste

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Execução (2026-07-12)
Batch 1 paralelo (worktrees): TASK-1 (hashInviteToken + schema rename token→token_hash + token_prefix + migração 0007 + journal + scratch-DB migration tests), TASK-4 (gate /api/manager no authorized() + matcher + extração de localhost-guard.ts + shape do erro), TASK-5 (docstring /api/ingest), TASK-6 (centralUrlSchema compartilhado https-unless-loopback nas 2 cópias). TASK-4 foi interrompida e re-executada. Batch 2 INLINE (dependia do rename da TASK-1): TASK-2 (invites create/revoke) + TASK-3 (redeem por hash, manager-alerts JOIN por token_prefix, match-active-invites + sso-auto-provision usando .tokenPrefix, +2 scripts de seed extras não previstos). Testes atualizados por subagente (13 arquivos + novos TCs); 3 arquivos extras com SQL cru corrigidos.

### Self-review (2026-07-12) — 3 revisores paralelos
Segurança: PASS — os 4 achados fechados, nenhum novo CRITICAL/HIGH/MEDIUM. Código: zero MUST FIX. Testes: 15 TCs reais e verdes contra Postgres real. SHOULD FIX aplicados: migração agora totalmente idempotente (ADD COLUMN IF NOT EXISTS + RENAME guardado por DO-block + CREATE INDEX IF NOT EXISTS) e TC-I-05 re-aplica o arquivo INTEIRO 2×; comentários stale `left(token,8)` corrigidos (6 sites + página + teste); TC de delegação SSO do buildRootMiddleware adicionado. Não aplicados (documentados): TC de read-fail do readConfig (comportamento de leitura de diretório é platform-dependent — não shipar teste frágil); fixtures do migrate-0004 com literal não-hash (cosmético); flaky pré-existente TC-I-35 do sso-auto-provision-flow — RESOLVIDO abaixo.

### Validação ao vivo (2026-07-12, Postgres migrado + server dev)
- DB armazena só sha256: `is_plaintext=f, is_hash=t` para o invite semeado.
- redeem com PLAINTEXT → **200** (lookup por hash resolve; `used_count=1` + 1 `user_machines` confirmam o round-trip).
- redeem com o valor HASH do dump → **401** ("invalid or expired invite") — dump do DB não é credencial.
- `POST /api/manager/dismiss-anomaly` sem sessão (SSO mode) → **401 JSON** `{error:{message,code}}` (não redirect).
- centralUrlSchema: http-não-loopback rejeitado, https ok, http-localhost ok, `localhost.evil.com` rejeitado, `[::1]` loopback ok.
Gates finais: root typecheck/lint/test 1246✓; server typecheck/lint/test 1435✓.

### TC-I-35 flake — investigação e hardening (2026-07-12)
Não reproduzido em 15 runs (5 da suíte de integração, 4 da suíte completa do server, 6 do combo exato do revisor). A lógica do teste é determinística sob READ COMMITTED: o revoke via segundo pool com COMMIT + `secondPool.end()` awaited acontece ANTES do orquestrador abrir sua tx, então o SELECT FOR UPDATE sempre vê o revoke → `rejected-race`. Ainda assim, para eliminar a dependência implícita de timing que o revisor apontou, adicionei uma **barreira de sincronização explícita**: após o revoke, um re-read na MESMA pool do `getDb()` (a que o `defaultProvisionInTx` usa) asserta `revoked_at IS NOT NULL` antes de dirigir o orquestrador. Sob READ COMMITTED, se essa conexão vê o revoke, a FOR UPDATE seguinte na mesma pool também vê — o resultado não pode mais virar `accepted-sso-auto`; se o revoke não estivesse visível, o teste falha alto na precondição em vez de flakear. 6 reruns do combo do revisor: verdes.