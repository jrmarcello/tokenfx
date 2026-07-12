# Spec: data-retention-policy

## Status: DONE

## Context

Item 3.2 do `docs/execution-plan-2026-07.md` (Fase 3). Hoje os aggregates do
servidor central acumulam **para sempre**, e não existe NENHUM fluxo de
offboarding — quando um dev sai da empresa, seu histórico identificável
(email, display_name, vínculo SSO) permanece indefinidamente. O único cleanup
existente é o de IPs truncados (30d, `lib/queries/cleanup.ts` +
`lib/cron/cleanup-audit-ips.ts`).

**Decisão de produto travada (2026-07-12): 24 meses + anonimizar.**

- **Retenção**: dados de série temporal com mais de **24 meses** são apagados
  por cron diário.
- **Offboarding**: um admin pode marcar um dev como "departed" — a identidade é
  **anonimizada in-place** (email/display_name/SSO removidos, máquinas
  revogadas), mas as rows de aggregates **permanecem** (mesmo `user_id`), então
  os totais históricos da org/time não mudam.

### Infra existente (reusar, não recriar)

- **Cron**: `app/api/internal/cron/*/route.ts` + `assertInternalCronAuth`
  (`lib/cron/auth.ts`, secret `x-internal-cron-secret`, constant-time compare) +
  telemetria `cron_runs` (started/finished/rows_written/status). Padrão:
  `cleanup-audit-ips`.
- **Cleanup query pattern**: `lib/queries/cleanup.ts` (`cleanupOldIps`) —
  Drizzle parametrizado, idempotente, `.returning()` para contagem exata.
- **Admin UI + Server Action**: `/manager/admin/users` (role admin, 3 camadas)
  e o padrão core/impl/action de `machine-revocation-ui`.
- **Audit**: `onboarding_audit_log` + enum `onboarding_audit_action` (migration
  `ALTER TYPE ADD VALUE`, padrão 0009) — nova ação `'user-offboarded'`.
- **Revogação de máquinas**: `revokeMachineUpdateForTest`/`revokeMachineCore`
  em `lib/queries/machines.ts` (o offboarding revoga TODAS as máquinas do dev).

### Mapa de dados × janela de retenção (24 meses)

| Tabela | Coluna de corte | Estratégia |
| --- | --- | --- |
| `sessions_agg` | `started_at` | DELETE direto |
| `model_breakdown_agg` | **sem coluna de tempo** (PK user+session) | orphan sweep: DELETE onde `(user_id, session_id)` não existe mais em `sessions_agg` |
| `tool_count_agg` | idem | idem |
| `session_outcomes_agg` | idem (PK user+session) | idem |
| `team_metrics_daily` | `day` | DELETE direto |
| `team_outcomes_daily` | `day` | DELETE direto |
| `ingestion_log` | `received_at` | DELETE direto (o null-IP de 30d continua à parte) |
| `onboarding_redemption_log` | `received_at` | DELETE direto |
| `auth_event_log` | `occurred_at` | DELETE direto (nome confirmado no schema) |
| `manager_drilldown_audit` | `viewed_at` | DELETE direto |
| `manager_anomalies` | `created_at` | DELETE direto |
| `manager_dismissed_anomalies` | `dismissed_at` | DELETE direto — **NUNCA `dismissed_until`** (é timestamp near-future de expiração; usá-lo faria as rows jamais prunarem) |
| `onboarding_audit_log` | `occurred_at` | DELETE direto (mesma janela — uniformidade > exceções) |
| `cron_runs` | `started_at` | DELETE direto |

Fora da retenção (dados de identidade/config, não série temporal): `orgs`,
`teams`, `users`, `user_machines`, `onboarding_invites` (têm TTL próprio via
`expires_at` + revogação), `org_settings`, `cost_calibration_per_user`,
`manager_alert_acks` (cascade via evento).

**Fora do prune por já ter dono**: `manager_notifications` é prunada pelo cron
existente `cleanup-audit-ips` (janela de 90 dias via `enqueued_at` — o nome da
rota é legado, o handler cobre IP-truncation E notification-prune). O
`retention-prune` NÃO a toca — duplicar seria dead code (90d < 24m) e trap de
manutenção. O README (TASK-5) cross-referencia isso explicitamente.

