# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# idp-stub — single-stage image.
#
# This is a dev/test OIDC fixture (not a production service). The boot guard
# in src/index.ts refuses NODE_ENV=production, so the image is intentionally
# tied to NODE_ENV=development.
#
# Build context: `./apps/idp-stub` (set by docker-compose.yaml). The package
# has no workspace siblings in its dependency tree, so a context-local
# `pnpm install` is equivalent to a workspace-aware `pnpm install --filter
# @tokenfx/idp-stub...`. We skip --frozen-lockfile because the root
# pnpm-lock.yaml is outside this build context.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim

# Enable corepack so `pnpm` resolves from the bundled shim.
RUN corepack enable

# Non-root user (security best practice). UID/GID 1001 matches the convention
# used by the root tokenfx Dockerfile and apps/server/Dockerfile.
RUN groupadd -r -g 1001 idp-stub \
 && useradd -r -u 1001 -g 1001 -m idp-stub

WORKDIR /app

# Install deps first so subsequent source edits don't bust the dep cache.
# `tsx` lives in devDependencies but is required at runtime (CMD = `pnpm
# start` → `tsx src/index.ts`), so devDependencies must be installed.
# `--ignore-scripts` skips lifecycle hooks for transitive deps (notably
# esbuild's postinstall): pnpm ≥10 fails the install on un-approved build
# scripts, and esbuild's postinstall only fetches a precompiled native
# binary that npm already ships in @esbuild/<platform> — safe to skip.
COPY --chown=idp-stub:idp-stub package.json ./
RUN pnpm install --prod=false --ignore-scripts

# Copy source. tsconfig is needed because `tsx` reads it for path mappings.
COPY --chown=idp-stub:idp-stub tsconfig.json ./
COPY --chown=idp-stub:idp-stub src ./src

# Runtime defaults. The container overrides loopback bind so sibling
# services on the docker network can reach the listener via DNS.
ENV NODE_ENV=development \
    IDP_STUB_HOSTNAME=0.0.0.0 \
    IDP_STUB_PORT=3001

USER idp-stub
EXPOSE 3001

# Healthcheck: 5-line node one-liner against the OIDC discovery endpoint.
# Avoids adding wget/curl to the slim base. Probes against the in-container
# loopback (the container's own listener) so the check works even when the
# container is the only thing on its network.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.IDP_STUB_PORT||3001)+'/.well-known/openid-configuration',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["pnpm", "start"]
