# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Build context is the REPO ROOT (compose: `build.context: .`,
# `dockerfile: apps/server/Dockerfile`). apps/server is a member of the pnpm
# workspace and depends on `@tokenfx/shared` (packages/shared) via
# `workspace:*`. The install runs at the WORKSPACE ROOT against the single
# root `pnpm-lock.yaml` — no more per-app lockfile, no more `@root/*` alias,
# no more `COPY lib` + `ln -s node_modules` symlink hack. `@tokenfx/shared`
# resolves natively through the workspace and is inlined into the Next bundle
# via `transpilePackages` + traced into the standalone output via
# `outputFileTracingRoot` (see apps/server/next.config.ts).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1 — builder: native toolchain for bcrypt rebuild + workspace pnpm
# install + Next.js build + esbuild compile of migrate.ts / smoke scripts so
# the runner stage runs pure Node (no tsx).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder

# Native toolchain FIRST (cached layer): bcrypt's node-gyp rebuild needs
# python3 + make + g++. --no-install-recommends keeps the layer slim;
# the runner stage starts from a clean node:22-slim so this never ships.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /repo

# Workspace manifests + lockfile first (cache-friendly), then the member
# source trees. `.dockerignore` strips **/node_modules, **/.next, **/dist so
# the COPY layers stay light. Root `lib/`/`app/` source is NOT copied — the
# server no longer imports root `lib/*`; the only shared code is
# `packages/shared` (@tokenfx/shared).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps

# Workspace install filtered to the server + its dependency graph
# (`@tokenfx/shared`). --ignore-scripts: pnpm requires native deps to be
# allow-listed in the root pnpm-workspace.yaml's `onlyBuiltDependencies`;
# we skip build scripts here and rebuild bcrypt explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @tokenfx/server...

# Explicit bcrypt build against the runner's libc/abi (debian slim, glibc 2.36).
# Drive the install script directly from inside the (workspace-hoisted) bcrypt
# package via npm (node-pre-gyp downloads the pre-built binding for the active
# platform/abi when available, falls back to source build).
RUN cd node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt \
 && npm run install --foreground-scripts

# Build-time env. Next.js's "Collecting page data" phase loads every route
# module top-level, triggering apps/server's production boot guards
# (INTERNAL_CRON_SECRET, ONBOARDING_EMAIL_HASH_PEPPER, AUTH_SECRET, etc).
# Dummy placeholders let the guards pass at build time; the real secrets are
# injected at container start via docker compose. NEVER used at runtime — the
# runner stage's ENV is overridden by compose for every guarded var.
ENV NEXT_TELEMETRY_DISABLED=1 \
    INTERNAL_CRON_SECRET=build-placeholder-not-used-at-runtime \
    ONBOARDING_EMAIL_HASH_PEPPER=build-placeholder-not-used-at-runtime \
    AUTH_SECRET=build-placeholder-not-used-at-runtime \
    OKTA_ISSUER=http://build-placeholder \
    OKTA_CLIENT_ID=build-placeholder \
    OKTA_CLIENT_SECRET=build-placeholder \
    GOOGLE_CLIENT_ID=build-placeholder \
    GOOGLE_CLIENT_SECRET=build-placeholder \
    DATABASE_URL=postgres://build:placeholder@localhost:5432/build \
    NEXTAUTH_URL=http://localhost:3232

WORKDIR /repo/apps/server

# Next.js production build. `transpilePackages: ['@tokenfx/shared']` inlines the
# shared source into the webpack bundle; `outputFileTracingRoot` (= repo root)
# makes the standalone output root at /repo, so server.js lands at
# `.next/standalone/apps/server/server.js` and packages/shared is traced in.
RUN pnpm build

# Bundle migrate.ts → dist/migrate.js as a SELF-CONTAINED CJS file via esbuild.
# Includes all runtime deps (drizzle-orm + pg + transitive) inlined; only
# `pg-native` is externalized (optional native dep we never use). Single file
# means the runner stage doesn't need node_modules trees for migration.
RUN pnpm dlx esbuild@0.24 lib/db/migrate.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --external:pg-native \
      --outfile=dist/migrate.js

# Also bundle smoke-reset.ts AND smoke-seed.ts (called via docker exec from
# host-side orchestrators). Same self-contained pattern. bcrypt is externalized
# — its native binding must resolve at runtime; added via COPY in the runner.
RUN pnpm dlx esbuild@0.24 scripts/smoke-reset.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --external:pg-native \
      --outfile=dist/scripts/smoke-reset.js \
 && pnpm dlx esbuild@0.24 scripts/smoke-seed.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --external:pg-native \
      --external:bcrypt \
      --outfile=dist/scripts/smoke-seed.js

# ---------------------------------------------------------------------------
# Stage 2 — runner: minimal runtime. Standalone bundle + compiled migrate
# + migrations SQL files (read from disk by drizzle migrator).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runner

# Non-root user follows the Next.js docker convention (UID 1001).
RUN groupadd -r -g 1001 tokenfx-server \
 && useradd  -r -u 1001 -g 1001 -m tokenfx-server

WORKDIR /app
# Image default: NODE_ENV=production (safe by default — self-review Security
# MEDIUM-2 hardening). The smoke compose profile overrides to `development`
# explicitly via the `environment:` block, which is the ONLY place where
# `E2E_AUTH_BYPASS=1` is paired with a dev env. Standalone `docker run` of
# this image (without the smoke profile's env) boots in production mode — the
# bypass provider's `assertNotProductionWithBypass` guard refuses to wire it.
ENV NODE_ENV=production \
    PORT=3232 \
    HOSTNAME=0.0.0.0

# Next.js standalone bundle. With outputFileTracingRoot = repo root, the
# standalone tree is rooted at /repo, so it contains apps/server/server.js,
# packages/shared/ (traced), a root-level node_modules/, and package.json.
# Copying it to /app preserves that layout: /app/apps/server/server.js, etc.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/.next/standalone/ ./
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/.next/static ./apps/server/.next/static

# Drizzle migrations: migrate.js resolves `./lib/db/migrations` relative to the
# CWD it runs in (apps/server — see ENTRYPOINT), so mirror the source layout.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/lib/db/migrations ./apps/server/lib/db/migrations

# Compiled migrate + smoke-reset + smoke-seed — self-contained CJS bundles
# via esbuild (built in stage 1). No node_modules trees needed at runtime
# EXCEPT for bcrypt (native binding) which smoke-seed needs.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/migrate.js ./dist/migrate.js
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/scripts/smoke-reset.js ./dist/scripts/smoke-reset.js
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/scripts/smoke-seed.js ./dist/scripts/smoke-seed.js

# bcrypt native binding for smoke-seed.js (externalized in the esbuild bundle
# because the napi-v3 .node file can't be inlined). Copy from the builder where
# it was rebuilt against the slim runtime's glibc/abi. Workspace-hoisted store,
# so the path is /repo/node_modules/.pnpm (not apps/server/node_modules).
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt \
     ./node_modules/bcrypt

# Healthcheck against /api/health (Next.js route inside the standalone bundle).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3232)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER tokenfx-server
EXPOSE 3232

# ENTRYPOINT — migrate then serve, both from /app/apps/server:
#  1. migrate.js uses `migrationsFolder: './lib/db/migrations'` (relative to
#     CWD); migrations live at /app/apps/server/lib/db/migrations.
#  2. server.js (Next.js standalone) lives at /app/apps/server/server.js; its
#     traced node_modules sit at /app/node_modules (Node walks up to find them).
ENTRYPOINT ["sh", "-c", "cd /app/apps/server && node /app/dist/migrate.js && node server.js"]