### Anonimização no offboarding (design)

UPDATE in-place na row `users` (NUNCA DELETE — os FKs `ON DELETE CASCADE`
apagariam os aggregates, violando a decisão "permanece nos totais"):

- `email` → `departed-<user_id COMPLETO>@anonymized.invalid` (UUID inteiro —
  36 chars — porque 8 hex têm só 32 bits e colidiriam em orgs grandes;
  unicidade GARANTIDA por construção; satisfaz `users_org_email_unique`; TLD
  `.invalid` é RFC 2606, nunca rotável; total 62 chars, dentro do limite de
  email).
- `display_name` → `NULL` (a UI já tem fallback `split_part(email,'@',1)` →
  vira `departed-xxxxxxxx`, legível e não-identificável).
- `sso_provider`/`sso_subject` → `NULL` (quebra o vínculo de login; um novo
  SSO login do mesmo email corporativo NÃO religa — auto-provision criaria um
  usuário novo, correto para re-hire).
- `role` → `'member'` (um admin/manager offboarded não deve manter privilégio
  se algo religar).
- Todas as máquinas do dev: `revoked_at = now()` (não pode mais fazer push).
- Audit: 1 row `user-offboarded` (actor, `target_token_prefix` = 8 chars do
  user_id — satisfaz o CHECK length=8 — metadata `{targetUserId}`; NÃO logar o
  email antigo: o propósito é remover a identidade, o audit não pode reter).
- **Scrub de PII residual (CRITICAL da review)**: a garantia "email em lugar
  nenhum" exige DOIS complementos na mesma transação do offboard:
  1. **Fix na fonte**: `writeAuditMachineRevoked` passa a gravar
     `{keyPrefix, machineId, userId}` (NÃO `userEmail`) — o email é resolvível
     em read-time via join enquanto o usuário existe, e se anonimiza junto após
     offboard. Muda `audit-log.ts` + `machines.ts` + testes (contrato interno,
     sem consumidor externo do metadata).
  2. **Scrub de rows legadas**: `UPDATE onboarding_audit_log SET metadata =
     metadata - 'userEmail' WHERE action='machine-revoked' AND
     (metadata->>'machineId') IN (SELECT machine_id::text FROM user_machines
     WHERE user_id = $target)` — remove o email de audits pré-existentes do dev.
  3. **`manager_drilldown_audit.reason_text`** do target → `NULL` (texto livre
     digitado por manager pode conter nome/email; o resto da tabela referencia
     por UUID e se anonimiza sozinho). Limitação documentada no README: textos
     livres em OUTRAS superfícies não são varridos.
- **Idempotente**: offboardar quem já está offboarded → `already-offboarded`
  (detecção: email termina em `@anonymized.invalid`).
- **Irreversível por design** (sem "un-offboard"; re-hire = novo usuário).
- **Limitação conhecida (JWT residual)**: nular `sso_subject` bloqueia logins
  FUTUROS, mas um JWT já emitido para o dev permanece válido até expirar — há uma
  janela em que o offboarded ainda pode agir. Mitigação plena (token-version /
  `sessionInvalidatedAt` no callback do JWT) é escopo maior; por ora, manter TTL de
  sessão curto e documentar a janela. Follow-up para uma iteração de auth.

### Decisões já travadas

- Janela: 24 meses, uniforme para toda série temporal (sem exceções por tabela).
- Cron diário `retention-prune`, mesmo padrão/auth do `cleanup-audit-ips`;
  janela configurável só por env `RETENTION_MONTHS` (default 24, **mínimo 12**
  — um typo `RETENTION_MONTHS=1` seria um mass-delete global irreversível;
  valores <12 ou inválidos → fallback 24 com `log.warn` ruidoso; a janela
  efetiva é logada no início de cada run) — sem UI de configuração.
- **Prune de `sessions_agg` + os 3 orphan sweeps rodam numa ÚNICA transação**
  (baratos, mesma invocação) — elimina a janela de órfãos visíveis a queries
  standalone dos child tables. As DEMAIS tabelas seguem individualmente
  idempotentes sem transação global (falha parcial → re-run completa).
