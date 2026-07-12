# Spec: docs-reconciliation

## Status: DONE

## Context

Itens 2.1–2.4 de `docs/execution-plan-2026-07.md` (Fase 2 — credibilidade dos números e docs). A avaliação de 2026-07-11 encontrou documentação divergente do código em pontos que serão lidos por gestores; para um pitch privacy-first e data-driven, o doc canônico errado é pior que ausente. **Nenhuma mudança de código de produção** — só `.md` e um teste novo de consistência docs↔código.

Fatos verificados no código (2026-07-11):

- `lib/analytics/scoring.ts:182-207` — o score composto usa **6 sinais**: avgRating **30%**, correctionDensity **20%**, toolErrorRate **15%**, acceptRate **15%**, cacheHitRatio **10%**, outputInputRatio **10%** (com redistribuição proporcional quando um sinal é null). O README raiz o descreve de 3 formas conflitantes: `README.md:24` ("Quatro sinais", sem pesos), `README.md:121-128` (4 sinais, pesos 40/20/30/10) e `README.md:312-320` ("5 sinais", pesos 30/20/20/15/15). Nenhuma bate com o código.
- `lib/reporter/types.ts` — `SanitizedSessionPayload` tem **27 campos** (20 originais + 7 outcome v3 `.optional().nullable()`: `commit_count`, `loc_added`, `loc_removed`, `files_changed`, `reverts_within_7d`, `merged_pr_count`, `outcome_status`). `apps/server/README.md:44` promete "20 fields permitted to leave the dev's machine" e a tabela lista só 20.
- `CLAUDE.md` diz "Next.js 15" para o app raiz (package.json: `next 16.2.4`; README badge já diz 16). A frase falsa "The logger is a no-op in tests." está em **`.claude/rules/ts-conventions.md:36`** (NÃO no CLAUDE.md — verificado por grep; o CLAUDE.md só tem a linha correta sobre usar lib/logger.ts). `lib/logger.ts` gate é só `LOG_LEVEL`, default `info` — confirmado na execução de fix-pricing-unknown-model-family, que precisou stubar `log.warn`.
- `apps/server/README.md` seção "Re-installing deps": afirma que apps/server "is **not** declared in the root pnpm-workspace.yaml" e manda usar `--ignore-workspace` — invertido; `pnpm-workspace.yaml` tem `packages: ['apps/*']` desde oauth-idp-stub (log 2026-05-12). Também: "Drizzle schema … (9 tables)" (são **23** `pgTable` em `apps/server/lib/db/schema.ts`) e "first user in an org is auto-promoted to admin until role assignment ships" (role assignment JÁ shipped: `/manager/admin/users` + `updateUserRoleAction`).
- `apps/server/SECURITY.md` §6 descreve `tests/e2e/sso-auto-provision.spec.ts` como placeholder `describe.skip` aguardando fake-Google harness — o arquivo foi deletado e o idp-stub (`apps/idp-stub/`) shipped cobrindo TC-E2E-01/02.
- README raiz undersell: `README.md:117` "Três views complementares" — existem **5 páginas** (`/`, `/sessions`, `/effectiveness`, `/quota`, `/search`) + features não citadas (session share, timeline heatmap, model breakdown, outcomes); a tabela de API routes lista 3 (existem 5+: falta `/api/search`, `/api/sessions/[id]/share`).
- 5 specs com código commitado e status errado: `oauth-idp-stub`, `onboarding-followups-lowsev`, `sso-nonce-replay`, `sso-replay-audit-row` (IN_PROGRESS) e `fix-e2e-auth-bypass` ("DONE (pending commit)") — commits `c218fb2`, `f37afa5`, `4eec79e`, `1961b61`, `48bbe6b`.

**Decisões já travadas:**

