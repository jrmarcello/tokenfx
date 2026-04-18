---
name: review
description: Single-agent code review for TypeScript/Next.js conventions, security, and data layer
user-invocable: true
---

# /review [file|branch]

Code review focused on TypeScript/React/Next.js conventions, security, and data-layer quality.

## Scope

- No arguments: review all uncommitted changes (`git diff` + `git diff --cached`)
- File path: review specific file
- Branch name: review all changes on branch vs main

## Checklist

### TypeScript

- [ ] No `any`; uses `unknown` + narrowing at boundaries
- [ ] No non-null assertions (`!`) without justification
- [ ] Named exports preferred (defaults only where Next requires)
- [ ] Zod validation at ingestion/API boundaries
- [ ] Result pattern (or typed errors) for fallible operations; avoid throwing across module boundaries

### React / Next.js (App Router)

- [ ] Server Components by default; `'use client'` only when needed
- [ ] Data fetched in Server Components via `lib/queries/*`, not client fetch
- [ ] Mutations via Server Actions or Route Handlers; `revalidatePath`/`revalidateTag` after writes
- [ ] Rules of Hooks respected; `key` on lists; no prop drilling where composition works
- [ ] `loading.tsx` / `error.tsx` present for long-running or fallible routes

### Data Layer (better-sqlite3)

- [ ] All queries via `db.prepare(...)` with parameter binding — no string concat
- [ ] Prepared statements hoisted / memoized, not rebuilt per call
- [ ] Multi-statement writes wrapped in `db.transaction(fn)`
- [ ] Indexes on foreign keys and common WHERE/ORDER BY columns
- [ ] Idempotency via `ON CONFLICT DO UPDATE` or natural keys

### Security

- [ ] No credentials in code
- [ ] Path traversal guard for filesystem reads (`lib/fs-paths.ts`)
- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] No PII in logs; no transcripts shipped to external services

### Testing

- [ ] New code has corresponding tests (Vitest)
- [ ] Tests colocated (`foo.ts` + `foo.test.ts`)
- [ ] Hand-written stubs (no mocking frameworks)
- [ ] Error paths and boundaries covered, not only happy paths

### Project Quality

- [ ] `lib/logger.ts` used instead of `console.log` in library/UI code
- [ ] Public modules have clear names; internal helpers colocated
- [ ] No dead code, no TODOs lingering without issue references

## Output Format

For each finding:

```text
[SEVERITY] file:line — Description
  Suggested fix: ...
```

Severities: MUST FIX, SHOULD FIX, NICE TO HAVE
