import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 blocks cross-origin dev requests by default. Allow loopback hosts
  // so Playwright (http://127.0.0.1:3123) can exercise client-side fetches
  // against the dev server.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
