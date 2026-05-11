/**
 * Anti-regression lint: scans the manager surface (`apps/server/app/manager`,
 * `apps/server/app/onboard`, `apps/server/app/me`,
 * `apps/server/components/manager`) for pt-BR diacritics. The surface is
 * locked to EN per the i18n-microcopy-consolidation spec — any diacritic
 * in a `.tsx` file outside the explicit allowlist is treated as a
 * regression.
 *
 * The tool exposes both:
 *  - a library function {@link lintLocale} that returns a typed `Result` of
 *    violations or an `io` / `path-outside-workspace` error (consumed by
 *    tests and by the CLI entrypoint below); and
 *  - a CLI entrypoint that enumerates `.tsx` files under the manager
 *    surface globs, runs `lintLocale` on each, and exits non-zero when
 *    violations are found.
 *
 * Output convention: stdout for `--help`, stderr for diagnostics and
 * violation listings. The CLI deliberately uses `process.stdout.write` /
 * `process.stderr.write` directly rather than `lib/logger.ts` because the
 * logger respects `LOG_LEVEL` and a CI run with `LOG_LEVEL=warn` would
 * silently suppress `--help`. See spec §Design / CLI output strategy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWithinWorkspace } from '../lib/fs-paths';
import type { Result } from '../lib/result';

export type LintViolation = {
  readonly file: string;
  readonly line: number;
  readonly preview: string;
};

export type LintErrorReason = 'io' | 'path-outside-workspace';

export type LintError = {
  readonly reason: LintErrorReason;
  readonly message: string;
  readonly cause?: unknown;
};

const DIACRITIC_RE = /[áàâãéêíóôõúüç]/gi;

// Allowlist: files where legitimate-EN copy is locked verbatim and must not
// be touched (REQ-5 / REQ-11 verbatim from manager-dashboard-v2). Paths are
// resolved against process.cwd() at first use.
const ALLOWLIST_RELATIVE: readonly string[] = [
  'apps/server/components/manager/check-in-card.tsx',
  'apps/server/components/manager/dropoff-card.tsx',
];

const buildAllowlist = (): readonly string[] => {
  return ALLOWLIST_RELATIVE.map((rel) => {
    const abs = path.resolve(process.cwd(), rel);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  });
};

/**
 * Preprocess `text` by replacing characters inside comments, imports, and
 * exports with spaces (newlines preserved) so the diacritic regex doesn't
 * fire on intentional non-user-visible content. Returns a string of the
 * same length as `text` so offsets map 1:1 to line numbers in the original.
 */
const preprocess = (text: string): string => {
  // 1. Normalize Unicode (NFC) — defence against NFD source files where
  //    `ã` would arrive as U+0061 U+0303 and miss the diacritic class.
  let out = text.normalize('NFC');

  // 2. Strip UTF-8 BOM (first char only)
  if (out.charCodeAt(0) === 0xfeff) {
    out = out.slice(1);
  }

  // 3. Strip block comments, preserving newlines. The lambda substitutes
  //    every non-newline character with a space so offsets line up.
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  // 4. Strip line comments. Same length-preserving substitution.
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  // 5. Strip import / export lines. Done line-by-line to keep the
  //    string-length invariant. We match `^\s*(import|export)\s` after
  //    line splitting.
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:import|export)\s/.test(line)) {
      lines[i] = ' '.repeat(line.length);
    }
  }
  out = lines.join('\n');

  return out;
};

const offsetToLine = (text: string, offset: number): number => {
  // 1-indexed line number for `offset` (count newlines in the prefix).
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) line++;
  }
  return line;
};

/**
 * Scan a single `.tsx` file for pt-BR diacritics outside of comments and
 * import/export statements. Returns a `Result` containing the (possibly
 * empty) list of violations, or a typed error.
 */
export const lintLocale = (filePath: string): Result<LintViolation[], LintError> => {
  const workspace = process.cwd();

  const resolved = resolveWithinWorkspace(workspace, filePath);
  if (!resolved.ok) {
    return {
      ok: false,
      error: {
        reason: 'path-outside-workspace',
        message: resolved.error.message,
      },
    };
  }
  const realPath = resolved.value;

  // Allowlist check — compare canonical realpaths.
  const allowlist = buildAllowlist();
  if (allowlist.includes(realPath)) {
    return { ok: true, value: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(realPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: {
        reason: 'io',
        message: `failed to read ${realPath}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      },
    };
  }

  // Share base text between scanner and preview extractor so character
  // indexing stays aligned (esp. when BOM is present).
  const normalized = raw.normalize('NFC');
  const withoutBom = normalized.charCodeAt(0) === 0xfeff ? normalized.slice(1) : normalized;
  const scanned = preprocess(withoutBom);
  const originalLines = withoutBom.split('\n');

  // De-duplicate by line: a single user-visible word may contain multiple
  // diacritic chars (e.g. "ação" → ç + ã); reporting one violation per
  // line keeps the CLI output signal-to-noise high. Preserve ascending
  // line order for stable output.
  const seenLines = new Set<number>();
  const violations: LintViolation[] = [];
  let match: RegExpExecArray | null;
  DIACRITIC_RE.lastIndex = 0;
  while ((match = DIACRITIC_RE.exec(scanned)) !== null) {
    const line = offsetToLine(scanned, match.index);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const preview = (originalLines[line - 1] ?? '').trim();
    violations.push({ file: realPath, line, preview });
  }

  return { ok: true, value: violations };
};

/**
 * Recursively enumerate `.tsx` files under the given roots, filtering out
 * files that resolve to an allowlisted path. Missing roots are silently
 * ignored — they may not exist in every checkout (e.g. spec fixture only).
 */
const enumerateFiles = (roots: readonly string[]): string[] => {
  const allowlist = new Set(buildAllowlist());
  const collected: string[] = [];
  for (const rel of roots) {
    const abs = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(abs)) continue;
    const entries = fs.readdirSync(abs, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.tsx')) continue;
      // Node 20: .path; Node 22+: .parentPath
      const parent =
        (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        abs;
      const file = path.resolve(parent, entry.name);
      let canonical = file;
      try {
        canonical = fs.realpathSync(file);
      } catch {
        // ignore
      }
      if (allowlist.has(canonical)) continue;
      collected.push(canonical);
    }
  }
  collected.sort();
  return collected;
};

const USAGE = `Usage: tsx scripts/lint-locale.ts [--help]\n\nScans manager surface .tsx files for pt-BR diacritics.\nExit codes: 0 = clean, 1 = violations or I/O error, 2 = unknown flag.\n`;

const MANAGER_SURFACE_ROOTS: readonly string[] = [
  'apps/server/app/manager',
  'apps/server/app/onboard',
  'apps/server/app/me',
  'apps/server/components/manager',
];

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  const unknown = args.find((a) => a.startsWith('--') && a !== '--help');
  if (unknown) {
    process.stderr.write(`Unknown flag: ${unknown}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const files = enumerateFiles(MANAGER_SURFACE_ROOTS);
  const violations: LintViolation[] = [];
  for (const file of files) {
    const result = lintLocale(file);
    if (!result.ok) {
      process.stderr.write(`I/O error on ${file}: ${result.error.message}\n`);
      process.exitCode = 1;
      continue;
    }
    violations.push(...result.value);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`${v.file}:${v.line}: ${v.preview}\n`);
    }
    process.exitCode = 1;
  }
};

// Entry guard: invoke main() only when this file is executed directly
// (not when imported by tests). The ESM idiom compares the URL of the
// current module against the executed script path.
const invokedDirectly = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main();
}
