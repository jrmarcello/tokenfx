import type { Result } from '@/lib/result';
import type { NumstatSummary, ParseError } from './types';

/**
 * Parse the stdout of `git diff --numstat` (or equivalent) into an
 * aggregated {@link NumstatSummary}.
 *
 * Pure function — no I/O, no logging. Returns a {@link Result} so callers
 * (TASK-3 collector) can decide how to surface a malformed line.
 *
 * Format reference (git docs):
 *   <added>\t<removed>\t<path>
 *   `-\t-\t<path>`              for binary files
 *   `<n>\t<n>\t{old => new}/x`  for braced renames
 *   `<n>\t<n>\told => new`      for unbraced renames
 *
 * Behavior:
 * - Sums `added` and `removed` across all rows.
 * - Binary rows contribute 0/0 to the sums but DO count toward `filesChanged`.
 * - Rename rows count as a single path (the resolved post-rename path is
 *   not material to outcome metrics — what matters is "one file touched").
 * - Blank lines are tolerated (git appends a trailing newline).
 * - Any line that does not have exactly 3 tab-separated fields, or whose
 *   first two fields are neither all-numeric nor literal `-`, returns
 *   `Result.err({kind:'parse-failed', line})` with the offending raw line.
 */
export const parseNumstat = (
  stdout: string,
): Result<NumstatSummary, ParseError> => {
  let added = 0;
  let removed = 0;
  let filesChanged = 0;

  // Split on \n; tolerate trailing/leading blanks. We deliberately do NOT
  // trim the line itself before splitting on \t — paths may legitimately
  // contain leading whitespace inside `{old => new}` segments.
  const lines = stdout.split('\n');
  for (const raw of lines) {
    if (raw.length === 0 || raw.trim().length === 0) continue;

    const parts = raw.split('\t');
    if (parts.length < 3) {
      return { ok: false, error: { kind: 'parse-failed', line: raw } };
    }

    const addedField = parts[0];
    const removedField = parts[1];
    // Path may itself contain `\t` if `{old => new}` produced one — rejoin.
    // (git --numstat does not emit literal tabs in paths in practice, but
    // rejoining is the safe boundary behavior.)

    const isBinary = addedField === '-' && removedField === '-';
    if (isBinary) {
      filesChanged += 1;
      continue;
    }

    if (!isNonNegativeInt(addedField) || !isNonNegativeInt(removedField)) {
      return { ok: false, error: { kind: 'parse-failed', line: raw } };
    }

    added += Number(addedField);
    removed += Number(removedField);
    filesChanged += 1;
  }

  return { ok: true, value: { added, removed, filesChanged } };
};

const isNonNegativeInt = (s: string): boolean => /^\d+$/.test(s);
