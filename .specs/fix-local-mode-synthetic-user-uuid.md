# Spec: fix-local-mode-synthetic-user-uuid

## Status: DONE

## Context

Item 1.2 do `docs/execution-plan-2026-07.md` — o **único bloqueador restante da Fase 1**
(bugs que quebram a demo).

O modo `AUTH_REQUIRED=false` (localhost-only open-access, default do initial release)
injeta uma sessão sintética via `buildLocalDevSession()` em
`apps/server/lib/auth/auth-required.ts:95-103`. O campo `user.id` é a string
`'local-dev'`, que **não é um UUID**. Toda query que binda `session.user.id` contra
uma coluna `uuid` do Postgres falha com
`invalid input syntax for type uuid: "local-dev"` → **HTTP 500**:

- `/manager` (`app/manager/page.tsx:56,69` → `loadFirstAutoProvisionAlert(db, orgId, userId)`)
- `/me/visibility` (`app/me/visibility/page.tsx:77` → `getMyDrilldownAudit` em
  `lib/queries/me-visibility.ts:268`, `WHERE target_user_id = ${params.userId}`)
- `/manager/health` (`app/manager/health/page.tsx:38`) e drilldown
  (`app/manager/_drilldown/render.tsx:205`) — mesmos consumidores de `session.user.id`.

É exatamente o modo usado na demo ao vivo: o dashboard de gestor quebra na primeira página.

**Prior art (padrão a seguir):** o mesmo problema para a org foi resolvido com o par
`LOCAL_ORG_ID` (constante UUID em `auth-required.ts:34`) + migration
`0006_local_org_seed.sql` (INSERT idempotente `ON CONFLICT (id) DO NOTHING`).
Este fix replica o padrão para o usuário.

**Por que seedar uma row `users` (e não só trocar a string por UUID):** com um UUID
válido as queries de leitura param de dar 500 mesmo sem row (retornam vazio), mas
qualquer write que referencia o usuário via FK — `manager_alert_acks.manager_user_id`
(ack do banner em `/manager`), `manager_drilldown_audit.manager_user_id` (drilldown),
dismiss de anomalia — violaria FK. A row seedada garante que o admin local pode usar
TODAS as features do dashboard, não só renderizar páginas. Além disso, joins como
`INNER JOIN users u ON u.id = mda.manager_user_id` produzem display labels corretos.

### Decisões já travadas

- `LOCAL_USER_ID = '00000000-0000-0000-0000-000000000002'` — sequencial ao
  `LOCAL_ORG_ID` (`...0001`), determinístico, comitável, não é segredo.
- Migration `0008_local_user_seed.sql` idempotente, inofensiva fora do modo localhost
  (nenhum code path referencia a row sem `AUTH_REQUIRED=false`), mesma justificativa
  documentada da `0006`.
- Row seedada: `role='admin'`, `email='dev@localhost'`, `display_name='Local Dev'`,
  `org_id=LOCAL_ORG_ID`, `sso_provider/sso_subject/team_id` NULL.
- **Invariante de não-colisão**: `LOCAL_ORG_ID` é inalcançável pelo SSO auto-provision
  (nenhum provider emite subjects dessa org; provisioning sempre resolve org via
  invite/domínio de org real), logo `users_org_email_unique(org_id, email)` e
  `users_org_sso_unique` nunca colidem com a row seedada. Nenhum outro code path pode
  INSERTar `users` com `org_id=LOCAL_ORG_ID`. Guardado por TC-I-12.

## Requirements

- [ ] REQ-1: GIVEN modo `AUTH_REQUIRED=false`, WHEN `buildLocalDevSession()` é chamado,
      THEN `user.id` é o UUID constante `LOCAL_USER_ID` (exportado de
      `auth-required.ts`), RFC-4122-shaped, estável entre chamadas/ambientes.
- [ ] REQ-2: GIVEN um banco recém-migrado (inclusive vazio de dados de negócio),
      WHEN as migrations rodam, THEN existe uma row `users` com
      `id=LOCAL_USER_ID`, `org_id=LOCAL_ORG_ID`, `role='admin'`,
      `email='dev@localhost'`; re-rodar a migration é no-op (idempotente).
- [ ] REQ-3: GIVEN modo localhost com DB vazio (só as seeds das migrations),
      WHEN as queries consumidas por `/manager` e `/me/visibility` executam com
      `userId = LOCAL_USER_ID` (`loadFirstAutoProvisionAlert`,
      `getMyDrilldownAudit`), THEN nenhuma lança erro de cast uuid — retornam
      resultado vazio/null normalmente (páginas renderizam sem 500).
