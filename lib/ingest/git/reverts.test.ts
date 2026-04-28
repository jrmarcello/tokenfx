import { describe, it, expect } from 'vitest';
import { parseRevertGrep } from './reverts';

describe('parseRevertGrep', () => {
  it('TC-U-06: returns deduped revert shas referencing session shas', () => {
    const stdout = [
      'abc1234 Revert "foo" (#123)',
      'ef56789 Revert sha1234 manually',
    ].join('\n');
    const result = parseRevertGrep(stdout, ['sha1234']);
    expect(result.size).toBe(1);
    expect(result.has('ef56789')).toBe(true);
  });

  it('TC-U-07: empty input returns empty set', () => {
    const result = parseRevertGrep('', []);
    expect(result.size).toBe(0);
  });

  it('TC-U-08: revert-commit mentioning 2 different session shas counted once (dedupe)', () => {
    const stdout = 'abc1234 Revert sha1111 and sha2222 in one go';
    const result = parseRevertGrep(stdout, ['sha1111', 'sha2222']);
    expect(result.size).toBe(1);
    expect(result.has('abc1234')).toBe(true);
  });

  it('matches multiple distinct revert-commits', () => {
    const stdout = [
      'aaaa111 Revert sha1111 manually',
      'bbbb222 Revert sha2222 manually',
    ].join('\n');
    const result = parseRevertGrep(stdout, ['sha1111', 'sha2222']);
    expect(result.size).toBe(2);
    expect(result.has('aaaa111')).toBe(true);
    expect(result.has('bbbb222')).toBe(true);
  });

  it('ignores revert-commits that do not reference any session sha', () => {
    const stdout = 'abc1234 Revert "unrelated" (#999)';
    const result = parseRevertGrep(stdout, ['sha1234']);
    expect(result.size).toBe(0);
  });

  it('skips blank lines and malformed rows', () => {
    const stdout = '\n\nabc1234 Revert sha1234 manually\n   \n';
    const result = parseRevertGrep(stdout, ['sha1234']);
    expect(result.size).toBe(1);
    expect(result.has('abc1234')).toBe(true);
  });
});
