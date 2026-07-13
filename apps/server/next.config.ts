import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Transpile the source-only shared workspace package (its `exports` point at
  // .ts). Without this, Next won't transpile TS from node_modules and the
  // build/runtime fails to resolve `@tokenfx/shared/*`.
  transpilePackages: ['@tokenfx/shared'],
  // `@tokenfx/shared` lives at ../../packages/shared, outside this app's dir.
  // Anchor the standalone file-tracing at the monorepo root so the trace picks
  // it up (replaces the old `ln -s ... node_modules` Docker hack).
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Allow loopback only — central server is intended for org-internal hosting
  // (Vercel / fly.io / self-hosted). NOT a public unsigned API.
  experimental: { typedRoutes: true },
};

export default nextConfig;
