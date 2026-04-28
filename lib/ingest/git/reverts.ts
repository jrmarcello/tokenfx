/**
 * Parse the stdout of `git log --pretty=oneline --grep="Revert.*"`
 * into the deduped set of revert-commit short SHAs that reference any
 * SHA from the given session window.
 *
 * Pure function — no I/O. Caller (TASK-3 collector) supplies the session
 * commit SHAs.
 *
 * Input shape (one revert-commit per line):
 *   `<short-sha> <subject>`
 *
 * A revert-commit is "matched" when its subject line literally contains
 * any of the `sessionShortShas` as a substring. The dedupe key is the
 * revert-commit SHA itself: if a single revert references two session
 * SHAs, it counts once.
 *
 * Empty / whitespace-only lines are skipped silently. Lines without a
 * space-separated SHA prefix are skipped (no error — `git log` output is
 * trusted to be well-formed; we just don't want to crash on a stray
 * blank line at EOF).
 */
export const parseRevertGrep = (
  stdout: string,
  sessionShortShas: readonly string[],
): Set<string> => {
  const reverts = new Set<string>();
  if (sessionShortShas.length === 0) return reverts;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx <= 0) continue;

    const revertSha = line.slice(0, spaceIdx);
    const subject = line.slice(spaceIdx + 1);

    // Match if any session SHA is referenced anywhere in the subject.
    // Substring match is intentional: revert subjects vary widely in
    // format ("Revert <sha>", "Revert \"foo\" (#123)", "Revert <sha> manually").
    for (const sessionSha of sessionShortShas) {
      if (subject.includes(sessionSha)) {
        reverts.add(revertSha);
        break;
      }
    }
  }

  return reverts;
};
