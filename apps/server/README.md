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

The dev server boots on `http://localhost:3232`. Sign in via the configured SSO provider; the first user in an org is auto-promoted to `admin`. Role assignment is available to admins at `/manager/admin/users` (`updateUserRoleAction`).

### Installing deps (workspace note)

Since 2026-05-12 the root `pnpm-workspace.yaml` declares `packages: ['apps/*']`, so `apps/server` **is** a workspace member — a plain `pnpm install` at the repo root installs everything, and running it from inside `apps/server/` also works.

> **Historical note:** before that date `apps/server` lived outside the
> workspace and required `pnpm install --ignore-workspace` from inside the
> directory. That ritual is no longer necessary; `apps/server/pnpm-lock.yaml`
> remains only for the standalone Docker build. If `tsc --noEmit` ever fails
> with `Cannot find module 'drizzle-orm'`, re-run `pnpm install` at the root.

## Privacy boundary (REQ-23)

This is the load-bearing contract between every dev's machine and the central
server. Read it end-to-end before pushing anything to a shared deployment.

The reporter on each dev's machine ships **sanitized aggregates only**. There
is no transcript content, no tool input/output, no filesystem path, and no
free-form note in the wire payload — by construction.

### Allowlist (27 fields permitted to leave the dev's machine)

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

#### Outcome fields (v3, optional)

Added by `manager-dashboard-v3-outcomes` (REQ-7). All 7 are `.optional().nullable()` in the wire schema: **old reporters omit the keys entirely** (`.optional()` keeps `.strict()` from rejecting them) and **new reporters send literal `null`** when the session has no evaluated outcome. Derived exclusively from local git metadata — never from transcript content.

| Field | Type | What it carries |
| --- | --- | --- |
| `commit_count` | int \| null | Commits attributed to the session window |
| `loc_added` | int \| null | Lines added (git numstat sum) |
| `loc_removed` | int \| null | Lines removed |
| `files_changed` | int \| null | Distinct files touched |
| `reverts_within_7d` | int \| null | Reverts of session commits within 7 days |
| `merged_pr_count` | int \| null | Merged PRs linked to session commits |
| `outcome_status` | enum \| null | `evaluated` \| `cwd-missing` \| `not-a-git-repo` \| `no-user-email` |

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

### Invite tokens at rest

Invite tokens are **hashed at rest**: `onboarding_invites.token_hash` stores
`sha256(token)`, never the plaintext (`token_prefix` keeps the first 8 chars
for UI/audit correlation). The redeem endpoint hashes the caller-supplied
plaintext before the lookup, so a read-only DB dump is not a usable
credential. The plaintext exists only once — in the invite URL returned at
creation time. Migration `0007_invite_token_hash` back-fills and hashes any
pre-existing rows in place; invites minted before the migration stay
redeemable by their original URL. See
`.specs/security-hardening-lowsev.md`.

### Revocation procedure

If a machine's HMAC secret is compromised (e.g. stolen laptop):

1. An **admin** opens `/manager/admin/machines`, finds the machine (listed by
   its 8-char key-id prefix, owner email, and last-seen), and clicks **Revoke**.
   This sets `revoked_at` and writes a `machine-revoked` row to
   `onboarding_audit_log` (actor + prefix, no secret). Revocation is idempotent
   and org-scoped — an admin can only revoke machines in their own org.
2. Subsequent push attempts return 401 (`unknown or revoked key`).
3. Re-onboard the dev (rerun `pnpm reporter:setup` per `central-server-onboarding.md`).

**Emergency fallback (SQL):** if two machines in the org share the same 8-char
key-id prefix, the UI reports a `collision` and cannot disambiguate — revoke by
full key-id directly:
`UPDATE user_machines SET revoked_at = now() WHERE key_id = '<full-key>'`.

## Architecture quick-ref

- **Drizzle schema**: `apps/server/lib/db/schema.ts` (23 tables — cost/adoption aggregates, onboarding/invites, auth & audit logs, manager views state; see the schema file for the authoritative list)
- **Migrations**: `apps/server/lib/db/migrations/` (drizzle-kit generated; commit the SQL)
- **Reporter sanitizer**: `lib/reporter/sanitizer.ts` (root — single source of truth, also imported by `apps/server/lib/ingest/sanitizer-shared.ts`)
- **Onboarding**: see `.specs/central-server-onboarding.md` (carved-out spec for invite tokens)

## Onboarding flow

Como um manager provisiona um colega de time pra reportar dados pro servidor central — fluxo invite-token + setup CLI (see `.specs/central-server-onboarding.md` REQ-7..15, REQ-17..22, REQ-26..36).

