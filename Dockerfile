# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 — deps: prod-only dependency tree. Re-used by the runner stage so
# we don't ship dev deps (vitest, playwright, typescript) into the runtime
# image. Native binding (better-sqlite3) is compiled here so the runtime
# arch matches (slim = Debian glibc).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS deps

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod \
 && pnpm rebuild better-sqlite3

# ---------------------------------------------------------------------------
# Stage 2 — builder: full dependency tree + `pnpm build` with Next.js
# `output: 'standalone'` emit. Scripts + schema + lib get copied into runner
# directly from here (unmodified source), so no separate "sources" stage.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile \
 && pnpm rebuild better-sqlite3

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3 — runner: minimal runtime. Standalone server + prod-only node_modules
# + scripts. Installs `tsx` globally for `pnpm ingest` / `pnpm watch` invoked
# via `docker compose exec`.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runner

# Enable corepack so `docker compose exec app pnpm <script>` works.
# Create non-root user (UID 1001 is the Next.js docker convention).
# `tsx` is a devDep in package.json but scripts/*.ts need it at runtime —
# install it globally so it's on PATH without polluting pnpm-lock.yaml.
RUN corepack enable \
 && groupadd -r -g 1001 nextjs \
 && useradd -r -u 1001 -g 1001 -m nextjs \
 && npm install -g tsx@^4

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3131 \
    HOSTNAME=0.0.0.0

# Next.js standalone bundle = server.js + .next/server + minimal deps.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

# Runtime artifacts for scripts (outside the Next build graph):
# - lib/: parsers, writer, queries — scripts import from here
# - schema.sql: loaded at runtime by lib/db/migrate.ts
# - scripts/: CLIs invoked via `pnpm ingest` / `pnpm watch` / `pnpm seed-dev`
# - package.json + pnpm-lock.yaml: so `pnpm <script>` resolves by name
# - deps stage's prod-only node_modules: replaces standalone's trimmed
#   tree with zod/chokidar/better-sqlite3/etc that scripts need. Server.js
#   ignores extras, so no downside.
COPY --from=builder --chown=nextjs:nextjs /app/lib ./lib
COPY --from=builder --chown=nextjs:nextjs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nextjs /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps --chown=nextjs:nextjs /app/node_modules ./node_modules

# SQLite DB lives at /app/data/dashboard.db (volume-mounted by compose).
# Pre-create + chown so the non-root user can write on first boot when
# the host mount is empty.
RUN mkdir -p /app/data && chown -R nextjs:nextjs /app/data

USER nextjs
EXPOSE 3131
CMD ["node", "server.js"]