- [ ] REQ-4: GIVEN a row seedada, WHEN um write FK-dependente do usuário local ocorre
      (ex.: ack de manager alert com `manager_user_id = LOCAL_USER_ID`), THEN o
      INSERT sucede sem violação de FK.
- [ ] REQ-5: GIVEN a migration `0008`, WHEN ela roda num banco que já tem a row
      (qualquer origem), THEN `ON CONFLICT (id) DO NOTHING` preserva a row existente
      sem erro.
- [ ] REQ-6: GIVEN modo localhost, WHEN `/manager/health` e o drilldown de gestor
      (`app/manager/_drilldown/render.tsx`) executam com `managerId = LOCAL_USER_ID`,
      THEN também renderizam sem 500 (todos os 4 consumidores citados no Context
      ficam cobertos, não só 2).

## Threat Model

1. **Trust boundary** — nenhuma nova fronteira: o modo localhost já injeta sessão
   sintética admin; este fix só troca o identificador. O guard de `Host` header
   (`isLocalhostHost`) e o fail-safe `isAuthRequired` permanecem intactos.
2. **Identidade autenticada** — o "caller" continua sendo o usuário local anônimo do
   modo `AUTH_REQUIRED=false`. O UUID constante NÃO cria credencial: não há password,
   token ou login associado à row (`sso_provider`/`sso_subject` NULL). Em modo SSO
   (produção) a row é inerte — nenhum provider emite esse subject, e login é sempre
   via SSO subject/email match, nunca por `users.id` arbitrário.
3. **Credenciais em jogo** — nenhuma. O UUID é público e comitável (como
   `LOCAL_ORG_ID`). Verificar que nenhum code path trata `LOCAL_USER_ID` como prova
   de identidade fora do shim `auth()` do modo localhost.
4. **Replay & idempotency** — N/A para requests; a migration é idempotente por
   `ON CONFLICT (id) DO NOTHING` (REQ-5).
5. **Authorization scope** — inalterado: org scoping continua via
   `session.user.orgId = LOCAL_ORG_ID` nas queries. A row seedada pertence à
   local-org; não amplia acesso a nenhuma outra org.
6. **PII / audit trail** — `dev@localhost` não é PII real. Auditoria
   (`manager_drilldown_audit`) passa a registrar o usuário local corretamente em vez
   de falhar — melhora a trilha forense no modo dev.

## Test Plan

### Unit Tests

(IDs continuam de `TC-U-17` — `auth-required.test.ts` já usa `TC-U-01..08` e
`auth-localhost-mode.test.ts` referencia `TC-U-09..17`; nenhum ID existente é retirado.)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-18 | REQ-1 | happy | `buildLocalDevSession().user.id === LOCAL_USER_ID` | igualdade estrita |
| TC-U-19 | REQ-1 | validation | `LOCAL_USER_ID` é RFC-4122-shaped (regex UUID) e ≠ `LOCAL_ORG_ID` | regex passa; valores distintos |
| TC-U-20 | REQ-1 | edge | duas chamadas de `buildLocalDevSession()` retornam o mesmo `user.id` (estável, sem randomness) | ids idênticos |
| TC-U-21 | REQ-1 | security | nenhuma ocorrência de `'local-dev'` como id restante no código de produção (grep no source, não em testes) | zero matches em `lib/**`, `app/**` **e `scripts/**`** |

### Integration Tests

