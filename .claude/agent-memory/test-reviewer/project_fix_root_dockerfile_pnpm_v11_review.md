---
name: fix-root-dockerfile-pnpm-v11 test-plan review
description: 2026-05-15 DRAFT review — REQ-3 pnpm-v11 host gap, TC-I-05 wrong methodology, TC-I-07 vacuous, TC-I-08 hash criterion unexecutable, missing failure-mode TCs, TC-E2E-01 fixture values unexplained
type: project
---

2026-05-15 DRAFT review of `.specs/fix-root-dockerfile-pnpm-v11.md`.

**Why:** Docker/pnpm build infra fix for root Dockerfile failing under pnpm v11 (ERR_PNPM_IGNORED_BUILDS). Spec changes pnpm-workspace.yaml (allow-list) + Dockerfile (native toolchain).

**How to apply:** Use these gaps when executing the spec to write or strengthen TCs before marking tasks done.

Gaps:
- REQ-3 pnpm-v11 host path has zero TCs (only pnpm-v9 host is exercised)
- TC-I-05 tests `pnpm exec` inside the runner stage, which only has corepack enabled — should test native binding via the app server startup instead
- TC-I-07 vacuous (no port/URL/body assertion specified)
- TC-I-08 "same content hash" criterion is not executable (layer hash always changes with base image bumps)
- No infra-failure TCs for: toolchain-missing (apt failure), esbuild binary download failure, frozen-lockfile mismatch after workspace config change
- No TC verifying ERR_PNPM_IGNORED_BUILDS fires WITHOUT the fix (confirms fix is load-bearing, not vacuous)
- TC-E2E-01 cites specific fixture values ($42.50, session count 3) with no seeding explanation
- TC-I-02/TC-I-03 don't specify how build logs are asserted (grep on --progress=plain output?)
