# Spec: fix-manager-alert-ack-org-scoping

## Status: DONE

## Context

Surge da Pause 2 do `central-server-onboarding-v2-sso.manager-ui`
(commit `4267229`), security MEDIUM M2.

### Problema

O Server Action `acknowledgeFirstAutoProvisionAction`
(`apps/server/app/manager/actions.ts`) Zod-valida `event_id` como
`int positive` mas NÃO verifica que o evento pertence ao org do manager
autenticado. Fluxo atual:

1. Form POST → Server Action.
2. `auth()` role check (manager|admin) passa.
3. Zod parse de `event_id` (positive int) passa.
4. `acknowledgeAlert(db, managerId, 'first-auto-provision', eventId)`
   insere row em `manager_alert_acks` (composite PK
   `(manager_user_id, alert_kind, event_id)`, ON CONFLICT DO NOTHING).

Um manager legítimo do Org A pode craftar um POST com `event_id` =
ID de um evento do Org B's redemption log. A FK pra
`onboarding_redemption_log(id)` passa (a row existe globalmente), e a
ack row entra na tabela. **Não há leak de dados** (a action retorna
`{ok: true}` independente), mas **polui** `manager_alert_acks` com
orphan acks apontando pra eventos sem visibilidade legítima.

### Impacto (low-to-medium)

- **NÃO há data read back** — Org A não descobre nada sobre Org B.
- **NÃO há collision risk** — `bigserial` IDs são globalmente únicos;
  não é possível um event do Org B "bloquear" um event id legítimo do
  Org A no futuro.
- **Forensic-trail noise**: pollution silenciosa da tabela com rows
  que apontam pra eventos cross-org.
