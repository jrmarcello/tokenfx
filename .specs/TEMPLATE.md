# Spec: <feature-name>

## Status: DRAFT

## Context

<!-- Why does this feature exist? What problem does it solve? What prompted it? -->

## Requirements

<!-- Use GIVEN/WHEN/THEN for unambiguous acceptance criteria -->

- [ ] REQ-1: ...
- [ ] REQ-2: ...

## Threat Model (opcional)

<!-- Preencher SOMENTE se a spec toca:
     - auth, SSO, credenciais, secrets, tokens, cookies, JWT
     - PII (email, hash de email, IP, user-agent, location)
     - filesystem reads driven por user input
     - superfície anônima (rate-limit, DoS, unauth probes)
     - audit-log / forensic-readiness surface

     Caso contrário, REMOVER a seção inteira (não deixar "N/A" item-a-item —
     ou a seção é relevante e responde tudo, ou some).

     As respostas alimentam diretamente a Test Plan (categoria `security`) e
     são auditadas pelo security-reviewer no Phase 3 da /ralph-loop. -->

1. **Trust boundary** — qual fronteira esse código atravessa (process / network / device)? Quem confia em quem do outro lado?

2. **Identidade autenticada** — quem é o caller? (user humano via SSO, machine bearer, SSO subject, anônimo)? Como a identidade é verificada antes de qualquer side-effect?

3. **Credenciais em jogo** — passwords, bearer tokens, SSO ID tokens, state/nonce cookies, idempotency keys? Quanto tempo vivem em memória / disco / log? Onde estão validadas (Zod boundary, signature check, expiry)?

4. **Replay & idempotency** — uma requisição capturada pode ser reexecutada com efeito? Que mecanismo previne? (state cookie, nonce, jti dedup, idempotency key, time-window guard)

5. **Authorization scope** — depois de autenticar, o caller pode tocar QUE recursos? Há check de `org_id` / `team_id` / `role` na query/route? Onde? (middleware vs route vs query WHERE clause)

6. **PII / audit trail** — que dados de usuário fluem? São hashados / redacted nos logs e exports? Que eventos devem aterrissar em `auth_event_log` (ou equivalente) com `email_hash` em vez de plaintext?

## Test Plan

<!-- Derive test cases from Requirements and Design.
     Coverage Rules (every spec MUST satisfy):
     - Every REQ has >= 1 TC
     - Every typed error surfaced by a module has >= 1 TC
     - Every validated field (Zod schema) has boundary TCs (valid min, valid max, invalid min-1, invalid max+1)
     - Every external dependency call (fs read, HTTP fetch, DB write) has >= 1 infra-failure TC
     - Every conditional branch has TCs for both paths
     - Every new API route / Server Action has integration TCs: happy + each error status + idempotency

     TC-ID convention:
     - TC-U-NN    = Unit tests (pure functions, parsers, scoring, pricing, value transforms)
     - TC-I-NN    = Integration tests (DB writer, queries, API routes with real SQLite)
     - TC-E2E-NN  = End-to-end tests (Playwright against running Next.js app)

     Categories: happy, validation, business, edge, infra, idempotency, security
-->

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | ... | ... |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | ... | ... |

### E2E Tests

<!-- E2E tests validate browser behavior via Playwright.
     Executed by TASK-SMOKE, NOT via TDD RED/GREEN cycle.
     Files: tests/e2e/<feature>.spec.ts -->

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1 | happy | ... | ... |

## Design

### Architecture Decisions

<!-- Approach, affected files, technical decisions.
     Organize by feature/domain (lib/, app/, components/), not by layer. -->

### Files to Create

<!-- List concrete file paths -->

### Files to Modify

<!-- List concrete file paths -->

### Dependencies

<!-- External packages needed, if any. Mark [NEEDS CLARIFICATION] for uncertain items.
     Prefer Context7 to verify API surface before committing to a package. -->

## Tasks

<!-- Each task should be concrete, independently verifiable (`pnpm typecheck` + affected tests pass after each) -->
<!-- Order tasks logically for the feature — no mandatory architecture layer ordering -->
<!-- `files:` lists files this task creates or modifies — used for parallelism detection -->
<!-- `depends:` lists tasks that must complete before this one can start -->
<!-- `tests:` lists TC-IDs this task must satisfy (triggers TDD cycle in ralph-loop) -->
<!-- Tasks with no shared files and no dependency can run in parallel -->

- [ ] TASK-1: ...
  - files: ...
  - tests: TC-U-01
- [ ] TASK-2: ...
  - files: ...
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02
- [ ] TASK-3: ...
  - files: ...
  - depends: TASK-1

<!-- E2E tests run directly (not TDD). Add a TASK-SMOKE at the end: -->

- [ ] TASK-SMOKE: Execute E2E smoke tests
  - Run `pnpm test:e2e`
  - If app not running: log `E2E: DEFERRED`
  - files: tests/e2e/<feature>.spec.ts
  - tests: TC-E2E-01, TC-E2E-02
  - depends: TASK-N

## Parallel Batches

<!-- Auto-generated by /spec based on file overlap and dependency analysis -->
<!-- Tasks in the same batch can run in parallel (no shared files, deps satisfied) -->
<!-- Batch N+1 only starts after all tasks in Batch N are complete -->

<!-- Example:
Batch 1: [TASK-1]                    — foundation (no deps)
Batch 2: [TASK-2, TASK-3, TASK-4]    — parallel (independent files, TASK-1 done)
Batch 3: [TASK-5]                    — integration (shared: app/layout.tsx [additive])
-->

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes
- [ ] `pnpm build` passes
- [ ] `pnpm test:e2e` passes (if E2E tests exist)
- [ ] ...

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
