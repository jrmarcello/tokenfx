---
applies-to: "**/*.{ts,tsx}"
---

# TypeScript Conventions

## Type Safety

- TS strict mode is non-negotiable. Do not disable it in `tsconfig.json`.
- No `any`. Use `unknown` and narrow with type guards or Zod schemas.
- No non-null assertions (`x!`) unless the invariant is truly guaranteed and accompanied by a comment explaining why.
- Prefer `readonly` and `as const` for data that should not be mutated.
- Exhaustive `switch` statements with a `const _exhaustive: never = value` fallback.

## Exports

- Named exports preferred over default exports.
- Exception: Next.js App Router files REQUIRE default exports for `page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`, `not-found.tsx`, and `route.ts` handlers' conventional shape where applicable.

## Error Handling

- Result/Either pattern at module boundaries (parsers, ingestion, analytics):

  ```ts
  export type Result<T, E = Error> =
    | { ok: true; value: T }
    | { ok: false; error: E };
  ```

- When you must throw, use `throw new Error(msg, { cause })` to preserve chains.
- Prefer returning a `Result` over throwing at module boundaries — let the caller decide how to surface failure.

## Logging

- No `console.log` in library (`lib/**`) or UI (`components/**`, `app/**`) code.
- Use `lib/logger.ts` with `debug` / `info` / `warn` / `error`. The logger is a no-op in tests.

## Functions

- Prefer `const fn = (...) => { ... }` for module-level utilities and component handlers.
- Use `function` declaration only when a hoisted, named function is needed (rare).

## Runtime Validation

- Zod at every ingestion boundary (JSONL parser, OTEL parser, API route bodies).
- Parse at the boundary; downstream code consumes typed values.

## Tests

- Tests colocated: `foo.ts` + `foo.test.ts` in the same directory.
- Table-driven tests with descriptive `it.each([...])` entries.
- Hand-written stubs colocated in the same `*.test.ts` — no mocking frameworks.
- Fixtures live under `tests/fixtures/`.
