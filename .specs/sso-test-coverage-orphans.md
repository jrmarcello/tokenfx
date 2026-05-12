# Spec: sso-test-coverage-orphans

## Status: DONE

## Context

Surge da PAUSE 2 do `central-server-onboarding-v2-sso.manager-ui`
(commit `4267229`), section "Pontos de atenção (escalados)" — test
MUST FIX (orphan TCs from test-reviewer).

### Problema

4 TCs foram listados no Test Plan da manager-ui spec mas nunca
implementados como `it()` entries porque caíam entre camadas — o
behavior era testado INDIRETAMENTE por TCs de integração numa camada
mais ampla, deixando a asserção targeted unit/integration descoberta.
Cada um representa um gap real de regression-detection.

### Os 4 órfãos

**1. TC-U-01..05 — standalone Zod schema unit tests pra
`allowed_sso_providers`**

Hoje subsumidos por TCs de action-layer (TC-I-20, TC-I-21, TC-I-22 em
`actions.test.ts`). Uma regressão que quebre `.min(1)` ou
`.transform(dedup)` sem tocar a action passaria silencioso (a action
tests valida o end-to-end, não o schema isolado). O code shipped em
`apps/server/app/manager/invites/actions.ts` linhas 67-70 monta o
schema INLINE dentro de `createInviteFormSchema`:

```ts
allowed_sso_providers: z
  .array(z.enum(SSO_PROVIDER_VALUES))
  .min(1, 'allowed_sso_providers requires at least one provider')
  .transform((arr) => Array.from(new Set(arr))),
```

Pra unit-testar isoladamente, esse field-schema precisa ser
**extraído pra named export** consumido por `createInviteFormSchema` E
importado diretamente pelo novo test block.

**2. TC-I-43b — `?page=abc` HTTP-layer Zod coercion**

`audit-log-view.test.ts` cobre TC-I-43 (page beyond max → empty) e
TC-I-43c (query-level non-negative guard via throw). Falta o último
mile: HTTP-layer coercion onde `?page=abc` → `page=0` via Zod
`.catch(0)` (em `page.tsx:63`). Hoje esse path NÃO é testado em lugar
nenhum.

A Zod schema vive INLINE em `apps/server/app/manager/audit-log/page.tsx`
(Server Component — testar via Next.js runtime é heavy). Solução:
extrair `searchParamsSchema` + helper `parseAuditLogSearchParams(raw):
ParsedFilters` pra módulo sibling importável do test.

**3. TC-I-22b — `enforceAllowedProviders([])` isolated unit**

A predicate vive INLINE em
`apps/server/lib/auth/sso-auto-provision.ts:643-646`:

```ts
if (
  invite.allowedSsoProviders.length > 0 &&
  !invite.allowedSsoProviders.includes(input.ssoProvider)
) { … return { kind: 'rejected-cross-idp' }; }
```

O legacy invariant "empty array = any provider allowed" só é testado
end-to-end via decision-engine TCs. Extrair pra pure named function +
4 unit TCs torna o invariant explícito + regression-protected sem
tocar a wider decision tree.

**4. TC-I-23b — `?provisioned_via=all` integration TC pra team-roster
CSV**