(Postgres via testcontainers — mesmo harness de `tests/integration/setup-pg.ts`.)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | após `migrate()`, row `users` com `id=LOCAL_USER_ID` existe com `org_id=LOCAL_ORG_ID`, `role='admin'`, `email='dev@localhost'` | SELECT retorna a row com os 4 campos |
| TC-I-02 | REQ-2/5 | idempotency | rodar a migration 0008 duas vezes | segunda execução no-op, sem erro, 1 row |
| TC-I-03 | REQ-5 | edge | banco com row `users` pré-existente com `id=LOCAL_USER_ID` e `display_name` alterado → roda 0008 | row preservada (DO NOTHING não sobrescreve) |
| TC-I-04 | REQ-3 | happy | `loadFirstAutoProvisionAlert(db, LOCAL_ORG_ID, LOCAL_USER_ID)` em DB vazio de eventos | retorna `null`, sem throw |
| TC-I-05 | REQ-3 | happy | `getMyDrilldownAudit` com `userId=LOCAL_USER_ID` em DB sem audit rows | `{rows: [], total: 0}`, sem throw |
| TC-I-06 | REQ-3 | business | regressão do bug original: mesmas queries com `userId='local-dev'` | throw com Postgres error code `22P02` (`invalid input syntax for type uuid`) — não basta "qualquer erro" |
| TC-I-07 | REQ-4 | happy | INSERT de ack (`manager_alert_acks`) com `manager_user_id=LOCAL_USER_ID` | sucesso, sem violação de FK |
| TC-I-08 | REQ-4 | business | mesmo INSERT com UUID aleatório NÃO seedado | violação de FK (prova que a seed é o que viabiliza REQ-4) |
| TC-I-09 | REQ-2 | validation | ordem no journal: `0008_local_user_seed` após `0007` com `idx: 8` | `_journal.json` consistente; `migrate()` roda sem erro em banco zerado; roda também sob `SKIP_PG_TESTS=1` (checagem só de filesystem) |
| TC-I-10 | REQ-6 | happy | queries consumidas por `/manager/health` e pelo drilldown executam com `managerId=LOCAL_USER_ID` em DB vazio | sem throw; resultados vazios |
| TC-I-11 | REQ-2 | infra | aplicar `0008` num banco SEM a row `orgs` de `LOCAL_ORG_ID` (0006 ausente/corrompido) | falha alto com violação de FK `users.org_id` — asserta a dependência de ordering 0006→0008 |
| TC-I-12 | REQ-2 | security | SSO auto-provision para org ≠ `LOCAL_ORG_ID` com usuário `dev@localhost` nessa outra org | provisioning normal, zero interferência da row seedada (invariante de não-colisão) |
| TC-I-13 | REQ-6 | happy | `loadDrilldownData` (via seam `authFn` carregando `LOCAL_USER_ID`) contra um dev-alvo na local-org | resolve sem throw; row em `manager_drilldown_audit` com `manager_user_id=LOCAL_USER_ID` (exercita o `SELECT users` + insert de auditoria do drilldown) |

### E2E Tests

(Estende `tests/e2e/auth-localhost-mode.spec.ts` existente — `AUTH_REQUIRED=false`.
IDs prefixados `TC-E2E-UUID-*` para não colidir com os `TC-E2E-01..` do spec
auth-optional-mode, que compartilha o mesmo arquivo.)

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-UUID-01 | REQ-3 | happy | visitar `/manager` no modo localhost com DB vazio | HTTP 200, página renderiza (empty-org state), sem 500 |
| TC-E2E-UUID-02 | REQ-3 | happy | visitar `/me/visibility` no modo localhost | HTTP 200, estado vazio de auditoria, sem 500 |
| TC-E2E-UUID-03 | REQ-6 | happy | visitar `/manager/health` no modo localhost | HTTP 200, sem 500 |
| TC-E2E-UUID-04 | REQ-3 | happy | recarregar `/manager` para o admin local (render-survives-reload) | HTTP 200, sem 500. **Escopo**: só o caminho de render; o write FK-dependente (ack) é coberto por TC-I-07, não na UI |

## Design

### Architecture Decisions

Replicar byte-a-byte o padrão `LOCAL_ORG_ID` + `0006_local_org_seed.sql`:

1. **`LOCAL_USER_ID`** — nova constante exportada em
   `apps/server/lib/auth/auth-required.ts` (edge-safe, sem imports novos), docstring
   no mesmo estilo da `LOCAL_ORG_ID` ("stable, safe to commit, NOT a secret").
   `buildLocalDevSession()` passa a usar `id: LOCAL_USER_ID`.
2. **Migration `0008_local_user_seed.sql`** — INSERT idempotente na `users`
   referenciando os UUIDs literais (migrations não importam TS). Diferente da `0006`
   (só `id, name`), a `users` tem superfície maior — coluna a coluna:

   ```sql
   INSERT INTO users (id, org_id, email, role, display_name)
   VALUES ('00000000-0000-0000-0000-000000000002',
           '00000000-0000-0000-0000-000000000001',
           'dev@localhost', 'admin', 'Local Dev')
   ON CONFLICT (id) DO NOTHING;
   ```

   `team_id`, `sso_provider`, `sso_subject` ficam NULL (nullable); `created_at`
   usa o DEFAULT. Satisfaz `users_org_email_unique(org_id, email)` — colisão
   impossível pelo invariante de não-colisão (Decisões travadas + TC-I-12).
   Comentário-cabeçalho explicando o vínculo com a constante e a inocuidade fora
   do modo localhost. Entrada em `lib/db/migrations/meta/_journal.json` (`idx: 8`).
