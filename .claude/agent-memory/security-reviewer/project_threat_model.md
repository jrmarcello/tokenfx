---
name: Project threat model
description: Threat model context for this project — localhost-only personal dashboard ingesting the user's own Claude Code transcripts
type: project
---

This is a single-user localhost-only dashboard. No auth by design. Primary threat surface is:
1. Path traversal through user-controlled paths into `~/.claude/projects/` (guard is `lib/fs-paths.ts`).
2. SQL injection through query params (all queries must be prepared + parameter-bound).
3. XSS from transcript content — user is the only source, but React escaping must not be bypassed (no `dangerouslySetInnerHTML`).
4. Accidental exposure if the Next.js server binds beyond localhost (check `next.config.ts`).

**Why:** The user is both the threat source and the victim — transcripts originate locally, so the realistic risks are bugs (traversal, injection) rather than hostile input.

**How to apply:** Don't over-index on CSRF/authn/authz (localhost, no mutation surface to worry about). Do focus on correctness of the path guard, prepared-statement discipline, and any feature that might accept a URL/path from outside this process.
