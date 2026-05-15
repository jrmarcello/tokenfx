---
name: cross-stack-smoke-validation spec review (2026-05-14)
description: Findings from reviewing the 13-task cross-stack smoke implementation — Dockerfiles, compose, reset/seed scripts, integration tests, E2E smoke spec
type: project
---

Key findings from reviewing the cross-stack-smoke-validation spec implementation.

**Why:** Recorded so future reviews of smoke infrastructure or cross-stack test files know which bugs were found and confirmed.

**How to apply:** Reference when modifying smoke scripts, cross-stack reporter test, or docker-compose smoke profile.

## MUST FIX

1. `tests/integration/cross-stack-reporter.test.ts:456` — `seedPg` INSERT into `users` omits `sso_provider` and `sso_subject` (`NOT NULL` per migration 0000_init.sql). Fails at PG constraint on `RUN_CROSS_STACK_SMOKE=1` runs.

2. `apps/server/scripts/smoke-seed.ts:17-19` — `Result<T,E>` re-declared locally instead of importing from `@/lib/result` or from `@/lib/result.ts`. `smoke-reset.ts` does the same at line 72-74. Two separate local re-declarations means callers importing both could get type incompatibility if the canonical definition ever diverges.

## SHOULD FIX

3. `tests/integration/runbook.test.ts:62` — `match!.index ?? -1` non-null assertion without a comment justifying the invariant. The comment 2 lines above says "previous expect would have thrown" but that only holds if this code is inside the same `it` block where the assertion ran — it isn't (it's inside the outer `positions.map` lambda inside the second test, which runs AFTER all the individual section tests in the `it.each`). The positions are independent test runs; if vitest skips on fail-fast the map could run against a section that didn't pass. Use `runbook.match(headerRegexFor(section))?.index ?? -1` instead.

4. `apps/server/scripts/smoke-seed.ts:274-279` — `isCli` detection uses `endsWith('smoke-seed.ts') || endsWith('smoke-seed.js')` which is fragile (matches any path ending with those strings, e.g. a `my-smoke-seed.ts`). Prefer the `fileURLToPath(import.meta.url) === process.argv[1]` pattern used in `scripts/smoke-reset.ts`.

5. `tests/integration/cross-stack-reporter.test.ts:146,160` — `null as number | null` casts on `total_cost_usd_otel` are redundant inside an `as const` object literal. `null` is already `null`, and the outer `as const` freezes the shape. Remove the casts; add an explicit type annotation to the `SEED` constant instead if the `number | null` union needs to be expressed.

## NICE TO HAVE

6. `scripts/smoke-seed.ts:17-19` — local `Result<T,E>` re-declaration should import `@/lib/result` like `scripts/smoke-reset.ts` already does. Consistency and single source of truth.

7. `docker-compose.yaml:126-136` — `tokenfx-idp-stub` healthcheck in compose uses `localhost:3001` (loopback) while the Dockerfile sets `IDP_STUB_HOSTNAME=0.0.0.0` as the bind address. The healthcheck runs in the container's network namespace where `localhost` IS the container loopback, so this works — but the comment explaining this is absent, making it look inconsistent with the `127.0.0.1` probe in the Dockerfile healthcheck.

8. `tests/integration/cross-stack-reporter.test.ts:514` — `pickPort` uses `31_000 + random() * 1_000` without collision detection between `idpPort` and `serverPort`, so there is a 1-in-1000 chance both calls return the same port. Use a counter (`let nextPort = pickPort(); const getPort = () => nextPort++`) or call `net.createServer` / `net.listen(0)` to let the OS assign.
