/**
 * Next.js 15 instrumentation hook. Runs once on server boot (both `next
 * dev` and `next start`/standalone) BEFORE any request is served.
 *
 * Sole responsibility: emit a loud, visible warning when localhost-only
 * open-access mode is active so a misconfigured production deploy
 * surfaces immediately in the boot log. The actual security enforcement
 * lives in `middleware.ts` (request-time Host check) — this is just
 * diagnostic noise to make the operational state obvious.
 *
 * Spec: `.specs/auth-optional-mode-and-sso-bugfixes.md` (REQ-2, Threat
 * Model "Security-critical invariants").
 */

import { isAuthRequired } from './lib/auth/auth-required';

export const register = (): void => {
  if (!isAuthRequired(process.env)) {
    console.warn(
      '⚠️  AUTH_REQUIRED=false — all manager dashboards are open-access. ' +
        'Set AUTH_REQUIRED=true for production.',
    );
  }
};
