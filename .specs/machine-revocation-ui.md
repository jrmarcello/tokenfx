# Spec: machine-revocation-ui

## Status: DONE

## Context

Item 3.1 do `docs/execution-plan-2026-07.md` (Fase 3 — perguntas que gestores farão).

O cenário "laptop roubado" hoje só é resolvível por **SQL manual**:
`apps/server/README.md:131-136` instrui o admin a rodar
`UPDATE user_machines SET revoked_at = now() WHERE key_id = '<key>'`. Não há UI —
o que é inviável para um gestor não-técnico e arriscado (SQL à mão em produção).

Este spec adiciona uma **UI admin** para listar e revogar credenciais de máquina,
espelhando o padrão já estabelecido de `/manager/admin/users` (role assignment) e o
fluxo de revogação de convites (`app/manager/invites/actions.ts`).

### Prior art (padrões a seguir)

- **Página admin org-scoped**: `app/manager/admin/users/page.tsx` — Server Component,
  gate de 3 camadas (middleware `/manager/admin/*` exige `role==='admin'` em
  `auth.config.ts:183` + layout re-check + Server Action re-check), lista filtrada por
  `orgId` da sessão, form de Server Action por linha.
- **Revogação idempotente com audit**: `app/manager/invites/actions.ts`
  (`revokeInviteImpl`) — `auth()` + role check + Zod na entrada + `revalidatePath` +
  split core/impl + entrada em `onboarding_audit_log` (`invite-revoked`).
- **Estado de revogação**: `user_machines.revoked_at` (timestamp nullable) já existe
  em `lib/db/schema.ts:83`. O push do reporter já retorna 401 para chaves revogadas
  (README:133-136) — nenhuma mudança no hot-path de ingest é necessária.

### Modelo de dados existente

`user_machines` (`schema.ts:72-95`): `id`, `user_id` (FK users, cascade), `machine_id`,
`key_id` (unique), `secret_hash`, `created_at`, `last_seen_at`, `revoked_at`,
`provisioned_via`. Não há coluna de org — o org scoping é via `JOIN users ON
users.id = user_machines.user_id AND users.org_id = <session org>`.

### Decisões já travadas

- Rota: `app/manager/admin/machines/` (admin-only automático pelo gate de
  `/manager/admin/*`). NÃO sob `/manager/*` genérico (managers não revogam máquinas —
  operação destrutiva, admin-only).
- Org scoping SEM coluna org em `user_machines`: todo SELECT e o UPDATE de revogação
  filtram por `user_id IN (SELECT id FROM users WHERE org_id = <session orgId>)` —
  cross-org revoke é impossível.
- Revogação idempotente: revogar uma máquina já revogada é no-op (retorna
  `already-revoked`, não erra). `revoked_at` nunca é sobrescrito (preserva o primeiro
  timestamp — forense).
- **NÃO** há "un-revoke" nesta UI (uma vez revogada, permanece; re-onboarding gera
  nova chave). Simplifica o modelo e evita reabilitar credencial potencialmente
  vazada por engano.
- **Auditoria**: paridade com invite-revoke — nova ação `'machine-revoked'` no
  `onboarding_audit_log`, com `target_token_prefix` = primeiros 8 chars do `key_id`
  (o check `length=8` do schema é satisfeito) e `metadata`
  `{keyPrefix, machineId, userEmail}` (**prefix-only**, consistente com a UI).
  Requer migration `0009` (`ALTER TYPE ... ADD VALUE 'machine-revoked'`) + o valor
  no array Drizzle de `schema.ts`.
- Exibição de `key_id`: mostrar só um **prefixo de 8 chars** na UI (o key_id completo
  é credencial-adjacente; prefixo basta para correlação/identificação).

## Requirements

- [ ] REQ-1: GIVEN um admin autenticado da org, WHEN visita `/manager/admin/machines`,
      THEN vê a lista de TODAS as credenciais de máquina da SUA org (email do dono,
      prefixo do key_id, provisioned_via, created/last_seen, status ativo/revogado),
      ordenadas com ativas primeiro — e NENHUMA máquina de outra org.
