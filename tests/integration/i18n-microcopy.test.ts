import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TASK-3 of .specs/i18n-microcopy-consolidation.md
 *
 * Verifies that 8 KPI title strings on the personal dashboard surface
 * (3 files) have been migrated EN -> pt-BR while preserving the locked
 * technical terms ("Commits / PRs", "Output/Input", "OTEL").
 *
 * Rationale for raw text + regex (not rendering): rendering Server
 * Components in a test env requires the full Next.js runtime and DB
 * fixtures. The TASK is a pure substitution refactor — verifying the
 * source contents directly is the closest evidence and matches the
 * test plan note in the spec ("raw text check é suficiente").
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

const read = (relPath: string): string =>
  readFileSync(resolve(REPO_ROOT, relPath), 'utf-8');

describe('TASK-3: personal dashboard KPI titles migrated to pt-BR', () => {
  it('TC-I-13: app/page.tsx contains pt-BR KPI titles and preserves "Commits / PRs"', () => {
    const src = read('app/page.tsx');
    expect(src).toMatch(/title="Taxa de aceitação"/);
    expect(src).toMatch(/title="Custo por linha"/);
    expect(src).toMatch(/title="Tempo ativo"/);
    // Locked technical term — must remain EN
    expect(src).toMatch(/title="Commits \/ PRs"/);
  });

  it('TC-I-14: app/effectiveness/page.tsx contains "Razão Output/Input"', () => {
    const src = read('app/effectiveness/page.tsx');
    expect(src).toMatch(/title="Razão Output\/Input"/);
  });

  it('TC-I-15: app/sessions/[id]/page.tsx contains pt-BR KPI titles with OTEL preserved', () => {
    const src = read('app/sessions/[id]/page.tsx');
    expect(src).toMatch(/title="Taxa de cache hit"/);
    expect(src).toMatch(/title="Taxa de aceitação \(OTEL\)"/);
    expect(src).toMatch(/title="Tempo ativo"/);
  });

  it('TC-I-16: no old EN KPI strings remain as title= props in the 3 source files', () => {
    const files = [
      'app/page.tsx',
      'app/effectiveness/page.tsx',
      'app/sessions/[id]/page.tsx',
    ] as const;

    // We assert on `title="..."` props (the user-visible KPI title API).
    // Code identifiers, comments, or chart legend names are out-of-scope
    // for TASK-3 (see spec Section B + Anti-goals).
    const forbiddenTitles = [
      'Accept rate',
      'Cost per line',
      'Active time',
      'Output/Input ratio',
      'Cache hit',
      'Accept rate (OTEL)',
    ] as const;

    for (const file of files) {
      const src = read(file);
      for (const title of forbiddenTitles) {
        // Escape regex special chars in the title
        const escaped = title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const pattern = new RegExp(`title="${escaped}"`);
        expect(
          src,
          `${file} still has title="${title}"`
        ).not.toMatch(pattern);
      }
    }
  });
});