- Offboarding é **admin-only**, via botão "Offboard" em `/manager/admin/users`
  (página existente ganha a ação; sem página nova).
- Anonimização preserva `user_id` → totais org/time inalterados.
- Docs: seção "Data retention & offboarding" no `apps/server/README.md`.

## Requirements

- [ ] REQ-1: GIVEN o cron `retention-prune` autenticado, WHEN roda, THEN apaga
      de TODAS as tabelas do mapa acima as rows com corte > `RETENTION_MONTHS`
      (default 24; valores <12 ou inválidos → fallback 24 com warn ruidoso; a
      janela efetiva é logada por run), registra em `cron_runs`, e retorna
      `{deletedByTable: Record<string, number>}`; re-rodar no mesmo dia é no-op.
- [ ] REQ-2: GIVEN sessões de `sessions_agg` apagadas pela retenção, WHEN o
      prune completa, THEN `model_breakdown_agg`/`tool_count_agg`/
      `session_outcomes_agg` não têm rows órfãs — o delete de `sessions_agg` e
      os 3 sweeps rodam numa ÚNICA transação (atômico). As demais tabelas são
      individualmente idempotentes fora de transação global (falha parcial → o
      re-run completa o resto).
- [ ] REQ-3: GIVEN dados DENTRO da janela, WHEN o prune roda, THEN nenhuma row
      recente é tocada (boundary: row exatamente no corte permanece; corte-1dia
      é apagada).
- [ ] REQ-4: GIVEN um admin da org, WHEN clica "Offboard" num dev da SUA org,
      THEN em uma única transação: email→`departed-<uuid completo>@anonymized.invalid`,
      `display_name`/`sso_provider`/`sso_subject`→NULL, `role`→'member', TODAS
      as máquinas do dev revogadas, **scrub do `userEmail` nas rows legadas
      `machine-revoked` do dev** (via join `metadata->>'machineId'` →
      `user_machines`), **`reason_text`→NULL nas rows de drilldown do target**,
      e 1 row de audit `user-offboarded`. Resultado: o email antigo não existe
      em NENHUMA tabela. Os aggregates do dev permanecem intactos (mesmo
      user_id) — totais org/time não mudam.
- [ ] REQ-4b: GIVEN novas revogações de máquina (pós este spec), THEN
      `writeAuditMachineRevoked` grava `{keyPrefix, machineId, userId}` — NÃO
      mais `userEmail` (fix na fonte; email resolvível em read-time por join,
      anonimiza-se automaticamente com o offboard).
- [ ] REQ-5: GIVEN offboarding, THEN é idempotente (`already-offboarded` na
      repetição) e org-scoped com UPDATE self-guarding (padrão
      machine-revocation) — cross-org é `not-found`; admin não pode offboardar
      A SI MESMO (guard explícito, evita lockout acidental).
- [ ] REQ-6: GIVEN um dev offboarded, WHEN dashboards renderizam, THEN o label
      exibido é o fallback `departed-xxxxxxxx` (via COALESCE existente) e um
      novo login SSO do ex-email NÃO religa à conta anonimizada.
- [ ] REQ-7: GIVEN a migration, THEN `'user-offboarded'` existe no enum
      Postgres E no array Drizzle (padrão 0009, sem drift); GIVEN o README,
      THEN documenta janela, cron, e o fluxo de offboarding.

## Threat Model

1. **Trust boundary** — cron: rede interna com shared secret (constant-time);
   offboarding: browser admin → server (SSO + gate triplo).
2. **Identidade autenticada** — cron via `x-internal-cron-secret`; offboarding
   via `auth()` role='admin' estrito (destrutivo/irreversível).
3. **Credenciais em jogo** — offboarding revoga `user_machines` (bcrypt hash
   intocado, apenas `revoked_at`); remove vínculo SSO. Nenhum secret novo.
4. **Replay & idempotency** — prune: predicados por timestamp (re-run no-op);
   offboard: detecção `@anonymized.invalid` → `already-offboarded`; Server
   Action CSRF nativo.
5. **Authorization scope** — offboard org-scoped com UPDATE self-guarding
   (`org_id` na mutação); self-offboard bloqueado; prune é global (todas as
   orgs — retenção é política do servidor, não por-org).