```text
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  Manager (web)   │     │   Slack / Email      │     │   Dev (CLI)      │
└────────┬─────────┘     └──────────┬───────────┘     └────────┬─────────┘
         │                          │                          │
         │ 1. Cria invite           │                          │
         │ /manager/invites         │                          │
         │ → onboard_url            │                          │
         │   (#token=… fragment,    │                          │
         │    visível 1× só)        │                          │
         │                          │                          │
         │ 2. Compartilha URL ──────►                          │
         │                          │ 3. Encaminha URL ────────►
         │                          │                          │
         │                          │                4. pnpm reporter:setup
         │                          │                  - cola URL ou token
         │                          │                  - confirma email
         │                          │                  - POST /api/onboarding/redeem-invite
         │                          │                          │
         │                          │                5. Server retorna
         │                          │                  { key_id, secret }
         │                          │                  → grava em data/reporter-config.json
         │                          │                          │
         │                          │                6. pnpm reporter:run
         │                          │                  → push contínuo (Bearer auth)
```

Passos:

1. **Manager cria o invite** em `/manager/invites/create`. Campos: team (opcional), `email_pattern` (opcional, ex.: `*@empresa.com`), `max_uses` (1..100, default 1), `expires_in_hours` (1..168, default 8).
2. O servidor gera o token (32 random bytes / 64 hex), insere `onboarding_invites` + `onboarding_audit_log` com `action='invite-created'` e responde com a URL `${central_url}/onboard#token=XXX`. **A URL completa só é exibida uma vez** (flash cookie HMAC-assinado, TTL 2min, `path=/manager/invites/created`).
3. **Manager compartilha** a URL via Slack/email. O fragmento `#token=…` nunca atinge o servidor (o navegador não envia fragmentos em requests HTTP) — mas **fica em histórico**. A página `/onboard` instrui o dev a copiar pro terminal imediatamente.
4. **Dev roda `pnpm reporter:setup`**. O CLI pede a URL (ou token) + o email de trabalho (default = `git config user.email`), confirma e faz `POST /api/onboarding/redeem-invite`.
5. **Server valida** (rate-limit, Zod, lookup `FOR UPDATE`, revoked / expired / exhausted / email-mismatch — todos uniformemente 401), executa a transação (upsert `users` por email, INSERT `user_machines` com `secret_hash = bcrypt(secret, 10)`, increment `used_count`, INSERT `onboarding_redemption_log`) e retorna `{ key_id, secret, central_url, user_email }`. **`secret` é o ÚNICO momento em que o plaintext sai pro cliente.**
6. **CLI grava `data/reporter-config.json`** (atomic write — `.tmp` + fsync + rename, mode 0600). Próximas pushes via `pnpm reporter:run` usam `Authorization: Bearer ${secret}` (REQ-6/7).

Pre-flight (REQ-32): se já existe um `reporter-config.json` válido (verificado via `GET /api/health` com Bearer), o setup recusa rerun sem `--force`. Útil pra evitar re-onboarding acidental que duplica máquinas.

## Threat model

Os 8 vetores que o desenho mitigou — explicação curta + onde o código materializa cada controle (see `.specs/central-server-onboarding.md` Context section).

| # | Vetor | Mitigação |
| --- | --- | --- |
| 1 | **Token leak via URL fragment** (browser history residual) | Fragmento (`#token=…`) nunca é enviado em requests HTTP; a página `/onboard` exibe warning ("This token is shown only once. Treat it like a password.") instruindo cópia imediata pro terminal. Risco residual = histórico do browser local — aceito. |
| 2 | **Token leak via Slack/email** (qualquer pessoa que vê a mensagem) | TTL curto (default 8h, máx 168h), single-use por padrão (`max_uses=1`), e `email_pattern` lock (ex.: `*@empresa.com`) — quem captura a URL ainda precisa controlar um email do domínio certo. |
| 3 | **Bruteforce de tokens** | 256-bit de entropia (`crypto.randomBytes(32).toString('hex')`) torna guessing infeasível. Rate limit dual: `(ip_truncated_24, 10/min)` + `(token, 3/min)` — ambas dimensões verificadas; qualquer uma excedida → 429. |
| 4 | **Token-existence probing** (atacante quer descobrir quais tokens existem) | TODAS as rejeições de token (invalid / expired / revoked / exhausted / email-mismatch) retornam **401 idêntico byte-a-byte**: `{"error":{"message":"invalid or expired invite","code":"unauthorized"}}`. Sem 403 vazando "seu token é válido mas o email tá errado". |
| 5 | **Manager session compromise → rogue invite** | Server Actions têm CSRF protection by default; `onboarding_audit_log` registra todo create/revoke com `actor_user_id` + `target_token_prefix` — qualquer convite forjado é rastreável. Re-auth a cada criação NÃO é exigido (queda ergonômica não justifica o ganho marginal). |
| 6 | **Replay de redeem após sucesso** | Increment de `used_count` é parte da MESMA transação do INSERT em `user_machines`. `SELECT ... FOR UPDATE` na linha do invite serializa attempts concorrentes; `max_uses=N` resulta exatamente em N aceitos e (M−N) `token-exhausted` pra M tentativas concorrentes. |
| 7 | **TLS off** (passar token em clear text) | Setup CLI recusa `central_url` não-HTTPS. Override apenas com `--allow-http` (dev-only, com warning ruidoso). Push contínuo via reporter assume HTTPS em produção. |
| 8 | **Email harvesting via redeem log** | `onboarding_redemption_log` armazena `email_domain` (ex.: `"empresa.com"`) + `email_hash = sha256(lowercase(email) + pepper)`. **Nunca o email completo.** Domain dá sinal coarse-grained de auditoria; hash permite contagem de emails únicos sem reversão. Pepper (`ONBOARDING_EMAIL_HASH_PEPPER`) protege contra rainbow-table mesmo se o DB vazar. |

