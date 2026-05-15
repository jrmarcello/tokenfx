---
name: i18n-microcopy-consolidation test review
description: 2026-05-11 IN_PROGRESS review of 4 test files; vacuous TC-U-15, TC-ID numbering drift from TC-U-08 onward, TC-U-08/TC-I-21 absent, TC-I-26/27 skipped, TC-U-07 name mismatch
type: project
---

Spec: `.specs/i18n-microcopy-consolidation.md` (IN_PROGRESS)
Test files reviewed:
- `scripts/lint-locale.test.ts` (28 unit tests)
- `tests/integration/lint-locale-cli.test.ts` (CLI integration)
- `tests/integration/i18n-microcopy.test.ts` (pessoal surface)
- `apps/server/tests/integration/i18n-microcopy.test.ts` (manager surface, 46 tests)

Results: 36 + 46 = 82 total tests, all passing.

## Key Findings

**TC-U-15 VACUOUS (MUST FIX)**: Import strip test uses `criarConvite` which has zero diacritics — the test passes even if import stripping is completely broken. Fix: use `import { ação } from '@/lib/foo'` so the strip is load-bearing.

**TC-ID numbering drift (SHOULD FIX)**: From TC-U-08 onward the test file TC-IDs are off-by-one from the spec. Spec's TC-U-08 (CLI glob scope) is absent from the unit file and its slot was taken by what spec calls TC-U-09 (check-in-card allowlist). Everything from TC-U-09 through TC-U-24 in the test file maps to TC-U-10..25 in the spec. Root cause: TC-U-08 (CLI glob scope, scoped to main()) was never written as a unit test.

**TC-U-08 ABSENT (MUST FIX)**: Spec TC-U-08 ("CLI glob doesn't scan app/ files") has zero coverage. It's explicitly scoped to main() not lintLocale(). Should be in `tests/integration/lint-locale-cli.test.ts` as a spawnSync test asserting that a pt-BR fixture placed under `app/` is NOT flagged.

**TC-I-21 ABSENT (MUST FIX)**: "CLI clean workspace → exit 0, stdout empty" is in the spec (REQ-7 happy path) but not in any test file. CLI test file only has TC-I-22 (violations), TC-I-23 (--help), TC-I-24 (unknown flag), TC-I-25 (YAML). The clean-workspace exit-0 path is untested.

**TC-I-26 SKIPPED (MUST FIX)**: Execution log explicitly notes "TC-I-26 (fixture inject) skipped — pode ser smoke posterior." REQ-10 enforcement (non-inventoried string caught by lint) has no automated test. TC-I-22 covers violation detection but not the REQ-10-specific contract.

**TC-I-27 ABSENT (SHOULD FIX)**: "pnpm test --run passes post-migration" never became an automated test — only noted as a post-condition in TASK-2 notes.

**TC-U-07 name mismatch (NICE TO HAVE)**: Test name says `title="Convite criado"` but "Convite criado" has no diacritic; fixture correctly uses "Ação criada". Misleading but not a real gap.

**TC-U-12 EACCES assertion gap (SHOULD FIX)**: chmod 000 test tolerates root-runner by allowing both ok and error returns without asserting error.message or error.cause for the error branch.

**NFD fixture (OK)**: TC-U-17 uses actual NFD bytes (U+0061 + U+0303). Confirmed via raw byte analysis.

**Manager surface tests (OK)**: Static file-content assertions via fs.readFileSync — rationale documented in test file comment.

**No .only/.skip in tree**: confirmed clean.

**Why:** TC-U-15 vacuousness is a recurring pattern flagged in prior reviews. TC-ID drift makes spec traceability unreliable.
**How to apply:** Flag vacuous tests first (import/export strip TCs); check that the "should be stripped" fixture actually contains a diacritic so stripping failure = test failure.