6. **PII / audit trail** — o offboarding REMOVE PII (esse é o ponto); o audit
   row não retém o email antigo (só user_id truncado + targetUserId no
   metadata). O prune APAGA logs velhos inteiros — redução de superfície.

## Test Plan

Integração via testcontainers (`setup-pg.ts`); unit para helpers puros.
Padrões: `lib/cron/cleanup-audit-ips.test.ts`, `lib/queries/machines.test.ts`.

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | validation | `resolveRetentionMonths(env)`: unset→24; `"12"`→12; `"36"`→36; `"11"`→24+warn (floor 12 — typo não vira mass-delete); `"0"`/`"-1"`/`"abc"`→24+warn | valores exatos por caso |
| TC-U-02 | REQ-4 | happy | `anonymizedEmailFor(userId)` → `departed-<uuid COMPLETO>@anonymized.invalid` | formato exato; determinístico; único por construção |
| TC-U-03 | REQ-5 | validation | Zod do target no action: UUID válido aceita; malformado rejeita | boundaries |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `it.each` sobre TODAS as 9 tabelas de DELETE direto do mapa (`[tabela, colunaDeCorte]`: sessions_agg/started_at, team_metrics_daily/day, team_outcomes_daily/day, ingestion_log/received_at, onboarding_redemption_log/received_at, auth_event_log/occurred_at, manager_drilldown_audit/viewed_at, manager_anomalies/created_at, manager_dismissed_anomalies/dismissed_at, onboarding_audit_log/occurred_at, cron_runs/started_at): seed a 25 meses + a 1 mês; prune | por tabela: velha apagada, recente intacta; `deletedByTable` reflete as contagens |
| TC-I-01b | REQ-1 | edge | `manager_dismissed_anomalies`: dismissal RECENTE (`dismissed_at` 1 mês) com `dismissed_until` já expirado | NÃO prunada (o corte é `dismissed_at`, jamais `dismissed_until`) |
| TC-I-02 | REQ-3 | edge | row EXATAMENTE no corte (now − 24 meses) e row corte−1dia | no-corte permanece; corte−1dia apagada (predicado `<`, não `<=`) |
| TC-I-03 | REQ-2 | business | sessão velha em `sessions_agg` + rows nas 3 child tables; prune | asserts POR TABELA (`model_breakdown_agg`, `tool_count_agg`, `session_outcomes_agg` individualmente): órfãs apagadas; rows de sessões vivas intactas nas 3 |
| TC-I-04 | REQ-1 | idempotency | rodar o prune 2× | 2ª execução: 0 deletes, sem erro; a própria row `cron_runs` do run em andamento sobrevive ao prune de `cron_runs` velhos e chega a `finished` |
| TC-I-05 | REQ-1 | infra | erro de DB numa tabela do meio da sequência (via deps seam `deleteTable` que lança) | `cron_runs` registra `failed`; HTTP 500; tabelas já processadas mantêm o delete; **re-run subsequente completa as restantes** (eventual completeness testada, não só documentada) |
| TC-I-05b | REQ-2 | infra | falha DENTRO da transação sessions_agg+sweeps (seam no sweep) | rollback: `sessions_agg` velho AINDA presente (atômico — sem órfãos nem estado parcial dessa etapa) |
| TC-I-06 | REQ-1 | security | cron sem/errado `x-internal-cron-secret` | 401, nenhum delete |
| TC-I-07 | REQ-4 | happy | offboard de um dev com 2 máquinas ativas e aggregates | email/display/SSO anonimizados, role member, 2 máquinas revogadas, audit `user-offboarded` presente SEM o email antigo, aggregates intactos (mesma contagem, mesmo user_id) |
| TC-I-08 | REQ-5 | idempotency | offboard 2× | 2ª → `already-offboarded`; nada muda |
| TC-I-09 | REQ-5 | security | admin org A offboarda dev da org B | `not-found`; dev B intacto |
| TC-I-09b | REQ-5 | security | UPDATE self-guarding (defense-in-depth, distinto do TC-I-09): um `targetUserId` de OUTRA org injetado direto no UPDATE (simulando bypass do resolve, via seam) | 0 rows afetadas — o predicado `org_id` na mutação segura sozinho |
| TC-I-10 | REQ-5 | security | admin tenta offboardar a si mesmo | rejeitado (`self-offboard-blocked`), sem efeito |
| TC-I-11 | REQ-5 | security | `offboardUserImpl` com role member/manager; sem orgId; sem user.id | todos rejeitados, core não chamado |
| TC-I-12 | REQ-4 | infra | erro no meio da transação de offboard (stub no revoke de máquinas) | rollback completo: email original preservado, nenhuma máquina revogada, sem audit |
| TC-I-13 | REQ-6 | business | após offboard, query de roster/drilldown do dev | label = `departed-xxxxxxxx` (fallback COALESCE); sem email antigo em nenhuma coluna retornada |
| TC-I-14 | REQ-6 | security | camada de query (mesmo pragmatismo do machines TC-I-05): `findPreExistingV1User(db, orgId, emailANTIGO)` após offboard | retorna `undefined` — o vínculo `(org_id, email)` não religa; pipeline completo fica no e2e |
| TC-I-15 | REQ-7 | business | enum: INSERT raw + INSERT Drizzle com `user-offboarded` | ambos aceitos (sem drift); journal idx correto |
| TC-I-16 | REQ-4 | security | dev com row LEGADA `machine-revoked` contendo `userEmail` no metadata; offboard | metadata da row legada perde a chave `userEmail` (scrub via join machineId→user_machines); demais chaves preservadas |
| TC-I-17 | REQ-4 | security | rows de `manager_drilldown_audit` do target com `reason_text` preenchido; offboard | `reason_text` → NULL nas rows do target; rows de outros users intactas |
| TC-I-18 | REQ-4b | happy | nova revogação de máquina pós-spec | metadata do audit contém `userId`, NÃO contém `userEmail` |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-4 | happy | admin clica "Offboard" em `/manager/admin/users` (com confirm) | linha mostra estado departed; email antigo ausente do DOM |
| TC-E2E-02 | REQ-5 | security | manager visita a página | sem botão Offboard funcional (403 na action) |

