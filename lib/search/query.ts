/**
 * Transcript search helpers — pure sanitization + clamping utilities.
 *
 * These helpers run at the API/page boundary before building an FTS5 query.
 * Zod lives one layer up (on the API route / page search param parser); this
 * module assumes strings and numbers have already been narrowed to the right
 * primitive types, and focuses on FTS5-safety and value normalization.
 */

/**
 * A single transcript search result as surfaced to the UI.
 *
 * Fields are already normalized: `timestamp` is epoch-ms, `score` is the
 * FTS5 bm25 rank negated so that higher-is-better, and the two `*Snippet`
 * fields are the raw output of FTS5's `snippet()` (still containing the
 * literal `<mark>` / `</mark>` delimiters that {@link renderSnippet}
 * understands).
 */
export type SearchHit = {
  turnId: string;
  sessionId: string;
  project: string;
  sequence: number;
  timestamp: number;
  model: string;
  score: number;
  promptSnippet: string;
  responseSnippet: string;
};

/** Characters that carry special meaning in FTS5 MATCH expressions. */
// Includes `"` (phrase delimiter), `:` (column filter), `*` (prefix operator),
// `(` / `)` (grouping), `-` (NOT operator when leading a term), `;` (belt-and-
// braces for SQL-injection-minded reviewers, even though MATCH is bound as a
// parameter), NUL and other C0 control chars (e.g. CR, LF, TAB — stripped to
// keep the query single-line).
const FTS5_SYNTAX_RE = /[":*()\-;\x00-\x1f]/g;

const MAX_RAW_LEN = 200;

const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * Turn a raw user search string into an FTS5 MATCH-safe expression or
 * `null` when the input cannot yield any useful term.
 *
 * Rules (see REQ-13 in the transcript-search spec):
 * - Trim and split on whitespace.
 * - Returns `null` when the trimmed input is empty, whitespace-only, or
 *   has ≤1 useful character.
 * - Returns `null` when the trimmed input exceeds 200 characters.
 * - Each surviving token has FTS5 syntactic characters stripped, is wrapped
 *   in double quotes (phrase) and suffixed with `*` (prefix match).
 * - `AND`/`OR`/`NOT` uppercase operators from user input are treated as
 *   plain terms — they are quoted, never interpreted.
 * - Unicode (including diacritics like `café`) passes through untouched.
 * - `foo*bar` is documented as splitting at `*` into two terms
 *   (`"foo"* "bar"*`) — we strip the `*` as a syntactic character and
 *   re-split so the user cannot smuggle operators mid-token.
 */
export const sanitizeFtsQuery = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length <= 1) return null;
  if (trimmed.length > MAX_RAW_LEN) return null;

  // Strip FTS5 syntactic chars first; the replacement becomes whitespace so
  // that e.g. `foo*bar` splits into two tokens below.
  const scrubbed = trimmed.replace(FTS5_SYNTAX_RE, ' ');

  const terms = scrubbed
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) return null;

  return terms.map((t) => `"${t}"*`).join(' ');
};

/**
 * Clamp a user-supplied limit to `[1, 100]`, defaulting to 25 when
 * `undefined`. Non-integer inputs are floored. NaN / non-finite defaults
 * to {@link DEFAULT_LIMIT}.
 */
export const normalizeLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < MIN_LIMIT) return MIN_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
};

/**
 * Coerce a user-supplied offset to a non-negative integer. Defaults to 0
 * when `undefined`, NaN, or negative.
 */
export const normalizeOffset = (offset: number | undefined): number => {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const n = Math.floor(offset);
  return n < 0 ? 0 : n;
};

/**
 * Render an FTS5 `snippet()` string for safe insertion into the DOM via
 * React's `dangerouslySetInnerHTML`.
 *
 * FTS5 is told to emit `<mark>` / `</mark>` as the literal snippet
 * delimiters. We HTML-escape the entire string first (so any transcript
 * content like `<script>` becomes inert), then undo the escape for the
 * exact two tokens we control. Nothing else can produce a live tag.
 */
export const renderSnippet = (snippetFromFts5: string): { __html: string } => {
  const escaped = snippetFromFts5
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const withMarks = escaped
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');

  return { __html: withMarks };
};
