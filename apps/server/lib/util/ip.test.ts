import { describe, it, expect } from 'vitest';
import { truncateIpForAudit } from './ip';

describe('truncateIpForAudit — IPv4', () => {
  it.each([
    ['1.2.3.4', '1.2.3.0/24'],
    ['0.0.0.0', '0.0.0.0/24'],
    ['255.255.255.255', '255.255.255.0/24'],
  ])('returns /24 form for valid IPv4 %s', (input, expected) => {
    expect(truncateIpForAudit(input)).toBe(expected);
  });

  it.each([
    ['999.999.999.999', 'octet > 255 at every position'],
    ['256.0.0.0', 'first octet exactly +1 over boundary'],
    ['-1.0.0.0', 'negative octet'],
  ])('rejects IPv4 with %s (case: %s)', (input) => {
    expect(truncateIpForAudit(input)).toBeNull();
  });

  it.each([
    ['1.2.a.4', 'non-numeric octet'],
    ['1.2.3', 'three octets only'],
    ['1.2.3.4.5', 'five octets'],
  ])('rejects malformed IPv4 %s (%s)', (input) => {
    expect(truncateIpForAudit(input)).toBeNull();
  });
});

describe('truncateIpForAudit — IPv6', () => {
  it('returns /48 form for valid IPv6 with embedded ::', () => {
    expect(truncateIpForAudit('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
  });

  it('normalizes mixed-case hextets to lowercase', () => {
    expect(truncateIpForAudit('FE80:0:0:1::1')).toBe('fe80:0:0::/48');
  });

  it.each([
    ['::1', 'loopback (starts with ::)'],
    ['::ffff:1.2.3.4', 'IPv4-mapped (starts with ::)'],
  ])('rejects IPv6 starting with :: (%s)', (input) => {
    expect(truncateIpForAudit(input)).toBeNull();
  });

  it('rejects IPv6 with non-hex hextet', () => {
    expect(truncateIpForAudit('2001:zzzz:1234::1')).toBeNull();
  });

  it('rejects pseudo-IPv6 with 3 segments and no :: shortcut (fixes drilldown bug)', () => {
    expect(truncateIpForAudit('2001:db8:abcd')).toBeNull();
  });

  it('rejects fe80::1 — :: expansion falls inside the /48 prefix window, cannot safely extract first 3 non-empty hextets', () => {
    // fe80::1 is a valid IPv6 (fe80:0:0:0:0:0:0:1), but the truncation
    // algorithm splits on ':' and looks at the first 3 raw segments —
    // when :: appears within those, an empty hextet leaks into head and
    // we reject rather than emit a malformed /48 prefix.
    expect(truncateIpForAudit('fe80::1')).toBeNull();
  });

  it('rejects trailing :: addresses (2001:db8::) — empty hextet in the /48 window', () => {
    expect(truncateIpForAudit('2001:db8::')).toBeNull();
  });
});

describe('truncateIpForAudit — edge cases', () => {
  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['not an ip at all', 'arbitrary text'],
  ])('returns null for %s (%s)', (input) => {
    expect(truncateIpForAudit(input)).toBeNull();
  });
});