## Design

### Architecture Decisions

1. **Prune** — `lib/cron/retention-prune.ts`:
   `runRetentionPrune(db, {months}, deps?)` com **deps seam injetável**
   (`deps?: { deleteTable?: (name, cutoff) => Promise<number> }`, mesmo padrão
   de `revokeMachineCore` — é o que torna TC-I-05/05b implementáveis com stub
   que lança, sem mocking framework). Ordem: (a) **transação única** com
   DELETE de `sessions_agg` + os 3 orphan sweeps (atômico); (b) as demais
   tabelas em sequência, cada DELETE parametrizado com `.returning()` para
   contagem, individualmente idempotente. Retorna
   `{deletedByTable: Record<string, number>}`. Rota
   `app/api/internal/cron/retention-prune/route.ts` clonando o shape de
   `cleanup-audit-ips` (auth + cron_runs + 200/500). O prune de `cron_runs`
   exclui a row do próprio run (`id != $currentRunId` ou predicado por status
   'running'). Testes copiam a lista de `TRUNCATE` de
   `cleanup-audit-ips.test.ts` estendida com as novas tabelas (evita colisão
   de seed cross-file).
2. **Orphan sweep** — `DELETE FROM model_breakdown_agg m WHERE NOT EXISTS
   (SELECT 1 FROM sessions_agg s WHERE s.user_id=m.user_id AND
   s.session_id=m.session_id)` (idem tool_count_agg/session_outcomes_agg).
   Dentro da MESMA transação do delete de `sessions_agg` (Design §1a).
