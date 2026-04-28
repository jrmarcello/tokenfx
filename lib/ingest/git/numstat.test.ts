import { describe, it, expect } from 'vitest';
import { parseNumstat } from './numstat';

describe('parseNumstat', () => {
  it('TC-U-01: sums tab-delimited numeric rows', () => {
    const stdout = '10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts';
    const result = parseNumstat(stdout);
    expect(result).toEqual({
      ok: true,
      value: { added: 15, removed: 2, filesChanged: 2 },
    });
  });

  it('TC-U-02: binary lines contribute 0/0 but count toward filesChanged', () => {
    const stdout = '-\t-\timg/logo.png';
    const result = parseNumstat(stdout);
    expect(result).toEqual({
      ok: true,
      value: { added: 0, removed: 0, filesChanged: 1 },
    });
  });

  it('TC-U-03: empty input yields zero summary', () => {
    const result = parseNumstat('');
    expect(result).toEqual({
      ok: true,
      value: { added: 0, removed: 0, filesChanged: 0 },
    });
  });

  it('TC-U-04: malformed line returns parse-failed error', () => {
    const result = parseNumstat('garbage line');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'parse-failed', line: 'garbage line' },
    });
  });

  it('TC-U-05: rename arrow {old => new}/path counted once with summed lines', () => {
    const stdout = '5\t3\t{old => new}/path.ts';
    const result = parseNumstat(stdout);
    expect(result).toEqual({
      ok: true,
      value: { added: 5, removed: 3, filesChanged: 1 },
    });
  });

  it('mixed: numeric + binary + rename together', () => {
    const stdout = [
      '10\t2\tsrc/a.ts',
      '-\t-\timg/logo.png',
      '5\t3\t{old => new}/path.ts',
    ].join('\n');
    const result = parseNumstat(stdout);
    expect(result).toEqual({
      ok: true,
      value: { added: 15, removed: 5, filesChanged: 3 },
    });
  });

  it('ignores trailing/leading blank lines', () => {
    const stdout = '\n10\t2\tsrc/a.ts\n\n';
    const result = parseNumstat(stdout);
    expect(result).toEqual({
      ok: true,
      value: { added: 10, removed: 2, filesChanged: 1 },
    });
  });
});
