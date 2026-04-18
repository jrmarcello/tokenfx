---
name: full-review-team
description: Parallel 3-agent review (code + security + data)
user-invocable: true
---

# /full-review-team

Launches a parallel code review with 3 specialized agents auditing the codebase independently.

## Team

### 1. Code Reviewer (code-reviewer agent)

- TypeScript correctness (no `any`, strict null checks, discriminated unions)
- React / Next.js App Router conventions (Server Components default, revalidation, Rules of Hooks)
- shadcn/ui composition
- Error handling (Result pattern, typed errors)
- Test quality (Vitest colocated, hand-written stubs, error paths)

### 2. Security Reviewer (security-reviewer agent)

- SQL injection (prepared statements via better-sqlite3)
- Path traversal in filesystem reads (`~/.claude/projects/`)
- XSS (dangerouslySetInnerHTML, unsafe bypasses)
- CSRF / API route exposure
- Secret exposure (credentials, PII in logs, transcripts sent externally)
- Dependency risk (unpopular/native packages)

### 3. Data Reviewer (data-reviewer agent)

- SQLite schema design (types, constraints, NOT NULL, CHECK)
- Query performance (EXPLAIN QUERY PLAN, indexes on FK and filter/sort columns)
- PRAGMA configuration (`foreign_keys=ON`, `journal_mode=WAL`)
- Transaction usage (`db.transaction(fn)` for multi-statement writes)
- Idempotency patterns (ON CONFLICT, natural keys)

## Execution

Launch all 3 agents in parallel using Agent tool:

```text
Agent(code-reviewer): Review codebase for TS/React/Next conventions and test quality
Agent(security-reviewer): Audit codebase for injection, traversal, XSS, secrets
Agent(data-reviewer): Analyze SQLite schema, queries, PRAGMA, and transactions
```

## Output

Synthesize findings into a unified report and save as `docs/review-report-YYYY-MM-DD.md` (using the current date).

The report must include:

1. Executive summary table (severity x category counts)
2. All findings grouped by priority (CRITICAL/MUST FIX first)
3. Deduplicated findings (when multiple reviewers flag the same issue)
4. Positive findings section (patterns to preserve)
5. Recommended action plan in phases

| Category | Severity | Count |
| --- | --- | --- |
| Code | MUST FIX / SHOULD FIX / NICE TO HAVE | N |
| Security | CRITICAL / HIGH / MEDIUM / LOW | N |
| Data | MUST FIX / SHOULD FIX / NICE TO HAVE | N |
