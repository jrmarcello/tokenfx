/**
 * Typecheck-only test for `writeAuditRowsForRejection` (TC-U-23 / REQ-14).
 *
 * The helper is the audit fan-out for the REJECTED branch of SSO auto-
 * provisioning. Its `outcome` parameter must be the rejection-only subset
 * of `AuthEventOutcome` — i.e. `'accepted-sso-auto'` is structurally
 * unreachable from this code path and the type system must enforce that.
 *
 * Mechanism: this file does not execute any runtime assertions. It compiles
 * under `tsc --noEmit` (via `pnpm typecheck`) and via Vitest's test discovery
 * (the test runs but the body is gated by `if (false)`). If the
 * `@ts-expect-error` directive ever stops triggering (i.e. the type widens
 * back to include `'accepted-sso-auto'`), tsc fails this file with
 * "Unused '@ts-expect-error' directive."
 *
 * Hand-written stub deps satisfy `AutoProvisionDeps` shape just enough for
 * tsc — no mocking framework per `.claude/rules/ts-conventions.md`.
 */
import { test } from 'vitest';

import type { AutoProvisionDeps } from './sso-auto-provision';
import { writeAuditRowsForRejection } from './sso-auto-provision';

// Stub deps — only shape matters; the function is never invoked at runtime
// because the call site is gated by `if (false)`. Cast through `unknown` to
// keep the stub minimal while still satisfying the structural shape.
const stubDeps = {} as unknown as AutoProvisionDeps;

const stubArgs = {
  tokenPrefix: '00000000',
  ssoProvider: 'google',
  ssoIssuer: 'https://accounts.google.com',
  emailHash: 'sha256:stub',
  emailDomain: 'example.com',
  ssoSubjectHash: null,
  ip: '127.0.0.1',
  city: null,
  userAgent: 'stub/1.0',
} as const;

test('typecheck: writeAuditRowsForRejection outcome union excludes accepted-sso-auto', () => {
  if (false) {
    // Negative case — the rejection helper must NOT accept the success
    // outcome. If the type ever widens back to `Exclude<…, never>` (or any
    // union that re-includes 'accepted-sso-auto'), the `@ts-expect-error`
    // directive becomes unused and tsc fails the build.
    void writeAuditRowsForRejection(stubDeps, {
      // @ts-expect-error 'accepted-sso-auto' is excluded from the rejection helper's outcome union (REQ-14 / TC-U-23).
      outcome: 'accepted-sso-auto',
      ...stubArgs,
    });

    // Positive case — a rejection outcome compiles cleanly. Acts as the
    // canary: if this line errors, the type is too narrow, not too wide.
    void writeAuditRowsForRejection(stubDeps, {
      outcome: 'rejected-csrf',
      ...stubArgs,
    });
  }
});
