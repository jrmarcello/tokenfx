---
applies-to: "**/*"
---
# Security Rules

## Credentials

- Never commit real credentials or secrets
- `.env` files must be in `.gitignore`
- Use environment variables for all secrets
- No hardcoded API keys, tokens, or passwords anywhere in the repo

## Data Protection

- Never log PII or full transcript bodies — summary counts / IDs only
- Don't ship user prompt content to external services (this tool is local-only by design)
- Sanitize error messages before surfacing them to the UI
- Use a consistent error response shape for API routes: `{ error: { message: string, code?: string } }`

## Code Safety

- SQLite via `better-sqlite3` — ALL queries MUST use prepared statements with parameter binding (`db.prepare(sql).run(params)`, `.get()`, `.all()`). Never template-literal or concatenate values into SQL.
- Validate all external input (API route bodies, CLI args, file contents) via Zod schemas at the boundary.
- Path traversal guard: any filesystem read driven by user-controlled paths must resolve the path and verify it stays within the allowed root (typically `~/.claude/projects/`). Reject `..` segments before normalization. Centralize in `lib/fs-paths.ts`.
- No `dangerouslySetInnerHTML` without sanitized, documented-as-trusted input.

## Infrastructure

- Bind the dev/prod server to `localhost` only — do not expose to the LAN without an explicit threat model
- No service-to-service auth required (localhost-only)
- `better-sqlite3` is a native dep — keep it, and any new native deps, documented in the README