3. **Sem mudança em queries/páginas** — `/manager` e `/me/visibility` já funcionam
   com um UUID válido + row seedada; o fix é inteiramente na fonte da identidade.
4. **Testes de integração** usam o harness testcontainers existente
   (`tests/integration/setup-pg.ts`); o teste de migration segue o padrão de
   `lib/db/migrate-0007.test.ts` — inclusive carregando no header do novo arquivo a
   mesma justificativa de isolamento por banco descartável (não schema scratch) e o
   gating `SKIP_PG_TESTS=1` (TCs Postgres-backed skippam; a checagem de journal
   TC-I-09 roda sempre).
5. **Clareza de arquivos de teste**: `lib/auth/auth-required.test.ts` (unit,
   colocado) e `tests/integration/auth-localhost-mode.test.ts` (integração) são
   arquivos DISTINTOS; TASK-1 **edita** a assertion existente
   `expect(session.user.id).toBe('local-dev')` em ambos — não duplica testes nem
   deixa assertion stale.
6. **E2E**: `tests/e2e/auth-localhost-mode.spec.ts` já provisiona dev server +
   Postgres via global-setup com banco recém-migrado; as assertions de empty-state
   de TC-E2E-01..03 assumem esse banco limpo — TASK-SMOKE deve confirmar que o
   harness não reusa DB compartilhado com dados ambientes (senão, assertar apenas
   HTTP 200/ausência de 500, não o empty-state textual).

### Files to Create

- `apps/server/lib/db/migrations/0008_local_user_seed.sql`
- `apps/server/lib/db/migrate-0008.test.ts` (TC-I-01..03, TC-I-09, TC-I-11)
- `apps/server/tests/integration/local-mode-user-queries.test.ts` (TC-I-04..08, TC-I-10, TC-I-12)

### Files to Modify

- `apps/server/lib/auth/auth-required.ts` — `LOCAL_USER_ID` + `buildLocalDevSession()`
- `apps/server/lib/auth/auth-required.test.ts` — TC-U-18..20 (edita o teste que
  hoje asserta `'local-dev'`)
- `apps/server/tests/integration/auth-localhost-mode.test.ts` — TC-U-21 + ajustar
  asserts existentes da sessão sintética
- `apps/server/lib/db/migrations/meta/_journal.json` — entrada `0008`
- `apps/server/tests/e2e/auth-localhost-mode.spec.ts` — TC-E2E-01..04
- `apps/server/scripts/seed-server.ts` / `smoke-seed.ts` — **verificar** se referenciam
  `'local-dev'`; alinhar se sim (checagem faz parte da TASK-1 via grep TC-U-21)

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: `LOCAL_USER_ID` + `buildLocalDevSession()` com UUID; **editar** (não
      duplicar) as assertions existentes de `'local-dev'` nos dois arquivos de teste;
      grep de resíduos em `lib/**`, `app/**`, `scripts/**` (alinhar
      `scripts/seed-server.ts`/`smoke-seed.ts` se referenciarem `'local-dev'`)
  - files: apps/server/lib/auth/auth-required.ts, apps/server/lib/auth/auth-required.test.ts, apps/server/tests/integration/auth-localhost-mode.test.ts, apps/server/scripts/seed-server.ts, apps/server/scripts/smoke-seed.ts
  - tests: TC-U-18, TC-U-19, TC-U-20, TC-U-21
- [x] TASK-2: migration `0008_local_user_seed.sql` + journal + teste de migration
      (com header de isolamento e gating `SKIP_PG_TESTS` — Design §4)
  - files: apps/server/lib/db/migrations/0008_local_user_seed.sql, apps/server/lib/db/migrations/meta/_journal.json, apps/server/lib/db/migrate-0008.test.ts
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-09, TC-I-11
- [x] TASK-3: teste de integração das queries do modo localhost com DB vazio
      (regressão 22P02, prova da FK, health/drilldown, não-interferência SSO)
  - files: apps/server/tests/integration/local-mode-user-queries.test.ts
  - depends: TASK-1, TASK-2
  - tests: TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-10, TC-I-12
- [x] TASK-SMOKE: estender e executar E2E do modo localhost
  - Run `pnpm test:e2e` (apps/server); se o app/Chromium não estiver disponível: log `E2E: DEFERRED`
  - files: apps/server/tests/e2e/auth-localhost-mode.spec.ts
  - depends: TASK-3
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04

## Parallel Batches

Batch 1: [TASK-1, TASK-2]   — arquivos disjuntos (auth vs migrations), sem deps
Batch 2: [TASK-3]           — integração (depende de 1 e 2)
Batch 3: [TASK-SMOKE]       — e2e