- **Fonte única do score:** a seção detalhada do README (~`:312`, "Como o score é calculado") vira a canônica com a tabela dos 6 sinais/pesos + nota da redistribuição de nulls + ponteiro para `lib/analytics/scoring.ts`. As menções anteriores (`:24`, `:121-128`) são reescritas para descrever sem enumerar pesos e LINCAM a seção canônica ("veja *Como o score é calculado*"). Nunca mais duplicar pesos em 3 lugares.
- **Allowlist:** a tabela em `apps/server/README.md` ganha os 7 campos v3 numa subseção "Outcome fields (v3, opcionais)" com a semântica `.optional().nullable()` explicada (reporters antigos omitem; novos mandam null quando não avaliado). O título muda para "27 fields". **Teste de consistência docs↔código** (novo): extrai os nomes de campo da(s) tabela(s) markdown do README e compara igualdade de conjunto com `Object.keys(SanitizedSessionPayload.shape)` — qualquer drift futuro entre schema e doc canônico de privacidade quebra o build.
- **Spec statuses (2.4):** transição direta para `## Status: DONE` + linha no Execution Log de cada uma: "Status fechado retroativamente em 2026-07-11 — código commitado em `<hash>` (ver docs-reconciliation.md)". Não tocar em Requirements/Test Plan/checkboxes dessas specs.
- **Logger em testes:** a correção vai em `.claude/rules/ts-conventions.md:36` — substituir "The logger is a no-op in tests." por "The logger emits in tests unless `LOG_LEVEL` suppresses the level; tests that capture logs stub `log.warn`/`log.error` by property mutation (hand-written stub)". CLAUDE.md só recebe o fix Next 15→16.
- **`extractAllowlistFields` retorna `Result<string[], { kind: 'heading-not-found' | 'table-not-found' }>`** (convenção Result do repo, mesmo padrão de `scripts/lint-locale.ts`) — TC-U-03 assert no error kind, sem throw.
- **RED da TASK-2 é determinístico via fixture** (NUNCA git stash): o teste nasce com uma fixture string copiada da tabela atual de 20 campos → comparação contra o schema de 27 falha (RED); depois a edição real do README + leitura do arquivo real ficam GREEN. A mesma infraestrutura de fixture serve TC-U-02/05.
- Test Plan: **parcialmente N/A** (edições de prosa são verificadas por checklist REQ-by-REQ + `pnpm lint:locale`); a parte automatizável (consistência do allowlist) tem TCs reais.

## Requirements

- [x] REQ-1: GIVEN o README raiz, WHEN um leitor procura como o score funciona, THEN existe UMA seção canônica com os 6 sinais e pesos exatos do código (30/20/15/15/10/10) + redistribuição de nulls, e TODAS as outras menções ao score referenciam essa seção sem enumerar pesos próprios.
- [x] REQ-2: GIVEN `apps/server/README.md`, WHEN um leitor audita a fronteira de privacidade, THEN a tabela allowlist documenta os 27 campos (20 + 7 outcome v3 com semântica optional/nullable) e o texto diz "27 fields".
- [x] REQ-3: GIVEN o schema `SanitizedSessionPayload` e a tabela do README do server, WHEN qualquer um dos dois muda sem o outro, THEN um teste automatizado falha (comparação de conjunto de nomes de campo).
- [x] REQ-4: GIVEN `CLAUDE.md` e `.claude/rules/ts-conventions.md`, THEN o CLAUDE.md diz Next.js 16 para o app raiz e o ts-conventions.md descreve corretamente o comportamento do logger em testes (emite salvo `LOG_LEVEL`; stub por mutação de propriedade).
- [x] REQ-5: GIVEN `apps/server/README.md`, THEN a seção de workspace reflete `packages: ['apps/*']` (sem ritual `--ignore-workspace` como necessário — pode permanecer como nota histórica explícita), diz 23 tabelas, e não afirma que role assignment "não shipped".
- [x] REQ-6: GIVEN `apps/server/SECURITY.md` §6, THEN descreve o estado real: idp-stub shipped, `sso-auto-provision.spec.ts` removido, TC-E2E-01/02 cobertos.
- [x] REQ-7: GIVEN o README raiz, THEN lista as 5 páginas e as features shipped (share, heatmap, model breakdown, outcomes) e a tabela de API routes está completa.
- [x] REQ-8: GIVEN as 5 specs (`oauth-idp-stub`, `onboarding-followups-lowsev`, `sso-nonce-replay`, `sso-replay-audit-row`, `fix-e2e-auth-bypass`), THEN status `DONE` com nota de fechamento retroativo no Execution Log citando o commit; Requirements/Test Plans intocados.

## Test Plan