3. **Offboard** — `lib/queries/offboard.ts`:
   `offboardUserCore(db, {orgId, actorUserId, targetUserId}, deps?)` com deps
   seam (`{ revokeMachines?, writeAudit?, scrubLegacyAudit?, scrubReasonText? }`)
   para os TCs de rollback. Transacional: (1) resolve target ANDando org_id
   (not-found/cross-org), detecta `@anonymized.invalid` → `already-offboarded`,
   bloqueia `targetUserId === actorUserId` → `self-offboard-blocked`; (2)
   UPDATE users self-guarding (`AND org_id=$org`); (3) UPDATE user_machines
   (`revoked_at=now() WHERE user_id=$target AND revoked_at IS NULL`); (4)
   **scrub PII residual**: `metadata - 'userEmail'` nas rows `machine-revoked`
   legadas do target (join `metadata->>'machineId'` → `user_machines.machine_id::text`)
   E `reason_text=NULL` em `manager_drilldown_audit WHERE target_user_id=$target`;
   (5) audit `user-offboarded` via helper em `audit-log.ts` (metadata só
   `{targetUserId}` — SEM email antigo). Union
   `offboarded | already-offboarded | not-found | self-offboard-blocked`.
3b. **Fix na fonte do metadata** — `writeAuditMachineRevoked`
   (`audit-log.ts`) muda o metadata para `{keyPrefix, machineId, userId}`
   (remove `userEmail`); `machines.ts` (`revokeMachineCore`) passa `userId` em
   vez de `userEmail`. Testes de ambos atualizados (TC-I-18).
4. **Server Action** — `offboardUserAction` em
   `app/manager/admin/users/actions.ts` (arquivo existente ganha o export),
   admin-estrito + Zod UUID + revalidatePath. **Confirm: decisão explícita —
   um Client Component leaf mínimo** (`OffboardButton`, `'use client'`) que
   chama `window.confirm()` antes de submeter o form — justificado por
   nextjs-conventions (interatividade exige client; leaf o mais fundo
   possível). O guard REAL continua sendo o action server-side; o confirm é UX
   contra misclick numa ação irreversível.
5. **Migration 0010** — `ALTER TYPE onboarding_audit_action ADD VALUE IF NOT
   EXISTS 'user-offboarded';` + journal idx:10 + array Drizzle (padrão 0009,
   um único statement).
6. **Env** — `RETENTION_MONTHS` lido no route handler via
   `resolveRetentionMonths(process.env)` (helper puro, fail-safe para 24).
7. **README** — seção "Data retention & offboarding": janela, cron (como
   agendar, mesmo padrão dos outros), fluxo de offboard, irreversibilidade,
   nota de que aggregates permanecem por user_id.

### Files to Create

- `apps/server/lib/cron/retention-prune.ts` + `retention-prune.test.ts` (TC-U-01, TC-I-01, 01b, 02..05, 05b)
- `apps/server/app/api/internal/cron/retention-prune/route.ts` (TC-I-06 no teste do prune)
- `apps/server/lib/queries/offboard.ts` + `offboard.test.ts` (TC-U-02, TC-I-07..10, TC-I-12..14, TC-I-16, TC-I-17)
- `apps/server/lib/db/migrations/0010_user_offboarded_audit_action.sql`
- `apps/server/lib/db/migrate-0010.test.ts` (TC-I-15)
- `apps/server/app/manager/admin/users/offboard-button.tsx` — Client leaf (`'use client'`, `window.confirm`)
- `apps/server/tests/e2e/offboarding.spec.ts` (TC-E2E-01..02)

### Files to Modify

- `apps/server/lib/db/schema.ts` — enum array (`'user-offboarded'`)
- `apps/server/lib/db/migrations/meta/_journal.json` — idx:10
- `apps/server/lib/queries/audit-log.ts` + `.test.ts` — `writeAuditUserOffboarded` + **metadata de `writeAuditMachineRevoked` → `{keyPrefix, machineId, userId}`** (TC-I-18)
- `apps/server/lib/queries/machines.ts` + `.test.ts` — `revokeMachineCore` passa `userId` (não `userEmail`) ao audit
- `apps/server/app/manager/admin/users/actions.ts` + `.test.ts` — `offboardUserImpl`/`offboardUserAction` (TC-U-03, TC-I-11)
- `apps/server/app/manager/admin/users/page.tsx` — coluna/botão Offboard
- `apps/server/tests/integration/schema-onboarding.test.ts` — enum agora com 4 valores
- `apps/server/README.md` — seção retenção/offboarding

### Dependencies

Nenhuma nova.

## Tasks