- [ ] REQ-2: GIVEN a lista renderizada, WHEN o key_id é exibido, THEN apenas os
      **8 primeiros chars** aparecem — nunca o key_id completo nem qualquer hash.
- [ ] REQ-3: GIVEN uma máquina ativa da org, WHEN o admin clica "Revoke", THEN
      `revoked_at` é setado via transação cujo **UPDATE carrega o predicado de org
      ele mesmo** (`AND user_id IN (SELECT id FROM users WHERE org_id=$org)` — a
      mutação é self-guarding, não depende do SELECT prévio), pushes subsequentes
      retornam 401, e a operação é idempotente (`already-revoked` em repetição,
      timestamp original preservado via `WHERE revoked_at IS NULL`); prefixo
      inexistente → `not-found`; prefixo ambíguo (>1 match na org) → `collision`,
      sem efeito.
- [ ] REQ-4: GIVEN o input do Server Action, WHEN o identificador chega, THEN é o
      **prefixo de 8 chars** do key_id (`key_id = 'k_' + 16 hex` — `tokens.ts:21`;
      prefixo = `k_` + 6 hex), validado por Zod `/^k_[0-9a-f]{6}$/` ANTES de tocar o
      DB. Vazio / não-hex / tamanho errado → erro estruturado, sem side-effect. O
      key_id completo NUNCA trafega pelo browser (nem em hidden input).
- [ ] REQ-5: GIVEN um admin da org A, WHEN tenta revogar (por prefixo) uma máquina da
      org B, THEN a operação retorna `not-found` e a máquina da org B permanece
      ativa — cross-org revoke é impossível TAMBÉM se o SELECT prévio for removido
      (o UPDATE carrega o predicado de org).
- [ ] REQ-6: GIVEN uma revogação bem-sucedida, WHEN a transação commita, THEN
      `onboarding_audit_log` ganha exatamente 1 row `machine-revoked` com
      `actor_user_id`, `target_token_prefix` (o prefixo de 8 chars) e `metadata`
      `{keyPrefix, machineId, userEmail}` — **prefix-only também no metadata**
      (consistência com a postura prefix-only; o key_id completo não é necessário
      para forense, o prefixo + machineId identificam a row); a migration `0009`
      adiciona o valor ao enum Postgres E ao array Drizzle em `schema.ts` (sem drift).
- [ ] REQ-7: GIVEN uma sessão com `role='member'` ou `'manager'` (ou sem `orgId`/
      `user.id`), WHEN chama o Server Action, THEN é rejeitada (unauthorized) sem
      qualquer efeito no DB — gate triplo (middleware + layout + action).

## Threat Model

1. **Trust boundary** — network (browser admin → server). O caller é um admin
   autenticado via SSO. A operação é destrutiva (invalida credencial de push).
2. **Identidade autenticada** — `auth()` (NextAuth SSO). Gate triplo: middleware
   `/manager/admin/*` (role admin), layout re-check, Server Action re-check. Um
   `manager` ou `member` recebe 403/redirect antes de qualquer efeito.
3. **Credenciais em jogo** — nenhuma nova. `secret_hash` (bcrypt) nunca é lido nem
   exposto; a UI só toca `revoked_at`. `key_id` é exibido truncado (8 chars).
4. **Replay & idempotency** — revogar duas vezes é no-op (`already-revoked`); Server
   Actions têm CSRF protection nativa. O UPDATE é `WHERE revoked_at IS NULL` para não
   sobrescrever o timestamp original.
5. **Authorization scope** — org scoping via join em `users.org_id = session.orgId` no
   SELECT e no UPDATE (Drizzle parametrizado). Cross-org revoke impossível. Admin-only
   (não manager) porque é destrutivo.