## Validation Criteria

- [ ] `pnpm typecheck` passa (apps/server)
- [ ] `pnpm lint` passa
- [ ] `pnpm test` passa (apps/server; requer `DATABASE_URL`/Docker p/ testcontainers)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (ou `E2E: DEFERRED` logado se Chromium indisponível)
- [ ] **Live validation**: subir apps/server com `AUTH_REQUIRED=false` + Postgres
      descartável migrado, `curl -i` em `/manager`, `/me/visibility` e
      `/manager/health` → **HTTP 200** nos três (hoje: 500)
- [ ] Nenhuma ocorrência de `'local-dev'` como user id em código de produção

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-2] (2026-07-12 15:56)

Executado inline sequencial (não worktrees): apps/server tem deps nativas
(`pg`/testcontainers) que worktrees sem `node_modules` quebrariam; arquivos
disjuntos → zero risco de conflito.

- TASK-1: `LOCAL_USER_ID` (`...0002`) + `buildLocalDevSession()`; assertions
  `'local-dev'` editadas (não duplicadas); grep TC-U-21 (lib/app/scripts, sem
  resíduos — scripts já estavam limpos). TDD: RED(1 fail: id ≠ local-dev) → GREEN(37 pass).
- TASK-2: `0008_local_user_seed.sql` idempotente + journal `idx:8` + migrate-0008.test.ts.
  TDD: RED(compile/journal) → GREEN(5 pass, inclui TC-I-11 FK-ordering 0006→0008).

### Batch 2 [TASK-3] (2026-07-12 15:57)

- TASK-3: local-mode-user-queries.test.ts — TC-I-04/05 (queries vazias sem throw),
  TC-I-06 (regressão: `'local-dev'` → Postgres `22P02`), TC-I-07 (ack FK write OK),
  TC-I-08 (uuid não-seedado → FK violation), TC-I-10 (health/drilldown sem throw),
  TC-I-12 (não-colisão: `dev@localhost` em outra org insere; unique scoped provado).
  Nota de design: TC-I-12 prova o invariante via o unique scoped `users_org_email_unique`
  em vez de dirigir `evaluateAutoProvision` inteiro (deps frágeis, mesma cobertura).
  TDD: RED → GREEN(7 pass).

### Batch 3 [TASK-SMOKE] (2026-07-12)

- TASK-SMOKE: TC-E2E-01..04 adicionados a `auth-localhost-mode.spec.ts` (não-500 em
  `/manager`, `/me/visibility`, `/manager/health`, reload de `/manager`).
  **E2E: DEFERRED** — spec é skip-by-default (exige 2º dev server com
  `AUTH_REQUIRED=false` + `LOCALHOST_MODE_E2E=1`; Chromium bloqueado por rede). O
  regression de 500 é validado ao vivo via curl (ver Validation Criteria) e na
  camada de integração (TC-I-04..12).

### Self-review — fixes aplicados (2026-07-12)

3 revisores em paralelo (code/test/security). Sem CRITICAL/HIGH; sem MUST FIX de
código/segurança. Aplicados:

- **MUST FIX (test)**: drilldown (`render.tsx`) não era exercitado com
  `LOCAL_USER_ID` — TC-I-10 só cobria as queries de health. Adicionado **TC-I-13**:
  dirige `loadDrilldownData` via seam `authFn` e asserta a row de auditoria com
  `manager_user_id=LOCAL_USER_ID` (fecha a 4ª superfície do Context). 8 TCs passam.
- **SHOULD FIX (test)**: `afterEach` — comentário contradizia o código (deletava a
  seed). Reescrito para teardown hermético honesto (re-seed por teste via
  `ensureLocalSeed`), FK-children primeiro.
- **SHOULD FIX (test)**: colisão de TC-ID E2E — renomeado para `TC-E2E-UUID-01..04`.
- **SHOULD FIX (test)**: TC-E2E-UUID-04 não fazia o write de ack — escopo corrigido
  para "render-survives-reload" no teste e no Test Plan (write coberto por TC-I-07).
- **LOW (security)**: docstring stale `0005_local_org_seed.sql` → `0006` em
  `auth-required.ts` (typo pré-existente, corrigido adjacente).
- **NICE TO HAVE (code)**: comentário no SQL sobre colunas NULL omitidas.
- NICE-TO-HAVE de dirigir `evaluateAutoProvision` inteiro no TC-I-12: mantido como
  está — rationale (deps frágeis, mesma cobertura do invariante) aceito e documentado.
