/**
 * RFC-4180-compliant CSV row formatter with OWASP formula-injection guard.
 *
 * Rules implemented:
 *  - RFC-4180 §2.1: rows terminate with CRLF.
 *  - RFC-4180 §2.5: cells containing `,`, `"`, CR, or LF are wrapped in
 *    double quotes; embedded `"` is escaped as `""`.
 *  - RFC-4180 §2.6: cells without special chars are emitted raw.
 *  - OWASP CSV Injection cheat sheet: cells whose trimmed value begins with
 *    `=`, `+`, `-`, `@`, TAB (\t), or CR (\r) are prefixed with a single
 *    apostrophe (`'`) to prevent spreadsheet apps (Excel, Google Sheets,
 *    LibreOffice) from interpreting the cell as a formula. The guard runs
 *    BEFORE quoting decisions, so a benign post-prefix cell stays raw and
 *    a post-prefix cell with special chars gets wrapped.
 *
 * Trade-off note: the `'` prefix is a *spreadsheet-layer* guard only.
 * RFC-4180-conforming parsers will include the literal apostrophe in the
 * cell value — spreadsheet apps strip it on import. Callers consuming the
 * CSV programmatically must be aware of this. We accept this trade-off
 * because the dominant consumer of an exported CSV is a spreadsheet app.
 *
 * Authority: https://owasp.org/www-community/attacks/CSV_Injection
 */

const QUOTE_REQUIRED = /[",\r\n]/;
const FORMULA_PREFIX_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Coerces a typed value to its CSV string form and decides whether the
 * OWASP formula-injection guard should apply. The guard is meaningful only
 * for *string* inputs — numbers and Dates are typed values produced by the
 * server (not user-supplied text), so we deliberately skip the guard for
 * them. A negative number like `-3` would otherwise be prefixed with `'`
 * and corrupt downstream consumers that expect numeric cells.
 */
const coerce = (
  value: string | number | Date | null | undefined,
): { text: string; guard: boolean } => {
  if (value === null || value === undefined) return { text: '', guard: false };
  if (value instanceof Date) return { text: value.toISOString(), guard: false };
  if (typeof value === 'number') return { text: String(value), guard: false };
  return { text: value, guard: true };
};

const guardFormula = (cell: string): string => {
  const trimmed = cell.trimStart();
  if (trimmed.length === 0) return cell;
  if (FORMULA_PREFIX_CHARS.has(trimmed[0]!)) return `'${cell}`;
  return cell;
};

const escapeCell = (cell: string): string => {
  if (!QUOTE_REQUIRED.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
};

export const toCsvRow = (
  values: ReadonlyArray<string | number | Date | null | undefined>,
): string => {
  const cells = values.map((v) => {
    const { text, guard } = coerce(v);
    return escapeCell(guard ? guardFormula(text) : text);
  });
  return `${cells.join(',')}\r\n`;
};
