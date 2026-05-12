import { describe, it, expect } from 'vitest';

import { truncateUserAgent } from './truncate-user-agent';

describe('truncateUserAgent', () => {
  it('truncates a string longer than 512 characters to exactly 512 characters', () => {
    const input = 'a'.repeat(1000);
    const result = truncateUserAgent(input);
    expect(result.length).toBe(512);
    expect(result).toBe('a'.repeat(512));
  });

  it('returns a 512-character string unchanged', () => {
    const input = 'b'.repeat(512);
    const result = truncateUserAgent(input);
    expect(result).toBe(input);
    expect(result.length).toBe(512);
  });

  it('returns an empty string unchanged', () => {
    expect(truncateUserAgent('')).toBe('');
  });

  it('returns a short string (< 512) unchanged', () => {
    const input = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    expect(truncateUserAgent(input)).toBe(input);
  });

  it('documents UTF-16 surrogate-pair behavior at the 512 boundary', () => {
    // String.prototype.slice operates on UTF-16 code units, not code points.
    // A non-BMP character like an emoji (e.g. '😀' / U+1F600) is encoded as a
    // surrogate pair (2 code units). If such a pair straddles index 512, slice
    // will split it and the result will contain a lone (invalid) surrogate.
    //
    // Trade-off: real-world User-Agent strings are ASCII; accepting this for
    // diagnostic logging keeps the helper a one-liner with no Intl.Segmenter
    // overhead. Documenting via test so future readers know the contract.
    const filler = 'a'.repeat(511); // 511 code units of ASCII
    const input = `${filler}😀rest`; // emoji starts at index 511 (2 code units: 511, 512)
    const result = truncateUserAgent(input);

    expect(result.length).toBe(512);
    // The high surrogate of '😀' (U+D83D) is preserved at index 511; the low
    // surrogate (U+DE00) is dropped, leaving a lone high surrogate.
    expect(result.charCodeAt(511)).toBe(0xd83d);
    expect(result.endsWith('rest')).toBe(false);
  });
});