Defesas em camadas adicionais que não se enquadram em vetor único:

- **Bcrypt cost factor 10** (~25ms) em `user_machines.secret_hash` — alinhado com Auth0/Stripe; cost 12 foi rejeitado por saturar o ingest hot-path. Cache em memória (60s TTL) evita re-bcrypt em cada push.
- **Authorization header parsing** segue RFC 7235: scheme `Bearer` case-insensitive; empty Bearer e schemes errados → 401.
- **DoS amplification protection**: rejeições antes da auth válida (rate-limit, Zod) NÃO escrevem em `onboarding_redemption_log` — bot scanner não consegue inflar storage. Apenas `logger.warn` estruturado.

## Operational procedures

Fluxos manuais que o time precisa rodar enquanto a UI dedicada pra cada um não chega.

### Revogar uma máquina comprometida

Quando o `secret` de uma máquina vaza (ex.: laptop roubado, leak em dotfiles públicos, dev offboarding):

```sql
UPDATE user_machines
SET revoked_at = now()
WHERE key_id = 'k_xxxxxxxxxxxxxxxx';
```

Após o UPDATE, qualquer push subsequente daquele `key_id` retorna 401 (`unknown or revoked key`). Re-onboarding é via novo invite + novo `pnpm reporter:setup` na máquina substituta. UI dedicada pra essa operação é uma spec follow-up (não chegou ainda).

Pra confirmar quais máquinas estão ativas:

```sql
SELECT key_id, hostname, last_seen_at, created_at
FROM user_machines
WHERE user_id = '<uuid>' AND revoked_at IS NULL
ORDER BY last_seen_at DESC;
```

### Rotacionar o pepper de email-hash

`ONBOARDING_EMAIL_HASH_PEPPER` é o segredo que impede rainbow-table reversa do `email_hash` em `onboarding_redemption_log`. Pra rotacionar:

1. Gera novo pepper (ex.: `openssl rand -hex 32`).
2. Bumpa o env var nos deployments (Vercel / Docker compose / etc.) e reinicia.
3. **Hashes existentes ficam incomparáveis** com hashes novos — aceito por design: o campo é usado pra contagem de emails únicos (uniqueness counting), não pra lookup. Não há query que cruze pré- e pós-rotação.

Não há migration de dados. Não há "rehash em massa" (impossível — não temos o email plaintext).

### Ler a trilha de auditoria

`onboarding_audit_log` registra todo `invite-created` e `invite-revoked` com `actor_user_id` + `target_token_prefix` + `metadata` JSONB.

```sql
SELECT *
FROM onboarding_audit_log
WHERE org_id = '<uuid>'
ORDER BY occurred_at DESC
LIMIT 50;
```

Pra investigar uma redemption suspeita, cruza com `onboarding_redemption_log` pelo `token_prefix`:

```sql
SELECT al.action, al.actor_user_id, al.occurred_at,
       rl.outcome, rl.email_domain, rl.received_at
FROM onboarding_audit_log al
LEFT JOIN onboarding_redemption_log rl
  ON rl.token_prefix = al.target_token_prefix
WHERE al.target_token_prefix = '<8-char prefix>'
ORDER BY al.occurred_at, rl.received_at;
```

`request_ip` em `onboarding_redemption_log` é truncado (`/24` IPv4, `/48` IPv6) e nullado após 30 dias por cleanup separado (parte da spec 3 REQ-27).

## Rate limits

`POST /api/ingest`: 100 requests/minute per machine_id. 429 with `Retry-After: 60`.

## Cron endpoints

`POST /api/admin/cleanup` (daily, `x-internal-cron-secret`) — nulls `request_ip` for rows older than 30 days (REQ-27).
