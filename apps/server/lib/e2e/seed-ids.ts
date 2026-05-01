/**
 * Deterministic ID helpers shared between the E2E seed (`scripts/seed-server.ts
 * --e2e`) and the Playwright suite (`tests/e2e/manager.spec.ts`).
 *
 * Both sides need to agree on org/team/user UUIDs without round-tripping
 * through the database — the seed writes them, the test mints JWTs with the
 * matching `orgId`. Keeping the formula in one place means any change is
 * mechanically reflected on both sides; if they drift, the test fails loudly.
 *
 * The SHA-1-derived UUID is **fixture-only**. RFC 4122 variant bits are
 * approximated, not strictly enforced. Never use this for production data.
 */
import { createHash } from 'node:crypto';

export const stableUuid = (key: string): string => {
  const hex = createHash('sha1').update(`tokenfx-e2e:${key}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
};

/**
 * Org slug → orgId helper. Mirrors `stableUuid('org:${slug}')` from
 * `seed-server.ts`. Hoisted as a named helper so call sites read as
 * `e2eOrgId('org-alpha')` instead of duplicating the namespace prefix.
 */
export const e2eOrgId = (slug: string): string => stableUuid(`org:${slug}`);