6. **PII / audit trail** — `onboarding_audit_log` registra `actor_user_id` +
   `target_token_prefix` (8 chars do key_id, não credencial) + `metadata`. `userEmail`
   no metadata é o email do dono da máquina (já visível ao admin da org; não é PII
   nova cross-org). **Escolha deliberada**: diferente das invite-rows (prefix/hash-only),
   guardamos o email em claro aqui — é valor forense direto ("de quem era a máquina
   revogada") num log org-scoped e admin-only, e o email já aparece na lista da UI.
   Nenhum secret nem key_id completo logado.

## Test Plan

Integração via testcontainers Postgres (`tests/integration/setup-pg.ts`), padrão de
`app/manager/invites/actions.test.ts`. Unit para o core puro.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01a | REQ-4 | validation | Zod do prefixo: string vazia | rejeita |
| TC-U-01b | REQ-4 | validation | `k_` + 6 chars não-hex (`k_zzzzzz`) | rejeita |
| TC-U-01c | REQ-4 | validation | tamanho errado (7 e 9 chars; `k_` + 5 hex; `k_` + 7 hex) | rejeita ambos |
| TC-U-01d | REQ-4 | happy | prefixo válido `k_a1b2c3` | aceita |
| TC-U-02 | REQ-2 | happy | `maskKeyId('k_' + 16hex)` retorna os 8 primeiros chars (`k_` + 6 hex) | prefixo correto; length 8 (satisfaz o CHECK do audit log) |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `listOrgMachines(db, orgId)` com 2 máquinas na org (uma de um usuário ≠ admin ator — cenário real do fluxo) + 1 em outra org | retorna só as 2 da org, com email/provisionedVia/lastSeen/revokedAt |
| TC-I-02 | REQ-1 | edge | org sem máquinas | `[]` |
| TC-I-03 | REQ-3 | happy | `revokeMachineCore` por prefixo numa máquina ativa de OUTRO usuário da org | `revoked_at` setado; retorna `{kind:'revoked'}` |
| TC-I-04 | REQ-3 | idempotency | revogar a mesma máquina 2× | 2ª retorna `already-revoked`; `revoked_at` inalterado (1º timestamp preservado) |
| TC-I-05 | REQ-5 | security | `revokeMachineCore` com prefixo de máquina de OUTRA org | `not-found`; a máquina da outra org permanece ativa |
| TC-I-05b | REQ-5 | security | UPDATE self-guarding: bypass do resolve (chamar o UPDATE direto/deps stub com keyId resolvido de outra org) | 0 rows afetadas — o predicado de org na mutação segura sozinho |
| TC-I-06 | REQ-3 | edge | prefixo inexistente | `not-found`, sem efeito |
| TC-I-06b | REQ-3 | edge | prefixo ambíguo: 2 máquinas na MESMA org com os mesmos 8 primeiros chars de key_id (seed forjado) | `collision`, NENHUMA revogada |
| TC-I-07 | REQ-6 | happy | após revogação, `onboarding_audit_log` tem 1 row `machine-revoked` com actor, `target_token_prefix` = prefixo (8 chars), metadata prefix-only (sem key_id completo) | row presente e correta |
| TC-I-08 | REQ-6 | business | migration 0009: enum Postgres aceita `machine-revoked` + journal `idx:9` | `ALTER TYPE` aplicado; INSERT raw com a nova ação sucede |
| TC-I-08b | REQ-6 | business | INSERT **via Drizzle** (`onboardingAuditLog`) com `action:'machine-revoked'` | tipado e aceito — prova que `schema.ts` foi atualizado junto (sem drift TS↔Postgres) |
| TC-I-09a | REQ-7 | security | `revokeMachineImpl` com sessão `role='member'` | rejeitado (unauthorized), sem efeito no DB |
| TC-I-09b | REQ-7 | security | `revokeMachineImpl` com sessão `role='manager'` | rejeitado — admin estrito (diferente dos invites, que aceitam manager) |
| TC-I-10 | REQ-7 | security | `revokeMachineImpl` com sessão admin sem `orgId`; e com sessão sem `user.id` | ambos rejeitados (defensive invariant) |
| TC-I-11a | REQ-3 | infra | erro do DB no UPDATE (stub que lança) | transação aborta; `revoked_at` permanece NULL; sem row de audit |
| TC-I-11b | REQ-3 | infra | erro do DB no INSERT de audit (stub que lança) | transação aborta; `revoked_at` volta a NULL (rollback) — nunca revogação sem audit |
| TC-I-12 | REQ-1 | infra | erro do DB no SELECT de `listOrgMachines` (stub que lança) | falha propagada limpa (error boundary da página), sem crash silencioso |
| TC-I-13 | REQ-3 | business | `revokeMachineImpl` retorna `already-revoked` (double-click/race) | Server Action trata como sucesso idempotente; página re-renderiza estado "revoked" sem erro ao usuário |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1/2 | happy | admin visita `/manager/admin/machines` | lista renderiza com as máquinas da org (prefixos, não key_id completo — assert no HTML) |
| TC-E2E-02 | REQ-3 | happy | admin clica "Revoke" numa máquina ativa | linha passa a "revoked" após revalidate |
| TC-E2E-03 | REQ-7 | security | sessão `manager` visita `/manager/admin/machines` | 403/redirect pelo gate real do middleware — nenhuma máquina listada |

## Design

### Architecture Decisions

1. **Query layer** — `apps/server/lib/queries/machines.ts` (novo):
   - `listOrgMachines(db, orgId): Promise<MachineRow[]>` — SELECT com
     `JOIN users u ON u.id = user_machines.user_id WHERE u.org_id = $orgId`,
     retornando `{ keyId, keyPrefix, userEmail, provisionedVia, createdAt, lastSeenAt, revokedAt }`.
     Drizzle parametrizado; ordenado por `revokedAt NULLS FIRST, createdAt DESC`
     (ativas primeiro).
   - `revokeMachineCore(db, {orgId, actorUserId, keyPrefix}): Promise<RevokeResult>`
     — recebe o **prefixo de 8 chars** (`k_` + 6 hex), nunca o key_id completo
     (espelha `revokeInviteCore`, que resolve por prefixo). Transação:
     (1) resolve por `key_id LIKE $prefix || '%'` (ou `left(key_id,8)=$prefix`)
     ANDando `u.org_id = $orgId` — 0 rows → `not-found`; >1 rows → `collision`
     (espaço de 6 hex pode colidir numa frota; o caller mostra "use SQL com o
     key_id completo" no caso raro); (2) se já revogada → `already-revoked`;
     (3) **UPDATE self-guarding**:

     ```sql
     UPDATE user_machines SET revoked_at = now()
     WHERE key_id = $resolvedKeyId AND revoked_at IS NULL
       AND user_id IN (SELECT id FROM users WHERE org_id = $orgId)
     ```

     (o predicado de org na mutação garante o scoping mesmo se o SELECT prévio
     for removido num refactor futuro); (4) audit via **novo helper
     `writeAuditMachineRevoked` em `lib/queries/audit-log.ts`** (módulo canônico
     dos writes de `onboarding_audit_log` — mesmo shape de `writeAuditRevoke`,
     action `'machine-revoked'`, metadata `{keyPrefix, machineId, userEmail}`
     prefix-only; NÃO reimplementar inline em machines.ts). Retorna union
     (`revoked | already-revoked | not-found | collision`). Drizzle parametrizado.
     Nota de formato: `target_token_prefix` para `machine-revoked` é `k_`-prefixado
     (`k_` + 6 hex), diferente dos prefixos hex-only dos invites — documentar no
     helper.
2. **Server Action** — `app/manager/admin/machines/actions.ts` (`'use server'`):
   `revokeMachineAction(formData)` + `revokeMachineImpl(prefix, deps)` (split
   core/impl como invites). `auth()` + **role === 'admin' estrito** (não
   manager|admin — operação destrutiva) + orgId + `user.id` checks + Zod
   `/^k_[0-9a-f]{6}$/` + chama `revokeMachineCore` +
   `revalidatePath('/manager/admin/machines')`.
3. **Página** — `app/manager/admin/machines/page.tsx` (Server Component): `auth()` +
   orgId, `listOrgMachines`, tabela com prefixo/email/provisionedVia/lastSeen/status;
   por linha ativa, um `<form action={revokeMachineAction}>` com input hidden do
   **prefixo** (o key_id completo NUNCA vai ao DOM) e botão "Revoke". Resultado
   `collision` renderiza mensagem orientando o fallback SQL documentado no README.
4. **Migration** — `apps/server/lib/db/migrations/0009_machine_revoked_audit_action.sql`:
   `ALTER TYPE onboarding_audit_action ADD VALUE IF NOT EXISTS 'machine-revoked';` +
   entrada `idx:9` no journal + `'machine-revoked'` no array Drizzle
   `onboardingAuditActionEnum` (`schema.ts:238`). (Notas: `IF NOT EXISTS` torna
   idempotente; a migration contém APENAS o ALTER TYPE — nenhum DML usando o novo
   valor no mesmo arquivo, pois o valor só é utilizável após o commit da transação
   da migration.)
5. **Docs** — atualizar `apps/server/README.md:131-136` substituindo o SQL manual pela
   referência à UI `/manager/admin/machines` (mantendo o SQL como fallback de
   emergência documentado).

### Files to Create

- `apps/server/lib/queries/machines.ts`
- `apps/server/lib/queries/machines.test.ts` (TC-U-02, TC-I-01..07, TC-I-11a/b, TC-I-12)
- `apps/server/app/manager/admin/machines/page.tsx`
- `apps/server/app/manager/admin/machines/actions.ts`
- `apps/server/app/manager/admin/machines/actions.test.ts` (TC-U-01a..d, TC-I-09a/b, TC-I-10, TC-I-13)
- `apps/server/lib/db/migrations/0009_machine_revoked_audit_action.sql`
- `apps/server/lib/db/migrate-0009.test.ts` (TC-I-08, TC-I-08b)
- `apps/server/tests/e2e/machine-revocation.spec.ts` (TC-E2E-01..03)

### Files to Modify

- `apps/server/lib/db/migrations/meta/_journal.json` — entrada `0009`
- `apps/server/lib/db/schema.ts` — `'machine-revoked'` no array `onboardingAuditActionEnum` (:238)
- `apps/server/lib/queries/audit-log.ts` + `audit-log.test.ts` — helper `writeAuditMachineRevoked`
- `apps/server/README.md` — seção 131-136 (SQL manual → UI, mantendo SQL como fallback de emergência p/ colisão de prefixo)

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: migration `0009` (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) + journal +
      **`'machine-revoked'` no array Drizzle `onboardingAuditActionEnum` em
      `schema.ts`** (sem drift TS↔Postgres) + teste de migration
  - files: apps/server/lib/db/migrations/0009_machine_revoked_audit_action.sql, apps/server/lib/db/migrations/meta/_journal.json, apps/server/lib/db/schema.ts, apps/server/lib/db/migrate-0009.test.ts
  - tests: TC-I-08, TC-I-08b
- [x] TASK-2: query layer `machines.ts` (list + revoke core prefix-based + maskKeyId)
      + helper `writeAuditMachineRevoked` em `audit-log.ts`
  - files: apps/server/lib/queries/machines.ts, apps/server/lib/queries/machines.test.ts, apps/server/lib/queries/audit-log.ts, apps/server/lib/queries/audit-log.test.ts
  - depends: TASK-1
  - tests: TC-U-02, TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-05b, TC-I-06, TC-I-06b, TC-I-07, TC-I-11a, TC-I-11b, TC-I-12
- [x] TASK-3: Server Action + página admin (prefix-only no DOM)
  - files: apps/server/app/manager/admin/machines/actions.ts, apps/server/app/manager/admin/machines/actions.test.ts, apps/server/app/manager/admin/machines/page.tsx
  - depends: TASK-2
  - tests: TC-U-01a, TC-U-01b, TC-U-01c, TC-U-01d, TC-I-09a, TC-I-09b, TC-I-10, TC-I-13
- [x] TASK-4: docs README (SQL → UI; a rota `/manager/admin/machines` já está travada
      em Decisões, então NÃO depende da TASK-3 — arquivo disjunto)
  - files: apps/server/README.md
- [x] TASK-SMOKE: E2E da revogação
  - Run `pnpm test:e2e` (apps/server); se indisponível: log `E2E: DEFERRED`
  - files: apps/server/tests/e2e/machine-revocation.spec.ts
  - depends: TASK-3
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03

## Parallel Batches

Batch 1: [TASK-1, TASK-4]    — migration/enum ∥ docs (independentes, arquivos disjuntos)
Batch 2: [TASK-2]            — query layer (depende do enum)
Batch 3: [TASK-3]            — action + página
Batch 4: [TASK-SMOKE]        — e2e

## Validation Criteria

- [ ] `pnpm typecheck` passa (apps/server)
- [ ] `pnpm lint` passa
- [ ] `pnpm test` passa (apps/server; testcontainers)
- [ ] `pnpm build` passa
- [ ] `pnpm test:e2e` passa (ou `E2E: DEFERRED`)
- [ ] **Live validation**: apps/server `AUTH_REQUIRED=false` + Postgres migrado, seed
      de uma máquina, `curl`/browser em `/manager/admin/machines` mostra a lista;
      revogar via UI seta `revoked_at` (confirmar via SQL) e registra a row de audit.
- [ ] Nenhum `key_id` completo exposto na UI (só prefixo de 8 chars).

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-4] (2026-07-12)

Inline (deps nativas + arquivos disjuntos).

- TASK-1: migration `0009` (`ALTER TYPE ADD VALUE IF NOT EXISTS 'machine-revoked'`)
  e journal idx:9 e `'machine-revoked'` no array Drizzle `onboardingAuditActionEnum`.
  migrate-0009.test.ts (TC-I-08 raw + TC-I-08b Drizzle tipado). GREEN(3).
  Ripple: `schema-onboarding.test.ts` TC-I-01 assertava o enum com 2 valores →
  atualizado para incluir machine-revoked.
- TASK-4: README "Revocation procedure" — SQL manual → UI `/manager/admin/machines`
  (SQL mantido como fallback de emergência para colisão de prefixo).

### Batch 2 [TASK-2] (2026-07-12)

- TASK-2: `machines.ts` (listOrgMachines, revokeMachineCore prefix-based com UPDATE
  self-guarding + transação, maskKeyId, revokeMachineUpdateForTest) +
  `writeAuditMachineRevoked` em audit-log.ts. TDD: RED(8) → GREEN(13 + 1 audit-log).
  Cobre cross-org (TC-I-05/05b), collision (TC-I-06b), rollback UPDATE/audit
  (TC-I-11a/b), list DB-error (TC-I-12).

### Batch 3 [TASK-3] (2026-07-12)

- TASK-3: Server Action (`revokeMachineImpl` admin-estrito + `revokeMachineAction`)
  e página `/manager/admin/machines`. actions.test.ts: Zod boundaries (TC-U-01a..d),
  authz member/manager/no-org/no-id (TC-I-09a/b, TC-I-10), result mapping (TC-I-13).
  GREEN(14).

### Batch 4 [TASK-SMOKE] (2026-07-12)

- machine-revocation.spec.ts (TC-E2E-01..03). **E2E: DEFERRED** (Chromium
  bloqueado por rede). O gate admin-only e o não-leak são validados ao vivo (abaixo).

### Validação (2026-07-12)

- typecheck + lint limpos; **suíte apps/server 1483 passed / 11 skipped**.
- **Live validation pegou um LEAK DE SEGURANÇA que os unit tests não viam**: o payload
  RSC (React flight) serializava os raw rows da query com o `key_id` COMPLETO, mesmo
  a UI renderizando só o prefixo. Fix na fonte: `listOrgMachines` faz `left(key_id, 8)`
  no SQL — o key_id completo nunca entra na memória JS server-side, logo não pode
  vazar no flight/DOM. Re-validado: só `k_deadbe` no HTML, `k_[0-9a-f]{16}` ausente.
  (TC-E2E-01 guarda essa regressão no HTML quando o e2e rodar.)
- **Live revoke**: `revokeMachineCore` → `{kind:'revoked'}`; `revoked_at` setado no
  DB; audit row `machine-revoked` com metadata prefix-only (`k_deadbe`, machineId,
  `dev@localhost` — sem key_id completo). Página lista em HTTP 200.
