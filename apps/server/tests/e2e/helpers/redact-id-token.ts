/**
 * `redactIdTokenLine` — privacy gate for the dev-server / idp-stub log
 * capture introduced by TASK-0 of `.specs/fix-sso-e2e-remaining-5.md`.
 *
 * Drops any JWT-shaped substring from a log line (`eyJ` header magic +
 * ≥10 base64-url chars). Auth.js v5 emits log lines that may include
 * `id_token=eyJ...` when debug instrumentation is on; the captured
 * `.logs/*.log` files MUST NOT contain raw bearer tokens (Threat Model
 * item 3 of the spec).
 *
 * Tradeoff: this is a coarse substring drop, not a structured-log
 * parser. A line like `note: eyJ is the JWT prefix` is preserved (under
 * the 10-char threshold). A line with the literal token bytes is
 * redacted. The regex collides only with strings that match the JWT
 * shape — collisions with non-token base64 strings of that length are
 * vanishingly rare in next-auth log output.
 */

// Match the FULL three-segment JWT: header.payload.signature. The
// `(?:\.[A-Za-z0-9_-]+)*` tail catches the payload + signature segments
// that follow the `eyJ` header — without it, the redactor would replace
// only the header and leave the payload (often a second `eyJ...`) +
// signature visible on disk. Self-review surface, code-reviewer MUST FIX.
const ID_TOKEN_RE = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/g;

export const redactIdTokenLine = (line: string): string =>
  line.replace(ID_TOKEN_RE, '[REDACTED]');
