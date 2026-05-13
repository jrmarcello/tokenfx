/**
 * Standalone logger for `apps/idp-stub`. Mirrors the shape of
 * `lib/logger.ts` (`{debug, info, warn, error}`) without importing it,
 * because the idp-stub is a separate Hono process and must not pull
 * Next.js deps.
 *
 * No `console.log` anywhere in `src/**` — only console.warn / console.error.
 * Boot/shutdown lines in `index.ts` use `process.stdout.write` directly.
 */
const noop = (): void => {
  /* no-op (silent in tests) */
};

const isQuiet = process.env.IDP_STUB_QUIET === '1';

export const log = {
  debug: noop,
  info: isQuiet ? noop : (...args: unknown[]) => console.warn('[idp-stub]', ...args),
  warn: (...args: unknown[]) => console.warn('[idp-stub]', ...args),
  error: (...args: unknown[]) => console.error('[idp-stub]', ...args),
} as const;
