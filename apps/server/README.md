# TokenFx Server

Central manager dashboard for org-wide Claude Code consumption (cost + adoption).
Sibling app to the personal dashboard at the repo root.

- **Tech**: Next.js 15 + React 19 + Postgres 16 + Drizzle ORM + NextAuth (Auth.js v5).
- **Port (dev)**: 3232.
- **Auth**: SSO via Google Workspace + Okta. Role gating at middleware: `member`/`manager`/`admin`.

## Quick start

```bash
pnpm install
pnpm db:server:migrate
cd apps/server && cp .env.example .env
# Fill in env vars (DATABASE_URL, AUTH_SECRET, OAuth client IDs, etc.)
pnpm dev:server
```

The dev server boots on `http://localhost:3232`. Sign in via the configured SSO provider; first user in an org is auto-promoted to `admin` until role assignment ships.

## Privacy boundary (REQ-23)

This is the load-bearing contract between every dev's machine and the central
server. Read it end-to-end before pushing anything to a shared deployment.

The reporter on each dev's machine ships **sanitized aggregates only**. There
is no transcript content, no tool input/output, no filesystem path, and no
free-form note in the wire payload — by construction.

### Allowlist (20 fields permitted to leave the dev's machine)

| Field | Type | What it carries |
| --- | --- | --- |
| `session_id` | string | Opaque session ID |
| `started_at` | int | Unix timestamp ms |
| `ended_at` | int | Unix timestamp ms |
| `project_slug` | string | HMAC-SHA256(project_secret, last-cwd-segment) — non-reversible |
| `git_branch` | string \| null | Branch name (if dev opts to share) |
| `cc_version` | string \| null | Claude Code CLI version |
| `total_input_tokens` | int | Sum across turns |
| `total_output_tokens` | int | Sum across turns |
| `total_cache_read_tokens` | int | Sum across turns |
| `total_cache_creation_tokens` | int | Sum across turns |
| `total_cost_usd` | number | Local-computed cost |
| `total_cost_usd_otel` | number \| null | OTEL-reported cost (for calibration) |
| `turn_count` | int | # turns |
| `tool_call_count` | int | # tool calls |
| `model_breakdown[]` | array | Per model: model name, token sums, cost |
| `tool_counts` | map<string, int> | Tool name to count (no args, no results) |
| `avg_rating` | number \| null | -1..1 (manual rating) |
| `cache_hit_ratio` | number \| null | 0..1 |
| `output_input_ratio` | number \| null | 0..infinity |
| `subagent_usage_ratio` | number \| null | 0..1 |

### NEVER sent (with examples)

The following fields **NEVER** leave the dev's machine:

- `user_prompt` (the actual text you typed) -> e.g. *"refactor the auth module to use NextAuth v5"*
- `assistant_text` (Claude's response) -> entire transcript content
- `tool_uses_json` (raw tool inputs/outputs) -> e.g. file paths, shell commands, git diffs, error messages
- `tool_calls.input_json` and `tool_calls.result_json` (per-tool raw JSON)
- `cwd` (full filesystem path) -> e.g. `/Users/alice/Development/secret-project`
- `source_file` (full JSONL path)
- Rating notes (free-form text from the user) — only the numeric rating bubbles up

The sanitizer constructs the payload by **explicitly listing each allowed field**
— it does NOT spread input objects. A new field added upstream cannot leak by
accident; it requires explicit code change to the sanitizer + Zod schema.

Defense-in-depth layers:

1. Reporter sanitizer (field-by-field construction)
2. Zod `.strict()` at the wire (rejects unknown keys)
3. Server re-validates with the same Zod schema (REQ-25)

### Auditing payload before push

To inspect exactly what gets pushed before any network call:

```bash
pnpm reporter:once --dry-run
```

This prints the canonical JSON of the next batch to stdout and exits — no
network, no DB write. Run before every onboarding to verify the contract.

Red-team test (`lib/reporter/sanitizer.test.ts:TC-U-07`) injects 100 random
adversarial fields (`password`, `__proto__`, `prompt_text`, etc.) and asserts
zero leakage in the output.

### Revocation procedure

If a machine's HMAC secret is compromised:

1. Admin runs `UPDATE user_machines SET revoked_at = now() WHERE key_id = '<key>'`
   (or via the admin UI when the onboarding spec ships).
2. Subsequent push attempts return 401 (`unknown or revoked key`).
3. Re-onboard the dev (rerun `pnpm reporter:setup` per `central-server-onboarding.md`).

## Architecture quick-ref

- **Drizzle schema**: `apps/server/lib/db/schema.ts` (9 tables: orgs, teams, users, user_machines, sessions_agg, model_breakdown_agg, tool_count_agg, cost_calibration_per_user, ingestion_log)
- **Migrations**: `apps/server/lib/db/migrations/` (drizzle-kit generated; commit the SQL)
- **Reporter sanitizer**: `lib/reporter/sanitizer.ts` (root — single source of truth, also imported by `apps/server/lib/ingest/sanitizer-shared.ts`)
- **Onboarding**: see `.specs/central-server-onboarding.md` (carved-out spec for invite tokens)

## Rate limits

`POST /api/ingest`: 100 requests/minute per machine_id. 429 with `Retry-After: 60`.

## Cron endpoints

`POST /api/admin/cleanup` (daily, `x-internal-cron-secret`) — nulls `request_ip` for rows older than 30 days (REQ-27).