- **Primitive composability**: se uma feature futura ("show me my
  recent acks") nasce sem re-validar org-scope, pode virar leak real.

### Decisão (locked, North Star Quality > Velocity)

Fix agora (defense-in-depth) mesmo com impacto baixo. Custo é
~30 LOC + 4 TCs; valor é "a função honra o contrato do docstring"
e elimina um primitive de pollution silenciosa.

### Decisões já travadas

- **Approach (B) push predicate into INSERT** (escolhido sobre (A)
  separar validação na action):
  - Primary rationale: **the org-scope invariant is atomically encoded
    into the write operation itself** — a future caller cannot skip
    the check by bypassing a pre-validation layer. The function
    contract reflects the security invariant ("ack only if event
    belongs to this org").
  - Secondary: single round-trip vs 2 queries. Idempotente (`ON
    CONFLICT DO NOTHING` + `WHERE NOT EXISTS` ambos produzem 0 rows
    quando rejeitado).
  - Trade-off acknowledged: a ação retorna `{ok: true}` mesmo quando
    o evento não pertence ao org (silently ignored). Alternativa
    (A) retornaria `{ok: false, code: 'not_found'}` — mas isso
    introduziria um info-leak primitive (atacante diferencia
    "event id válido em meu org não acked" de "event id válido em
    outro org" pela response). Silent-ignore é a postura segura.

- **Signature mudança**: `acknowledgeAlert(db, managerId, alertKind,
  eventId)` → `acknowledgeAlert(db, managerId, alertKind, eventId,
  orgId)`. Backward-compat NÃO preserva o old signature — todos os
  callsites são internos (1 Server Action + 1 test stub), atualizados
  no mesmo commit.

- **`acknowledgeFn` DI seam type** em `actions.ts`: signature do stub
  cresce 1 parâmetro pra refletir a função real. Existing tests usam
  stubs hand-written que passam pelo type check.

- **Query reuse**: o JOIN `redemption_log.token_prefix = LEFT(invites.token, 8)`
  já é usado em `loadFirstAutoProvisionAlert` no mesmo módulo — manter
  consistente.

- **Server Action signature UNCHANGED**: `acknowledgeFirstAutoProvisionAction(formData)`
  preserva. A mudança é interna ao impl: ler `session.user.orgId` e passar
  pra `acknowledgeAlert`.

## Requirements

- [ ] **REQ-1**: GIVEN um Server Action invocado pelo manager A do Org A,
  WHEN o `event_id` payload corresponde a um redemption-log event do
  Org B, THEN `acknowledgeAlert` é chamado mas **nenhuma row é inserida**
  em `manager_alert_acks` (silent ignore via INSERT WHERE EXISTS).
  Action retorna `{ok: true}` (postura: silent ignore evita info-leak
  primitive entre "event não existe" vs "event de outro org").

- [ ] **REQ-2**: GIVEN um manager A do Org A, WHEN o `event_id`
  corresponde a um evento legítimo do Org A, THEN `acknowledgeAlert`
  insere a row + ON CONFLICT preserva idempotência (re-ack do mesmo
  event = no-op, primeiro `acked_at` mantido).

- [ ] **REQ-3**: GIVEN dois events distintos no Org A (event X,
  event Y), WHEN o manager acka apenas event X, THEN event Y permanece
  unacked (independência forensic-trail preservada — Decisão #15 do
  threat model).

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | security | `acknowledgeFirstAutoProvisionImpl` passa `session.user.orgId` pra `acknowledgeAlert` (verificado via DI stub captura args). The `AckCall` capture type + `makeAckSpy` stub MUST be extended to include `orgId: string` (failure to update = TDD RED state). Lives in `app/manager/actions.test.ts`. | stub receives `(db, managerId, 'first-auto-provision', eventId, orgId)` exatamente |
| TC-U-02 | REQ-1 | security | session com `userId` + role manager mas `orgId` undefined → `acknowledgeFirstAutoProvisionImpl` retorna `{ok: false, code: 'unauthorized'}` e `acknowledgeFn` NUNCA é chamado | defensive narrow para `!session.user.orgId` |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | seed Org A + manager A + 1 evento no Org A → `acknowledgeAlert(db, managerA, 'first-auto-provision', eventA, orgA)` → 1 row em manager_alert_acks com `acked_at` populado | row exists |
| TC-I-02 | REQ-1 | security | seed Org A + Org B + manager A em A + evento eventB em B → `acknowledgeAlert(db, managerA, 'first-auto-provision', eventB, orgA)` → **0 rows** em manager_alert_acks (INSERT silently rejected) | `SELECT COUNT(*) FROM manager_alert_acks WHERE event_id = eventB` returns 0 |
| TC-I-03 | REQ-2 | idempotency | acknowledgeAlert chamado 2x com mesmo (managerA, eventA, orgA) → 1 row total; `acked_at` da primeira call preservado (não atualizado pela segunda) | count=1, `acked_at` ≈ first-call timestamp |
| TC-I-04 | REQ-3 | business | seed eventA + eventB no Org A → ack apenas eventA → eventB ainda unacked | `loadFirstAutoProvisionAlert` retorna `{count: 1, events: [B]}` |
| TC-I-05 | REQ-1 | happy | positive predicate arm: manager B em Org B → `acknowledgeAlert(db, managerB, 'first-auto-provision', eventB, orgB)` → 1 row inserted. Distinto do TC-I-01 porque exercita o predicate sob outra (org, manager, event) tuple — guarda contra a hipótese de o predicate só funcionar pra um org específico | 1 row in manager_alert_acks |
| TC-I-06 | REQ-1 | security | edge: `eventId` corresponde a uma row em `onboarding_redemption_log` com `method = 'manual-token'` (não 'sso-auto'). O predicate joina via token_prefix → invite → org_id (não filtra por method), então cross-org continua rejeitado | 0 rows inserted |
| TC-I-07 | REQ-1 | edge | `eventId` que NÃO existe em `onboarding_redemption_log` → 0 rows (INSERT silently no-ops porque WHERE EXISTS retorna false; nenhum FK error propagado ao caller) | 0 rows inserted |
| TC-I-08 | REQ-1 | edge | `orgId = ''` (string vazia) com `eventId` legítimo do Org A → 0 rows inserted. Documenta fail-safe: a função confia que o caller passa orgId válido (action garante via session); se valor malformado vier de outro caller, predicate rejeita silenciosamente em vez de inserir ack órfã | 0 rows inserted |
| TC-I-09 | REQ-1 | security | privacy invariant: cross-org ack attempt (cenário TC-I-02) NÃO dispara `logger.warn` / `logger.error` / `logger.info`. Hand-written logger spy registra calls; após ack rejeitado, assert que spy.warnCalls/errorCalls são vazios | no log entries from the rejection path |

### E2E Tests

N/A — query-layer security fix. Comportamento do Server Action sob form
POST permanece idêntico ao usuário legítimo (200 OK). E2E não exercita
o vetor de ataque cross-org sem stand-up de IdP stub (escopo do
`oauth-idp-stub` spec separado).

## Design

### Architecture Decisions

1. **INSERT ... SELECT ... WHERE EXISTS pattern** em
   `acknowledgeAlert`. Substitui o atual `.insert().values().onConflictDoNothing()`
   builder por raw SQL via `db.execute(sql\`...\`)` porque Drizzle
   query builder não expõe `INSERT INTO ... SELECT ... WHERE EXISTS`
   diretamente. Precedente do pattern: `lib/queries/overview.ts` e
   `lib/cron/cleanup-audit-ips.ts` ambos usam `db.execute(sql\`...\`)`
   pra escape hatch.

   **Token-prefix collision risk** (negligible at expected cardinality):
   o JOIN `redemption_log.token_prefix = LEFT(invites.token, 8)` usa
   8-char hex prefix (espaço 16^8 = 4.3B). Pra org com < 1M invites,
   probabilidade de colisão entre dois prefixes diferentes é
   estatisticamente irrisória. Se o invite model um dia escalar pra
   ~10M+ invites por org, revisitar pra usar full-token join ou
   adicionar `r.token_prefix = LEFT(i.token, 8) AND r.id = ?` como
   secondary disambiguator.

   **Future alert_kind safety**: o `WHERE EXISTS` predicate é
   hardcoded ao chain `redemption_log → invite → org`. Vale apenas
   pro `alert_kind = 'first-auto-provision'`. Se um futuro alert_kind
   (e.g. billing alert com event table própria) for adicionado, NÃO
   estender essa função — introduzir nova função org-scoped ou
   adicionar `switch (alertKind)` que escolha o predicate correto.
   Documentado no JSDoc da função.

   ```ts
   await db.execute(sql`
     INSERT INTO manager_alert_acks (manager_user_id, alert_kind, event_id)
     SELECT ${managerId}, ${alertKind}, ${eventId}
     WHERE EXISTS (
       SELECT 1
       FROM onboarding_redemption_log r
       JOIN onboarding_invites i ON r.token_prefix = LEFT(i.token, 8)
       WHERE r.id = ${eventId}
         AND i.org_id = ${orgId}
     )
     ON CONFLICT (manager_user_id, alert_kind, event_id) DO NOTHING
   `);
   ```

   - Drizzle's `sql` tag parametriza valores (segurança contra SQL
     injection preservada).
   - `LEFT(i.token, 8)` matches the existing functional index
     `idx_onboarding_invites_prefix` (prefix lookup é O(log n)).
   - `ON CONFLICT DO NOTHING` preserva idempotência (re-ack legítimo
     no-op).
   - `WHERE EXISTS` returning false → INSERT inserts 0 rows (silent).
   - `WHERE EXISTS` + `ON CONFLICT` ambos produzem 0 rows — contrato
     idempotente do caller não muda.

2. **Function signature change**: `acknowledgeAlert(db, managerId,
   alertKind, eventId, orgId)`. O parâmetro `orgId` é
   non-optional para forçar todos os callsites a passarem o valor
   correto (type system enforce).

3. **Server Action wiring**: `acknowledgeFirstAutoProvisionImpl` lê
   `session.user.orgId` (já parte do Session shape — `auth()` retorna
   `{user: {id, role, orgId, ...}}`). Branch `if (!userId ||
   (role !== 'manager' && role !== 'admin'))` é estendido pra
   também verificar `!session?.user?.orgId` — se orgId está faltando
   na session, retorna `{ok: false, code: 'unauthorized'}`. Defensive:
   uma session válida com role manager/admin SEMPRE tem orgId, mas
   o type narrow é gratuito.

4. **`acknowledgeFn` DI seam** em
   `AcknowledgeFirstAutoProvisionImplDeps`: signature gains `orgId:
   string` parameter. Existing test stubs (hand-written, no mocking
   framework) atualizam — type system mostra todos os callsites.

5. **Anti-regression**: a suite existente de `manager-alerts-banner.test.ts`
   seeda invites + redemption-log rows no MESMO org do manager. O
   novo predicate é no-op nesse caso (org_id matches → WHERE EXISTS
   returns true → INSERT prossegue). Zero TCs existentes quebram.

6. **Privacy invariant**: NENHUM log adicional. O silent-ignore
   path do INSERT WHERE EXISTS não fires um warn (atacante não
   sabe se a action foi silenciosamente rejeitada — postura ideal
   contra info-leak). Trade-off documentado: ops loses visibility
   sobre tentativas de cross-org ack. Mitigação: a tabela
   `manager_alert_acks` mantém o invariante "todas as rows são
   válidas por construção". Se um padrão de probes precisa ser
   detectado no futuro, virar `manager_csrf_log` spec dedicada
   (mesma decisão do `fix-sso-csv-export-csrf`).

   **Divergência intencional** dos sibling CSRF guards
   (`csrf-origin-guard` + `same-origin-get-guard`) que DO log on
   rejection: ali o threat é exfiltração de dados (HIGH severity)
   e o log é necessário pra ops triage. Aqui o threat é forensic-trail
   noise (MEDIUM, sem data leak) — log noise é proporcionalmente
   maior do que o sinal. Reavaliar se evidência operacional surgir.

7. **NOT modified**: `loadFirstAutoProvisionAlert` (read-side já é
   org-scoped via `onboarding_invites.org_id` join — não vulnerável).

### Files to Modify

- `apps/server/lib/queries/manager-alerts.ts` — `acknowledgeAlert`
  signature + body (raw SQL via `db.execute(sql\`\`)`).
- **LOCKED — file ownership for new TCs**:
  - TC-U-01 + TC-U-02 (unit) → `apps/server/app/manager/actions.test.ts`
    (exercise the Server Action impl + DI stub capture).
  - TC-I-01..09 (integration) → `apps/server/tests/integration/manager-alerts-banner.test.ts`
    (testcontainers Postgres).
  - `apps/server/lib/queries/manager-alerts.test.ts` is NOT touched
    by this spec (the existing unit tests cover `formatBannerCount`
    only — no query DB tests live there).
- `apps/server/tests/integration/manager-alerts-banner.test.ts` —
  add TC-I-01..07 (cross-org rejection + happy path preservation +
  idempotency + edge cases).
- `apps/server/app/manager/actions.ts` —
  `acknowledgeFirstAutoProvisionImpl` reads `session.user.orgId` +
  passes it to `ack(...)`. `acknowledgeFn` type in `Deps` updated.
- `apps/server/app/manager/actions.test.ts` — update existing
  `acknowledgeFn` stubs to accept the new `orgId` param; add
  TC-U-01 that asserts orgId flows through.

### Files to Create

None.

### Dependencies

None — Drizzle's `sql` tag + `db.execute` already used in the
codebase (e.g. `teams.ts`).

## Tasks

- [x] **TASK-1**: Refactor `acknowledgeAlert` to use INSERT WHERE
  EXISTS with org-scope predicate; signature gains required `orgId`.
  Add cross-org + edge integration TCs. **Note**: existing
  `acknowledgeAlert(db, managerId, kind, eventId)` callsites in
  `tests/integration/manager-alerts-banner.test.ts` must ALL be
  updated to pass the seed-org's `orgId` as the 5th arg (same-org
  → predicate returns true → existing assertions stay green).
  Without this update, ~10 existing TCs break.
  - files: `apps/server/lib/queries/manager-alerts.ts`, `apps/server/tests/integration/manager-alerts-banner.test.ts`
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05, TC-I-06, TC-I-07, TC-I-08, TC-I-09

- [x] **TASK-2**: Wire `session.user.orgId` through
  `acknowledgeFirstAutoProvisionImpl`; update `acknowledgeFn` DI
  type to include `orgId` parameter; extend auth-narrow check to
  reject missing orgId; assert orgId flow via stub-capture in
  action unit test.
  - files: `apps/server/app/manager/actions.ts`, `apps/server/app/manager/actions.test.ts`
  - depends: TASK-1
  - tests: TC-U-01, TC-U-02

Note: existing Zod boundary TCs in `actions.test.ts` (non-numeric,
negative, zero, fractional, missing `event_id`) are UNCHANGED by this
spec — they stay green. No new Zod boundary TCs required.

## Parallel Batches

```text
Batch 1: [TASK-1]    — query layer + cross-org integration TCs
Batch 2: [TASK-2]    — action layer wiring (depends on TASK-1 signature)
```

Two-batch sequence (TASK-2 depends on TASK-1's new signature). No
parallel-safe pair within the spec; serial execution.

## Validation Criteria

- [ ] `pnpm typecheck` passes (apps/server).
- [ ] `pnpm lint` passes.
- [ ] `pnpm test --run` passes — anti-regression: existing 10+
  manager-alerts integration TCs continue green; existing
  action unit TCs continue green after stub-signature update.
- [ ] `pnpm build` passes.
- [ ] **Live validation**:
  - Seed DB: 1 manager in Org A, 1 sso-auto event in Org A's invite,
    1 sso-auto event in Org B's invite.
  - As Org-A manager, POST `/manager/actions` (via form-action) with
    `event_id=<eventA.id>` → query manager_alert_acks → 1 row inserted.
  - POST again with `event_id=<eventB.id>` (cross-org) → action
    returns 200 (silent); query manager_alert_acks → still only the
    1 row from the previous step (eventB.id NOT present).
  - POST again with `event_id=<eventA.id>` (re-ack) → still 1 row;
    `acked_at` unchanged (idempotency).
- [ ] **SQL invariant verified**: `grep -n "acknowledgeAlert" apps/server/`
  returns only the 2 callsites (action + tests); both pass the new
  `orgId` argument.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### TASK-1 (2026-05-12 15:24)
acknowledgeAlert refactored to INSERT WHERE EXISTS with org-scope predicate; signature gains `orgId`. Drizzle raw SQL via `db.execute(sql\`\`)` (parameterized). Empty-orgId fail-safe early-return added (avoids `''::uuid` Postgres throw). 6 existing callsites in `manager-alerts-banner.test.ts` updated to pass orgId. 10/10 existing TCs green. Added 9 new TCs (TC-I-01..09): happy/cross-org/idempotent/forensic/predicate-positive/manual-token/non-existent/empty-orgId/privacy-no-log. Final: 19/19 GREEN.

### TASK-2 (2026-05-12 15:28)
`acknowledgeFirstAutoProvisionImpl` now reads `session.user.orgId` + passes to `acknowledgeAlert`. Defensive narrow extended to also reject missing orgId with `{ok: false, code: 'unauthorized'}` (no info-leak about session shape). `AckCall` capture type + `makeAckSpy` extended with `orgId: string`. Existing TC-U updated to assert orgId flows through. Added TC-U-02 (defensive narrow). Final: 11/11 GREEN.

### Final validation (2026-05-12 15:28)
- typecheck: clean
- 1169 passed / 10 skipped / 1 pre-existing flake (`aggregate-team-outcomes:233` — unrelated)
- Anti-regression: 10 existing manager-alerts integration TCs + 9 existing action TCs all green with new signature.
- Privacy invariant: TC-I-09 asserts no logger.warn/error/info on cross-org rejection.
