import { fetchAndParse } from '@/lib/ingest/otel/parser';

const DEFAULT_URL = 'http://localhost:9464/metrics';
const TTL_MS = 60_000;

let cache: { at: number; ok: boolean } | null = null;

/**
 * Is Claude Code's Prometheus endpoint reachable right now?
 *
 * Used by the Nav badge to tell the user whether OTEL metrics are being
 * captured. Result is cached for 60s so every Server Component render
 * doesn't re-probe the endpoint. A 500ms timeout prevents page loads from
 * hanging when OTEL is off.
 */
export async function isOtelReachable(): Promise<boolean> {
  const url = process.env.OTEL_SCRAPE_URL ?? DEFAULT_URL;
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.ok;
  const result = await fetchAndParse(url, globalThis.fetch, {
    timeoutMs: 500,
  });
  const ok = result.ok && result.value.length > 0;
  cache = { at: now, ok };
  return ok;
}
