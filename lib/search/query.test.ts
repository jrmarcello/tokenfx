import { describe, it, expect } from 'vitest';
import type { SearchHit } from './query';
import {
  normalizeLimit,
  normalizeOffset,
  renderSnippet,
  sanitizeFtsQuery,
} from './query';

describe('sanitizeFtsQuery', () => {
  it.each([
    // TC-U-01 happy: basic two-term input
    { input: 'auth bug', expected: '"auth"* "bug"*', label: 'TC-U-01' },
    // TC-U-02 happy: collapses whitespace
    {
      input: '  foo   bar  ',
      expected: '"foo"* "bar"*',
      label: 'TC-U-02',
    },
    // TC-U-04 security: AND/OR/NOT treated as plain quoted terms
    {
      input: 'AND OR NOT',
      expected: '"AND"* "OR"* "NOT"*',
      label: 'TC-U-04',
    },
    // TC-U-05 edge: `*` is stripped and treated as a term separator (documented choice)
    {
      input: 'foo*bar',
      expected: '"foo"* "bar"*',
      label: 'TC-U-05',
    },
    // TC-U-10 edge: Unicode preserved
    { input: 'café', expected: '"café"*', label: 'TC-U-10' },
  ])('$label sanitizeFtsQuery($input) -> $expected', ({ input, expected }) => {
    expect(sanitizeFtsQuery(input)).toBe(expected);
  });

  it('TC-U-03 security: strips FTS5 syntactic characters', () => {
    const out = sanitizeFtsQuery('foo"); DROP TABLE');
    expect(out).not.toBeNull();
    // No unquoted injection: no quote characters inside the quoted fragments,
    // no parens, no semicolons
    // out has the form '"foo"* ...'; the only `"` chars should be the paired wrappers.
    // Assert the string does not contain `);` or `"foo";` style injection leftovers.
    expect(out).not.toContain(');');
    expect(out).not.toContain(';');
    expect(out).not.toContain('(');
    expect(out).not.toContain(')');
    // Make sure every `"` appears as a term wrapper (even count) and no bare `"`
    // survives inside the term content. Count quotes: should be 2 per term.
    const quoteCount = (out ?? '').split('"').length - 1;
    expect(quoteCount % 2).toBe(0);
    // No control chars or NUL
    expect(out).not.toMatch(/[\x00-\x1f]/);
  });

  it.each([
    // TC-U-06 validation: empty
    { input: '', label: 'TC-U-06' },
    // TC-U-07 validation: only whitespace
    { input: '   ', label: 'TC-U-07' },
    // TC-U-08 validation: <=1 useful char
    { input: 'a', label: 'TC-U-08' },
    // TC-U-09 validation: over 200 chars
    { input: 'a'.repeat(300), label: 'TC-U-09' },
  ])('$label sanitizeFtsQuery($input) -> null', ({ input }) => {
    expect(sanitizeFtsQuery(input)).toBeNull();
  });
});

describe('normalizeLimit', () => {
  it.each([
    // TC-U-11 default
    { input: undefined, expected: 25, label: 'TC-U-11' },
    // TC-U-12 clamp min
    { input: 0, expected: 1, label: 'TC-U-12' },
    // TC-U-13 clamp max
    { input: 200, expected: 100, label: 'TC-U-13' },
    // extra: within range
    { input: 50, expected: 50, label: 'extra-within-range' },
    // extra: negative goes to min
    { input: -10, expected: 1, label: 'extra-negative' },
    // extra: exact boundaries
    { input: 1, expected: 1, label: 'extra-min-boundary' },
    { input: 100, expected: 100, label: 'extra-max-boundary' },
  ])('$label normalizeLimit($input) -> $expected', ({ input, expected }) => {
    expect(normalizeLimit(input)).toBe(expected);
  });
});

describe('normalizeOffset', () => {
  it.each([
    // TC-U-14 negative to zero
    { input: -5, expected: 0, label: 'TC-U-14' },
    // default
    { input: undefined, expected: 0, label: 'extra-default' },
    // valid offset
    { input: 10, expected: 10, label: 'extra-valid' },
    // zero stays zero
    { input: 0, expected: 0, label: 'extra-zero' },
  ])('$label normalizeOffset($input) -> $expected', ({ input, expected }) => {
    expect(normalizeOffset(input)).toBe(expected);
  });
});

describe('renderSnippet', () => {
  it('preserves <mark> tags around terms', () => {
    expect(renderSnippet('Hello <mark>auth</mark> world')).toEqual({
      __html: 'Hello <mark>auth</mark> world',
    });
  });

  it('XSS escapes non-mark tags (script becomes inert entities)', () => {
    expect(renderSnippet('<script>alert(1)</script>')).toEqual({
      __html: '&lt;script&gt;alert(1)&lt;/script&gt;',
    });
  });

  it('keeps mark tags while escaping other tags in the same snippet', () => {
    const result = renderSnippet('<mark>a</mark> <script>b</script>');
    expect(result.__html).toContain('<mark>a</mark>');
    expect(result.__html).toContain('&lt;script&gt;b&lt;/script&gt;');
    expect(result.__html).not.toContain('<script>');
  });

  it('escapes ambient quotes and ampersands', () => {
    expect(renderSnippet('A & "B" \'C\'')).toEqual({
      __html: 'A &amp; &quot;B&quot; &#39;C&#39;',
    });
  });
});

describe('SearchHit type shape', () => {
  it('accepts an object with all 9 fields of the correct types', () => {
    const hit: SearchHit = {
      turnId: 't-1',
      sessionId: 's-1',
      project: 'tokenfx',
      sequence: 7,
      timestamp: 1_700_000_000_000,
      model: 'claude-opus-4',
      score: 0.9321,
      promptSnippet: 'pre <mark>term</mark> post',
      responseSnippet: 'pre <mark>term</mark> post',
    };
    expect(hit.turnId).toBe('t-1');
    expect(hit.sessionId).toBe('s-1');
    expect(hit.project).toBe('tokenfx');
    expect(hit.sequence).toBe(7);
    expect(hit.timestamp).toBe(1_700_000_000_000);
    expect(hit.model).toBe('claude-opus-4');
    expect(hit.score).toBeCloseTo(0.9321);
    expect(hit.promptSnippet).toContain('<mark>');
    expect(hit.responseSnippet).toContain('<mark>');
  });
});