Edições de prosa (REQ-1/2/4/5/6/7/8): **N/A para TCs unitários** (não há lógica). Verificação real dessas REQs = checklist REQ-by-REQ com citação de linha no self-review da implementação. `pnpm lint:locale` roda como gate, mas cobre APENAS convenções de microcopy — não valida acurácia factual. Parte automatizável (REQ-1 e REQ-3):

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-3 | happy | Nomes de campo extraídos da(s) tabela(s) allowlist de `apps/server/README.md` vs `Object.keys(SanitizedSessionPayload.shape)` | conjunto extraído tem exatamente 27 entradas e é igual ao do schema (sem faltar, sem sobrar) |
| TC-U-02 | REQ-3 | edge | Fixture de tabela com campo faltando E com campo extra, passada pela mesma comparação | falha reportando o(s) campo(s) divergente(s) no assert message |
| TC-U-03 | REQ-3 | infra | Markdown sem o heading / sem tabela sob o heading | `Result` de erro com kind `heading-not-found`/`table-not-found` — nunca retorna lista vazia "passável" |
| TC-U-05 | REQ-3 | edge | Fixture com DUAS tabelas (principal + subseção v3), linha de alinhamento `\| --- \|`, nomes com crases | extrator pula a linha de alinhamento, mescla os dois conjuntos, remove crases |
| TC-U-04 | REQ-1 | validation | Invariante estrutural positivo em `README.md`: o padrão de enumeração de pesos (regex da tupla ordenada `30%…20%…15%…15%…10%…10%` OU ≥2 tokens de porcentagem próximos a nomes de sinais) ocorre **exatamente 1 vez** no arquivo inteiro | count === 1 — resiste a re-fraseamentos futuros; não é lista negativa de strings de hoje |

### Integration / E2E

N/A — sem superfícies de runtime.

## Design

### Architecture Decisions

- **Teste de consistência** em `tests/unit/privacy-allowlist-docs.test.ts` (home `tests/unit/` justificado: o teste cruza dois arquivos de diretórios distintos — `apps/server/README.md` + `lib/reporter/types.ts` — não há colocação 1:1 possível; mesmo precedente de `tests/unit/recompute-costs-args.test.ts`): `extractAllowlistFields(markdown: string): Result<string[], ExtractError>` localiza as tabelas sob o heading da allowlist (principal + subseção v3), pula linhas de alinhamento, extrai a 1ª coluna removendo crases. Compara com `Object.keys(SanitizedSessionPayload.shape)` de `@/lib/reporter/types` (nota no teste: zod v4 — `.strict().refine()` retornam `this`, `.shape` acessível direto; quebraria com semântica v3). Sem parser de markdown novo — regex linha-a-linha (espírito de `scripts/lint-locale.ts`). TC-U-04 no mesmo arquivo (lê `README.md` raiz).
- **README raiz**: seção canônica do score reescrita com tabela `| Sinal | Peso | Fonte |`; `:24` vira resumo qualitativo com link; `:121-128` idem. Seção "Três views" vira "As páginas" (5 rotas + features). Tabela de API routes completada por inspeção de `app/api/**/route.ts`.
- **apps/server/README.md**: título/contagem "27 fields"; subseção v3 com os 7 campos; seção workspace reescrita como nota histórica ("antes de 2026-05-12 o apps/server ficava fora do workspace; hoje `packages: ['apps/*']` — `pnpm install` na raiz cobre tudo"); "9 tables"→"23 tables"; frase do auto-promote atualizada apontando para `/manager/admin/users`.
- **CLAUDE.md**: "Next.js 15"→"Next.js 16" (app raiz; apps/server permanece 15), logger corrigido.
- **SECURITY.md §6**: reescrito para o estado atual (idp-stub, specs live SSO e2e).
- **Spec closures**: edição mínima — linha de status + append no Execution Log. Nada mais.

### Files to Create

- `tests/unit/privacy-allowlist-docs.test.ts` — TC-U-01..04

### Files to Modify

- `README.md`
- `apps/server/README.md`
- `apps/server/SECURITY.md`
- `CLAUDE.md`
- `.claude/rules/ts-conventions.md`
- `.specs/oauth-idp-stub.md`, `.specs/onboarding-followups-lowsev.md`, `.specs/sso-nonce-replay.md`, `.specs/sso-replay-audit-row.md`, `.specs/fix-e2e-auth-bypass.md`

### Dependencies

Nenhuma.

## Tasks

- [x] TASK-1: README raiz — seção canônica do score (6 sinais/pesos), demais menções viram referências; páginas/features; tabela de API routes completa
  - files: README.md
