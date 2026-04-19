import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 blocks cross-origin dev requests by default. Allow loopback hosts
  // so Playwright (http://127.0.0.1:3123) can exercise client-side fetches
  // against the dev server.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Emit a minimal standalone server bundle (`.next/standalone/server.js`
  // + trimmed `node_modules/`) so the Docker runtime image stays small.
  // No impact on `pnpm dev` — only `pnpm build` gains the emit step.
  output: 'standalone',
};

export default nextConfig;