- [x] TASK-1: migration 0010 + enum Drizzle + journal + teste (padrão 0009) +
      update do `schema-onboarding.test.ts` (4 valores)
  - files: apps/server/lib/db/migrations/0010_user_offboarded_audit_action.sql, apps/server/lib/db/migrations/meta/_journal.json, apps/server/lib/db/schema.ts, apps/server/lib/db/migrate-0010.test.ts, apps/server/tests/integration/schema-onboarding.test.ts
  - tests: TC-I-15
- [x] TASK-2: prune (`retention-prune.ts` com deps seam + transação
      sessions_agg+sweeps + route cron + env helper floor-12)
  - files: apps/server/lib/cron/retention-prune.ts, apps/server/lib/cron/retention-prune.test.ts, apps/server/app/api/internal/cron/retention-prune/route.ts
  - tests: TC-U-01, TC-I-01, TC-I-01b, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-05b, TC-I-06
- [x] TASK-3: offboard core (`offboard.ts` com deps seam + scrubs PII + audit
      helper) + fix na fonte do metadata de `machine-revoked`
  - files: apps/server/lib/queries/offboard.ts, apps/server/lib/queries/offboard.test.ts, apps/server/lib/queries/audit-log.ts, apps/server/lib/queries/audit-log.test.ts, apps/server/lib/queries/machines.ts, apps/server/lib/queries/machines.test.ts
  - depends: TASK-1
  - tests: TC-U-02, TC-I-07, TC-I-08, TC-I-09, TC-I-09b, TC-I-10, TC-I-12, TC-I-13, TC-I-14, TC-I-16, TC-I-17, TC-I-18
- [x] TASK-4: Server Action + botão Offboard (client leaf com confirm) na
      página admin/users
  - files: apps/server/app/manager/admin/users/actions.ts, apps/server/app/manager/admin/users/actions.test.ts, apps/server/app/manager/admin/users/page.tsx, apps/server/app/manager/admin/users/offboard-button.tsx
  - depends: TASK-3
  - tests: TC-U-03, TC-I-11
- [x] TASK-5: README (retention & offboarding)
  - files: apps/server/README.md
- [x] TASK-SMOKE: e2e offboarding
  - Run `pnpm test:e2e`; indisponível → `E2E: DEFERRED`
  - files: apps/server/tests/e2e/offboarding.spec.ts
  - depends: TASK-4
  - tests: TC-E2E-01, TC-E2E-02

## Parallel Batches

Batch 1: [TASK-1, TASK-2, TASK-5]  — migration ∥ prune ∥ docs (arquivos disjuntos; prune não depende do enum)
Batch 2: [TASK-3]                  — offboard core (depende do enum)
Batch 3: [TASK-4]                  — action + página
Batch 4: [TASK-SMOKE]              — e2e

## Validation Criteria

- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm test` (apps/server) + `pnpm build` passam
- [ ] `pnpm test:e2e` (ou `E2E: DEFERRED`)
- [ ] **Live validation**: Postgres migrado + servidor localhost; seed com dados
      velhos (>24m) e recentes; `curl` no cron `retention-prune` com o secret →
      velhos somem, recentes ficam (SQL confirma); offboard de um dev seedado →
      email anonimizado no DB, máquinas revogadas, audit row presente, e o
      email antigo AUSENTE de qualquer resposta HTTP subsequente.
- [ ] Nenhum email antigo retido em audit/logs após offboard — incluindo o
      metadata das rows `machine-revoked` legadas (SQL: `SELECT count(*) FROM
      onboarding_audit_log WHERE metadata->>'userEmail' IS NOT NULL AND ...` = 0
      para o target).
- [ ] README contém a seção "Data retention & offboarding" citando
      `RETENTION_MONTHS` (floor 12), o cron, a irreversibilidade do offboard, o
      cross-ref ao `cleanup-audit-ips` (dono do prune de `manager_notifications`,
      90d) e a limitação de textos livres fora do scrub.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batches 1-3 (2026-07-12)

Executado inline (deps nativas; arquivos disjuntos por batch).

- **TASK-1** (migration 0010): `ALTER TYPE ADD VALUE 'user-offboarded'` + journal
  idx:10 + array Drizzle + schema-onboarding.test.ts (enum agora 4 valores).
  migrate-0010.test.ts. GREEN(3).
- **TASK-2** (prune): `retention-prune.ts` — `resolveRetentionMonths` (floor 12,
  fail-safe), `runRetentionPrune` com deps seam + transação sessions_agg+3 sweeps +
  direct-delete das 9 tabelas + prune de cron_runs (exclui o próprio run). Route
  cron + auth. 15 TCs (it.each de todas as tabelas, boundary `<`, dismissed_at≠
  dismissed_until, idempotência, rollback da tx, deps-seam failure) + 3 route auth.
  GREEN(18).
- **TASK-3** (offboard): `offboard.ts` (`offboardUserCore` transacional + deps seam,
  `anonymizedEmailFor` UUID-completo, scrub de audit legado + reason_text,
  `offboardAnonymizeUpdateForTest`) + `writeAuditUserOffboarded`. **Fix na fonte**:
  `writeAuditMachineRevoked` metadata `{keyPrefix, machineId, userId}` (removido
  `userEmail`) — machines.ts + testes atualizados. 11 offboard TCs + audit-log unit.
  GREEN.
- **TASK-4** (UI): `offboardUserImpl`/`offboardUserAction` (admin-estrito) +
  `OffboardButton` client leaf (`window.confirm`) + coluna Offboard na página
  admin/users. actions.test.ts 19 (Zod, role gates member/manager/no-org/no-id).
- **TASK-5** (docs): README seção "Data retention & offboarding" + cron endpoints
  (cross-ref ao cleanup-audit-ips como dono do prune de manager_notifications).
- **TASK-SMOKE**: offboarding.spec.ts (TC-E2E-01/02). E2E: DEFERRED (Chromium).

### Validação (2026-07-12)

- typecheck + lint limpos; **suíte apps/server 1523 passed / 11 skipped**.
- **Live validation** (Postgres + servidor localhost, dados seedados):
  - Cron `retention-prune` via curl (secret) → `{rows_written:1, status:ok}`;
    `ingestion_log` 2→1 (row de 25 meses apagada, a de 1 mês mantida).
  - Offboard de um dev via core → `{kind:'offboarded'}`; DB: email→
    `departed-<uuid>@anonymized.invalid`, `display_name`/`sso_provider`/
    `sso_subject` NULL, `role=member`, máquina revogada.
  - **Scrub do CRITICAL confirmado ao vivo**: a row `machine-revoked` legada
    (seedada com `userEmail:'bob@corp.example'`) NÃO contém mais o email após o
    offboard; o audit `user-offboarded` também não retém email antigo.

### Self-review — fixes aplicados (2026-07-12)

3 revisores em paralelo. Nenhum CRITICAL/HIGH; nenhum MUST FIX. Aplicados:

- **M1 (security, MEDIUM)**: o scrub de audit legado só casava por `machineId` —
  uma row com `machineId` ausente manteria o email. Adicionado predicado por email
  antigo (capturado ANTES da anonimização): `... OR metadata->>'userEmail' = $oldEmail`.
  TC-I-16b prova o scrub de row sem machineId. Fecha a garantia "email em lugar nenhum".
- **DRY (code, SHOULD)**: `offboardUserCore` agora chama `offboardAnonymizeUpdateForTest`
  (um único code path do UPDATE self-guarding) — TC-I-09b passa a exercitar a lógica
  de produção, sem risco de drift do predicado de org.
- **TC-I-18 no call site (test, SHOULD)**: machines TC-I-07 agora asserta `userId`
  presente + ausência de `@` no metadata — prova que `revokeMachineCore` passa
  `userId`, não `userEmail` (a regressão que só o unit do writer não pegaria).
- **E2E loud (test)**: TC-E2E-01 asserta o botão visível (falha alto) em vez de skip
  silencioso.
- **NICE**: `RetentionPruneResult.rowsWritten` como single source of truth (route
  não recomputa); comentário no `DeleteTableFn` (roda fora de transação); header do
  migrate-0010 corrigido (REQ-7/TC-I-15).
- **M2 (security, MEDIUM)** — JWT residual até expirar após offboard: documentado como
  limitação conhecida + follow-up de auth (mitigação plena é escopo maior). Não
  bloqueia. Ponto de atenção abaixo.
