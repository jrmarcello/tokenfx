import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Allow loopback only — central server is intended for org-internal hosting
  // (Vercel / fly.io / self-hosted). NOT a public unsigned API.
  experimental: { typedRoutes: true },
};

export default nextConfig;
