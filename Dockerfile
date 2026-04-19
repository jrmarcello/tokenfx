# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 — builder: full dependency tree + `pnpm build` with Next.js
# `output: 'standalone'` emit. Standalone traces the server import graph
# and copies only what the request path actually needs into
# `.next/standalone/node_modules/` — typically <100MB for a Next app.
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
# Stage 2 — runner: minimal runtime. Uses standalone's trimmed node_modules
# directly (no full-prod overlay) and adds tsx + the runtime deps that
# Next's tracer doesn't see through scripts/*.ts (outside the build graph).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runner

# Enable corepack so `docker compose exec app pnpm <script>` works.
# Non-root user follows the Next.js docker convention (UID 1001).
RUN corepack enable \
 && groupadd -r -g 1001 nextjs \
 && useradd -r -u 1001 -g 1001 -m nextjs

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3131 \
    HOSTNAME=0.0.0.0

# Next.js standalone bundle = server.js + trimmed node_modules + .next/server.
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

# Scripts' support files (not on the Next request path):
# - lib/: parsers/writer/queries. Most of these are already copied into
#   standalone by the tracer since the API routes import them, but the
#   tsx loader resolves from the scripts/ folder and needs the source
#   tree to exist at /app/lib.
# - schema.sql: loaded at runtime by lib/db/migrate.ts (read from disk).
# - scripts/: CLIs invoked via `pnpm ingest` / `pnpm watch` / `pnpm seed-dev`.
# - package.json: so `pnpm <script>` resolves command names.
COPY --from=builder --chown=nextjs:nextjs /app/lib ./lib
COPY --from=builder --chown=nextjs:nextjs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nextjs /app/package.json ./package.json

# Scripts' runtime deps live in a sidecar prefix so we don't pollute the
# standalone node_modules (which is tightly trimmed by Next's tracer —
# only 4 top-level packages: next, react, react-dom, better-sqlite3).
# Everything else used by lib/ingest/* got bundled into .next/server/chunks/
# by webpack, which is fine for the server runtime, but scripts/*.ts bypass
# webpack and use Node's native resolver — they need real packages on disk.
# NODE_PATH adds a fallback lookup location after the regular node_modules
# walk, so `require('zod')` in scripts resolves to the sidecar.
RUN mkdir -p /opt/scripts-deps \
 && cd /opt/scripts-deps \
 && npm init -y >/dev/null \
 && npm install --no-fund --no-audit --omit=dev --no-package-lock \
    tsx@^4 zod@^4 chokidar@^4 \
 && ln -s /opt/scripts-deps/node_modules/.bin/tsx /usr/local/bin/tsx
ENV NODE_PATH=/opt/scripts-deps/node_modules

RUN mkdir -p /app/data && chown -R nextjs:nextjs /app/data
USER nextjs
EXPOSE 3131
CMD ["node", "server.js"]