`team-roster-csv.test.ts` cobre sso-auto + token filters mas não o
`all` path com mixed-provisioned rows incluindo `pre-v2-unknown`.
Documentado em manager-ui spec §7 ("pre-v2-unknown rows surface
under 'all' only") mas nunca asserted.

### Decisões já travadas

- **Approach (A): refactor inline → named export** pra #1, #2, #3.
  Preferido sobre "re-implement literal in test" porque:
  - Regressão na definição inline NÃO quebraria tests que
    re-implementam o literal (false negative).
  - Named exports permitem unit boundary clean.
  - Cost: ~30-50 LOC totais de moving code + import updates.
- **Approach (B): purely additive TCs** pra #4 (no refactor).
- **NÃO mudar comportamento** — todas as extrações são refactors
  estruturais, behavior idêntico. Anti-regression: ~50 SSO TCs
  existentes continuam GREEN.
- **`enforceAllowedProviders` signature**: pure function
  `(invite: {allowedSsoProviders: string[]}, requestedProvider: string): boolean`.
  Retorna `true` se array vazio (legacy "any") OU includes provider.
  Caller faz `if (!enforceAllowedProviders(invite, input.ssoProvider))
  { return rejected-cross-idp; }`.
- **`allowedSsoProvidersSchema` placement**: declarado como named
  export no topo de `actions.ts` (mesmo módulo). Alternativa de mover
  pra `lib/auth/sso-providers.ts` separado é over-engineering pra
  uma constante + schema combo.
- **`searchParamsSchema` placement**: extraído de `page.tsx` pra
  novo sibling module
  `apps/server/app/manager/audit-log/audit-log-page-params.ts`
  (named export `auditLogSearchParamsSchema` + helper
  `parseAuditLogSearchParams`). Página importa e usa.

## Requirements

- [ ] **REQ-1**: GIVEN o `allowedSsoProvidersSchema` é importado
  diretamente, WHEN um caller tenta parsear `[]` (write-path), THEN
  Zod retorna error com code `too_small`. WHEN o input é
  `['google', 'google']`, THEN o output é `['google']`
  (deduplicação preservada). Comportamento idêntico ao current via
  `createInviteFormSchema`.
- [ ] **REQ-2**: GIVEN o helper `parseAuditLogSearchParams(raw)` é
  invocado com `{ page: 'abc' }`, THEN retorna `{ page: 0, ... }`
  (Zod `.catch(0)` aplica). WHEN invocado com `{ page: '-1' }`, THEN
  retorna `{ page: 0, ... }` (clamp). Comportamento idêntico ao
  inline schema atual em `page.tsx`.
- [ ] **REQ-3**: GIVEN um invite tem `allowedSsoProviders = []`
  (legacy), WHEN `enforceAllowedProviders(invite, anyProvider)` é
  chamado, THEN retorna `true` (any provider allowed). GIVEN
  `allowedSsoProviders = ['google']`, WHEN provider é `'google'`,
  THEN retorna `true`; WHEN provider é `'okta'`, THEN retorna
  `false`. Comportamento idêntico ao inline check em
  `sso-auto-provision.ts`.
- [ ] **REQ-4**: GIVEN team A em Org A seedado com 3 users —
  user-sso (sso-auto), user-tok (manual-token), user-legacy
  (sem `user_machines` row, surfaces como `pre-v2-unknown`) —
  WHEN GET `/manager/teams/[id]/export?provisioned_via=all`,
  THEN response CSV body contém os 3 email_hash_prefixes (uma row
  por user). Confirma a documented semantic em manager-ui spec §7.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01a | REQ-1 | happy | `allowedSsoProvidersSchema.parse(['google'])` → `['google']` | success |
| TC-U-01b | REQ-1 | happy | `allowedSsoProvidersSchema.parse(['google', 'okta'])` → `['google', 'okta']` (order preserved) | success |
| TC-U-01c | REQ-1 | validation | `allowedSsoProvidersSchema.safeParse([])` → `{success: false}` com `error.issues[0].code === 'too_small'` | rejection |
| TC-U-01d | REQ-1 | validation | `allowedSsoProvidersSchema.safeParse(['nonexistent'])` → `{success: false}` com `code === 'invalid_value'` (Zod 4 — renamed from Zod 3's `invalid_enum_value`) | rejection |
| TC-U-01e | REQ-1 | business | `allowedSsoProvidersSchema.parse(['google', 'google'])` → `['google']` (dedup) | length 1 |
| TC-U-01f | REQ-1 | business | `allowedSsoProvidersSchema.parse(['google', 'okta', 'google'])` → `['google', 'okta']` (first-seen order preserved by Set) | length 2 |
| TC-U-02a | REQ-2 | happy | `parseAuditLogSearchParams({page: '5'})` → `{page: 5, ...}` (string coerce) | numeric value === 5 |
| TC-U-02b | REQ-2 | validation | `parseAuditLogSearchParams({page: 'abc'})` → `{page: 0, ...}` (Zod catch fallback, no NaN) | page === 0 |
| TC-U-02c | REQ-2 | validation | `parseAuditLogSearchParams({page: '-1'})` → `{page: 0, ...}` (negative → 0 clamp via catch) | page === 0 |
| TC-U-02d | REQ-2 | edge | `parseAuditLogSearchParams({})` (no params at all) → all fields undefined; page defaults to 0 via catch | page === 0, all others undefined |
| TC-U-02e | REQ-2 | edge | `parseAuditLogSearchParams({page: '99999999999999'})` → page === 0 (exceeds `.max(MAX_PAGE)` → `.catch(0)` kicks in) | page === 0 (exact) |
| TC-U-02f | REQ-2 | edge | `parseAuditLogSearchParams({page: '0'})` → page === 0 (valid minimum, NOT clamped) | page === 0 (passes `.min(0)`) |
| TC-U-02g | REQ-2 | validation | `parseAuditLogSearchParams({page: '5.5'})` → page === 0 (fractional fails `.int()` → catch fallback) | page === 0 |
| TC-U-02h | REQ-2 | edge | `parseAuditLogSearchParams({page: undefined})` → page === 0 (missing key) | page === 0 |
| TC-U-03a | REQ-3 | business | `enforceAllowedProviders({allowedSsoProviders: []}, 'google')` → `true` (legacy any) | true |
| TC-U-03b | REQ-3 | business | `enforceAllowedProviders({allowedSsoProviders: []}, 'okta')` → `true` (legacy any) | true |
| TC-U-03c | REQ-3 | happy | `enforceAllowedProviders({allowedSsoProviders: ['google']}, 'google')` → `true` | true |
| TC-U-03d | REQ-3 | business | `enforceAllowedProviders({allowedSsoProviders: ['google']}, 'okta')` → `false` | false |
| TC-U-03e | REQ-3 | business | `enforceAllowedProviders({allowedSsoProviders: ['google', 'okta']}, 'microsoft')` → `false` | false |
| TC-U-03f | REQ-3 | happy | `enforceAllowedProviders({allowedSsoProviders: ['google', 'okta']}, 'okta')` → `true` | true |
| TC-U-03g | REQ-3 | security | `enforceAllowedProviders({allowedSsoProviders: ['google']}, 'GOOGLE')` → `false` (case-sensitive — pins the contract; no normalization happens here) | false |
| TC-U-01g | REQ-1 | validation | `() => allowedSsoProvidersSchema.parse([])` throws `ZodError` (complements TC-U-01c which uses `.safeParse()`; pins that this schema does NOT use `.catch()` and `.parse()` MUST throw on empty input) | throws |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-23b | REQ-4 | happy | seed team A em Org A com EXATAMENTE 3 users (sso-auto + manual-token + pre-v2-unknown — sem `user_machines` row) → GET `/manager/teams/[id]/export?provisioned_via=all` → response CSV body data rows count EXATAMENTE 3 (header excluído); cada um dos 3 email_hash_prefixes esperados (set membership assertion) está presente | rows.length === 3 + Set match |
| TC-I-23c | REQ-4 | business | mesmo seed (3 users) → GET sem query param (`?provisioned_via` ausente) → asserção INDEPENDENTE: rows.length === 3 + os 3 prefixes esperados presentes (NÃO compara com TC-I-23b — cada TC valida o invariant standalone pra evitar coupled-test failures) | rows.length === 3 + Set match |

### Anti-regression checks

Não são novos TCs — são verificações pós-execução de que as ~50 TCs
existentes do SSO continuam GREEN:

- `apps/server/app/manager/invites/actions.test.ts` (28 TCs existentes
  + 8 new) — Zod refactor não muda behavior.
- `apps/server/lib/auth/sso-auto-provision.test.ts` (~40 TCs) —
  `enforceAllowedProviders` extraction não muda decision tree.
- `apps/server/tests/integration/audit-log-view.test.ts` (12+ TCs) —
  `searchParamsSchema` extraction não muda parsing behavior.
- `apps/server/tests/integration/team-roster-csv.test.ts` (existing
  TCs + 2 new) — additive only.

## Design

### Architecture Decisions

1. **Extraction-placement criterion (LOCKED, single rule)**: extract
   to sibling module ONLY when the host file is a Next.js Server
   Component (page.tsx / layout.tsx / error.tsx) — those files pull
   React/Next runtime imports that don't load cleanly in Vitest
   without extra wiring. For Server Action files (`actions.ts`) +
   library modules (`lib/**`), in-module named exports are fine —
   the existing test files already import these modules directly
   from Vitest without runtime issues. Application of the rule:
   - `allowedSsoProvidersSchema` → in-module export from `actions.ts`
     (Server Action file, already test-importable today).
   - `enforceAllowedProviders` → in-module export from
     `sso-auto-provision.ts` (library module).
   - `auditLogSearchParamsSchema` + `parseAuditLogSearchParams` →
     sibling module `audit-log-page-params.ts` (host is Server
     Component page.tsx).

2. **`enforceAllowedProviders` signature**:

   ```ts
   /**
    * Returns true if the invite's allowed-providers list permits the
    * requested provider. Legacy semantic: empty array means "any
    * provider allowed" (preserves pre-spec-c invites).
    */
   export const enforceAllowedProviders = (
     invite: { allowedSsoProviders: ReadonlyArray<string> },
     requestedProvider: string,
   ): boolean => {
     if (invite.allowedSsoProviders.length === 0) return true;
     return invite.allowedSsoProviders.includes(requestedProvider);
   };
   ```

   Pure function — no DB, no logger. Easy unit test. Decision logic
   crisp. Caller becomes:

   ```ts
   if (!enforceAllowedProviders(invite, input.ssoProvider)) {
     await writeAuditRowsForRejection(deps, {
       outcome: 'rejected-cross-idp', ...auditCommon
     });
     return { kind: 'rejected-cross-idp' };
   }
   ```

   Reads as "if NOT allowed, reject" — more direct than the inline
   negation chain.

3. **`auditLogSearchParamsSchema` extraction**: copy the schema
   **VERBATIM** from `apps/server/app/manager/audit-log/page.tsx`
   (currently around line 63). Do NOT re-derive from the snippet
   below — the actual schema uses project constants (`OUTCOME_VALUES`,
   `MAX_TEXT_LEN`, `MAX_PAGE`) and `.datetime({ offset: true })` for
   date fields. The snippet below is illustrative only:

   ```ts
   // Constants MUST be moved to or re-exported from this new module:
   //   OUTCOME_VALUES (string-tuple of auth_event_log outcomes)
   //   MAX_TEXT_LEN   (200 — filter string field cap)
   //   MAX_PAGE       (10_000 — pagination index ceiling; NOT
   //                  related to CSV export row cap)
   //
   // Illustrative — copy real body from page.tsx:
   export const auditLogSearchParamsSchema = z.object({
     page: z.coerce.number().int().min(0).max(MAX_PAGE).catch(0),
     outcome: z.enum(OUTCOME_VALUES).optional().catch(undefined),
     iss: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
     city: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
     browser: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
     from: z.string().datetime({ offset: true }).optional().catch(undefined),
     to: z.string().datetime({ offset: true }).optional().catch(undefined),
   });
   export type AuditLogSearchParams = z.infer<typeof auditLogSearchParamsSchema>;
   export const parseAuditLogSearchParams = (raw: Record<string, string | string[] | undefined>) =>
     auditLogSearchParamsSchema.parse(raw);
   ```

   **Constants location locked**: `MAX_TEXT_LEN`, `MAX_PAGE`,
   `OUTCOME_VALUES` move to the new `audit-log-page-params.ts`
   module as named exports. `page.tsx` imports them back. Single
   source of truth.

   **`.parse()` safety**: every field has `.catch()` — never throws.
   Verified against the real `page.tsx` schema body in TASK-3.

4. **`allowedSsoProvidersSchema` extraction**: pull the `.array().min(1).transform()` pipeline OUT of `createInviteFormSchema`, name it, then reference it back inside the form schema:

   ```ts
   export const allowedSsoProvidersSchema = z
     .array(z.enum(SSO_PROVIDER_VALUES))
     .min(1, 'allowed_sso_providers requires at least one provider')
     .transform((arr) => Array.from(new Set(arr)));

   const createInviteFormSchema = z.object({
     // ...
     allowed_sso_providers: allowedSsoProvidersSchema,
   }).strict();
   ```

5. **TC-I-23b/c integration** uses existing seed helpers in
   `team-roster-csv.test.ts`. The "pre-v2-unknown" path means
   seeding a user WITHOUT a `user_machines` row — the query already
   surfaces it via COALESCE (per the original spec). Just add the
   3-user seed scenario + `?provisioned_via=all` assertion.

### Files to Modify

- `apps/server/app/manager/invites/actions.ts` — extract
  `allowedSsoProvidersSchema` as named export; reference inside
  `createInviteFormSchema`.
- `apps/server/app/manager/invites/actions.test.ts` — add
  `describe('allowedSsoProvidersSchema (standalone)')` block (6 TCs).
- `apps/server/lib/auth/sso-auto-provision.ts` — extract
  `enforceAllowedProviders` pure function (named export); replace
  inline check with function call.
- `apps/server/lib/auth/sso-auto-provision.test.ts` — add
  `describe('enforceAllowedProviders')` block (6 TCs).
- `apps/server/app/manager/audit-log/page.tsx` — import
  `auditLogSearchParamsSchema` + `parseAuditLogSearchParams` from
  new sibling; remove inline schema.
- `apps/server/tests/integration/team-roster-csv.test.ts` — add
  TC-I-23b + TC-I-23c.

### Files to Create

- `apps/server/app/manager/audit-log/audit-log-page-params.ts` — new
  named exports (schema + helper).
- `apps/server/app/manager/audit-log/audit-log-page-params.test.ts` —
  5 unit TCs (TC-U-02a..e).

### Dependencies

None — pure refactor + additive TCs. No new npm packages.

## Tasks

- [x] **TASK-1**: Extract `allowedSsoProvidersSchema` to named export
  in `actions.ts` + add 7 standalone unit TCs in `actions.test.ts`.
  - files: `apps/server/app/manager/invites/actions.ts`, `apps/server/app/manager/invites/actions.test.ts`
  - tests: TC-U-01a, TC-U-01b, TC-U-01c, TC-U-01d, TC-U-01e, TC-U-01f, TC-U-01g

- [x] **TASK-2**: Extract `enforceAllowedProviders` to named export
  in `sso-auto-provision.ts` + replace inline callsite + add 7 unit
  TCs in `sso-auto-provision.test.ts`.
  - files: `apps/server/lib/auth/sso-auto-provision.ts`, `apps/server/lib/auth/sso-auto-provision.test.ts`
  - tests: TC-U-03a, TC-U-03b, TC-U-03c, TC-U-03d, TC-U-03e, TC-U-03f, TC-U-03g

- [x] **TASK-3**: Create `audit-log-page-params.{ts,test.ts}` sibling
  + move `MAX_PAGE`/`MAX_TEXT_LEN`/`OUTCOME_VALUES` constants from
  `page.tsx` into the new module + update `page.tsx` to import
  (delete inline schema) + 8 unit TCs.
  - files: `apps/server/app/manager/audit-log/audit-log-page-params.ts`, `apps/server/app/manager/audit-log/audit-log-page-params.test.ts`, `apps/server/app/manager/audit-log/page.tsx`
  - tests: TC-U-02a, TC-U-02b, TC-U-02c, TC-U-02d, TC-U-02e, TC-U-02f, TC-U-02g, TC-U-02h

- [x] **TASK-4**: Add TC-I-23b + TC-I-23c integration TCs in
  `team-roster-csv.test.ts` for `?provisioned_via=all` with mixed
  rows (sso-auto + manual-token + pre-v2-unknown).
  - files: `apps/server/tests/integration/team-roster-csv.test.ts`
  - tests: TC-I-23b, TC-I-23c

## Parallel Batches

4 tasks touch 4 disjoint file pairs. No shared files, no deps.

**LOCKED — inline sequential** (NOT worktree parallel): the 4 tasks
total ~50-80 LOC each including tests; worktree overhead (stale-base
checkout, file-copy merge, cleanup) exceeds the wall-time savings.
Inline sequential keeps validation focused per task. `/ralph-loop`
should execute each task in order, running `pnpm test --run <file>`
between tasks.

```text
Batch 1: [TASK-1]   — actions.ts schema extract + tests
Batch 2: [TASK-2]   — sso-auto-provision.ts predicate extract + tests
Batch 3: [TASK-3]   — audit-log-page-params.ts sibling create + page.tsx wire
Batch 4: [TASK-4]   — team-roster-csv.test.ts integration TCs
```

Per Quality > Velocity > Cost: the 4 tasks are small (~50 LOC each
incl. tests) and disjoint. Inline-sequential is fine; worktree-parallel
is also fine. Locked: inline sequential to skip worktree overhead +
keep validation focused (4 small tasks = ~5 min total).

## Validation Criteria

- [ ] `pnpm typecheck` passes (apps/server).
- [ ] `pnpm lint` passes.
- [ ] `pnpm test --run` passes (apps/server full suite).
- [ ] **Anti-regression spot-check**: `pnpm exec vitest --run app/manager/invites/actions.test.ts lib/auth/sso-auto-provision.test.ts tests/integration/audit-log-view.test.ts tests/integration/team-roster-csv.test.ts` — all pre-existing TCs in these 4 files continue GREEN (verifies the 3 extractions did not change observable behavior).
- [ ] `pnpm build` passes.
- [ ] **Live validation NOT required** — pure refactor + additive
  TCs, zero behavior change. The 4 new unit TC blocks + 2 integration
  TCs are the validation evidence.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### TASK-1 (2026-05-12 17:56)
Extracted `allowedSsoProvidersSchema` to named export from `actions.ts`. `createInviteFormSchema` now references the named schema. 7 new unit TCs (TC-U-01a..g) added. Final: 43/43 GREEN (36 existing + 7 new).

### TASK-2 (2026-05-12 17:59)
Extracted `enforceAllowedProviders` pure predicate (case-sensitive `.includes()`, empty-array = legacy any) from inline check at `sso-auto-provision.ts:643-646`. Callsite replaced with `if (!enforceAllowedProviders(invite, input.ssoProvider))`. 7 new unit TCs (TC-U-03a..g). Final: 48/48 GREEN (41 existing + 7 new).

### TASK-3 (2026-05-12 18:04)
Created `audit-log-page-params.ts` sibling holding `auditLogSearchParamsSchema`, `parseAuditLogSearchParams`, and the constants (`OUTCOME_VALUES`, `MAX_TEXT_LEN`, `MAX_PAGE`, `PAGE_SIZE`, `AuditLogOutcome`). `page.tsx` now imports + re-exports `AuditLogOutcome` for public surface compat. 8 unit TCs (TC-U-02a..h). **Bug fix bonus**: added `.default(0)` to `page` schema — production page would have crashed with ZodError on first visit without `?page=`. Final: 8/8 GREEN.

### TASK-4 (2026-05-12 18:05)
Added 2 integration TCs (TC-AO-23b/c) covering `?provisioned_via=all` happy path with mixed sso-auto + manual-token + pre-v2-unknown rows, plus the omitted-query default. Independent assertions per TC. Final: 9/9 GREEN in `team-roster-csv.test.ts`.

### Final validation (2026-05-12 18:06)
- typecheck: clean
- 1193 passed / 10 skipped / 1 pre-existing flake (`aggregate-team-outcomes:233` — unrelated)
- Net: +24 new TCs across 4 files; ~50 existing SSO TCs continue GREEN (anti-regression).
- Bonus: bug fix in `page.tsx` schema (page=undefined no longer crashes) shipped via TASK-3.
