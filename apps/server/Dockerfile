# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Build context is the REPO ROOT (compose: `build.context: .`,
# `dockerfile: apps/server/Dockerfile`). The repo root is needed because
# apps/server's tsconfig.json includes `../../lib/*` via the `@root/*`
# path alias. The pnpm install runs against apps/server's own
# pnpm-lock.yaml — the app is designed to install standalone (no root
# workspace install required).
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1 — builder: native toolchain for bcrypt rebuild + standalone pnpm
# install + Next.js build + tsc compile of lib/db/migrate.ts so the runner
# stage runs pure Node (no tsx).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder

# Native toolchain FIRST (cached layer): bcrypt's node-gyp rebuild needs
# python3 + make + g++. --no-install-recommends keeps the layer slim;
# the runner stage starts from a clean node:22-slim so this never ships.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Mirror the host repo layout so apps/server's tsconfig `../../lib/*`
# alias resolves correctly during `next build`.
WORKDIR /repo

# Source trees first. They're light (the build context excludes node_modules
# and .next). We copy them before install so that any postinstall hook (in
# our case there are none — see --ignore-scripts) wouldn't surprise us.
# - apps/server/: the server itself.
# - lib/ (root tokenfx): apps/server's tsconfig.json includes
#   `../../lib/analytics`, `../../lib/reporter/*`, `../../lib/result.ts`
#   and aliases them via `@root/*` → `../../lib/*`.
COPY apps/server ./apps/server
COPY lib ./lib

WORKDIR /repo/apps/server

# Standalone pnpm install against apps/server's own lockfile.
# --ignore-scripts: pnpm v11 errors out (ERR_PNPM_IGNORED_BUILDS) when
# native deps aren't allow-listed in pnpm-workspace.yaml. The workspace
# allow-list lives at the repo root and isn't visible here. Skipping
# build scripts and rebuilding bcrypt explicitly below is both faster
# and matches the spec ("`pnpm rebuild bcrypt` explicit").
RUN pnpm install --frozen-lockfile --ignore-scripts

# Explicit bcrypt build against the runner's libc/abi (debian slim, glibc 2.36).
# `pnpm rebuild` is a no-op here because pnpm v11 requires the package to be
# explicitly allow-listed in pnpm-workspace.yaml's `onlyBuiltDependencies`,
# which lives at the repo root and isn't visible to this standalone install.
# Workaround: drive the install script directly from inside the bcrypt
# package via npm (node-pre-gyp downloads the pre-built binding for the
# active platform/abi when available, falls back to source build).
RUN cd node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt \
 && npm run install --foreground-scripts

# Webpack resolves modules referenced from /repo/lib/* (pulled in via the
# `@root/*` tsconfig alias) by walking up node_modules. /repo/lib has no
# node_modules of its own — but apps/server's node_modules contains every
# dep root-lib needs (zod, etc., transitive through apps/server). Symlink
# /repo/node_modules → apps/server/node_modules so the walk-up resolves.
RUN ln -s /repo/apps/server/node_modules /repo/node_modules

# Build-time env. Next.js's "Collecting page data" phase loads every
# route module top-level, triggering apps/server's production boot guards
# (INTERNAL_CRON_SECRET, ONBOARDING_EMAIL_HASH_PEPPER, AUTH_SECRET, etc).
# `next build` always evaluates those modules in NODE_ENV=production mode
# regardless of the build-time env. We provide dummy placeholders so the
# guards pass at build time; the real secrets are injected at container
# start via docker compose. These placeholders are NEVER used at runtime —
# the runner stage's ENV is overridden by compose for every guarded var.
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

# Next.js production build (writes .next/standalone via next.config.ts output: 'standalone').
RUN pnpm build

# Bundle migrate.ts → dist/migrate.js as a SELF-CONTAINED CJS file via
# esbuild. Includes all runtime deps (drizzle-orm + pg + transitive)
# inlined; only `pg-native` is externalized because it's an OPTIONAL
# native dep we never use (pg's pure-JS path is the default). Single
# file means the runner stage doesn't need to copy node_modules trees
# — significantly slimmer image + no resolution fragility.
RUN pnpm dlx esbuild@0.24 lib/db/migrate.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --external:pg-native \
      --outfile=dist/migrate.js

# Also bundle smoke-reset.ts AND smoke-seed.ts (called via docker exec
# from the host-side orchestrators). Same self-contained bundle pattern.
# bcrypt is externalized — its native binding must resolve at runtime;
# we add it via npm install in the runner stage below.
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
# this image (without the smoke profile's env) will boot in production
# mode — the bypass provider's `assertNotProductionWithBypass` guard
# refuses to wire the bypass and the server requires real SSO.
ENV NODE_ENV=production \
    PORT=3232 \
    HOSTNAME=0.0.0.0

# Next.js standalone bundle = server.js + trimmed node_modules + .next/server.
# For a build whose CWD is /repo/apps/server, standalone preserves the
# repo-relative layout under .next/standalone: apps/server/server.js,
# apps/server/.next/server, etc.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/.next/standalone/ ./
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/.next/static ./.next/static

# Drizzle migrations: migrate.ts loads them from disk via the drizzle
# migrator; the compiled migrate.js (commonjs) resolves paths relative
# to its own location, so we mirror the source layout.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/lib/db/migrations ./apps/server/lib/db/migrations

# Compiled migrate + smoke-reset + smoke-seed — self-contained CJS bundles
# via esbuild (built in stage 1). No node_modules trees needed at runtime
# EXCEPT for bcrypt (native binding) which the smoke-seed needs.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/migrate.js ./dist/migrate.js
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/scripts/smoke-reset.js ./dist/scripts/smoke-reset.js
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/dist/scripts/smoke-seed.js ./dist/scripts/smoke-seed.js

# bcrypt native binding for smoke-seed.js (externalized in the esbuild
# bundle because the napi-v3 .node file can't be inlined). Copy from
# builder where it was rebuilt against the slim runtime's glibc/abi.
COPY --from=builder --chown=tokenfx-server:tokenfx-server \
     /repo/apps/server/node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt \
     ./node_modules/bcrypt

# Healthcheck against /api/health (Next.js route inside the standalone bundle).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3232)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER tokenfx-server
EXPOSE 3232

# ENTRYPOINT — migrate then serve. Two CWDs:
#  1. migrate.js uses `migrationsFolder: './lib/db/migrations'` (relative).
#     The migrations live at /app/apps/server/lib/db/migrations.
#  2. server.js (Next.js standalone) lives at /app/server.js — the
#     standalone trimmed node_modules + .next are sibling to it.
# So: cd into apps/server for migrate, then cd back to /app for serve.
ENTRYPOINT ["sh", "-c", "cd /app/apps/server && node /app/dist/migrate.js && cd /app && node server.js"]
