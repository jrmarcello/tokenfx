import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { lintLocale } from './lint-locale';

// Tests use temp .tsx fixtures created inside process.cwd() so the
// resolveWithinWorkspace path-guard accepts them. The fixture directory is
// created/cleaned per-test.
//
// Note: per spec Design §Preprocessing pass 6, lines matching
// `^\s*(import|export)\s` are stripped before scanning. Fixtures therefore
// place diacritic content on non-export lines (typical real-world JSX
// where the export is the function declaration and content lives in
// inner returned markup).

describe('lintLocale', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.lint-locale-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const writeFixture = (relativeName: string, contents: string): string => {
    const file = path.join(tmpDir, relativeName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
    return file;
  };

  it('TC-U-01: returns empty for a clean ASCII-only file', () => {
    const file = writeFixture(
      'clean.tsx',
      `export const Page = () => <h1>Invites</h1>;\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-02: detects diacritic in <h1>Início</h1> with correct line + preview', () => {
    const file = writeFixture(
      'with-diacritic.tsx',
      `const Page = () => {\n  return <h1>Início</h1>;\n};\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    const v = result.value[0]!;
    expect(v.line).toBe(2);
    expect(v.preview).toContain('Início');
    expect(v.file).toBe(file);
  });

  it('TC-U-03a: ignores diacritics inside `// Início` line comments', () => {
    const file = writeFixture(
      'line-comment.tsx',
      `// Início do componente\nconst Page = () => <h1>Invites</h1>;\nexport { Page };\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-03b: ignores diacritics inside single-line /* Início */ block comments', () => {
    const file = writeFixture(
      'block-single.tsx',
      `/* Início do componente */\nconst Page = () => <h1>Invites</h1>;\nexport { Page };\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-03c: ignores diacritics inside multi-line /* ... */ block comments', () => {
    const file = writeFixture(
      'block-multi.tsx',
      `/*\n  Início\n  ação\n*/\nconst Page = () => <h1>Invites</h1>;\nexport { Page };\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-04: detects diacritics in string literal binding (algorithm is syntactically agnostic)', () => {
    const file = writeFixture(
      'string-binding.tsx',
      `const foo = "ação";\nconst Page = () => <h1>{foo}</h1>;\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.preview).toContain('ação');
    expect(result.value[0]!.line).toBe(1);
  });

  it('TC-U-05: detects diacritics in placeholder="Ação"', () => {
    const file = writeFixture(
      'placeholder.tsx',
      `const Page = () => (\n  <input placeholder="Ação" />\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.preview).toContain('Ação');
  });

  it('TC-U-06: detects diacritics in aria-label="Visão geral"', () => {
    const file = writeFixture(
      'aria-label.tsx',
      `const Page = () => (\n  <button aria-label="Visão geral" />\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.preview).toContain('Visão geral');
  });

  it('TC-U-07: detects diacritics in title="Convite criado"', () => {
    // Note: "Convite criado" itself has no diacritic chars — use "Ação criada"
    // to exercise the same attribute-value contract. The spec table A uses
    // "Convite criado" because it's pt-BR, but only diacritic-bearing words
    // ever trigger the regex; the contract under test is "regex matches in
    // attribute values".
    const file = writeFixture(
      'title.tsx',
      `const Page = () => (\n  <h1 title="Ação criada">x</h1>\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.preview).toContain('Ação criada');
  });

  it('TC-U-08: allowlist excludes apps/server/components/manager/check-in-card.tsx', () => {
    const allowlisted = path.resolve(
      process.cwd(),
      'apps/server/components/manager/check-in-card.tsx',
    );
    expect(fs.existsSync(allowlisted), 'allowlist file must exist').toBe(true);
    const result = lintLocale(allowlisted);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual([]);
  });

  it('TC-U-09: allowlist excludes apps/server/components/manager/dropoff-card.tsx', () => {
    const allowlisted = path.resolve(
      process.cwd(),
      'apps/server/components/manager/dropoff-card.tsx',
    );
    expect(fs.existsSync(allowlisted), 'allowlist file must exist').toBe(true);
    const result = lintLocale(allowlisted);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual([]);
  });

  it('TC-U-10: returns empty for an empty file', () => {
    const file = writeFixture('empty.tsx', '');
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-11: returns io error when file does not exist (ENOENT)', () => {
    const missing = path.join(tmpDir, 'does-not-exist.tsx');
    const result = lintLocale(missing);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.reason).toBe('io');
    expect(result.error.message).toContain(missing);
    const cause = result.error.cause as NodeJS.ErrnoException;
    expect(cause?.code).toBe('ENOENT');
  });

  it('TC-U-12: returns io error when file is unreadable (chmod 000)', () => {
    if (process.platform === 'win32') return;
    const file = writeFixture('locked.tsx', 'export const x = 1;\n');
    fs.chmodSync(file, 0o000);
    try {
      // Some test runners run as root → chmod 000 still readable; tolerate by
      // checking either an io error or ok return. The contract is "io
      // failure surfaces as io error", not "this specific fs op fails".
      const result = lintLocale(file);
      if (!result.ok) {
        expect(result.error.reason).toBe('io');
        expect(result.error.message.length).toBeGreaterThan(0);
        expect(result.error.cause).toBeDefined();
      }
    } finally {
      try {
        fs.chmodSync(file, 0o644);
      } catch {
        // ignore
      }
    }
  });

  it('TC-U-13: strips UTF-8 BOM before analysis', () => {
    const bomFile = writeFixture(
      'bom.tsx',
      `﻿export const Page = () => <h1>Invites</h1>;\n`,
    );
    const result = lintLocale(bomFile);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-14: returns multiple violations ordered by line', () => {
    const file = writeFixture(
      'multi.tsx',
      `const Page = () => (\n  <div>\n    <h1>Início</h1>\n    <p>Ação</p>\n  </div>\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(2);
    expect(result.value[0]!.line).toBeLessThan(result.value[1]!.line);
    expect(result.value[0]!.preview).toContain('Início');
    expect(result.value[1]!.preview).toContain('Ação');
  });

  it('TC-U-15: strips import lines before scan (diacritic in import path is ignored)', () => {
    // Diacritic in import path verifies the import-stripping pass is load-bearing —
    // without it, this fixture would fail the lint.
    const file = writeFixture(
      'import.tsx',
      `import { foo } from '@/lib/ação';\nconst Page = () => <h1>Invites</h1>;\nexport { Page };\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-16: strips export-from re-export lines before scan', () => {
    const file = writeFixture(
      'export.tsx',
      `export { default } from '@/foo/açao';\nconst x = 1;\nexport { x };\n`,
    );
    const result = lintLocale(file);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('TC-U-17: normalizes NFD-encoded diacritics to NFC before regex match', () => {
    // NFD form of "ã" is U+0061 (a) + U+0303 (combining tilde)
    const nfd = 'ã';
    const file = writeFixture(
      'nfd.tsx',
      `const Page = () => (\n  <h1>Ac${nfd}o</h1>\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBeGreaterThanOrEqual(1);
  });

  it('TC-U-18: detects French diacritic é (intentional false-positive per spec)', () => {
    const file = writeFixture(
      'french.tsx',
      `const Page = () => (\n  <h1>résumé</h1>\n);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    expect(result.value[0]!.preview).toContain('résumé');
  });

  it('TC-U-19: returns path-outside-workspace error for an absolute path outside cwd', () => {
    const outside = '/etc/passwd';
    const result = lintLocale(outside);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.reason).toBe('path-outside-workspace');
  });

  it('TC-U-20a: allowlist resolution accepts ./ prefix paths', () => {
    const rel = './apps/server/components/manager/check-in-card.tsx';
    const absolute = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(absolute)) return;
    const result = lintLocale(rel);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual([]);
  });

  it('TC-U-20b: allowlist resolution accepts relative path without prefix', () => {
    const rel = 'apps/server/components/manager/check-in-card.tsx';
    const absolute = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(absolute)) return;
    const result = lintLocale(rel);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual([]);
  });

  it('TC-U-20c: allowlist resolution accepts absolute resolved path', () => {
    const abs = path.resolve(
      process.cwd(),
      'apps/server/components/manager/check-in-card.tsx',
    );
    if (!fs.existsSync(abs)) return;
    const result = lintLocale(abs);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual([]);
  });

  it('TC-U-21: detects diacritic in JSX text node across multiple lines (line 2)', () => {
    const file = writeFixture(
      'jsx-text.tsx',
      `const Page = () => (<p>\n  Ação\n</p>);\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.line).toBe(2);
  });

  it('TC-U-22: detects violation on line 1', () => {
    const file = writeFixture('line-one.tsx', `const x = "ação";\n`);
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value[0]!.line).toBe(1);
  });

  it('TC-U-23: detects violation on the last line without trailing newline', () => {
    const file = writeFixture(
      'no-trailing-newline.tsx',
      `const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = "ação";`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.line).toBe(5);
  });

  it('TC-U-24: preserves line numbers after stripping multi-line block comment', () => {
    const file = writeFixture(
      'block-then-violation.tsx',
      `/* l1\n  l2\n */\n<h1>Ação</h1>\n`,
    );
    const result = lintLocale(file);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.line).toBe(4);
  });
});