- [x] TASK-2: apps/server/README.md — allowlist 27 campos (+ subseção v3), workspace como nota histórica, 23 tabelas, role-assignment shipped; + teste de consistência docs↔código. TDD RED determinístico via FIXTURE (nunca git stash): teste nasce com fixture da tabela atual de 20 campos → RED; edição real do README → GREEN. TC-U-04 roda contra o README.md já editado pela TASK-1 (por isso o depends).
  - files: apps/server/README.md, tests/unit/privacy-allowlist-docs.test.ts
  - depends: TASK-1
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05
- [x] TASK-3: CLAUDE.md (Next 15→16) + .claude/rules/ts-conventions.md (logger em testes) + apps/server/SECURITY.md §6 (estado real do e2e SSO)
  - files: CLAUDE.md, .claude/rules/ts-conventions.md, apps/server/SECURITY.md
- [x] TASK-4: Fechar status das 5 specs com nota retroativa citando commit. Execution Log é APPEND-ONLY — nunca sobrescrever entradas existentes; nada além da linha de status + append.
  - files: .specs/oauth-idp-stub.md, .specs/onboarding-followups-lowsev.md, .specs/sso-nonce-replay.md, .specs/sso-replay-audit-row.md, .specs/fix-e2e-auth-bypass.md

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-3, TASK-4]  — arquivos disjuntos
Batch 2: [TASK-2]                  — depends: TASK-1 (TC-U-04 lê o README.md já editado)
Batch 3: validação final (pnpm test -- --run + lint:locale + typecheck raiz e apps/server)
```

## Validation Criteria

- [ ] `pnpm typecheck` passes (raiz e apps/server)
- [ ] `pnpm lint` passes
- [ ] `pnpm test -- --run` passes (inclui o novo teste de consistência)
- [ ] `pnpm lint:locale` passes
- [ ] Checklist REQ-by-REQ com citação de linha para cada edição de prosa (REQ-1..8)
- [ ] Nenhum arquivo fora de `.md` + `tests/unit/privacy-allowlist-docs.test.ts` alterado (spec de docs — sem código de produção)

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch [TASK-1, TASK-3, TASK-4] (2026-07-12)
Parallel via worktrees (hook OK após pin do pnpm no .tool-versions).
- TASK-1: README raiz — seção canônica "Como o score é calculado" (6 sinais 30/20/15/15/10/10 + redistribuição de nulls), menções :24/:121-128/:227 viram referências; "As páginas" (5 rotas + share/heatmap/model breakdown/outcomes); tabela de API completa (+/api/search, +/api/sessions/[id]/share). Invariante: tupla de pesos aparece 1× (grep). lint:locale ✓
- TASK-3: CLAUDE.md Next 15→16 (linha 9, única ocorrência); ts-conventions.md:36 logger corrigido; SECURITY.md §6 reescrito para o estado real (idp-stub live e2e, sso-flow.spec.ts:43/:92, fatos verificados contra global-setup e docker-compose)
- TASK-4: 5 specs fechadas (status DONE + append retroativo com hash verificado). Append-only respeitado.

### TASK-2 (2026-07-12)
Inline (depends: TASK-1 já mergeado). TDD: RED(1 — README ainda com 20 campos) → GREEN(5). tests/unit/privacy-allowlist-docs.test.ts: extractAllowlistFields com Result pattern, fixtures p/ drift/2-tabelas/alinhamento/crases; invariante de pesos do README raiz (tupla ordenada 1×). apps/server/README.md: "27 fields" + subseção "Outcome fields (v3)" com semântica optional/nullable; workspace como nota histórica (--ignore-workspace removido como necessário); 23 tables; role assignment shipped (/manager/admin/users); bônus de acurácia: linha da revogação agora aponta o follow-up 3.1 do plano em vez de prometer UI inexistente.

### Self-review da implementação (2026-07-12)
3 revisores em paralelo. code-reviewer: REQ-1..8 verificados fato-a-fato contra código/filesystem — zero MUST/SHOULD FIX. security-reviewer: PASS (allowlist v3 preciso vs sanitizer; SECURITY.md sem vazamentos; teste só lê arquivos do repo). test-reviewer SHOULD FIX aplicados: TC-U-02 assert exato do conjunto missing; TC-U-04 regex ancorada em células de tabela + assert de nome de sinal no match; "opcionais"→"optional" (consistência de idioma). Validação pós-fixes: typecheck ✓ lint ✓ suíte completa verde.
