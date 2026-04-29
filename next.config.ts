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
  // NOTE: a previous redirect `/effectiveness → /` (from spec
  // unified-dashboard) was removed when spec effectiveness-personal-v2
  // re-introduced the dedicated `/effectiveness` deep-analysis page
  // (REQ-26..28). The home `/` keeps the consumption overview; the
  // effectiveness deep-dive lives at its own route again.
};

export default nextConfig;
