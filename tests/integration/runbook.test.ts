import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * TC-U-10 — Smoke runbook structure.
 *
 * The cross-stack smoke validation is a manual procedure documented in
 * `docs/smoke-runbook.md`. The runbook is the single authoritative copy
 * of the operator-facing steps and trapdoors; if a section header is
 * renamed or dropped accidentally, operators lose their place mid-flow.
 *
 * This test asserts the runbook contains every section header listed in
 * `cross-stack-smoke-validation.md` Design §6, in order. It is a
 * structural guard, not a content guard.
 */

const RUNBOOK_PATH = resolve(__dirname, '..', '..', 'docs', 'smoke-runbook.md');

const REQUIRED_SECTIONS = [
  'Preconditions',
  'Step 1 — Build images',
  'Step 2 — Up the stack',
  'Step 3 — Reset DBs',
  'Step 4 — Seed deterministic data',
  'Step 5 — Re-ingest idempotency check',
  'Step 6 — Reporter push',
  'Step 7 — Re-push idempotency',
  'Step 8 — Root dashboard validation',
  'Step 9 — Server dashboard validation',
  'Step 10 — SSO live (optional, Playwright)',
  'Step 11 — Tear down',
  'Troubleshooting',
  'Test gaps found',
] as const;

// Escape every regex metacharacter so we can build a matcher from a literal
// section title (which contains parentheses, em-dashes, etc.).
const escapeRegex = (literal: string): string =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const headerRegexFor = (section: string): RegExp =>
  new RegExp(`^#{2,3}\\s+${escapeRegex(section)}\\s*$`, 'm');

describe('docs/smoke-runbook.md', () => {
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');

  it.each(REQUIRED_SECTIONS.map((section) => ({ section })))(
    'contains section header: $section',
    ({ section }) => {
      expect(runbook).toMatch(headerRegexFor(section));
    },
  );

  it('lists every section in the order specified by the spec', () => {
    const positions = REQUIRED_SECTIONS.map((section) => {
      const match = runbook.match(headerRegexFor(section));
      // Each section is asserted-present by the table above, so a missing
      // match here would already have failed; we re-check defensively.
      expect(match, `section "${section}" missing`).not.toBeNull();
      return match?.index ?? -1;
    });

    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i],
        `section "${REQUIRED_SECTIONS[i]}" must appear after "${REQUIRED_SECTIONS[i - 1]}"`,
      ).toBeGreaterThan(positions[i - 1]);
    }
  });
});
