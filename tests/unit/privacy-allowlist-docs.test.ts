// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SanitizedSessionPayload } from '@/lib/reporter/types';

/**
 * Docs↔code consistency guards (.specs/docs-reconciliation.md REQ-1/REQ-3).
 *
 * Lives in tests/unit/ (not colocated) because it spans two files across
 * directories: apps/server/README.md (the canonical privacy doc) and
 * lib/reporter/types.ts (the wire schema). Same precedent as
 * tests/unit/recompute-costs-args.test.ts.
 *
 * zod v4 note: `.strict()`/`.refine()` return `this`, so `.shape` is
 * directly accessible on SanitizedSessionPayload. Under zod v3 semantics
 * (.refine() wrapping in ZodEffects) this would need `_def.schema.shape`.
 */

type ExtractError = { kind: 'heading-not-found' | 'table-not-found' };
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

const ALLOWLIST_HEADING = /^###\s+Allowlist/;

/**
 * Extracts field names from every markdown table between the Allowlist
 * heading and the next same-or-higher-level heading that is not part of
 * the allowlist block (the "NEVER sent" section ends it). Skips alignment
 * rows, strips backticks and a trailing `[]` marker.
 */
const extractAllowlistFields = (
  markdown: string,
): Result<string[], ExtractError> => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => ALLOWLIST_HEADING.test(l));
  if (start === -1) return { ok: false, error: { kind: 'heading-not-found' } };

  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next "### NEVER sent" (or any h2) — subsection tables
    // under the allowlist (e.g. "#### Outcome fields") stay in scope.
    if (/^###\s/.test(line) || /^##\s/.test(line)) break;
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the empty string before the leading pipe.
    const first = cells[1] ?? '';
    if (first === '' || /^-+$/.test(first) || first.toLowerCase() === 'field') {
      continue; // alignment row / header row / empty
    }
    const name = first.replace(/`/g, '').replace(/\[\]$/, '');
    fields.push(name);
  }
  if (fields.length === 0) return { ok: false, error: { kind: 'table-not-found' } };
  return { ok: true, value: fields };
};

const readRepoFile = (rel: string): string =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('privacy allowlist doc ↔ wire schema consistency', () => {
  it('documents exactly the fields the SanitizedSessionPayload schema permits', () => {
    const markdown = readRepoFile('apps/server/README.md');
    const extracted = extractAllowlistFields(markdown);
    if (!extracted.ok) {
      throw new Error(`allowlist extraction failed: ${extracted.error.kind}`);
    }
    const documented = [...extracted.value].sort();
    const schemaFields = Object.keys(SanitizedSessionPayload.shape).sort();
    expect(schemaFields).toHaveLength(27);
    expect(documented).toEqual(schemaFields);
  });

  it('reports which fields diverge when the doc drifts from the schema', () => {
    const fixture = [
      '### Allowlist (fixture)',
      '',
      '| Field | Type |',
      '| --- | --- |',
      '| `session_id` | string |',
      '| `not_in_schema` | string |',
      '',
      '### NEVER sent',
    ].join('\n');
    const extracted = extractAllowlistFields(fixture);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const schemaFields = new Set(Object.keys(SanitizedSessionPayload.shape));
    const extra = extracted.value.filter((f) => !schemaFields.has(f));
    const missing = [...schemaFields]
      .filter((f) => !extracted.value.includes(f))
      .sort();
    expect(extra).toEqual(['not_in_schema']);
    // Exactly every schema field except the one the fixture documents.
    expect(missing).toEqual(
      [...schemaFields].filter((f) => f !== 'session_id').sort(),
    );
  });

  it('fails explicitly when the heading or table is absent', () => {
    expect(extractAllowlistFields('# nothing here')).toEqual({
      ok: false,
      error: { kind: 'heading-not-found' },
    });
    expect(
      extractAllowlistFields('### Allowlist (fields)\n\nprose only\n\n## next'),
    ).toEqual({ ok: false, error: { kind: 'table-not-found' } });
  });

  it('merges multiple tables, skips alignment rows and strips backticks and [] markers', () => {
    const fixture = [
      '### Allowlist (fixture)',
      '',
      '| Field | Type |',
      '| --- | --- |',
      '| `alpha` | int |',
      '| `beta[]` | array |',
      '',
      '#### Outcome fields (v3)',
      '',
      '| Field | Type |',
      '| --- | --- |',
      '| `gamma` | int |',
      '',
      '### NEVER sent',
    ].join('\n');
    const extracted = extractAllowlistFields(fixture);
    expect(extracted).toEqual({ ok: true, value: ['alpha', 'beta', 'gamma'] });
  });
});

describe('root README score weights — single source of truth', () => {
  it('enumerates the score weights exactly once (the canonical table)', () => {
    const markdown = readRepoFile('README.md');
    // Ordered tuple of the real weights, each anchored to a markdown table
    // cell (\`| 30% |\`) so stray percentages in prose can't satisfy it.
    // Gap budget: observed inter-row distance is ~70-100 chars; 400 leaves
    // room for wording changes without spanning into unrelated sections.
    const cell = (w: string): string => `\\|\\s*${w}\\s*\\|`;
    const tuple = new RegExp(
      [cell('30%'), cell('20%'), cell('15%'), cell('15%'), cell('10%'), cell('10%')].join(
        '[\\s\\S]{0,400}?',
      ),
      'g',
    );
    const matches = markdown.match(tuple) ?? [];
    expect(matches).toHaveLength(1);
    // Prove the single match IS the canonical table, not a coincidental
    // percentage run elsewhere: it must mention a real signal name.
    expect(matches[0]).toMatch(/avalia|rating|corre|cache/i);
  });
});
