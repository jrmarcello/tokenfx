# Cross-Stack Smoke Validation Runbook

End-to-end procedure to bring the full TokenFx stack (root dashboard + central reporter server + Postgres + OIDC stub) online via Docker Compose, seed deterministic data, exercise the ingestion + reporter + dashboards, and tear it down. Run this whenever a change crosses the root-app / reporter / server boundary or before cutting a release.

## Preconditions

- **Docker Desktop** running (or compatible engine with the `compose` plugin).
- **pnpm** 9 or newer.
- **Node.js** 22 or newer.
- **No port conflicts** on `3001`, `3131`, `3232`, `5432`. Check with:

  ```bash
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3001|3131|3232|5432)\b' || echo "ports free"
  ```

- Repository cloned and `pnpm install` already run at the workspace root.

## Step 1 — Build images

```bash
docker compose --profile smoke build
```

Builds the `root-app`, `reporter`, `server`, `oidc-stub`, and `postgres-smoke` images for the `smoke` profile. First build is slow (native deps); subsequent builds are cached.

## Step 2 — Up the stack

```bash
docker compose --profile smoke up -d
```

Wait for all services to report **HEALTHY**:

```bash
docker compose --profile smoke ps
```

Every row in the `STATUS` column must end with `(healthy)`. If any service stays `starting` for more than ~90s, see **Troubleshooting** below.

## Step 3 — Reset DBs

```bash
pnpm smoke:reset
```

Drops + recreates the root SQLite DB and the Postgres `tokenfx_smoke` schema. Safe to re-run; idempotent.

## Step 4 — Seed deterministic data

```bash
pnpm smoke:seed
```

Generates a fixed, known-shape dataset (3 sessions, 2 users, 1 org "Smoke Co", total cost $42.50) and writes `.env.smoke` with the connection strings + bypass tokens the next steps source.

## Step 5 — Re-ingest idempotency check

```bash
pnpm ingest
pnpm ingest
```

Runs the JSONL + OTEL ingestion pipeline twice. Verify the second run is a true no-op:

```bash
sqlite3 data/dashboard.db "SELECT COUNT(*) FROM sessions;"
# expected: 3
```

Same count after both runs ⇒ idempotent.

## Step 6 — Reporter push

```bash
source .env.smoke
pnpm reporter:once
```

The reporter reads from the root SQLite, transforms, and pushes aggregates to the central server's Postgres. Verify the rows landed:

```bash
docker compose --profile smoke exec postgres-smoke \
  psql -U tokenfx -d tokenfx_smoke -c "SELECT COUNT(*) FROM sessions_agg;"
```

Expected: `3`.

## Step 7 — Re-push idempotency

```bash
source .env.smoke
pnpm reporter:once
```

Run the reporter a second time. The summary line on stdout must read:

```text
pushed=0 skipped=3
```

Same hashes ⇒ no duplicate rows on the server side.

## Step 8 — Root dashboard validation

```bash
open http://localhost:3131/
```

Manual checklist (tick each before moving on):

- [ ] Page renders without 5xx
- [ ] Total cost = $42.50
- [ ] Session count = 3
- [ ] `/sessions`, `/effectiveness` render

## Step 9 — Server dashboard validation

```bash
open http://localhost:3232/manager/teams
```

The server image is built with `E2E_AUTH_BYPASS=1` for the smoke profile, so no SSO round-trip is needed. Checklist:

- [ ] Org "Smoke Co" visible
- [ ] User count = 2
- [ ] Cost agg matches root's $42.50
- [ ] `/manager/teams`, `/manager/activity`, `/me/dashboard` return 200

## Step 10 — SSO live (optional, Playwright)

Run only when explicitly validating the SSO flow against the OIDC stub:

```bash
pnpm exec playwright test --project=smoke --grep "@smoke"
```

This drives a real browser through the OIDC stub login and asserts the resulting session.

## Step 11 — Tear down

```bash
docker compose --profile smoke down
```

Stops the stack and removes containers + network. Volumes are preserved by default; add `-v` to also wipe `postgres-smoke` data.

## Troubleshooting

- **Port conflict on 3001/3131/3232/5432** — another process is already bound. Use `lsof -nP -iTCP -sTCP:LISTEN | grep <port>` to find it; stop it or override the published port in `docker-compose.yml` (`ports: ["<host>:<container>"]`).
- **bcrypt rebuild failure (toolchain missing in builder)** — the image lacks `python3` / `make` / `g++`. Either rebuild on a base image with the build toolchain installed or switch to a precompiled bcrypt build. Re-run `docker compose --profile smoke build --no-cache <service>`.
- **OIDC issuer mismatch** — `NEXTAUTH_URL` points to `localhost` while `OKTA_ISSUER` resolves via Docker DNS, so callback validation fails. Workarounds: enable `trustHost: true` on the NextAuth config, or align both to the same hostname (custom issuer config in the stub).
- **`postgres-smoke` not healthy in 90s** — likely a slow disk or a stale volume with an incompatible schema. Inspect: `docker compose --profile smoke logs postgres-smoke`. Recovery: `docker compose --profile smoke down -v && docker compose --profile smoke up -d`.
- **`.env.smoke` not generated** — `pnpm smoke:seed` failed before reaching the env-file writer (typically a server-side seed failure). Re-run `pnpm smoke:seed` and check stdout for the first error; fix that before retrying.

## Test gaps found

<!--
Populated during smoke execution.
Each gap: (i) description, (ii) trivial/non-trivial, (iii) fix-in-spec OR follow-up.
If no gaps: write "no gaps found" explicitly.
-->
