import { describe, it, expect } from 'vitest';
import { toCsvRow } from './format';

describe('toCsvRow', () => {
  describe('happy path + edges', () => {
    it.each<{
      name: string;
      input: ReadonlyArray<string | number | Date | null | undefined>;
      expected: string;
    }>([
      {
        // TC-U-06
        name: 'quotes cells that contain commas or newlines, leaves plain cells raw',
        input: ['ok', 'a, b', 'c\nd'],
        expected: 'ok,"a, b","c\nd"\r\n',
      },
      {
        // TC-U-07
        name: 'emits empty cells for null/undefined and escapes embedded double-quotes',
        input: ['', null, 'x"y'],
        expected: ',,"x""y"\r\n',
      },
      {
        // TC-U-07b
        name: 'preserves CRLF inside quoted cells so the row remains parser-safe',
        input: ['ok', 'line1\r\nline2', 'x'],
        expected: 'ok,"line1\r\nline2",x\r\n',
      },
      {
        name: 'returns just CRLF for an empty row',
        input: [],
        expected: '\r\n',
      },
      {
        name: 'coerces numbers to their string representation without quoting',
        input: [1, 2.5, -3],
        expected: '1,2.5,-3\r\n',
      },
      {
        name: 'serializes Date values as ISO strings without quoting (no special chars)',
        input: [new Date('2026-05-12T10:20:30.000Z')],
        expected: '2026-05-12T10:20:30.000Z\r\n',
      },
      {
        name: 'treats undefined like null (empty cell)',
        input: [undefined, 'ok', undefined],
        expected: ',ok,\r\n',
      },
      {
        name: 'quotes cells containing a bare carriage return',
        input: ['plain', 'has\rCR'],
        expected: 'plain,"has\rCR"\r\n',
      },
    ])('$name', ({ input, expected }) => {
      expect(toCsvRow(input)).toBe(expected);
    });
  });

  describe('OWASP formula-injection guard', () => {
    it.each<{ name: string; cell: string; expected: string }>([
      {
        name: "prefixes cells starting with = to neutralize spreadsheet formulas",
        cell: '=SUM(A1)',
        expected: "'=SUM(A1)\r\n",
      },
      {
        name: "prefixes cells starting with + to neutralize spreadsheet formulas",
        cell: '+1+1',
        expected: "'+1+1\r\n",
      },
      {
        name: "prefixes cells starting with - to neutralize spreadsheet formulas",
        cell: '-2+3',
        expected: "'-2+3\r\n",
      },
      {
        name: 'prefixes cells starting with @ to neutralize spreadsheet formulas',
        cell: '@cmd|',
        expected: "'@cmd|\r\n",
      },
      {
        name: 'prefixes cells starting with a tab character to neutralize spreadsheet formulas',
        cell: '\t=evil()',
        // After prefix: "'\t=evil()" — contains a tab but no comma/quote/newline → not wrapped.
        expected: "'\t=evil()\r\n",
      },
      {
        name: 'prefixes cells starting with a carriage return to neutralize spreadsheet formulas',
        cell: '\r=evil()',
        // After prefix: "'\r=evil()" — contains CR → quoted.
        expected: "\"'\r=evil()\"\r\n",
      },
      {
        name: 'detects formula chars after leading whitespace (trim before classifying)',
        cell: '   =SUM(A1)',
        expected: "'   =SUM(A1)\r\n",
      },
      {
        name: 'still quotes prefixed cells whose original content has commas',
        cell: '=A1,A2',
        expected: '"\'=A1,A2"\r\n',
      },
      {
        name: 'leaves benign cells untouched (no prefix, no quoting)',
        cell: 'hello world',
        expected: 'hello world\r\n',
      },
      {
        name: 'does not prefix cells that merely contain formula chars after the first non-space',
        cell: 'a=b',
        expected: 'a=b\r\n',
      },
    ])('$name', ({ cell, expected }) => {
      expect(toCsvRow([cell])).toBe(expected);
    });
  });
});
