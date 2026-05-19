/**
 * Static check (TC-U-05 of `.specs/fix-sso-e2e-remaining-5.md`).
 *
 * Grep `tests/e2e/sso-*.spec.ts` for the legacy GET-style signin
 * initiation (`page.goto('/api/auth/signin/okta')`). Auth.js v5 rejects
 * that shape with `UnknownAction`; the canonical initiator is the
 * `initiateOktaSignin` helper (POST + CSRF token).
 *
 * Documented exception (locked in spec design): `sso-flow.spec.ts`
 * TC-E2E-01 uses `page.goto('/api/auth/signin')` + button click — that's
 * the signin PAGE, not the per-provider GET path, and the browser-driven
 * click is load-bearing for that specific test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const E2E_DIR = path.resolve(__dirname);

// Match `<obj>.goto('<base>/api/auth/signin/<provider>')` — the legacy
// per-provider GET shape Auth.js v5 rejects. The signin PAGE path
// `/api/auth/signin` (no provider segment) is allowed. `[a-zA-Z]`
// catches both lowercase (`okta`) and PascalCase-by-accident (`Okta`)
// — a typo renaming the provider segment should still be detected.
const FORBIDDEN_RE = /goto\([^)]*\/api\/auth\/signin\/[a-zA-Z]/;

describe('SSO spec files use initiateOktaSignin (no inline GET signin)', () => {
  it('TC-U-05: no per-provider GET signin in tests/e2e/sso-*.spec.ts', () => {
    const files = readdirSync(E2E_DIR)
      .filter((f) => f.startsWith('sso-') && f.endsWith('.spec.ts'))
      .map((f) => path.join(E2E_DIR, f));

    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (FORBIDDEN_RE.test(lines[i])) {
          violations.push({ file: path.basename(file), line: i + 1, text: lines[i].trim() });
        }
      }
    }

    expect(violations, `Inline GET signin detected — use initiateOktaSignin instead:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });
});
